#!/bin/bash
# Detect that a module's BUILD CONFIGURATION changed since that module last
# compiled into the shared workdir.
#
# WHY
# ---
# All five WASM modules compile into ONE shared libreoffice/workdir, and it is
# deliberately never cleaned (engine/build/build.sh: "workdir has compiled
# objects, skipping clean"). make's staleness test is mtime-based, so it cannot
# see that an object was produced by a DIFFERENT configuration than the one now
# in effect. Such an object is newer than its source and is reused forever.
#
# 2026-08-22: one object of 11,516 -- pnghelper.o, built eight days earlier with
# -fsanitize=address -- broke the pdf-docx link with ~150 undefined __asan_*
# symbols naming flags that appear NOWHERE in this repo's configuration.
# engine/scripts/check_object_hygiene.sh now catches sanitizer taint specifically,
# because sanitizer taint is self-identifying. THIS script catches the general
# case: any configuration change at all.
#
# WHAT IS FINGERPRINTED
# ---------------------
# Everything that determines how this module compiles, resolved the same way
# engine/build/build.sh resolves it (build.sh:104-138):
#   * the module's autogen.input
#   * the CC and CXX command lines it yields (recorded verbatim, so a drift
#     message can name the change instead of just reporting "hash differs")
#   * distro-configs/LibreOfficeWASM32.conf, which configure also consumes and
#     which is itself patched (20251202_032355_disable-qt5.patch) -- so this must
#     run AFTER patches are applied, which is where the orchestrator calls it
#   * docker/Dockerfile.builder, as a proxy for the pinned toolchain
#     (FROM emscripten/emsdk:3.1.51) -- a toolchain bump changes object ABI
#
# SCOPE -- READ THIS BEFORE TRUSTING IT
# -------------------------------------
# Keyed PER MODULE, so it catches "this module's config changed since this
# module last built". It does NOT catch cross-module contamination: module A
# building with different flags still writes into the same shared workdir, and
# module B's fingerprint is unchanged, so B will not notice. Only partitioning
# workdir makes that impossible -- see docs/BUILD_HYGIENE_TRAP_PROPOSAL.md.
# That gap is narrow TODAY only because all five modules currently share
# byte-identical CC/CXX. If that ever stops being true, this check is no longer
# sufficient on its own.
#
# NOTE: engine/build/build.sh runs with `set -e` DISABLED and callers may too, so
# this signals via an explicit exit code. Callers MUST check it.

set -uo pipefail

MODULE="${1:-}"
TREE="${2:-}"
if [[ -z "$MODULE" || -z "$TREE" ]]; then
    echo "usage: check_build_config_drift.sh <module> <path-to-libreoffice-tree>" >&2
    exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AUTOGEN="$ROOT/engine/modules/$MODULE/autogen.input"

if [[ ! -f "$AUTOGEN" ]]; then
    echo "ERROR: no autogen.input for module '$MODULE' ($AUTOGEN)" >&2
    exit 2
fi

sha() { [[ -f "$1" ]] && sha256sum "$1" 2>/dev/null | cut -c1-16 || echo "absent"; }

# Resolve CC/CXX exactly as build.sh does, defaults included.
resolve() { # $1 = CC|CXX, $2 = default
    if grep -q "^$1=" "$AUTOGEN"; then
        grep "^$1=" "$AUTOGEN" | sed "s/^$1=//" | sed 's/^"//' | sed 's/"$//'
    else
        echo "$2"
    fi
}

CUR_CC=$(resolve CC emcc)
CUR_CXX=$(resolve CXX em++)
CUR_AUTOGEN=$(sha "$AUTOGEN")
CUR_CONF=$(sha "$TREE/distro-configs/LibreOfficeWASM32.conf")
CUR_DOCKER=$(sha "$ROOT/docker/Dockerfile.builder")

STATE_DIR="$TREE/workdir"
STATE="$STATE_DIR/.config_hash.$MODULE"

