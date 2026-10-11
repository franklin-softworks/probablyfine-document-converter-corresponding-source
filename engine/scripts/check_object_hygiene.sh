#!/bin/bash
# Copyright (c) 2025-2026 Franklin Softworks LLC
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Detect object files built with a sanitizer that no current configuration asks for.
#
# WHY THIS EXISTS
# ---------------
# All five WASM modules are built from ONE shared LibreOffice tree, and
# libreoffice/workdir is deliberately NOT cleaned between builds (see
# engine/build/build.sh: "workdir has compiled objects, skipping clean").
# make's staleness test is timestamp-based, so an object compiled with flags no
# current config would produce is NEWER than its source and gets reused forever.
#
# On 2026-08-22 exactly ONE object out of 11,516 --
#   workdir/CxxObject/sdext/source/pdfimport/xpdfwrapper/pnghelper.o, dated
#   2026-08-14 -- had been built with -fsanitize=address. It sat there for EIGHT
# DAYS and then broke the pdf-docx link with ~150 undefined __asan_* symbols. It
# waited that long because it lives in the poppler path, and pdf-docx is the only
# module configured --enable-poppler.
#
# The link error names symbols that appear NOWHERE in this repository's
# configuration, so it actively misleads whoever reads it. This check turns that
# into a named diagnosis, BEFORE a compile is spent.
#
# WHAT IT DOES NOT CATCH
# ----------------------
# Only sanitizer taint, which is self-identifying. It does NOT catch the general
# class of flag divergence -- -msimd128, exception model, -O level, or
# pdfium-vs-poppler object mixing leave no unique symbol to grep for. See
# docs/BUILD_HYGIENE_TRAP_PROPOSAL.md for the options that would.
#
# NOTE: engine/build/build.sh runs with `set -e` DISABLED, and callers here may
# too, so this script signals failure by an explicit exit code and its caller
# must check it. Do not rely on errexit.

set -uo pipefail

WORKDIR="${1:-}"
if [[ -z "$WORKDIR" ]]; then
    echo "usage: check_object_hygiene.sh <path-to-libreoffice-tree>" >&2
    exit 2
fi

# Nothing built yet is not a failure -- it is the clean case.
if [[ ! -d "$WORKDIR/workdir" ]]; then
    exit 0
fi

# Sanitizer runtimes are never linked into these builds, so ANY of these symbols
# in a compiled object means that object was built with a sanitizer enabled.
SANITIZER_SYMBOLS='__asan_report|__asan_stack_malloc|__ubsan_handle|__tsan_read|__tsan_write|__sanitizer_annotate'

tainted=$(find "$WORKDIR/workdir" "$WORKDIR/instdir" \
              \( -name '*.o' -o -name '*.a' \) -print0 2>/dev/null \
          | xargs -0 grep -lE "$SANITIZER_SYMBOLS" 2>/dev/null)

if [[ -z "$tainted" ]]; then
    exit 0
fi

count=$(printf '%s\n' "$tainted" | wc -l)
echo "" >&2
echo "ERROR: $count object/archive file(s) were built with a SANITIZER enabled," >&2
echo "       but no current configuration requests one. They are stale." >&2
echo "" >&2
printf '%s\n' "$tainted" | sed 's/^/       /' >&2
echo "" >&2
echo "       Left in place these link with ~150 undefined __asan_* symbols, in a" >&2
echo "       module that may not be the one that created them, naming symbols that" >&2
echo "       appear nowhere in this repository's configuration." >&2
echo "" >&2
echo "       Remove them and let the build regenerate:" >&2
printf '%s\n' "$tainted" | sed 's/^/         rm -f /' >&2
echo "" >&2
echo "       An archive (.a) listed above will relink; an object will recompile." >&2
echo "       A full 'rm -rf workdir' is NOT required -- in the 2026-08-22 incident" >&2
echo "       exactly 1 file of 11,516 was affected." >&2
echo "" >&2
exit 1
