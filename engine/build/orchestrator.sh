#!/bin/bash
set -e

# Directory Setup
# This script lives at engine/build/, so the repo root is two levels up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# LIBREOFFICE_DIR env var allows parallel builds to use separate worktrees
INTERNAL_SOURCE_DIR="${LIBREOFFICE_DIR:-$ROOT_DIR/libreoffice}"
INTERNAL_CCACHE_DIR="$ROOT_DIR/ccache"

# Repo-side paths. The container-internal mount points (/build_scripts, /src,
# /web, /tools, /modules) are unchanged by the engine/ restructure — only the
# host side of each bind mount moved.
BUILD_DIR="$ROOT_DIR/engine/build"
MODULES_DIR="$ROOT_DIR/engine/modules"
SRC_DIR="$ROOT_DIR/engine/bridge"
WEB_DIR="$ROOT_DIR/web"
DOCKER_DIR="$ROOT_DIR/docker"
TOOLS_DIR="$ROOT_DIR/engine/tools"
TEST_DIR="$ROOT_DIR/engine/build/visual"

# Ensure directories exist
mkdir -p "$INTERNAL_CCACHE_DIR"

# Read nice level from pipeline config (default 10 = lower priority for builds)
# This allows interactive processes to remain responsive during long builds
NICE_LEVEL=$(jq -r '.build_config.nice_level // 10' "$ROOT_DIR/pipeline/config/modules.json" 2>/dev/null || echo 10)

# Run docker with lower CPU priority for builds
# Usage: run_docker_build [docker run args...]
run_docker_build() {
    # PARTITIONED WORKDIR (opt-in, default OFF -- behaviour is unchanged unless
    # PARTITIONED_WORKDIR=1 is exported).
    #
    # WHY THIS IS THE ONLY EDIT SITE. All 16 build functions hardcode their own
    # `docker run` argument list but every one of them goes through this helper,
    # and apply_patches() already records the module in APPLIED_PATCH_MODULE for
    # the config-drift check. So the module is in scope here and nowhere else
    # central -- adding the mount at each call site would be the same duplication
    # that let the spot/on-demand split in build.yml drift twice in two PRs.
    #
    # WHAT IT DOES. Bind-mounts <root>/workdirs/<module> over /build/core/workdir
    # inside the builder, so LibreOffice writes where it always does and each
    # module gets its own. This removes the cross-module coupling documented in
    # bugs/BUG-28...:1164 and re-found on 2026-09-20: a writer build succeeding
    # only because a spreadsheets build left an artifact behind.
    #
    # FAILS LOUD, NOT OPEN. If partitioning is requested and the module is not
    # known, this refuses rather than silently falling back to the shared workdir
    # -- a silent fallback would report "partitioned" while measuring "shared",
    # which is the exact class of defect this whole exercise keeps turning up.
    local _extra=()
    if [[ "${PARTITIONED_WORKDIR:-0}" == "1" ]]; then
        if [[ -z "${APPLIED_PATCH_MODULE:-}" ]]; then
            echo "ERROR: PARTITIONED_WORKDIR=1 but no module is known (APPLIED_PATCH_MODULE unset)." >&2
            echo "       Refusing to fall back to the shared workdir, which would silently" >&2
            echo "       measure and build the thing partitioning exists to avoid." >&2
            exit 1
        fi
        mkdir -p "$ROOT_DIR/workdirs/$APPLIED_PATCH_MODULE"
        # Keep 1eb4c25d's fix alive under partitioning. That commit added
        # `rm -rf workdir/Rdb` to every clean step because a stale services.rdb
        # was reused and shipped a VFS with no pdfimport registration. Those 14
        # clean steps operate on the SHARED libreoffice/workdir, which is not
        # where this build now writes -- so without this line the fix would be
        # silently bypassed the moment partitioning is switched on. Cross-module
        # reuse is gone, but same-module reuse across runs is not.
        rm -rf "$ROOT_DIR/workdirs/$APPLIED_PATCH_MODULE/Rdb"
        _extra=(-v "$HOST_ROOT_DIR/workdirs/$APPLIED_PATCH_MODULE:/build/core/workdir")
        echo "  Partitioned workdir: $HOST_ROOT_DIR/workdirs/$APPLIED_PATCH_MODULE -> /build/core/workdir"
    fi
    nice -n "${NICE_LEVEL}" sudo docker run "${_extra[@]}" "$@"
}
# ---------------------------------------------------------------------------
# HYDRATE THE SOURCE TREE FROM THE UPSTREAM MIRROR, IF IT IS ABSENT.
#
# An ephemeral CI runner starts with no libreoffice/ at all, and every build
# fetching ~1.8GB from github.com is both an availability dependency (an outage
# blocks releases) and a reproducibility gap: LibreOffice/core is a THIRD-PARTY
# repo, and docs/deployment/02-legal-sequence.md §1b names its commit as MPL/LGPL
# Corresponding Source. If that commit ever became unreachable we could not
# rebuild a release whose provenance record claims it.
#
# The mirror stores a GIT BUNDLE per commit. A bundle is self-verifying: git
# checks object integrity on clone and the commit SHA is the content address, so
# a hostile or corrupted mirror cannot substitute different content under the
# same SHA. The upstream-pin check immediately below then re-verifies the tree
# against engine/upstream.json regardless of where it came from -- so this is a
# CONVENIENCE for fetching, never a trust boundary.
#
# See docs/deployment/runbooks/build-input-mirrors.md.
# ---------------------------------------------------------------------------
hydrate_from_mirror() {
    local commit bundle_uri tmp
    commit="$(jq -r .commit "$ROOT_DIR/engine/upstream.json" 2>/dev/null || true)"
    [[ -n "$commit" && "$commit" != "null" ]] || return 1
    [[ -n "${UPSTREAM_MIRROR_BUCKET:-}" ]] || return 1
    command -v aws >/dev/null 2>&1 || { echo "  mirror: aws CLI absent; cannot fetch"; return 1; }

    bundle_uri="s3://${UPSTREAM_MIRROR_BUCKET}/libreoffice/${commit}.bundle"

    # STAGE BESIDE THE DESTINATION, NOT IN /tmp. The bundle is ~3.9 GiB and the
    # tree it clones to is ~11 GiB, so the only filesystem guaranteed to hold it
    # is the one already committed to holding the checkout.
    #
    # `mktemp -d` picks /tmp, and on the CI runner /tmp is a tmpfs: build #9
    # (2026-09-21) died with "[Errno 28] No space left on device" on an instance
    # whose only EBS volume was 100 GB and ~90 GB free. Worth stating plainly
    # because the wrong conclusion was reached first -- ENOSPC was ruled OUT by
    # reasoning about throughput against that 100 GB volume, which was not the
    # volume being written to. A single-volume launch template does not mean a
    # single filesystem.
    tmp="$(dirname "$INTERNAL_SOURCE_DIR")/.mirror-stage.$$"
    rm -rf "$tmp" && mkdir -p "$tmp" || { echo "  mirror: cannot create staging dir $tmp"; return 1; }
    echo "  mirror: fetching $bundle_uri"
    echo "  mirror: staging in $tmp ($(df -Ph "$tmp" | awk 'NR==2{print $4" free on "$6}'))"
    # SHOW THE REASON. `>/dev/null 2>&1` collapsed AccessDenied, an unresolvable
    # region, absent IMDS credentials, no network and a genuinely missing key into
    # one message -- "no bundle for $commit" -- which NAMES A CAUSE IT HAS NOT
    # ESTABLISHED. Build #8 (2026-09-21) died here with the bundle sitting in the
    # bucket and the IAM grant correct, and the log could not distinguish which of
    # five unrelated faults had occurred. Capture stderr, keep the payload off
    # stdout (`2>&1 >/dev/null` in that order), and print what aws actually said.
    local _err
    if ! _err="$(aws s3 cp "$bundle_uri" "$tmp/lo.bundle" 2>&1 >/dev/null)"; then
        rm -rf "$tmp"
        echo "  mirror: FETCH FAILED for $commit — aws s3 cp reported:"
        [[ -n "$_err" ]] && sed 's/^/  mirror: | /' <<<"$_err"
        # Disk facts belong with a fetch failure: ENOSPC and AccessDenied read
        # identically once the message is gone, and the first diagnosis of #9
        # reasoned about the wrong filesystem.
        df -Ph "$(dirname "$tmp")" /tmp 2>/dev/null | sed 's/^/  mirror: | df: /'
        return 1
    fi
    if ! git clone -q "$tmp/lo.bundle" "$INTERNAL_SOURCE_DIR" 2>/dev/null; then
        rm -rf "$tmp"; echo "  mirror: bundle did not clone"; return 1
    fi
    rm -rf "$tmp"

    # ASSERT THE TREE IS THE DECLARED COMMIT. The previous spelling was
    # `checkout ... || true` followed by an unconditional "hydrated at $(rev-parse
    # HEAD)" and `return 0` -- so when the bundle's only ref was not the local
    # default branch name AND the declared commit was absent from it, the clone
    # left HEAD UNBORN, the checkout failed, the success line printed BLANK, and
    # this returned 0. The upstream-pin check below then SKIPPED rather than
    # refused, because it is guarded on a non-empty commit. The build got as far
    # as apply_patches before failing with "patch does not apply" -- a true
    # failure reached by a path where every intermediate check reported success.
    if ! git -C "$INTERNAL_SOURCE_DIR" checkout -q "$commit" 2>/dev/null; then
        echo "  mirror: bundle does not contain the declared commit $commit"
        rm -rf "$INTERNAL_SOURCE_DIR"
        return 1
    fi
    local _head
    _head="$(git -C "$INTERNAL_SOURCE_DIR" rev-parse HEAD 2>/dev/null || true)"
    if [[ "$_head" != "$commit" ]]; then
        echo "  mirror: HEAD is '${_head:-<unborn>}', expected $commit"
        rm -rf "$INTERNAL_SOURCE_DIR"
        return 1
    fi
    # Do not leave origin pointing at the deleted temp bundle -- the tree would
    # then lie about where it came from to anyone who looks.
    git -C "$INTERNAL_SOURCE_DIR" remote set-url origin \
        "$(jq -r .repository "$ROOT_DIR/engine/upstream.json" 2>/dev/null)" 2>/dev/null || true
    echo "  mirror: hydrated at $(git -C "$INTERNAL_SOURCE_DIR" rev-parse --short HEAD)"
    return 0
}

