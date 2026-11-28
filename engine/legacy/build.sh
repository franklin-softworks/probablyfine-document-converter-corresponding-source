#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Franklin Softworks LLC
# Part of the Franklin Softworks document conversion engine. Licensed under the
# GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
# Franklin Softworks LLC may also license this file under separate terms.

# FF-6 option C: build the standalone legacy module (legacy.js + legacy.wasm) from the SAME library sources the LibreOffice modules compile.
#
#   engine/legacy/build.sh [--out DIR] [--lo-tree DIR] [--image NAME] [--require] [--key-only]
#
# --key-only prints the inputs' KEY and exits 0 (CI module reuse, infra/runner/hydrate_modules.sh): it needs only <lo-tree>/download.lst
# and this repository, not the unpacked library sources or the builder image, so it works before any LibreOffice module is built.
#
# Inputs (all pinned, all recorded in the manifest): the libraries' unpacked + LibreOffice-patched sources under <lo-tree>/workdir/UnpackedTarball
# (they exist once any module has been built; their tarballs are pinned by sha256 in download.lst), engine/patches/legacy/ (applied on top,
# --fuzz=0), bridge.cpp and build_inner.sh. The compile runs in the builder container with NO network.
# Output: DIR/legacy.js, DIR/legacy.wasm, DIR/legacy-build-manifest.json (default DIR: .pipeline_state/legacy). Reused when the inputs' key is unchanged.
# Exit: 0 built (or reused); 77 inputs or builder image absent (a SKIP, unless --require: then 2); 2 any other failure.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
LO="${LO_TREE:-$REPO/libreoffice}"; OUT="${LEGACY_OUT:-$REPO/.pipeline_state/legacy}"; IMAGE="${BUILDER_IMAGE:-wasm-builder}"; REQUIRE=0; KEY_ONLY=0
while [ $# -gt 0 ]; do case "$1" in --out) OUT="$2"; shift 2;; --lo-tree) LO="$2"; shift 2;; --image) IMAGE="$2"; shift 2;; --require) REQUIRE=1; shift;; --key-only) KEY_ONLY=1; shift;; *) echo "unknown argument $1" >&2; exit 2;; esac; done
absent() { echo "legacy build: $*" >&2; [ "$REQUIRE" = 1 ] && exit 2; exit 77; }
U="$LO/workdir/UnpackedTarball"
LIBS="librevenge libodfgen libwpd libmwaw libwps libxml2 zlib"
command -v python3 >/dev/null || absent "needs python3"
[ -f "$LO/download.lst" ] || absent "no $LO/download.lst"

# ---- the builder, named by DIGEST, not by the local tag (FIX1 gap 1: the tag `wasm-builder` names whatever image was tagged last).
# The pinned digest from infra/runner/builder-image.lock.json when the local image carries it OR is not present yet (--key-only, or a run where
# every LibreOffice module was reused and nothing pulled the image: the build below then refuses if the image is absent). Any other local image
# is named by its own id, so its KEY can never equal one built with the pinned toolchain.
LOCK="$REPO/infra/runner/builder-image.lock.json"; LOCK_DIGEST=""
[ -f "$LOCK" ] && LOCK_DIGEST="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("digest",""))' "$LOCK" 2>/dev/null || true)"
IMG_ID=""; IMG_DIGESTS=""
if command -v docker >/dev/null 2>&1 && docker image inspect "$IMAGE" >/dev/null 2>&1; then
    IMG_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
    IMG_DIGESTS="$(docker image inspect "$IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}')"
fi
if [ -n "$LOCK_DIGEST" ] && { [ -z "$IMG_ID" ] || grep -qF "@$LOCK_DIGEST" <<<"$IMG_DIGESTS"; }; then BUILDER="pinned:$LOCK_DIGEST"
elif [ -n "$IMG_ID" ]; then BUILDER="local:$IMG_ID"
else BUILDER="absent"; fi

# ---- the inputs' key and manifest (tarball pins from download.lst; the patches; the bridge and the scripts)
KEY_FILE="$OUT/KEY"; mkdir -p "$OUT"
MANIFEST="$(python3 -I - "$LO" "$HERE" "$BUILDER" <<'PY'
import hashlib, json, os, re, sys
lo, here, builder = sys.argv[1], sys.argv[2], sys.argv[3]
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
lst = open(os.path.join(lo, 'download.lst')).read()
pins = {'librevenge': 'REVENGE', 'libodfgen': 'ODFGEN', 'libwpd': 'WPD', 'libmwaw': 'MWAW', 'libwps': 'WPS', 'libxml2': 'LIBXML', 'zlib': 'ZLIB',
        'boost': 'BOOST'}  # FIX1 gap 3: boost is mounted into the build (headers), so its tarball pin is an input too
