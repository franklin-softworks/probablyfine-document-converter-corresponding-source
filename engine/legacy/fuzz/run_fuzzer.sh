#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Franklin Softworks LLC
# Part of the Franklin Softworks document conversion engine. Licensed under the
# GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
# Franklin Softworks LLC may also license this file under separate terms.

# Time-boxed libFuzzer run of the legacy bridge.   run_fuzzer.sh --binary B --seeds DIR --corpus DIR [--time SECONDS]
# Prints executions and the number of crash artifacts; exit 0 only for zero artifacts. Synthetic seeds only in CI (engine/legacy/fuzz/make_seeds.js);
# the owner's sample is run the same way, INSIDE the no-network sandbox only, never here.
set -uo pipefail
BIN=""; SEEDS=""; CORPUS=""; SECS=60
while [ $# -gt 0 ]; do case "$1" in --binary) BIN="$2"; shift 2;; --seeds) SEEDS="$2"; shift 2;; --corpus) CORPUS="$2"; shift 2;; --time) SECS="$2"; shift 2;; *) echo "unknown argument $1" >&2; exit 2;; esac; done
[ -x "$BIN" ] && [ -d "$SEEDS" ] && [ -n "$CORPUS" ] || { echo "usage: run_fuzzer.sh --binary B --seeds DIR --corpus DIR [--time S]" >&2; exit 2; }
mkdir -p "$CORPUS" "$CORPUS/../artifacts"; ART="$(cd "$CORPUS/../artifacts" && pwd)"; rm -f "$ART"/*
LOG="$CORPUS/../fuzz.log"
ASAN_OPTIONS=detect_leaks=0:abort_on_error=0 "$BIN" -max_total_time="$SECS" -rss_limit_mb=2048 -timeout=20 -max_len=65536 -print_final_stats=1 -artifact_prefix="$ART/" "$CORPUS" "$SEEDS" > "$LOG" 2>&1
rc=$?
execs="$(grep -o 'stat::number_of_executed_units: [0-9]*' "$LOG" | tail -1 | awk '{print $2}')"
arts="$(ls "$ART" 2>/dev/null | wc -l)"
echo "fuzz: rc=$rc executions=${execs:-0} artifacts=$arts"
[ "$arts" -eq 0 ] && [ "$rc" -eq 0 ]
