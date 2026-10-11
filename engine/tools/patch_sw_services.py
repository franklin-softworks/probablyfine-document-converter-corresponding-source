#!/usr/bin/env python3
# Copyright (c) 2025-2026 Franklin Softworks LLC
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""
Patch SW services into soffice.data after build.
This script modifies the services.rdb inside the Emscripten-packed soffice.data
to include the Writer (SW) module services.
"""
import json
import re
import sys
import os

def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <soffice.data> <sw.component> <msword.component> <swd.component>")
        print("  Or: {sys.argv[0]} <soffice.data> --auto  (to find components automatically)")
        return 1
    
    data_file = sys.argv[1]
    metadata_file = data_file + ".js.metadata"
    
    # Auto-detect component files
    if len(sys.argv) == 3 and sys.argv[2] == "--auto":
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        sw_component = os.path.join(base_dir, "libreoffice/workdir/ComponentTarget/sw/util/sw.component")
        msword_component = os.path.join(base_dir, "libreoffice/workdir/ComponentTarget/sw/util/msword.component")
        swd_component = os.path.join(base_dir, "libreoffice/workdir/ComponentTarget/sw/util/swd.component")
        sw_writerfilter_component = os.path.join(base_dir, "libreoffice/workdir/ComponentTarget/sw/util/sw_writerfilter.component")
    else:
        sw_component = sys.argv[2]
        msword_component = sys.argv[3]
        swd_component = sys.argv[4]
        sw_writerfilter_component = sys.argv[5] if len(sys.argv) > 5 else None
    
    # Read metadata
    with open(metadata_file, 'r') as f:
        metadata = json.load(f)
    
    # Find services/services.rdb location in data file
    services_entry = None
    for entry in metadata['files']:
        if entry['filename'] == '/instdir/program/services/services.rdb':
            services_entry = entry
            break
    
    if not services_entry:
        print("ERROR: Could not find /instdir/program/services/services.rdb in metadata")
        return 1
    
    # Read soffice.data
    with open(data_file, 'rb') as f:
        data = bytearray(f.read())
    
    # Extract current services.rdb
    start = services_entry['start']
    end = services_entry['end']
    current_services = data[start:end].decode('utf-8')
    
    # Check if SW is already present
    if 'libswlo' in current_services:
        print("SW services already present in services.rdb")
        return 0
    
    # Read component files and extract <component> elements (not <components>)
    def extract_component(filepath):
        with open(filepath, 'r') as f:
            content = f.read()
        # Use <component\s to ensure we don't match <components>
        match = re.search(r'(<component\s[^>]*>.*?</component>)', content, re.DOTALL)
        if match:
            return match.group(1)
        return None
    
    sw_comp = extract_component(sw_component)
    msword_comp = extract_component(msword_component)
    swd_comp = extract_component(swd_component)
    sw_writerfilter_comp = None
    if sw_writerfilter_component and os.path.exists(sw_writerfilter_component):
        sw_writerfilter_comp = extract_component(sw_writerfilter_component)

    if not sw_comp:
        print("ERROR: Could not extract SW component")
        return 1

    # Merge components
    merged = current_services.replace('</components>', sw_comp + '</components>')
    if msword_comp:
        merged = merged.replace('</components>', msword_comp + '</components>')
    if swd_comp:
        merged = merged.replace('</components>', swd_comp + '</components>')
    if sw_writerfilter_comp:
        merged = merged.replace('</components>', sw_writerfilter_comp + '</components>')
        print("Added sw_writerfilter services (DOCX/RTF import/export)")
    
    merged_bytes = merged.encode('utf-8')
    
    # Calculate size difference
    old_size = end - start
    new_size = len(merged_bytes)
    size_diff = new_size - old_size
    
    print(f"Original services.rdb: {old_size} bytes")
    print(f"Merged services.rdb: {new_size} bytes")
    print(f"Size difference: {size_diff} bytes")
    
    # Create new data file
    new_data = data[:start] + merged_bytes + data[end:]
    
    # Update metadata for all files after services.rdb
    for entry in metadata['files']:
        if entry['start'] > start:
            entry['start'] += size_diff
            entry['end'] += size_diff
        elif entry['start'] == start:
            entry['end'] = start + new_size
    
    # Backup original files
    import shutil
    shutil.copy(data_file, data_file + '.backup')
    shutil.copy(metadata_file, metadata_file + '.backup')
    
    # Write modified files
    with open(data_file, 'wb') as f:
        f.write(new_data)
    
    with open(metadata_file, 'w') as f:
        json.dump(metadata, f)
    
    # Verify
    with open(data_file, 'rb') as f:
        verify_data = f.read()
    
    if b'libswlo' in verify_data:
        print("SUCCESS: SW services have been patched into soffice.data")
        print(f"Data file size: {len(data)} -> {len(new_data)} bytes")
        return 0
    else:
        print("ERROR: Verification failed")
        return 1

if __name__ == '__main__':
    sys.exit(main())