if [ ! -d "$INTERNAL_SOURCE_DIR" ]; then
    if ! hydrate_from_mirror; then
        # NO SILENT FALLBACK TO github.com ON A PROVENANCE BUILD. If the mirror
        # does not hold the bundle for the commit we are about to convey as
        # Corresponding Source, then the mirror does not hold what shipped --
        # and discovering that after the release is worthless. Refuse instead.
        # MATCH THE VALUE build_and_deploy.sh ACTUALLY SETS. It assigns the
        # STRING "true" (:73, :158), not 1 -- an earlier draft of this guard
        # tested for "1" and would therefore have been dead code on every real
        # provenance build, refusing nothing while looking like a safeguard.
        if [[ "${WITH_PROVENANCE:-false}" == "true" || "${REQUIRE_UPSTREAM_MIRROR:-0}" == "1" ]]; then
            echo "Error: could not obtain the upstream bundle for the declared commit (the reason is" >&2
            echo "       printed above — absent object, AccessDenied and no credentials are all" >&2
            echo "       possible and are NOT the same problem), and this is a" >&2
            echo "       provenance build. Refusing to fetch from github.com instead: the mirror" >&2
            echo "       would then not hold the source this release conveys as Corresponding" >&2
            echo "       Source (02-legal-sequence.md §1b). Populate it first — see" >&2
            echo "       docs/deployment/runbooks/build-input-mirrors.md §5." >&2
            exit 1
        fi
        echo "Error: LibreOffice source directory '$INTERNAL_SOURCE_DIR' does not exist. Please clone the repository first."
        echo "       Declared upstream: $(jq -r '.repository + " @ " + .commit' "$ROOT_DIR/engine/upstream.json" 2>/dev/null || echo 'see engine/upstream.json')"
        exit 1
    fi
fi

# Verify the tree we are about to build is the one we DECLARE we build.
#
# engine/upstream.json is the prescriptive record; libreoffice/ is a gitignored
# working tree that can be anything. Building a different upstream than the one
# declared breaks two things silently: the patch series is only known-good
# against the declared commit, and MPL/LGPL Corresponding Source must correspond
# to the binary actually conveyed (docs/deployment/02-legal-sequence.md 1b).
#
# Fails closed. Set ALLOW_UPSTREAM_MISMATCH=1 for a deliberate upgrade — and
# then update engine/upstream.json, which is the point of the override existing
# rather than the check being advisory.
UPSTREAM_PIN="$ROOT_DIR/engine/upstream.json"
if [ -f "$UPSTREAM_PIN" ] && [ -d "$INTERNAL_SOURCE_DIR/.git" ]; then
    declared_commit=$(jq -r '.commit // ""' "$UPSTREAM_PIN" 2>/dev/null || echo "")
    actual_commit=$(git -C "$INTERNAL_SOURCE_DIR" rev-parse HEAD 2>/dev/null || echo "")
    # AN UNRESOLVABLE HEAD IS A REFUSAL, NOT A SKIP. This condition required a
    # NON-EMPTY actual_commit, so a tree whose HEAD could not be resolved -- an
    # unborn HEAD after a clone that found no matching ref -- fell straight
    # through the one check whose job is "are we building the upstream we
    # declare?". Absence of an answer was being read as absence of a problem.
    if [ -n "$declared_commit" ] && [ -z "$actual_commit" ] && [ -d "$INTERNAL_SOURCE_DIR/.git" ]; then
        echo "==============================================================="
        echo "ERROR: $INTERNAL_SOURCE_DIR is a git repository whose HEAD cannot be resolved."
        echo "       Declared upstream: $declared_commit"
        echo "       Refusing to build: the pin check cannot answer, and an unanswered"
        echo "       check is not a passed one."
        echo "==============================================================="
        exit 1
    fi
    if [ -n "$declared_commit" ] && [ -n "$actual_commit" ] && [ "$declared_commit" != "$actual_commit" ]; then
        echo "==============================================================="
        echo "ERROR: upstream LibreOffice does not match engine/upstream.json"
        echo "  declared: $declared_commit"
        echo "  checked out: $actual_commit"
        echo "  tree: $INTERNAL_SOURCE_DIR"
        echo ""
        echo "The patch series is known-good only against the declared commit,"
        echo "and the licence obligation names it as Corresponding Source."
        echo ""
        echo "  - building the declared upstream:  git -C '$INTERNAL_SOURCE_DIR' checkout $declared_commit"
        echo "  - deliberately moving upstream:    update engine/upstream.json, then re-run"
        echo "  - one-off override:                ALLOW_UPSTREAM_MISMATCH=1 $0 ..."
        echo "==============================================================="
        if [ "${ALLOW_UPSTREAM_MISMATCH:-0}" != "1" ]; then
            exit 1
        fi
        echo "ALLOW_UPSTREAM_MISMATCH=1 — continuing with an UNDECLARED upstream."
    fi
