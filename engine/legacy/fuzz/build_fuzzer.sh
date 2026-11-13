#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Franklin Softworks LLC
# Part of the Franklin Softworks document conversion engine. Licensed under the
# GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
# Franklin Softworks LLC may also license this file under separate terms.

# Native libFuzzer build of the legacy bridge (FF-6 option C): the SAME patched library sources as the module (sources.sh) plus legacy_core.cpp, with
# ASan + UBSan, NDEBUG (what ships). Builds two binaries: bridge_fuzzer, and bridge_fuzzer_plant (a planted crash on an 8-byte marker: the sabotage control).
#   engine/legacy/fuzz/build_fuzzer.sh [--out DIR] [--lo-tree DIR]        exit 77 when clang with libFuzzer or the sources are absent
# Caveat: the libraries' config.h files were generated for the WebAssembly build (LibreOffice's), not for this host; they hold feature macros, not word sizes
# the parsers depend on. A finding here is checked against the module before it is believed.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; LEG="$(cd "$HERE/.." && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
LO="${LO_TREE:-$REPO/libreoffice}"; OUT="${LEGACY_FUZZ_OUT:-$REPO/.pipeline_state/legacy-fuzz}"
while [ $# -gt 0 ]; do case "$1" in --out) OUT="$2"; shift 2;; --lo-tree) LO="$2"; shift 2;; *) echo "unknown argument $1" >&2; exit 2;; esac; done
absent() { echo "legacy fuzz build: $*" >&2; exit 77; }
CXX=""; for c in "${CLANGXX:-}" "$HOME/tools/llvm/bin/clang++" clang++ clang++-20 clang++-19 clang++-18 clang++-17 clang++-16 clang++-15; do [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && { CXX="$c"; break; }; done
[ -n "$CXX" ] || absent "no clang++"
CC="${CXX%++}"; command -v "$CC" >/dev/null 2>&1 || CC="$CXX"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
printf 'extern "C" int LLVMFuzzerTestOneInput(const unsigned char*, unsigned long){return 0;}\n' > "$T/p.cpp"
"$CXX" -fsanitize=fuzzer,address,undefined "$T/p.cpp" -o "$T/p" 2>/dev/null && "$T/p" -runs=1 >/dev/null 2>&1 || absent "$CXX cannot build and run a libFuzzer + ASan + UBSan binary here"
U="$LO/workdir/UnpackedTarball"; [ -d "$U/libwps" ] || absent "no $U (build any module first)"
command -v git >/dev/null && command -v tar >/dev/null || absent "needs git and tar"
. "$LEG/sources.sh"
WORK="$T/work"; legacy_prepare_sources "$LO" "$WORK" || exit 2
S="$WORK/src"; rm -rf "$S/boost"; ln -s "$U/boost" "$S/boost"   # sources.sh left an empty mount point there
mkdir -p "$OUT/obj"; JOBS=$(nproc 2>/dev/null || echo 2); [ "$JOBS" -gt 4 ] && JOBS=4
SAN="-fsanitize=address,undefined,fuzzer-no-link -fno-sanitize-recover=undefined -fno-omit-frame-pointer"
FLAGS="-O1 -w -DHAVE_CONFIG_H -DNDEBUG $SAN"
export CXX CC S OUT FLAGS
comp() { local lib=$1; shift; printf '%s\n' "$@" | xargs -P "$JOBS" -I{} bash -c '
    f={}; o="$OUT/obj/'"$lib"'_$(basename "$f").o"
    case "$f" in *.c) cc="$CC"; std=;; *) cc="$CXX"; std=-std=c++17;; esac
    "$cc" $std $FLAGS -I"$S"/boost -I"$S"/zlib -I"$S"/libxml2/include -I"$S"/'"$lib"' -I"$S"/'"$lib"'/inc -I"$S"/librevenge/inc -I"$S"/librevenge/src/lib -I"$S"/'"$lib"'/src/lib -c "$f" -o "$o"'; }
rm -f "$OUT"/obj/*.o
comp librevenge "$S"/librevenge/src/lib/*.cpp
comp libodfgen "$S"/libodfgen/src/*.cxx
comp libxml2 $(ls "$S"/libxml2/*.c | grep -v -E '/(lintmain|runsuite|runtest|runxmlconf|shell|testModule|testapi|testchar|testdict|testdso|testlimits|testparser|testrecurse|xmllint|xmlcatalog)\.c$')
comp libwpd "$S"/libwpd/src/lib/*.cpp
comp libmwaw "$S"/libmwaw/src/lib/*.cxx
comp libwps "$S"/libwps/src/lib/*.cpp
for c in adler32 compress crc32 deflate gzclose gzlib gzread gzwrite infback inffast inflate inftrees trees uncompr zutil; do "$CC" -O1 -w -DNDEBUG -DZ_HAVE_UNISTD_H -I"$S/zlib" -c "$S/zlib/$c.c" -o "$OUT/obj/z_$c.o"; done
INC="-I$S/librevenge/inc -I$S/libodfgen/inc -I$S/libwpd/inc -I$S/libmwaw/inc -I$S/libwps/inc -I$S/libxml2/include -I$LEG"
"$CXX" -std=c++17 $FLAGS $INC -c "$LEG/legacy_core.cpp" -o "$OUT/legacy_core.o"
"$CXX" -std=c++17 $FLAGS $INC -fsanitize=fuzzer "$HERE/bridge_fuzzer.cpp" "$OUT/legacy_core.o" "$OUT"/obj/*.o -o "$OUT/bridge_fuzzer"
"$CXX" -std=c++17 $FLAGS $INC -DLEGACY_FUZZ_PLANT -fsanitize=fuzzer "$HERE/bridge_fuzzer.cpp" "$OUT/legacy_core.o" "$OUT"/obj/*.o -o "$OUT/bridge_fuzzer_plant"
echo "legacy fuzz build: done ($OUT/bridge_fuzzer, $OUT/bridge_fuzzer_plant) with $CXX"
