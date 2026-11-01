#!/usr/bin/env python3
# Copyright (c) 2025-2026 Franklin Softworks LLC
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import sys
import os
import json

def check_size_constraint(wasm_br_path: str, max_size_mb: int, autogen_input_config: str):
    print("--- Size Gate (Stub) ---")
    print(f"Checking size of {wasm_br_path} against {max_size_mb} MB limit...")

    if not os.path.exists(wasm_br_path):
        print(f"Error: Compressed Wasm file not found at {wasm_br_path}")
        return False, {"reason": "Wasm file not found", "suggestions": []}

    size_bytes = os.path.getsize(wasm_br_path)
    size_mb = size_bytes / (1024 * 1024)

    print(f"Actual size: {size_mb:.2f} MB")

    if size_mb > max_size_mb:
        overage = size_mb - max_size_mb
        print(f"Size exceeds limit by {overage:.2f} MB. Triggering optimization agent (stub).")
        
        # In a real scenario, this would call a Claude/Gemini API for optimization suggestions.
        # The prompt would typically include:
        # 1. The current autogen.input configuration (`autogen_input_config`)
        # 2. The target size (max_size_mb)
        # 3. The current size (size_mb)
        # 4. Potentially, an analysis of the Wasm binary's symbol table (nm --size-sort)
        #    to identify large components, which would require another tool integration.
        
        print("\n--- Calling Hypothetical Claude Optimization Agent ---")
        print(f"Current autogen.input:\n{autogen_input_config}")
        print(f"Current size: {size_mb:.2f} MB, Target: {max_size_mb} MB")
        print("Agent would analyze and suggest new autogen.input flags...")
        print("--- End Hypothetical Claude Optimization Agent ---")

        suggestions = [
            f"Stub: Binary is {overage:.2f} MB over limit. The Claude Optimization Agent would suggest flags like --disable-pdfium, --disable-skia, or specific --without-module flags based on Wasm symbol analysis to reduce size."
        ]
        return False, {"reason": f"Size exceeded {max_size_mb} MB", "suggestions": suggestions}
    else:
        print("Size constraint met.")
        return True, {"reason": "Size OK", "suggestions": []}
    
    print("--- End Size Gate (Stub) ---")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 size_gate.py <path_to_wasm.br> <max_size_mb> [autogen_input_config_path]")
        sys.exit(1)

    wasm_br_file = sys.argv[1]
    max_mb = int(sys.argv[2])
    autogen_input_path = sys.argv[3] if len(sys.argv) > 3 else None

    autogen_config_content = ""
    if autogen_input_path and os.path.exists(autogen_input_path):
        with open(autogen_input_path, 'r') as f:
            autogen_config_content = f.read()

    passed, result = check_size_constraint(wasm_br_file, max_mb, autogen_config_content)
    
    # Output JSON for pipeline to consume
    print(json.dumps({"passed": passed, "details": result}, indent=2))
    
    if not passed:
        sys.exit(1)