#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Franklin Softworks LLC
# Part of the Franklin Softworks document conversion engine. Licensed under the
# GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
# Franklin Softworks LLC may also license this file under separate terms.

# Time-boxed libFuzzer run of the legacy bridge.   run_fuzzer.sh --binary B --seeds DIR --corpus DIR [--time SECONDS] [--keep DIR]
# Prints executions and the number of crash artifacts; exit 0 only for zero artifacts. With --keep, a failed run copies what reproduces it into
# DIR/<UTC time>-<pid>/: the crash artifacts, fuzz.log, and binary.sha256 (the fuzz binary's sha256 and path), so the next hit can be re-run
# against the same binary (`<binary> <artifact>`); the newest 10 such folders are kept. Synthetic seeds only in CI (engine/legacy/fuzz/make_seeds.js);
# the owner's sample is run the same way, INSIDE the no-network sandbox only, never here.
set -uo pipefail
BIN=""; SEEDS=""; CORPUS=""; SECS=60; KEEP=""
while [ $# -gt 0 ]; do case "$1" in --binary) BIN="$2"; shift 2;; --seeds) SEEDS="$2"; shift 2;; --corpus) CORPUS="$2"; shift 2;; --time) SECS="$2"; shift 2;; --keep) KEEP="$2"; shift 2;; *) echo "unknown argument $1" >&2; exit 2;; esac; done
[ -x "$BIN" ] && [ -d "$SEEDS" ] && [ -n "$CORPUS" ] || { echo "usage: run_fuzzer.sh --binary B --seeds DIR --corpus DIR [--time S] [--keep DIR]" >&2; exit 2; }
mkdir -p "$CORPUS" "$CORPUS/../artifacts"; ART="$(cd "$CORPUS/../artifacts" && pwd)"; rm -f "$ART"/*
LOG="$CORPUS/../fuzz.log"
ASAN_OPTIONS=detect_leaks=0:abort_on_error=0 "$BIN" -max_total_time="$SECS" -rss_limit_mb=2048 -timeout=20 -max_len=65536 -print_final_stats=1 -artifact_prefix="$ART/" "$CORPUS" "$SEEDS" > "$LOG" 2>&1
rc=$?
execs="$(grep -o 'stat::number_of_executed_units: [0-9]*' "$LOG" | tail -1 | awk '{print $2}')"
arts="$(ls "$ART" 2>/dev/null | wc -l)"
if [ -n "$KEEP" ] && { [ "$arts" -ne 0 ] || [ "$rc" -ne 0 ]; }; then
    K="$KEEP/$(date -u +%Y%m%dT%H%M%SZ)-$$"; mkdir -p "$K"
    cp -p "$ART"/* "$K/" 2>/dev/null || true; cp -p "$LOG" "$K/fuzz.log"
    sha256sum "$BIN" > "$K/binary.sha256"
    ls -1dt "$KEEP"/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf --
    echo "fuzz: kept the failing run in $K ($arts artifact(s), fuzz.log, binary.sha256)" >&2
fi
echo "fuzz: rc=$rc executions=${execs:-0} artifacts=$arts"
[ "$arts" -eq 0 ] && [ "$rc" -eq 0 ]
