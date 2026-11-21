#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Franklin Softworks LLC
# Part of the Franklin Softworks document conversion engine. Licensed under the
# GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
# Franklin Softworks LLC may also license this file under separate terms.

# Sourced by build.sh and fuzz/build_fuzzer.sh: ONE way to get the patched library sources, so the module and the fuzz target are built from the same bytes.
#   legacy_prepare_sources <lo-tree> <work-dir>   copies the libraries' unpacked, LibreOffice-patched sources (no objects) into <work-dir>/src and applies
#                                                 engine/patches/legacy/*.patch (exact, no fuzz); <work-dir>/src/boost is left as an empty mount point.
LEGACY_LIBS="librevenge libodfgen libwpd libmwaw libwps libxml2 zlib"
legacy_prepare_sources() {
    local lo="$1" work="$2" u="$1/workdir/UnpackedTarball" here l p lib
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    mkdir -p "$work/src"
    for l in $LEGACY_LIBS; do tar -C "$u" --exclude='*.o' --exclude='*.lo' --exclude='.libs' --exclude='.deps' --exclude='*.a' --exclude='*.la' --exclude="$l/test*" -cf - "$l" | tar -C "$work/src" -xf -; done
    for p in "$here"/../patches/legacy/*.patch; do
        lib="$(basename "$p")"; lib="${lib%%-*}"
        [ -d "$work/src/$lib" ] || { echo "legacy: patch $(basename "$p") names no library ($lib)" >&2; return 2; }
        # git apply is exact (no fuzz) and needs no repository; the text before the first diff header is ignored
        git -C "$work/src/$lib" apply -p1 --unsafe-paths "$p" || { echo "legacy: $(basename "$p") does not apply to $lib" >&2; return 2; }
    done
    mkdir -p "$work/src/boost"
}