write_state() {
    mkdir -p "$STATE_DIR" 2>/dev/null || return 0
    {
        echo "# written by engine/scripts/check_build_config_drift.sh — do not edit"
        echo "autogen=$CUR_AUTOGEN"
        echo "cc=$CUR_CC"
        echo "cxx=$CUR_CXX"
        echo "distroconf=$CUR_CONF"
        echo "dockerfile=$CUR_DOCKER"
    } > "$STATE" 2>/dev/null || true
}

# No objects yet: nothing can be stale. Record and pass.
if [[ ! -d "$STATE_DIR" ]]; then
    write_state
    exit 0
fi

# First run after this check was introduced. The workdir predates tracking, so
# there is nothing to compare against. Say so plainly rather than implying the
# existing objects have been vouched for — they have not.
if [[ ! -f "$STATE" ]]; then
    echo "NOTE: no build-config fingerprint recorded for '$MODULE' yet — recording now."
    echo "      Objects already in workdir were NOT verified against it."
    write_state
    exit 0
fi

# shellcheck source=/dev/null
OLD_AUTOGEN=$(grep '^autogen=' "$STATE" 2>/dev/null | cut -d= -f2-)
OLD_CC=$(grep '^cc=' "$STATE" 2>/dev/null | cut -d= -f2-)
OLD_CXX=$(grep '^cxx=' "$STATE" 2>/dev/null | cut -d= -f2-)
OLD_CONF=$(grep '^distroconf=' "$STATE" 2>/dev/null | cut -d= -f2-)
OLD_DOCKER=$(grep '^dockerfile=' "$STATE" 2>/dev/null | cut -d= -f2-)

drift=""
[[ "$OLD_AUTOGEN" != "$CUR_AUTOGEN" ]] && drift="$drift\n       autogen.input   $OLD_AUTOGEN -> $CUR_AUTOGEN"
[[ "$OLD_CC"      != "$CUR_CC"      ]] && drift="$drift\n       CC              $OLD_CC\n                    -> $CUR_CC"
[[ "$OLD_CXX"     != "$CUR_CXX"     ]] && drift="$drift\n       CXX             $OLD_CXX\n                    -> $CUR_CXX"
[[ "$OLD_CONF"    != "$CUR_CONF"    ]] && drift="$drift\n       WASM32.conf     $OLD_CONF -> $CUR_CONF"
[[ "$OLD_DOCKER"  != "$CUR_DOCKER"  ]] && drift="$drift\n       Dockerfile      $OLD_DOCKER -> $CUR_DOCKER (TOOLCHAIN)"

if [[ -z "$drift" ]]; then
    exit 0
fi

if [[ "${ALLOW_BUILD_CONFIG_DRIFT:-0}" == "1" ]]; then
    echo "" >&2
    echo "WARNING: build configuration for '$MODULE' CHANGED, and" >&2
    echo "         ALLOW_BUILD_CONFIG_DRIFT=1 is set — proceeding anyway." >&2
    echo -e "$drift" >&2
    echo "" >&2
    echo "         Objects in workdir built under the OLD configuration will be" >&2
    echo "         reused. If the build fails strangely, this is the first thing" >&2
    echo "         to rule out." >&2
    echo "" >&2
    write_state
    exit 0
fi

echo "" >&2
echo "ERROR: the build configuration for module '$MODULE' has CHANGED since it" >&2
echo "       last compiled into this shared workdir:" >&2
echo -e "$drift" >&2
echo "" >&2
echo "       make cannot see this. Objects compiled under the OLD configuration" >&2
echo "       are newer than their sources, so they will be SILENTLY REUSED and" >&2
echo "       linked into this build." >&2
echo "" >&2
echo "       Because workdir is shared by all five modules, the affected objects" >&2
echo "       cannot be identified individually. Clear it:" >&2
echo "" >&2
echo "         rm -rf $TREE/workdir" >&2
echo "" >&2
echo "       That forces a cold rebuild. (This cost is exactly what partitioning" >&2
echo "       workdir per module would avoid — docs/BUILD_HYGIENE_TRAP_PROPOSAL.md.)" >&2
echo "" >&2
echo "       If you KNOW this change cannot invalidate existing objects, re-run" >&2
echo "       with ALLOW_BUILD_CONFIG_DRIFT=1 to proceed and re-record." >&2
echo "" >&2
exit 1
