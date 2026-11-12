#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Franklin Softworks LLC
# Part of the Franklin Softworks document conversion engine. Licensed under the
# GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
# Franklin Softworks LLC may also license this file under separate terms.

# Runs INSIDE the builder container (wasm-builder, emscripten) with NO network: /src holds the patched library sources (read-only, see build.sh),
# /legacy this directory (read-only), /out the output. Compiles librevenge, libodfgen, libwpd, libmwaw, libwps, libxml2 and zlib plus bridge.cpp
# into /out/legacy.{js,wasm}: size-optimised (-Oz, LTO), native wasm exceptions, NDEBUG (the libraries' own release setting: their asserts are
# for developers, not for hostile input), no filesystem, memory growth to 512 MiB (the instance's own ceiling).
set -euo pipefail
U=/src; OBJ=/tmp/legacy-obj; OUT=/out; mkdir -p "$OBJ" "$OUT"
JOBS=$(nproc 2>/dev/null || echo 2); [ "$JOBS" -gt 4 ] && JOBS=4
em++ --version | head -1
OPT="-Oz -flto -fwasm-exceptions -w -DHAVE_CONFIG_H -DNDEBUG"
compile() { # compile <lib> <files...>
    local lib=$1; shift
    printf '%s\n' "$@" | xargs -P "$JOBS" -I{} bash -c '
        f={}; o='"$OBJ"'/'"$lib"'_$(basename "$f").o
        case "$f" in *.c) cc=emcc; std=;; *) cc=em++; std=-std=c++17;; esac
        $cc $std '"$OPT"' -I'"$U"'/boost -I'"$U"'/zlib -I'"$U"'/libxml2/include -I'"$U"'/'"$lib"' -I'"$U"'/'"$lib"'/inc \
            -I'"$U"'/librevenge/inc -I'"$U"'/librevenge/src/lib -I'"$U"'/'"$lib"'/src/lib -c "$f" -o "$o"'
}
compile librevenge $U/librevenge/src/lib/*.cpp
compile libodfgen $U/libodfgen/src/*.cxx
compile libxml2 $(ls $U/libxml2/*.c | grep -v -E '/(lintmain|runsuite|runtest|runxmlconf|shell|testModule|testapi|testchar|testdict|testdso|testlimits|testparser|testrecurse|xmllint|xmlcatalog)\.c$')
compile libwpd $U/libwpd/src/lib/*.cpp
compile libmwaw $U/libmwaw/src/lib/*.cxx
compile libwps $U/libwps/src/lib/*.cpp
for c in adler32 compress crc32 deflate gzclose gzlib gzread gzwrite infback inffast inflate inftrees trees uncompr zutil; do
    emcc -Oz -flto -w -DNDEBUG -I"$U/zlib" -DZ_HAVE_UNISTD_H -c "$U/zlib/$c.c" -o "$OBJ/z_$c.o"
done
em++ -std=c++17 $OPT -I"$U/libxml2/include" -I"$U/librevenge/inc" -I"$U/libodfgen/inc" -I"$U/libwpd/inc" -I"$U/libmwaw/inc" -I"$U/libwps/inc" \
    -c /legacy/bridge.cpp -o "$OBJ/bridge.o"
em++ -Oz -flto -fwasm-exceptions "$OBJ"/*.o \
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=512MB -sINITIAL_MEMORY=33554432 -sFILESYSTEM=0 -sMODULARIZE=1 -sEXPORT_NAME=LegacyModule \
    -sENVIRONMENT=web,worker,node -sSTACK_SIZE=1048576 \
    -sEXPORTED_FUNCTIONS=_legacy_convert,_legacy_output,_legacy_output_size,_legacy_family,_legacy_alloc,_legacy_free \
    -sEXPORTED_RUNTIME_METHODS=UTF8ToString -o "$OUT/legacy.js"
ls -l "$OUT/legacy.js" "$OUT/legacy.wasm" | awk '{print $5, $9}'