fi

# Determine Host Path for Volume Mounts (Docker-in-Docker Sibling Support)
# We are inside a container, but we need to tell the host docker daemon where to mount files from.
CONTAINER_ID=$(hostname)
# We use sudo because the docker socket typically requires root or docker group.
# We assume the user has sudo access or is in the docker group.
HOST_WORKSPACE_ROOT=$(sudo docker inspect --format='{{range .Mounts}}{{if eq .Destination "/home/dev/workspace"}}{{.Source}}{{end}}{{end}}' "$CONTAINER_ID" 2>/dev/null || true)

if [ -z "$HOST_WORKSPACE_ROOT" ]; then
    echo "Warning: Could not determine host path via docker inspect. Falling back to local path '$ROOT_DIR'."
    echo "This assumes we are running on the host or in a simple bind mount where paths match."
    HOST_WORKSPACE_ROOT="$ROOT_DIR"
fi

# Map ROOT_DIR onto the host path. ROOT_DIR may be a LANE
# (/home/dev/workspace/.lanes/<name>) rather than the workspace root; deriving
# every mount from HOST_WORKSPACE_ROOT alone silently mounted the MAIN
# checkout's libreoffice/, web/ and engine/ into the build container while the
# local (lane) tree got the patches -- a build of the wrong source deployed to
# the wrong checkout. (Observed 2026-08-31 during BUG-28.)
if [[ "$ROOT_DIR" == /home/dev/workspace/* ]]; then
    HOST_ROOT_DIR="$HOST_WORKSPACE_ROOT${ROOT_DIR#/home/dev/workspace}"
elif [[ "$ROOT_DIR" == /home/dev/workspace ]]; then
    HOST_ROOT_DIR="$HOST_WORKSPACE_ROOT"
else
    HOST_ROOT_DIR="$ROOT_DIR"
fi

# Derive host source path: if LIBREOFFICE_DIR was overridden, resolve its host path
if [[ "$INTERNAL_SOURCE_DIR" == "$ROOT_DIR/libreoffice" ]]; then
    HOST_SOURCE_DIR="$HOST_ROOT_DIR/libreoffice"
else
    # For worktrees: inspect mount to find the host path, or assume paths match
    HOST_SOURCE_DIR=$(sudo docker inspect --format="{{range .Mounts}}{{if eq .Destination \"$INTERNAL_SOURCE_DIR\"}}{{.Source}}{{end}}{{end}}" "$CONTAINER_ID" 2>/dev/null || true)
    if [ -z "$HOST_SOURCE_DIR" ]; then
        HOST_SOURCE_DIR="$INTERNAL_SOURCE_DIR"
    fi
fi
HOST_CCACHE_DIR="$HOST_ROOT_DIR/ccache"
HOST_BUILD_DIR="$HOST_ROOT_DIR/engine/build"
HOST_MODULES_DIR="$HOST_ROOT_DIR/engine/modules"
HOST_SRC_DIR="$HOST_ROOT_DIR/engine/bridge"
HOST_WEB_DIR="$HOST_ROOT_DIR/web"
HOST_DOCKER_DIR="$HOST_ROOT_DIR/docker"
# NOTE: /tools now mounts engine/tools ONLY. It used to mount the whole of
# tools/, which meant every build container also received the crypto toolchain
# (init_keyring.py, verify_provenance.sh, rotate_provenance_key.sh, ...).
# The build has never needed those; it uses exactly three scripts from here.
HOST_TOOLS_DIR="$HOST_WORKSPACE_ROOT/engine/tools"
HOST_TEST_DIR="$HOST_WORKSPACE_ROOT/engine/build/visual"
HOST_TEST_CORPUS_DIR="$HOST_WORKSPACE_ROOT/test_corpus"

# --- Functions for different pipeline stages ---

apply_patches() {
    local module="${1:-}"
    # Record which module's series is now on the tree. build_wasm_builder_image
    # needs it for the config-drift check and has no other way to know: the
    # module name is hardcoded at each of the 15 call sites and MODULE_NAME is
    # only a `docker -e` variable at the run site, NOT a shell variable in scope.
    # Setting it here keeps this to ONE edit instead of fifteen.
    APPLIED_PATCH_MODULE="$module"
    echo "Applying patches..."
    if [ -n "$module" ]; then
        echo "  Module: $module (skipping patches for other modules)"
    fi
    "$ROOT_DIR/engine/scripts/apply_patches.sh" "$module"
}

# Copy optimized WASM artifacts to finished_packages
# After wasm-opt runs, soffice_optimized.wasm is in the libreoffice root.
# This overwrites the unoptimized instdir version in finished_packages so
# deploy_module always gets the optimized binary regardless of build mode.
copy_optimized_artifacts() {
    local module_name="$1"
    local packages_dir="$ROOT_DIR/finished_packages"

    if [ -f "$INTERNAL_SOURCE_DIR/soffice_optimized.wasm" ]; then
        echo "Copying optimized WASM to finished_packages for $module_name..."
        cp "$INTERNAL_SOURCE_DIR/soffice_optimized.wasm" "$packages_dir/soffice-${module_name}.wasm"
    fi
    if [ -f "$INTERNAL_SOURCE_DIR/soffice_optimized.wasm.br" ]; then
        cp "$INTERNAL_SOURCE_DIR/soffice_optimized.wasm.br" "$packages_dir/soffice-${module_name}.wasm.br"
    fi
}

# Post-build validation function
# Validates that the WASM binary has required symbols and VFS content
validate_build() {
    local module_type="${1:-documents}"
    local wasm_path="$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm"
    local vfs_metadata="$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata"

    echo ""
    echo "=== Running Post-Build Validation ==="
    if [ -x "$ROOT_DIR/engine/scripts/validate_build.sh" ]; then
        "$ROOT_DIR/engine/scripts/validate_build.sh" "$wasm_path" "$vfs_metadata" "$module_type"
        local validation_result=$?
        if [ $validation_result -ne 0 ]; then
            echo "WARNING: Build validation found issues. See above for details."
            return $validation_result
        fi
    else
        echo "WARNING: Validation script not found or not executable"
    fi
    return 0
}

build_wasm_builder_image() {
    # Pre-flight: refuse to build on top of sanitizer-tainted objects.
    #
    # Hooked HERE because every module's build path calls this one function, so a
    # single edit covers all of them and no shared list has to be kept in sync.
    #
    # Costs ~0.6s over 11,516 objects (measured). Checked EXPLICITLY rather than
    # relying on errexit: engine/build/build.sh disables `set -e`, and a hygiene
    # gate that fails open is worse than none -- it would silently link poisoned
    # objects while looking configured.
    if [ -x "$ROOT_DIR/engine/scripts/check_object_hygiene.sh" ]; then
        if ! "$ROOT_DIR/engine/scripts/check_object_hygiene.sh" "$INTERNAL_SOURCE_DIR"; then
            echo "Aborting before the build: see the stale objects listed above." >&2
            exit 1
        fi

        # Config drift: the general case that object hygiene cannot see, since
        # only sanitizer taint is self-identifying. Runs AFTER apply_patches
        # (the caller's order) because it fingerprints the PATCHED
        # distro-configs/LibreOfficeWASM32.conf, which is what configure reads.
        # Checked explicitly for the same reason as above: build.sh disables
        # `set -e`, and a hygiene check that fails open is worse than none.
        if [ -z "${APPLIED_PATCH_MODULE:-}" ]; then
            echo "WARNING: no module recorded by apply_patches; build-config drift" >&2
            echo "         check SKIPPED (not passed)." >&2
        elif [ -x "$ROOT_DIR/engine/scripts/check_build_config_drift.sh" ]; then
            if ! "$ROOT_DIR/engine/scripts/check_build_config_drift.sh" "${APPLIED_PATCH_MODULE:-}" "$INTERNAL_SOURCE_DIR"; then
                echo "Aborting before the build: build configuration changed." >&2
                exit 1
            fi
        else
            echo "WARNING: engine/scripts/check_build_config_drift.sh missing or not" >&2
            echo "         executable; build-config drift check SKIPPED (not passed)." >&2
        fi
    else
        # The checker is missing or not executable. Say so -- silence here would
        # be indistinguishable from a clean tree.
        echo "WARNING: engine/scripts/check_object_hygiene.sh missing or not executable;" >&2
        echo "         stale-object pre-flight SKIPPED (not passed)." >&2
    fi

    # PULL THE PINNED IMAGE IF ONE IS PINNED; BUILD ONLY AS A FALLBACK.
    #
    # This was `docker build` on every machine, from a Dockerfile whose base was a
    # MUTABLE tag plus an unpinned apt-get -- so "the same builder" was never
    # guaranteed to be the same builder, and every runner spent ~2 min rebuilding
    # it while depending on Docker Hub's anonymous-pull rate limit.
    #
    # ONE RESOLUTION POINT. All 16 build sites already funnel through
    # run_docker_build and refer to the local tag `wasm-builder`, so the pinned
    # image is pulled and re-tagged to that name here rather than changing 16
    # call sites -- the same reasoning as the partitioned-workdir mount.
    local _lock="$ROOT_DIR/infra/runner/builder-image.lock.json"
    if [[ -f "$_lock" ]]; then
        local _repo _digest
        _repo="$(jq -r '.repository // empty' "$_lock" 2>/dev/null)"
        _digest="$(jq -r '.digest // empty' "$_lock" 2>/dev/null)"
        if [[ -n "$_repo" && -n "$_digest" ]]; then
            # AUTHENTICATE FIRST. The repository is a PRIVATE ECR registry, and
            # nothing in this repo ever logged docker in to it -- the runner's IAM
            # grant carries ecr:GetAuthorizationToken (build_inputs.tf) and no code
            # path called it. The pull therefore failed with "no basic auth
            # credentials" on every provenance build, reported as the generic
            # "could not pull the pinned image" because stderr was discarded.
            #
            # Skipped silently when the repo is not an ECR registry (a local
            # registry or a docker.io mirror needs no AWS login) and when `aws` is
            # absent, so a developer machine behaves as before.
            local _registry="${_repo%%/*}"
            if [[ "$_registry" == *.dkr.ecr.*.amazonaws.com ]] && command -v aws >/dev/null 2>&1; then
                local _ecr_region _login_err
                _ecr_region="$(sed -E 's/.*\.dkr\.ecr\.([^.]+)\.amazonaws\.com/\1/' <<<"$_registry")"
                if ! _login_err="$(aws ecr get-login-password --region "$_ecr_region" 2>&1 \
                       | sudo docker login --username AWS --password-stdin "$_registry" 2>&1 >/dev/null)"; then
                    echo "  builder: ECR login FAILED for $_registry:"
                    [[ -n "$_login_err" ]] && sed 's/^/  builder: | /' <<<"$_login_err"
                else
                    echo "  builder: authenticated to $_registry"
                fi
            fi
            echo "Pulling pinned builder image ${_repo}@${_digest}"
            local _pull_err
            if _pull_err="$(sudo docker pull -q "${_repo}@${_digest}" 2>&1 >/dev/null)"; then
                # VERIFY WHAT WE GOT, do not assume the pull honoured the digest.
                local _got
                _got="$(sudo docker image inspect "${_repo}@${_digest}" \
                          --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | grep -F "$_digest" || true)"
                if [[ -n "$_got" ]]; then
                    sudo docker tag "${_repo}@${_digest}" wasm-builder
                    echo "  builder: PINNED ${_digest}"
                    return 0
                fi
                echo "  builder: pulled image does not carry the pinned digest — refusing it"
            else
                echo "  builder: could not pull the pinned image — docker reported:"
                [[ -n "$_pull_err" ]] && sed 's/^/  builder: | /' <<<"$_pull_err"
            fi
            # A PROVENANCE BUILD MUST NOT SILENTLY COMPILE WITH A DIFFERENT
            # TOOLCHAIN. Same rule as the upstream mirror, and the same value
            # shape: build_and_deploy.sh sets the STRING "true".
            if [[ "${WITH_PROVENANCE:-false}" == "true" ]]; then
                echo "ERROR: the pinned builder image is unavailable and this is a provenance build." >&2
                echo "       Refusing to fall back to a local docker build: the release would be" >&2
                echo "       compiled by a toolchain that is not the one pinned in" >&2
                echo "       infra/runner/builder-image.lock.json, and nothing downstream would say so." >&2
                exit 1
            fi
            echo "  builder: falling back to a local build (NOT the pinned toolchain)"
        fi
    fi
    echo "Building/Verifying Docker image 'wasm-builder'..."
    sudo docker build -t wasm-builder -f "$DOCKER_DIR/Dockerfile.builder" "$DOCKER_DIR"
}

build_golden_master_image() {
    echo "Building/Verifying Docker image 'golden-master'..."
    sudo docker build -t golden-master -f "$DOCKER_DIR/Dockerfile.golden-master" "$DOCKER_DIR"
}

build_libreoffice_wasm() {
    # Ensure a clean state for libreoffice before applying patches
    echo "Cleaning libreoffice directory to ensure a pristine state..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches documents
    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    echo "Running LibreOffice WASM build in container 'wasm-builder'..."
    echo "  Host LibreOffice Source: $HOST_SOURCE_DIR -> /build/core"
    echo "  Host CCACHE: $HOST_CCACHE_DIR -> /cache/ccache"
    echo "  Host Build Config: $HOST_BUILD_DIR -> /build_scripts"
    echo "  Host Source: $HOST_SRC_DIR -> /src"
    echo "  Host Web: $HOST_WEB_DIR -> /web"
    echo "  Host Tools: $HOST_TOOLS_DIR -> /tools"
    echo "  Host Modules: $HOST_MODULES_DIR -> /modules"
    echo "  Container User: $USER_ID:$GROUP_ID"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR=\"$ROOT_DIR\" \
        wasm-builder \
        bash -c "cp /build_scripts/config/autogen.input /build/core/autogen.input && /build_scripts/build.sh"
}

run_golden_master_generation() {
    build_golden_master_image

    local INPUT_CORPUS_DIR="$ROOT_DIR/test_corpus"
    local GOLDEN_OUTPUT_DIR="$ROOT_DIR/test_corpus/golden"

    mkdir -p "$GOLDEN_OUTPUT_DIR"

    echo "Running Golden Master generation in container 'golden-master'..."
    echo "  Host Input Corpus: $HOST_TEST_CORPUS_DIR -> /input"
    echo "  Host Golden Output: $HOST_TEST_CORPUS_DIR/golden -> /output"

    # Note: golden-master runs without nice (quick operation, not a build)
    sudo docker run --rm \
        -v "$HOST_TEST_CORPUS_DIR:/input" \
        -v "$GOLDEN_OUTPUT_DIR:/output" \
        -v "$HOST_TEST_DIR/generate_golden_masters.sh:/app/generate_golden_masters.sh" \
        --user "$(id -u):$(id -g)" \
        golden-master \
        /app/generate_golden_masters.sh
}

run_visual_comparison() {
    local WASM_OUTPUT_PDF_HOST_PATH="$1"
    local GOLDEN_MASTER_PDF_HOST_PATH="$2"
    local OUTPUT_DIR_HOST_PATH="$3"

    build_golden_master_image # Ensure image is built

    echo "Running visual comparison in container 'golden-master'..."
    echo "  Wasm Output PDF: $WASM_OUTPUT_PDF_HOST_PATH"
    echo "  Golden Master PDF: $GOLDEN_MASTER_PDF_HOST_PATH"
    echo "  Comparison Output Dir: $OUTPUT_DIR_HOST_PATH"

    mkdir -p "$OUTPUT_DIR_HOST_PATH" # Ensure output directory exists on host

    # Note: visual comparison runs without nice (quick operation, not a build)
    sudo docker run --rm \
        -v "$WASM_OUTPUT_PDF_HOST_PATH:/input_wasm.pdf" \
        -v "$GOLDEN_MASTER_PDF_HOST_PATH:/input_golden.pdf" \
        -v "$OUTPUT_DIR_HOST_PATH:/output" \
        -v "$HOST_TEST_DIR/visual_compare.sh:/app/visual_compare.sh" \
        --user "$(id -u):$(id -g)" \
        golden-master \
        /app/visual_compare.sh /input_wasm.pdf /input_golden.pdf /output
}

run_wasm_test() {
    # Ensure Golden Masters are generated first
    run_golden_master_generation

    local WEB_ROOT="$ROOT_DIR/libreoffice/instdir/program"
    local SERVER_PORT=8000
    local TEST_OUTPUT_DIR="$ROOT_DIR/test_corpus/results" # Directory for comparison outputs

    echo "Starting web server to serve Wasm application from $WEB_ROOT on port $SERVER_PORT..."
    python3 -m http.server $SERVER_PORT --directory "$WEB_ROOT" > /dev/null 2>&1 &
    SERVER_PID=$!
    echo "Web server started with PID $SERVER_PID"

    # Give server a moment to start
    sleep 2

    echo "Running Puppeteer test harness..."
    node "$ROOT_DIR/tests/lib/test_harness.js"
    TEST_EXIT_CODE=$?

    echo "Stopping web server (PID $SERVER_PID)..."
    kill $SERVER_PID

    if [ $TEST_EXIT_CODE -ne 0 ]; then
        echo "Puppeteer test harness failed. Exiting."
        return $TEST_EXIT_CODE
    fi

    echo "Puppeteer test harness completed successfully. Running visual comparison."
    run_visual_comparison "$ROOT_DIR/test_corpus/wasm_output.pdf" \
                          "$ROOT_DIR/test_corpus/golden/dummy_test.pdf" \
                          "$TEST_OUTPUT_DIR"
    return $?
}

build_all_modules() {
    apply_patches
    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    echo "--- Building Main Module (Kernel) ---"
    # Execute build.sh for main module
    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR=\"$ROOT_DIR\" \
        wasm-builder \
        bash -c "cp /build_scripts/config/autogen.input.main_module /build/core/autogen.input && /build_scripts/build.sh"

    # After build_lo.sh finishes, copy artifacts
    # Assuming the output is soffice_optimized.wasm.br in libreoffice/ (or /build/core in container)
    cp "$INTERNAL_SOURCE_DIR/soffice_optimized.wasm.br" "$PACKAGES_DIR/libreoffice-main-kernel.wasm.br"
    cp "$INTERNAL_SOURCE_DIR/soffice.js" "$PACKAGES_DIR/libreoffice-main-kernel.js"
    echo "Main Module artifact copied to $PACKAGES_DIR/libreoffice-main-kernel.wasm.br"

    echo "--- Building Documents Side Module ---"
    # Execute build.sh for documents side module
    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR=\"$ROOT_DIR\" \
        wasm-builder \
        bash -c "cp /build_scripts/config/autogen.input.documents_side_module /build/core/autogen.input && /build_scripts/build.sh"

    # After build_lo.sh finishes, copy artifacts
    cp "$INTERNAL_SOURCE_DIR/soffice_optimized.wasm.br" "$PACKAGES_DIR/libreoffice-documents-side-module.wasm.br"
    cp "$INTERNAL_SOURCE_DIR/soffice.js" "$PACKAGES_DIR/libreoffice-documents-side-module.js"
    echo "Documents Side Module artifact copied to $PACKAGES_DIR/libreoffice-documents-side-module.wasm.br"

    echo "All modules built and copied to $PACKAGES_DIR."
}

# Build Spreadsheets Lite module (optimized for simple XLSX)
build_spreadsheets_lite() {
    echo "--- Building Spreadsheets Lite Module ---"
    echo "Configuration: autogen_spreadsheets_lite.input"
    echo "Purpose: Optimized for simple XLSX files with reduced memory footprint"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches spreadsheets
    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR=\"$ROOT_DIR\" \
        wasm-builder \
        bash -c "cp /build_scripts/config/autogen_spreadsheets_lite.input /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with lite suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-spreadsheets-lite.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-spreadsheets-lite.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-spreadsheets-lite.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-spreadsheets-lite.data.js.metadata" 2>/dev/null || true
        echo "Spreadsheets Lite artifacts copied to $PACKAGES_DIR/"
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build Spreadsheets Full module (full liborcus support)
build_spreadsheets_full() {
    echo "--- Building Spreadsheets Full Module ---"
    echo "Configuration: autogen_spreadsheets_full.input"
    echo "Purpose: Full liborcus support for complex XLSX files"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches spreadsheets
    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR=\"$ROOT_DIR\" \
        wasm-builder \
        bash -c "cp /build_scripts/config/autogen_spreadsheets_full.input /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with full suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-spreadsheets-full.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-spreadsheets-full.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-spreadsheets-full.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-spreadsheets-full.data.js.metadata" 2>/dev/null || true
        echo "Spreadsheets Full artifacts copied to $PACKAGES_DIR/"
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build both Spreadsheets modules for dual converter architecture
build_dual_spreadsheets() {
    echo "=== Building Dual Spreadsheets Modules ==="
    echo "This will build both Lite and Full Spreadsheets modules"
    echo ""

    build_spreadsheets_lite
    echo ""
    build_spreadsheets_full

    echo ""
    echo "=== Dual Spreadsheets Build Complete ==="
    echo "Artifacts:"
    ls -lh "$ROOT_DIR/finished_packages/soffice-spreadsheets-"* 2>/dev/null || echo "No artifacts found"
}

# Build Documents module (for DOCX, DOC, RTF, ODT, TXT, HTML)
build_documents() {
    echo "--- Building Documents Module ---"
    echo "Configuration: autogen.input.documents"
    echo "Purpose: Document conversion for Documents formats (DOCX, DOC, RTF, ODT, TXT, HTML)"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches documents
    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR=\"$ROOT_DIR\" \
        -e MODULE_NAME=documents \
        wasm-builder \
        bash -c "cp /modules/documents/autogen.input /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with documents suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        # Run validation BEFORE copying to catch issues early
        validate_build "documents"
        VALIDATION_RESULT=$?

        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-documents.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-documents.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-documents.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-documents.data.js.metadata"
        copy_optimized_artifacts "documents"
        echo "Documents artifacts copied to $PACKAGES_DIR/"

        # Patch SW services into soffice.data (required for DOCX conversion)
        echo "Patching SW services into documents soffice.data..."
        if [ -f "$TOOLS_DIR/patch_sw_services.py" ]; then
            python3 "$TOOLS_DIR/patch_sw_services.py" "$PACKAGES_DIR/soffice-documents.data" --auto
            if [ $? -eq 0 ]; then
                echo "SW services patched successfully"
            else
                echo "Warning: SW services patching failed"
            fi
        else
            echo "Warning: patch_sw_services.py not found at $TOOLS_DIR/patch_sw_services.py"
        fi

        ls -lh "$PACKAGES_DIR/soffice-documents."*

        if [ $VALIDATION_RESULT -ne 0 ]; then
            echo "ERROR: Documents build validation failed! Artifacts may not work correctly."
            exit 1
        fi
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build Spreadsheets module (for XLSX, XLS, ODS)
build_spreadsheets() {
    echo "--- Building Spreadsheets Module ---"
    echo "Configuration: autogen.input.spreadsheets (with --with-main-module=calc)"
    echo "Purpose: Spreadsheet conversion for Spreadsheets formats (XLSX, XLS, ODS)"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches spreadsheets
    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR=\"$ROOT_DIR\" \
        -e MODULE_NAME=spreadsheets \
        wasm-builder \
        bash -c "cp /modules/spreadsheets/autogen.input /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with spreadsheets suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        # Run validation BEFORE copying to catch issues early
        validate_build "spreadsheets"
        VALIDATION_RESULT=$?

        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-spreadsheets.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-spreadsheets.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-spreadsheets.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-spreadsheets.data.js.metadata" 2>/dev/null || true
        copy_optimized_artifacts "spreadsheets"
        echo "Spreadsheets artifacts copied to $PACKAGES_DIR/"
        ls -lh "$PACKAGES_DIR/soffice-spreadsheets."*

        if [ $VALIDATION_RESULT -ne 0 ]; then
            echo "ERROR: Spreadsheets build validation failed! Artifacts may not work correctly."
            exit 1
        fi
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build Spreadsheets-Charts module (EXPERIMENTAL: with Cairo for chart/drawing support)
build_spreadsheets_charts() {
    echo "--- Building Spreadsheets-Charts Module (EXPERIMENTAL) ---"
    echo "Configuration: autogen.input.spreadsheets-charts (with Cairo canvas)"
    echo "Purpose: Spreadsheet conversion with chart/drawing support (larger build)"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    # Use spreadsheets-charts patch suffix to skip the drawing-skip patch
    apply_patches spreadsheets-charts
    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR=\"$ROOT_DIR\" \
        wasm-builder \
        bash -c "cp /modules/spreadsheets-charts/autogen.input /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with spreadsheets-charts suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-spreadsheets-charts.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-spreadsheets-charts.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-spreadsheets-charts.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-spreadsheets-charts.data.js.metadata" 2>/dev/null || true
        echo "Spreadsheets-Charts artifacts copied to $PACKAGES_DIR/"

        # Report size comparison
        local REGULAR_SIZE=$(stat -c %s "$ROOT_DIR/web/modules/spreadsheets/soffice.wasm" 2>/dev/null || echo "0")
        local CHARTS_SIZE=$(stat -c %s "$PACKAGES_DIR/soffice-spreadsheets-charts.wasm")
        echo "=== SIZE COMPARISON ==="
        echo "Regular spreadsheets: $((REGULAR_SIZE / 1024 / 1024)) MB"
        echo "With charts (Cairo):  $((CHARTS_SIZE / 1024 / 1024)) MB"
        echo "Difference: $(( (CHARTS_SIZE - REGULAR_SIZE) / 1024 / 1024 )) MB"

        ls -lh "$PACKAGES_DIR/soffice-spreadsheets-charts."*
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build Presentations module (for PPTX, PPT, ODP presentations)
build_presentations() {
    echo "--- Building Presentations Module ---"
    echo "Configuration: autogen.input.presentations"
    echo "Purpose: Presentation conversion for Presentations formats (PPTX, PPT, ODP)"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches presentations
    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR=\"$ROOT_DIR\" \
        -e MODULE_NAME=presentations \
        wasm-builder \
        bash -c "cp /modules/presentations/autogen.input /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with presentations suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        # Run validation BEFORE copying to catch issues early
        validate_build "presentations"
        VALIDATION_RESULT=$?

        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-presentations.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-presentations.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-presentations.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-presentations.data.js.metadata" 2>/dev/null || true
        copy_optimized_artifacts "presentations"
        echo "Presentations artifacts copied to $PACKAGES_DIR/"
        ls -lh "$PACKAGES_DIR/soffice-presentations."*

        if [ $VALIDATION_RESULT -ne 0 ]; then
            echo "ERROR: Presentations build validation failed! Artifacts may not work correctly."
            exit 1
        fi
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build CSV module (DEPRECATED — csv module is identical to spreadsheets module)
# CSV/TSV files are routed to the spreadsheets module. This function is kept
# for reference but is no longer in the default build pipeline.
build_csv() {
    echo "--- Building CSV Module ---"
    echo "Configuration: autogen.input.csv (no --with-main-module, includes text filters)"
    echo "Purpose: CSV/text file conversion with proper filter support"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches spreadsheets
    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR="$ROOT_DIR" \
        -e MODULE_NAME=csv \
        wasm-builder \
        bash -c "cp /modules/csv/autogen.input /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with csv suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        validate_build "csv"
        VALIDATION_RESULT=$?

        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-csv.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-csv.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-csv.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-csv.data.js.metadata" 2>/dev/null || true
        copy_optimized_artifacts "csv"
        echo "CSV artifacts copied to $PACKAGES_DIR/"
        ls -lh "$PACKAGES_DIR/soffice-csv."*

        if [ $VALIDATION_RESULT -ne 0 ]; then
            echo "WARNING: CSV build validation had issues (see above)"
        fi
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build PDF-DOCX module (for PDF to Word conversion)
# This module enables PDF import and exports to DOCX format
build_pdf_docx() {
    echo "--- Building PDF-DOCX Module ---"
    echo "Configuration: autogen.input.pdf-docx"
    echo "Purpose: PDF to Word document conversion"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches pdf-docx

    # Force regeneration of configure since we patched configure.ac
    echo "Forcing configure regeneration for pdf-docx patches..."
    rm -f "$INTERNAL_SOURCE_DIR/configure"

    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR="$ROOT_DIR" \
        -e MODULE_NAME=pdf-docx \
        wasm-builder \
        bash -c "cp /modules/pdf-docx/autogen.input /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with pdf-docx suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        validate_build "pdf-docx"
        VALIDATION_RESULT=$?

        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-pdf-docx.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-pdf-docx.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-pdf-docx.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-pdf-docx.data.js.metadata" 2>/dev/null || true
        copy_optimized_artifacts "pdf-docx"
        echo "PDF-DOCX artifacts copied to $PACKAGES_DIR/"
        ls -lh "$PACKAGES_DIR/soffice-pdf-docx."*

        if [ $VALIDATION_RESULT -ne 0 ]; then
            echo "WARNING: PDF-DOCX build validation had issues (see above)"
        fi
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build PDF-XLSX module (DEPRECATED — never wired to UI, LO has no native PDF→Calc import)
# LibreOffice PDF import creates Draw/Writer documents, not spreadsheets.
# This function is kept for reference but is no longer in the default build pipeline.
build_pdf_xlsx() {
    echo "--- Building PDF-XLSX Module ---"
    echo "Configuration: autogen.input.pdf-xlsx"
    echo "Purpose: PDF to Excel spreadsheet conversion"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches pdf-xlsx

    # Force regeneration of configure since we patched configure.ac
    echo "Forcing configure regeneration for pdf-xlsx patches..."
    rm -f "$INTERNAL_SOURCE_DIR/configure"

    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR="$ROOT_DIR" \
        -e MODULE_NAME=pdf-xlsx \
        wasm-builder \
        bash -c "cp /modules/pdf-xlsx/autogen.input /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with pdf-xlsx suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        validate_build "pdf-xlsx"
        VALIDATION_RESULT=$?

        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-pdf-xlsx.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-pdf-xlsx.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-pdf-xlsx.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-pdf-xlsx.data.js.metadata" 2>/dev/null || true
        copy_optimized_artifacts "pdf-xlsx"
        echo "PDF-XLSX artifacts copied to $PACKAGES_DIR/"
        ls -lh "$PACKAGES_DIR/soffice-pdf-xlsx."*

        if [ $VALIDATION_RESULT -ne 0 ]; then
            echo "WARNING: PDF-XLSX build validation had issues (see above)"
        fi
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build PDF-PPTX module (PDF import with Impress for PPTX export)
build_pdf_pptx() {
    echo "--- Building PDF-PPTX Module ---"
    echo "Configuration: autogen.input.pdf-pptx"
    echo "Purpose: PDF to PowerPoint presentation conversion"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches pdf-pptx

    # Force regeneration of configure since we patched configure.ac
    echo "Forcing configure regeneration for pdf-pptx patches..."
    rm -f "$INTERNAL_SOURCE_DIR/configure"

    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR="$ROOT_DIR" \
        -e MODULE_NAME=pdf-pptx \
        wasm-builder \
        bash -c "cp /modules/pdf-pptx/autogen.input /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with pdf-pptx suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        validate_build "pdf-pptx"
        VALIDATION_RESULT=$?

        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-pdf-pptx.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-pdf-pptx.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-pdf-pptx.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-pdf-pptx.data.js.metadata" 2>/dev/null || true
        copy_optimized_artifacts "pdf-pptx"
        echo "PDF-PPTX artifacts copied to $PACKAGES_DIR/"
        ls -lh "$PACKAGES_DIR/soffice-pdf-pptx."*

        if [ $VALIDATION_RESULT -ne 0 ]; then
            echo "WARNING: PDF-PPTX build validation had issues (see above)"
        fi
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build Spreadsheets Profiling module (for performance analysis)
build_spreadsheets_profile() {
    echo "--- Building Spreadsheets Profiling Module ---"
    echo "Configuration: autogen.input.spreadsheets-profile (with --profiling flags)"
    echo "Purpose: Performance profiling for XLSX sharedStrings bottleneck analysis"
    echo "WARNING: Build will be larger and slower due to preserved function names"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    # Apply patches - profiling patch (20251214_170000_emscripten-profiling.patch)
    # is included in the patches directory and applied automatically
    apply_patches spreadsheets

    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR="$ROOT_DIR" \
        wasm-builder \
        bash -c "cp /build_scripts/config/autogen.input.spreadsheets-profile /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with profile suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-spreadsheets-profile.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-spreadsheets-profile.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-spreadsheets-profile.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-spreadsheets-profile.data.js.metadata" 2>/dev/null || true
        echo "Spreadsheets Profile artifacts copied to $PACKAGES_DIR/"
        ls -lh "$PACKAGES_DIR/soffice-spreadsheets-profile."*

        echo ""
        echo "=== Profiling Build Complete ==="
        echo "To use:"
        echo "  1. Deploy: ./engine/build/orchestrator.sh deploy-module spreadsheets-profile"
        echo "  2. Run profiler: node tests/profile_xlsx_devtools.js"
        echo "  3. Or use Chrome DevTools Performance tab directly"
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build XLS Debug module (for debugging XLS BIFF import issues)
build_xls_debug() {
    echo "--- Building XLS Debug Module ---"
    echo "Configuration: autogen.input.spreadsheets-xls (with --enable-debug --enable-sal-log)"
    echo "Purpose: Debug XLS/BIFF import issues with verbose logging"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches spreadsheets
    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR="$ROOT_DIR" \
        wasm-builder \
        bash -c "cp /build_scripts/config/autogen.input.spreadsheets-xls /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with xls-debug suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-xls-debug.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-xls-debug.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-xls-debug.data"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-xls-debug.data.js.metadata"
        echo "XLS Debug artifacts copied to $PACKAGES_DIR/"
        ls -lh "$PACKAGES_DIR/soffice-xls-debug."*
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Build Universal module (all formats - DOCX, XLSX, ODT, ODS, etc.)
# This build includes all LOK components needed for document loading
build_universal() {
    echo "--- Building Universal Module ---"
    echo "Configuration: autogen.input.universal (no --with-main-module)"
    echo "Purpose: Universal document conversion for all formats"

    # Clean libreoffice directory
    echo "Cleaning libreoffice directory..."
    (cd "$INTERNAL_SOURCE_DIR" && rm -rf instdir workdir/Rdb && git reset --hard && git clean -fd) || { echo "Error: Failed to clean libreoffice directory."; exit 1; }

    apply_patches
    build_wasm_builder_image

    local USER_ID=$(stat -c '%u' "$INTERNAL_SOURCE_DIR")
    local GROUP_ID=$(stat -c '%g' "$INTERNAL_SOURCE_DIR")

    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    mkdir -p "$PACKAGES_DIR"

    run_docker_build --rm \
        -v "$HOST_SOURCE_DIR:/build/core" \
        -v "$HOST_CCACHE_DIR:/cache/ccache" \
        -v "$HOST_BUILD_DIR:/build_scripts" \
        -v "$HOST_SRC_DIR:/src" \
        -v "$HOST_WEB_DIR:/web" \
        -v "$HOST_TOOLS_DIR:/tools" \
        -v "$HOST_MODULES_DIR:/modules" \
        --user "$USER_ID:$GROUP_ID" \
        -e HOME=/tmp \
        -e ROOT_DIR=\"$ROOT_DIR\" \
        wasm-builder \
        bash -c "cp /modules/universal/autogen.input /build/core/autogen.input && /build_scripts/build.sh"

    # Copy artifacts with universal suffix
    if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" ]; then
        # Run comprehensive validation BEFORE copying
        validate_build "universal"
        VALIDATION_RESULT=$?

        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.wasm" "$PACKAGES_DIR/soffice-universal.wasm"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.js" "$PACKAGES_DIR/soffice-universal.js"
        cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data" "$PACKAGES_DIR/soffice-universal.data"
        if [ -f "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" ]; then
            cp "$INTERNAL_SOURCE_DIR/instdir/program/soffice.data.js.metadata" "$PACKAGES_DIR/soffice-universal.data.js.metadata"
        fi
        echo "Universal artifacts copied to $PACKAGES_DIR/"
        ls -lh "$PACKAGES_DIR/soffice-universal."*

        if [ $VALIDATION_RESULT -ne 0 ]; then
            echo "ERROR: Universal build validation failed! Artifacts may not work correctly."
            exit 1
        fi
    else
        echo "Warning: soffice.wasm not found after build"
    fi
}

# Deploy a module to the web modules directory
# Usage: deploy_module <module_name>
# Example: deploy_module writer
deploy_module() {
    local MODULE_NAME="$1"
    local PACKAGES_DIR="$ROOT_DIR/finished_packages"
    local WEB_MODULES_DIR="$ROOT_DIR/libreoffice/instdir/program/modules"
    local TARGET_DIR="$WEB_MODULES_DIR/$MODULE_NAME"
    # Fallback support files below are read from INTERNAL_SOURCE_DIR (not the
    # hardcoded root libreoffice/ tree) so that --parallel builds, which build
    # each module in its own worktree via LIBREOFFICE_DIR, deploy the fallback
    # files that actually match this module instead of stale/wrong-module
    # artifacts left behind in the root tree.
    local INSTDIR="$INTERNAL_SOURCE_DIR/instdir/program"

    if [ -z "$MODULE_NAME" ]; then
        echo "Error: Module name required. Usage: deploy_module <module_name>"
        exit 1
    fi

    echo "--- Deploying $MODULE_NAME module ---"

    # Check if artifacts exist
    if [ ! -f "$PACKAGES_DIR/soffice-${MODULE_NAME}.wasm" ]; then
        echo "Error: No artifacts found for $MODULE_NAME. Run build-$MODULE_NAME first."
        echo "Expected: $PACKAGES_DIR/soffice-${MODULE_NAME}.wasm"
        exit 1
    fi

    # Create target directory
    mkdir -p "$TARGET_DIR"

    # Copy WASM artifacts
    echo "Copying WASM artifacts to $TARGET_DIR/"
    cp "$PACKAGES_DIR/soffice-${MODULE_NAME}.wasm" "$TARGET_DIR/soffice.wasm"
    cp "$PACKAGES_DIR/soffice-${MODULE_NAME}.js" "$TARGET_DIR/soffice.js"
    cp "$PACKAGES_DIR/soffice-${MODULE_NAME}.data" "$TARGET_DIR/soffice.data"

    # Copy supporting files - prefer packaged metadata (may have been patched)
    if [ -f "$PACKAGES_DIR/soffice-${MODULE_NAME}.data.js.metadata" ]; then
        cp "$PACKAGES_DIR/soffice-${MODULE_NAME}.data.js.metadata" "$TARGET_DIR/soffice.data.js.metadata"
    elif [ -f "$INSTDIR/soffice.data.js.metadata" ]; then
        cp "$INSTDIR/soffice.data.js.metadata" "$TARGET_DIR/"
    fi
    if [ -f "$INSTDIR/soffice.worker.js" ]; then
        cp "$INSTDIR/soffice.worker.js" "$TARGET_DIR/"
    fi

    # Copy conversion_worker.js from js/ directory
    if [ -f "$INSTDIR/js/conversion_worker.js" ]; then
        cp "$INSTDIR/js/conversion_worker.js" "$TARGET_DIR/"
    elif [ -f "$ROOT_DIR/web/js/conversion_worker.js" ]; then
        cp "$ROOT_DIR/web/js/conversion_worker.js" "$TARGET_DIR/"
    fi

    echo "Deployment complete. Module $MODULE_NAME deployed to $TARGET_DIR/"
    ls -lh "$TARGET_DIR/"
}


# --- Main command dispatcher ---

case "$1" in
    build-wasm)
        build_libreoffice_wasm
        ;;
    generate-golden-masters)
        run_golden_master_generation
        ;;
    run-wasm-test)
        run_wasm_test
        ;;
    run-visual-comparison)
        shift # remove 'run-visual-comparison'
        run_visual_comparison "$@"
        ;;
    build-all-modules)
        build_all_modules
        ;;
    build-spreadsheets-lite)
        build_spreadsheets_lite
        ;;
    build-spreadsheets-full)
        build_spreadsheets_full
        ;;
    build-dual-spreadsheets)
        build_dual_spreadsheets
        ;;
    build-documents)
        build_documents
        ;;
    build-spreadsheets)
        build_spreadsheets
        ;;
    build-presentations)
        build_presentations
        ;;
    build-csv)
        build_csv
        ;;
    build-pdf-docx)
        build_pdf_docx
        ;;
    build-pdf-xlsx)
        build_pdf_xlsx
        ;;
    build-pdf-pptx)
        build_pdf_pptx
        ;;
    build-xls-debug)
        build_xls_debug
        ;;
    build-spreadsheets-profile)
        build_spreadsheets_profile
        ;;
    build-spreadsheets-charts)
        build_spreadsheets_charts
        ;;
    build-universal)
        build_universal
        ;;
    deploy-module)
        shift # remove 'deploy-module'
        deploy_module "$@"
        ;;
    validate)
        # Standalone validation command
        shift # remove 'validate'
        MODULE_TYPE="${1:-documents}"
        validate_build "$MODULE_TYPE"
        ;;
    *)
        echo "Usage: $0 {command}"
        echo ""
        echo "Commands:"
        echo "  build-wasm              Build LibreOffice WASM (uses autogen.input)"
        echo "  build-documents         Build Documents module (DOCX, DOC, RTF, ODT, TXT, HTML)"
        echo "  build-spreadsheets      Build Spreadsheets module (XLSX, XLS, ODS)"
        echo "  build-presentations     Build Presentations module (PPTX, PPT, ODP)"
        echo "  build-csv               Build CSV module (includes text filter support)"
        echo "  build-pdf-docx          Build PDF-DOCX module (PDF to Word conversion)"
        echo "  build-pdf-xlsx          Build PDF-XLSX module (PDF to Excel conversion)"
        echo "  build-pdf-pptx          Build PDF-PPTX module (PDF to PowerPoint conversion)"
        echo "  build-spreadsheets-profile  Build Spreadsheets with profiling (for performance analysis)"
        echo "  build-spreadsheets-charts   Build Spreadsheets with Cairo (EXPERIMENTAL - charts/drawings)"
        echo "  build-universal         Build Universal module (all formats - fixes Documents LOK issue)"
        echo "  build-spreadsheets-lite     Build Spreadsheets Lite module for simple XLSX"
        echo "  build-spreadsheets-full     Build Spreadsheets Full module for complex XLSX"
        echo "  build-dual-spreadsheets     Build both Spreadsheets modules"
        echo "  build-all-modules       Build all modules (main + side modules)"
        echo "  deploy-module <name>    Deploy module to /modules/<name>/"
        echo "  validate [type]         Run post-build validation (documents|spreadsheets|universal)"
        echo "  generate-golden-masters Generate golden master PDFs"
        echo "  run-wasm-test           Run WASM tests"
        echo "  run-visual-comparison   Compare PDFs visually"
        exit 1
        ;;
esac