libs = {}
for lib, key in pins.items():
    m = re.search(r'^%s_SHA256SUM\s*:=\s*(\S+)' % key, lst, re.M)
    libs[lib] = {'tarball_sha256': m.group(1) if m else None}
patches = {n: sha(os.path.join(here, '..', 'patches', 'legacy', n)) for n in sorted(os.listdir(os.path.join(here, '..', 'patches', 'legacy'))) if n.endswith('.patch')}
# Every file under engine/legacy/ except fuzz/ (module agent, #848: a named list misses a new source file, and a miss would ship a stale
# legacy module on a reused build). Symlinks are hashed by their target text, never followed.
files = {}
for d, dirs, fs in os.walk(here):
    rel_d = os.path.relpath(d, here)
    dirs[:] = sorted(x for x in dirs if not (rel_d == '.' and x == 'fuzz'))
    for f in sorted(fs):
        p = os.path.join(d, f); r = os.path.normpath(os.path.join(rel_d, f))
        files[r] = ('symlink:' + os.readlink(p)) if os.path.islink(p) else sha(p)
# FIX1 gap 2: the routed LibreOffice patches that change these libraries' sources in the LO tree (the libraries are copied from the PATCHED
# tree), found by what they touch, not by name, so a new one is an input without editing this list; and the upstream pin they apply to.
root = os.path.join(here, '..', '..')
touch = re.compile(r'^\+\+\+ b/external/(librevenge|libodfgen|libwpd|libmwaw|libwps|libxml2|zlib|boost)/', re.M)
pdir = os.path.join(root, 'engine', 'patches')
lo_patches = {n: sha(os.path.join(pdir, n)) for n in sorted(os.listdir(pdir))
              if n.endswith('.patch') and touch.search(open(os.path.join(pdir, n), encoding='utf-8', errors='replace').read())}
upstream = sha(os.path.join(root, 'engine', 'upstream.json'))
print(json.dumps({'libraries': libs, 'patches': patches, 'files': files, 'lo_patches': lo_patches,
                  'upstream_json': upstream, 'builder': builder}, sort_keys=True))
PY
)"
KEY="$(printf '%s' "$MANIFEST" | sha256sum | cut -d' ' -f1)"
if [ "$KEY_ONLY" = 1 ]; then echo "$KEY"; exit 0; fi
if [ -f "$OUT/legacy.wasm" ] && [ -f "$OUT/legacy.js" ] && [ "$(cat "$KEY_FILE" 2>/dev/null)" = "$KEY" ]; then echo "legacy build: inputs unchanged ($KEY), reusing $OUT"; exit 0; fi

# ---- building: now the unpacked sources and the image must be here
for l in $LIBS boost; do [ -d "$U/$l" ] || absent "no $U/$l (build any module first: the libraries are unpacked and patched by LibreOffice's own build)"; done
[ -n "$IMG_ID" ] || absent "no builder image '$IMAGE'"
command -v git >/dev/null && command -v tar >/dev/null || absent "needs git and tar"

# ---- a private copy of the library sources (never the LibreOffice tree itself), patched
# shellcheck source=sources.sh
. "$HERE/sources.sh"
mkdir -p "$REPO/.pipeline_state"; WORK="$(mktemp -d "$REPO/.pipeline_state/legacy-src.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
legacy_prepare_sources "$LO" "$WORK" || exit 2
rm -f "$OUT/legacy.js" "$OUT/legacy.wasm"
docker run --rm --network none -v "$WORK/src:/src:ro" -v "$U/boost:/src/boost:ro" -v "$HERE:/legacy:ro" -v "$OUT:/out" "$IMAGE" bash /legacy/build_inner.sh \
    || { echo "legacy build: the container build failed" >&2; exit 2; }
[ -f "$OUT/legacy.wasm" ] && [ -f "$OUT/legacy.js" ] || { echo "legacy build: no output" >&2; exit 2; }
python3 -I - "$OUT" "$MANIFEST" "$KEY" <<'PY'
import hashlib, json, sys
out, manifest, key = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
sha = lambda p: hashlib.sha256(open(out + '/' + p, 'rb').read()).hexdigest()
manifest['outputs'] = {'legacy.wasm': sha('legacy.wasm'), 'legacy.js': sha('legacy.js')}
manifest['inputs_key'] = key
open(out + '/legacy-build-manifest.json', 'w').write(json.dumps(manifest, indent=1, sort_keys=True) + '\n')
PY
echo "$KEY" > "$KEY_FILE"
echo "legacy build: done ($OUT)"
