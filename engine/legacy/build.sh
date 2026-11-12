#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Franklin Softworks LLC
# Part of the Franklin Softworks document conversion engine. Licensed under the
# GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
# Franklin Softworks LLC may also license this file under separate terms.

# FF-6 option C: build the standalone legacy module (legacy.js + legacy.wasm) from the SAME library sources the LibreOffice modules compile.
#
#   engine/legacy/build.sh [--out DIR] [--lo-tree DIR] [--image NAME] [--require]
#
# Inputs (all pinned, all recorded in the manifest): the libraries' unpacked + LibreOffice-patched sources under <lo-tree>/workdir/UnpackedTarball
# (they exist once any module has been built; their tarballs are pinned by sha256 in download.lst), engine/patches/legacy/ (applied on top,
# --fuzz=0), bridge.cpp and build_inner.sh. The compile runs in the builder container with NO network.
# Output: DIR/legacy.js, DIR/legacy.wasm, DIR/legacy-build-manifest.json (default DIR: .pipeline_state/legacy). Reused when the inputs' key is unchanged.
# Exit: 0 built (or reused); 77 inputs or builder image absent (a SKIP, unless --require: then 2); 2 any other failure.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
LO="${LO_TREE:-$REPO/libreoffice}"; OUT="${LEGACY_OUT:-$REPO/.pipeline_state/legacy}"; IMAGE="${BUILDER_IMAGE:-wasm-builder}"; REQUIRE=0
while [ $# -gt 0 ]; do case "$1" in --out) OUT="$2"; shift 2;; --lo-tree) LO="$2"; shift 2;; --image) IMAGE="$2"; shift 2;; --require) REQUIRE=1; shift;; *) echo "unknown argument $1" >&2; exit 2;; esac; done
absent() { echo "legacy build: $*" >&2; [ "$REQUIRE" = 1 ] && exit 2; exit 77; }
U="$LO/workdir/UnpackedTarball"
LIBS="librevenge libodfgen libwpd libmwaw libwps libxml2 zlib"
for l in $LIBS boost; do [ -d "$U/$l" ] || absent "no $U/$l (build any module first: the libraries are unpacked and patched by LibreOffice's own build)"; done
command -v docker >/dev/null 2>&1 && docker image inspect "$IMAGE" >/dev/null 2>&1 || absent "no builder image '$IMAGE'"
command -v git >/dev/null && command -v python3 >/dev/null && command -v tar >/dev/null || absent "needs git, python3 and tar"

# ---- the inputs' key and manifest (tarball pins from download.lst; the patches; the bridge and the scripts)
KEY_FILE="$OUT/KEY"; mkdir -p "$OUT"
MANIFEST="$(python3 -I - "$LO" "$HERE" <<'PY'
import hashlib, json, os, re, sys
lo, here = sys.argv[1], sys.argv[2]
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
lst = open(os.path.join(lo, 'download.lst')).read()
pins = {'librevenge': 'REVENGE', 'libodfgen': 'ODFGEN', 'libwpd': 'WPD', 'libmwaw': 'MWAW', 'libwps': 'WPS', 'libxml2': 'LIBXML', 'zlib': 'ZLIB'}
libs = {}
for lib, key in pins.items():
    m = re.search(r'^%s_SHA256SUM\s*:=\s*(\S+)' % key, lst, re.M)
    libs[lib] = {'tarball_sha256': m.group(1) if m else None}
patches = {n: sha(os.path.join(here, '..', 'patches', 'legacy', n)) for n in sorted(os.listdir(os.path.join(here, '..', 'patches', 'legacy'))) if n.endswith('.patch')}
files = {n: sha(os.path.join(here, n)) for n in ('bridge.cpp', 'legacy_core.cpp', 'legacy_core.hpp', 'sources.sh', 'build.sh', 'build_inner.sh')}
print(json.dumps({'libraries': libs, 'patches': patches, 'files': files}, sort_keys=True))
PY
)"
KEY="$(printf '%s %s' "$MANIFEST" "$IMAGE" | sha256sum | cut -d' ' -f1)"
if [ -f "$OUT/legacy.wasm" ] && [ -f "$OUT/legacy.js" ] && [ "$(cat "$KEY_FILE" 2>/dev/null)" = "$KEY" ]; then echo "legacy build: inputs unchanged ($KEY), reusing $OUT"; exit 0; fi

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
