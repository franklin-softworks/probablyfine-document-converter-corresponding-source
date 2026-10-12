#!/usr/bin/env python3
# Copyright (c) 2025-2026 Franklin Softworks LLC
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""
patch_services_for_module.py
Patches services.rdb in soffice.data to remove components for other modules.

For Calc builds: removes Writer components (libswlo.a, libswdlo.a, libwriterfilterlo.a)
For Writer builds: removes Calc components (libsclo.a, libscdlo.a, libscfiltlo.a)

Usage:
    python3 patch_services_for_module.py <module> <soffice.data> [--metadata <path>]

Examples:
    python3 patch_services_for_module.py calc /path/to/soffice.data
    python3 patch_services_for_module.py writer /path/to/soffice.data
"""

import argparse
import json
import os
import re
import sys

# Components to remove for each module
COMPONENTS_TO_REMOVE = {
    'calc': [
        'libswlo.a',           # Writer core
        'libswdlo.a',          # Writer Drawing
        'libwriterfilterlo.a', # Writer filter (DOCX import)
        'libmswordlo.a',       # MS Word import
    ],
    'writer': [
        'libsclo.a',           # Calc core
        'libscdlo.a',          # Calc Drawing
        'libscfiltlo.a',       # Calc filters (XLSX import)
    ],
    'impress': [
        'libswlo.a',           # Writer core
        'libswdlo.a',          # Writer Drawing
        'libwriterfilterlo.a', # Writer filter (DOCX import)
        'libmswordlo.a',       # MS Word import
        'libsclo.a',           # Calc core
        'libscdlo.a',          # Calc Drawing
        'libscfiltlo.a',       # Calc filters (XLSX import)
    ],
    'csv': [
        'libswlo.a',           # Writer core
        'libswdlo.a',          # Writer Drawing
        'libwriterfilterlo.a', # Writer filter (DOCX import)
        'libmswordlo.a',       # MS Word import
    ]
}

def patch_services_rdb(data_path, metadata_path, module):
    """Remove components for other modules from services.rdb in soffice.data."""

    components_to_remove = COMPONENTS_TO_REMOVE.get(module, [])
    if not components_to_remove:
        print(f"ERROR: Unknown module '{module}'. Must be 'calc' or 'writer'.")
        return False

    print(f"Module: {module}")
    print(f"Components to remove: {components_to_remove}")

    # Read metadata
    with open(metadata_path, 'r') as f:
        metadata = json.load(f)

    # Find services.rdb entry in services/ subdirectory (the one with full components)
    services_entry = None
    for entry in metadata.get('files', []):
        if entry.get('filename', '') == '/instdir/program/services/services.rdb':
            services_entry = entry
            break

    if not services_entry:
        print("ERROR: /instdir/program/services/services.rdb not found in metadata!")
        return False

    # Read data file
    with open(data_path, 'rb') as f:
        data = bytearray(f.read())

    # Extract current services.rdb content
    start = services_entry['start']
    end = services_entry['end']
    original_content = data[start:end].decode('utf-8', errors='ignore')

    print(f"Original services.rdb size: {end - start} bytes")

    # Count original components
    original_libs = re.findall(r'uri="([^"]+)"', original_content)
    print(f"Original component count: {len(original_libs)}")

    # Remove components
    modified_content = original_content
    removed_count = 0

    for comp in components_to_remove:
        # The services.rdb has structure like:
        # <components xmlns="..."><component uri="lib.a">...</component></components><components xmlns="..."><component uri="lib2.a">...
        # So we need to match the component AND any surrounding components wrapper

        # First try: component with its wrapper
        pattern = rf'<components\s+xmlns="[^"]*">\s*<component\s+loader="[^"]*"\s+environment="[^"]*"\s+uri="{re.escape(comp)}"[^>]*>.*?</component>\s*</components>'
        matches = len(re.findall(pattern, modified_content, re.DOTALL))
        if matches > 0:
            modified_content = re.sub(pattern, '', modified_content, flags=re.DOTALL)
            removed_count += matches
            print(f"  Removed: {comp} with wrapper ({matches} block(s))")
        else:
            # Second try: just the component (shared wrapper with others)
            pattern = rf'<component\s+loader="[^"]*"\s+environment="[^"]*"\s+uri="{re.escape(comp)}"[^>]*>.*?</component>'
            matches = len(re.findall(pattern, modified_content, re.DOTALL))
            if matches > 0:
                modified_content = re.sub(pattern, '', modified_content, flags=re.DOTALL)
                removed_count += matches
                print(f"  Removed: {comp} ({matches} block(s))")
            else:
                print(f"  Not found: {comp}")

    # The services.rdb has unusual structure with multiple <components> opening tags
    # but only one </components> closing tag at the end. LibreOffice parses this specially.
    # We need to ensure the final </components> is present.

    # Clean up any empty components wrappers that may have been left
    # But preserve the overall structure
    empty_wrapper_pattern = r'<components\s+xmlns="[^"]*">\s*(?=<components)'
    modified_content = re.sub(empty_wrapper_pattern, '', modified_content)

    # Ensure file ends with </components>\n
    if not modified_content.rstrip().endswith('</components>'):
        # Find the last </component> and add </components> after it
        if '</component>' in modified_content:
            last_component_end = modified_content.rfind('</component>')
            if last_component_end > 0:
                modified_content = modified_content[:last_component_end + len('</component>')] + '</components>\n'
                print("  Added missing </components> closing tag")

    # Note: The services.rdb is not valid XML (nested <components> without closing tags)
    # LibreOffice parses it specially, so we can't validate with standard XML parser
    print("  Note: services.rdb uses non-standard XML structure (multiple <components> tags)")

    if removed_count == 0:
        print("No components were removed - services.rdb is already clean.")
        return True

    # Encode modified content
    modified_bytes = modified_content.encode('utf-8')
    size_diff = len(modified_bytes) - (end - start)

    print(f"Modified services.rdb size: {len(modified_bytes)} bytes")
    print(f"Size difference: {size_diff} bytes")

    # Update data file
    new_data = data[:start] + modified_bytes + data[end:]

    # Update metadata for all files after services.rdb
    for entry in metadata.get('files', []):
        if entry['start'] > start:
            entry['start'] += size_diff
            entry['end'] += size_diff
        elif entry['start'] == start:
            entry['end'] = entry['start'] + len(modified_bytes)

    # Write updated data file
    with open(data_path, 'wb') as f:
        f.write(new_data)

    # Write updated metadata
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f)

    # Verify
    new_libs = re.findall(r'uri="([^"]+)"', modified_content)
    print(f"New component count: {len(new_libs)}")
    print(f"Removed {len(original_libs) - len(new_libs)} components")

    return True

def main():
    parser = argparse.ArgumentParser(description='Patch services.rdb for specific module')
    parser.add_argument('module', choices=['calc', 'writer', 'impress', 'csv'], help='Target module')
    parser.add_argument('data_file', help='Path to soffice.data file')
    parser.add_argument('--metadata', '-m', help='Path to metadata file (default: <data_file>.js.metadata)')
    args = parser.parse_args()

    data_path = args.data_file
    metadata_path = args.metadata or (data_path + '.js.metadata')

    print(f"Data file: {data_path}")
    print(f"Metadata file: {metadata_path}")

    if not os.path.exists(data_path):
        print(f"ERROR: Data file not found: {data_path}")
        return 1

    if not os.path.exists(metadata_path):
        print(f"ERROR: Metadata file not found: {metadata_path}")
        return 1

    if patch_services_rdb(data_path, metadata_path, args.module):
        print("\n✓ Services patched successfully!")
        return 0
    else:
        print("\n✗ Failed to patch services")
        return 1

if __name__ == '__main__':
    sys.exit(main())
