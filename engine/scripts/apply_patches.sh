#!/bin/bash
# Copyright (c) 2025-2026 Franklin Softworks LLC
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -e

# This script applies all patches in the engine/patches/ directory to the libreoffice/ repo.
# It is intended to be run by the build orchestrator or manually after a fresh clone.
#
# Usage: apply_patches.sh [MODULE]
#   MODULE: "documents", "spreadsheets", "presentations", or empty for all patches
#   When MODULE is specified, patches ending in -documents.patch, -spreadsheets.patch,
#   or -presentations.patch for OTHER modules are skipped.

# Get the script directory and derive workspace root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"   # engine/scripts -> repo root

# Source shared libraries for patch filtering
source "$WORKSPACE_ROOT/pipeline/lib/common.sh"
source "$WORKSPACE_ROOT/pipeline/lib/module_registry.sh"
source "$WORKSPACE_ROOT/pipeline/lib/fingerprint.sh"

# Use absolute paths
REPO_DIR="$WORKSPACE_ROOT/libreoffice"
PATCHES_DIR="$WORKSPACE_ROOT/engine/patches"
MODULE="${1:-}"  # Optional module parameter

if [ ! -d "$REPO_DIR" ]; then
    echo "Error: '$REPO_DIR' directory not found."
    exit 1
fi

if [ ! -d "$PATCHES_DIR" ]; then
    echo "Warning: '$PATCHES_DIR' directory not found. No patches to apply."
    exit 0
fi

echo "Applying patches from '$PATCHES_DIR' to '$REPO_DIR'..."

# Get filtered patch list using shared function (single source of truth)
if [ -n "$MODULE" ]; then
    PATCH_FILES=$(_get_module_patches "$MODULE")
else
    PATCH_FILES=$(ls "$PATCHES_DIR"/*.patch 2>/dev/null | sort)
fi

if [ -z "$PATCH_FILES" ]; then
    echo "No .patch files found for ${MODULE:-all modules}."
    exit 0
fi

cd "$REPO_DIR"

for patch in $PATCH_FILES; do
    ABS_PATCH_PATH="$patch"

    echo "Applying $patch..."

    # Use git apply.
    # --check first to see if it will apply cleanly
    if git apply --check "$ABS_PATCH_PATH"; then
        git apply "$ABS_PATCH_PATH"
        echo "✅ Applied $patch"
    else
        echo "❌ Failed to apply $patch"
        echo "Run 'git apply --reject $ABS_PATCH_PATH' manually to inspect conflicts."
        exit 1
    fi
done

echo "All patches applied successfully."
