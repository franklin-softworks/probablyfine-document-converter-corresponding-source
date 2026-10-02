#!/usr/bin/env python3
"""
Ensure soffice.js FS_createPath entries cover all directories in soffice.data.

The Emscripten file packager generates FS_createPath calls in soffice.js for
directories needed by files in soffice.data. When build caches are stale, some
directory entries can be missing, causing "ErrnoError: No such file or directory"
at runtime.

This script reads the metadata file to find all required directories, checks
which ones are already in soffice.js, and adds any missing ones.
"""

import json
import re
import sys
from pathlib import PurePosixPath


def get_required_dirs(metadata_path):
    """Extract all unique parent directories from the metadata file."""
    with open(metadata_path) as f:
        meta = json.load(f)

    dirs = set()
    for entry in meta["files"]:
        path = PurePosixPath(entry["filename"])
        # Add all ancestor directories
        for parent in list(path.parents)[:-1]:  # exclude root "/"
            dirs.add(str(parent))
    return dirs


def get_existing_dirs(js_path):
    """Extract directories already created by FS_createPath in soffice.js."""
    with open(js_path) as f:
        content = f.read()

    # Match: Module["FS_createPath"]("/parent", "child", true, true);
    pattern = r'Module\["FS_createPath"\]\("([^"]*)",\s*"([^"]*)"'
    dirs = set()
    for match in re.finditer(pattern, content):
        parent, child = match.group(1), match.group(2)
        if parent == "/":
            dirs.add("/" + child)
        else:
            dirs.add(parent + "/" + child)
    return dirs


def generate_create_path_calls(dirs):
    """Generate FS_createPath calls for a set of directories."""
    lines = []
    for d in sorted(dirs):
        path = PurePosixPath(d)
        parent = str(path.parent)
        child = path.name
        lines.append(
            f'   Module["FS_createPath"]("{parent}", "{child}", true, true);'
        )
    return "\n".join(lines)


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <soffice.js> <soffice.data.js.metadata>")
        sys.exit(1)

    js_path = sys.argv[1]
    metadata_path = sys.argv[2]

    required = get_required_dirs(metadata_path)
    existing = get_existing_dirs(js_path)
    missing = required - existing

    if not missing:
        print("VFS directories: all present")
        return

    print(f"VFS directories: {len(missing)} missing, patching soffice.js")
    for d in sorted(missing):
        print(f"  + {d}")

    # Generate the new FS_createPath lines
    new_lines = generate_create_path_calls(missing)

    # Insert after the last existing FS_createPath line
    with open(js_path) as f:
        content = f.read()

    # Find the last FS_createPath call and insert after it
    last_match = None
    for match in re.finditer(
        r'   Module\["FS_createPath"\]\("[^"]*",\s*"[^"]*",\s*true,\s*true\);',
        content,
    ):
        last_match = match

    if last_match:
        insert_pos = last_match.end()
        content = content[:insert_pos] + "\n" + new_lines + content[insert_pos:]

        with open(js_path, "w") as f:
            f.write(content)
        print(f"Patched {len(missing)} directory entries into soffice.js")
    else:
        print("WARNING: Could not find FS_createPath calls in soffice.js")
        sys.exit(1)


if __name__ == "__main__":
    main()
