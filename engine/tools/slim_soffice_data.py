#!/usr/bin/env python3
"""
slim_soffice_data.py - Create a minimal soffice.data for headless conversion

This script creates a slimmed-down version of soffice.data by removing
files that are never needed for headless document conversion.

Modes:
  (default)     Analyze the .data contents and show potential savings
  --repackage   Directly repackage the .data binary in-place
  --dry-run     Analyze only, don't modify anything

Strategy:
  KEEP:   Program files, registry configs, fontconfig, fonts,
          whitelisted .ui files (scrollbars, inputbar, etc.)
  REMOVE: .ui dialog files (patched VCL silently skips missing .ui in WASM),
          Android examples, icon themes, gallery clipart, StarBasic presets,
          PNG/SVG icons, liblangtag registry, DrawingML presets, VBA types
"""

import json
import os
import sys
import shutil
from pathlib import Path

# Files/patterns to REMOVE entirely
REMOVE_PATTERNS = [
    '/android/',                   # Example documents (~280KB)
    '/instdir/presets/gallery/',   # Gallery presets
    '/instdir/presets/basic/',     # StarBasic macros
    '/instdir/share/gallery/',     # Clipart (~960KB)
    '/liblangtag/',                # BCP47 language subtag registry (~1.74MB)
    '/soffice.cfg/modules/',       # Toolbar/menubar/statusbar/popupmenu XML configs (~1MB)
    '/wizard/',                    # Wizard CSS/templates (unused in headless)
]

# File-name patterns to REMOVE (matched anywhere in path)
REMOVE_NAME_PATTERNS = [
    'images_',                     # Icon theme ZIPs (~3MB each)
    # 'oox-drawingml-cs-presets',  # REMOVED FROM THE REMOVE-LIST 2026-08-18.
    #   Stripping this broke EVERY custom shape in the presentations module.
    #   <a:prstGeom prst="..."/> — every preset geometry, including a plain
    #   rectangle — imports as an SdrObjCustomShape, whose geometry is built by
    #   EnhancedCustomShape2d::CreateObject from this preset data. Without the
    #   file, oox/source/drawingml/customshapepresetdata.cxx:906 cannot open it,
    #   CreateObject produces nothing, EnhancedCustomShapeEngine::render()
    #   returns an empty reference, GetSdrObjectFromCustomShape() is null, and
    #   ViewContactOfSdrObjCustomShape emits NO GEOMETRY — only the shape's text.
    #   Measured: 222 of 222 custom shapes in one 63-slide deck produced no
    #   geometry, 120 of them carrying a fill that was never drawn.
    #   Costs ~1.62 MB uncompressed. Do not re-add without re-measuring.
]

# Exact filenames to REMOVE (matched against basename)
REMOVE_FILENAMES = [
    'oovbaapi.rdb',                # VBA type definitions (~347KB, macros not used)
]

# File extensions to REMOVE
REMOVE_EXTENSIONS = [
    '.png',                        # Splash/icon images (~200KB)
    '.svg',                        # Vector icons (~100KB)
    '.ui',                         # Dialog files (~12-16MB, VCL patch skips missing)
]

# .ui files to KEEP (basename match). These are loaded during core initialization
# and needed even in headless mode. Discovered iteratively during testing.
KEEP_UI_FILES = {
    'scrollbars.ui',               # VCL scrollbar infrastructure
    'inputbar.ui',                 # Spreadsheets: Calc formula bar
    'posbox.ui',                   # Spreadsheets: Calc cell position box
    'selectionmenu.ui',            # Status bar selection (null deref without)
    # Spreadsheets: InterimItemWindow subclasses (null deref without)
    'numberbox.ui',                # Number format box (cbnumberformat.cxx)
    'zoombox.ui',                  # Zoom slider control (tbzoomsliderctrl.cxx)
    # Presentations: InterimItemWindow subclasses (null deref without)
    'tabviewbar.ui',               # Tab bar (ViewTabBar.cxx)
    'pagesfieldbox.ui',            # Pages field (diactrl.cxx)
    'gluebox.ui',                  # Glue control (gluectrl.cxx)
    # Framework: toolbar controls (InterimItemWindow subclasses)
    'fixedtextcontrol.ui',         # Fixed text toolbar controller
    'editcontrol.ui',              # Edit toolbar controller
    'combocontrol.ui',             # Combo box toolbar controller
    'listcontrol.ui',              # Dropdown toolbar controller
    'spinfieldcontrol.ui',         # Spin field toolbar controller
    'fixedimagecontrol.ui',        # Fixed image toolbar controller
}


def classify_file(filepath: str):
    """Classify a VFS file into 'keep' or 'remove'.

    Returns (action, reason) tuple.
    """
    basename = filepath.rsplit('/', 1)[-1] if '/' in filepath else filepath

    # Check .ui whitelist BEFORE extension removal
    if basename in KEEP_UI_FILES:
        return 'keep', 'whitelisted .ui'

    # Check full-path removal patterns
    for pattern in REMOVE_PATTERNS:
        if pattern in filepath:
            return 'remove', pattern

    # Check file-name patterns
    for pattern in REMOVE_NAME_PATTERNS:
        if pattern in filepath:
            return 'remove', pattern

    # Check exact filename removals
    if basename in REMOVE_FILENAMES:
        return 'remove', basename

    # Check extension removals
    for ext in REMOVE_EXTENSIONS:
        if filepath.endswith(ext):
            return 'remove', ext

    return 'keep', 'default'


def analyze_metadata(metadata_path: str) -> dict:
    """Analyze the metadata file and return classification statistics."""
    with open(metadata_path) as f:
        data = json.load(f)

    keep_files = []
    remove_files = []

    for f in data['files']:
        path = f['filename']
        size = f.get('end', 0) - f.get('start', 0)
        action, reason = classify_file(path)

        if action == 'keep':
            keep_files.append((path, size, f))
        else:
            remove_files.append((path, size, f))

    return {
        'keep': keep_files,
        'remove': remove_files,
        'keep_size': sum(s for _, s, _ in keep_files),
        'remove_size': sum(s for _, s, _ in remove_files),
        'original_data': data
    }


def find_data_files(target_path: Path):
    """Find soffice.data and soffice.data.js.metadata in either layout.

    Supports two layouts:
      - instdir layout:  <path>/program/soffice.data{,.js.metadata}
      - module layout:   <path>/soffice.data{,.js.metadata}
    """
    # Try instdir layout first
    metadata = target_path / 'program' / 'soffice.data.js.metadata'
    data = target_path / 'program' / 'soffice.data'
    if metadata.exists() and data.exists():
        return data, metadata

    # Try module layout (web/modules/<name>/)
    metadata = target_path / 'soffice.data.js.metadata'
    data = target_path / 'soffice.data'
    if metadata.exists() and data.exists():
        return data, metadata

    return None, None


def repackage(target_path: Path, dry_run: bool = False):
    """Repackage .data binary in-place, removing unnecessary files.

    Reads the metadata to find byte ranges in the .data binary, copies only
    kept files' ranges into a new binary, recomputes offsets, and replaces
    the originals in-place.
    """
    data_path, metadata_path = find_data_files(target_path)
    if not data_path:
        print(f"Error: Could not find soffice.data and soffice.data.js.metadata in {target_path}")
        print(f"  Tried: {target_path}/program/ and {target_path}/")
        sys.exit(1)

    print(f"Data file: {data_path}")
    print(f"Metadata:  {metadata_path}")

    stats = analyze_metadata(str(metadata_path))
    original_size = data_path.stat().st_size

    # Categorize removals for reporting
    ui_removed = sum(s for p, s, _ in stats['remove'] if p.endswith('.ui'))
    ui_count = sum(1 for p, _, _ in stats['remove'] if p.endswith('.ui'))

    print(f"\n=== VFS Slimming Analysis ===")
    print(f"Files to KEEP:   {len(stats['keep']):4d} ({stats['keep_size']/1024/1024:.1f} MB)")
    print(f"Files to REMOVE: {len(stats['remove']):4d} ({stats['remove_size']/1024/1024:.1f} MB)")
    if ui_count:
        print(f"  .ui dialogs:   {ui_count:4d} ({ui_removed/1024/1024:.1f} MB)")
    print(f"Original .data:  {original_size/1024/1024:.1f} MB")
    print(f"Expected .data:  {stats['keep_size']/1024/1024:.1f} MB")
    print(f"Savings:         {stats['remove_size']/1024/1024:.1f} MB ({100*stats['remove_size']/original_size:.0f}%)")

    if dry_run:
        print("\n[DRY RUN] No files modified.")
        return

    # Sort kept files by their original start offset for sequential reading
    kept_entries = sorted(stats['keep'], key=lambda x: x[2]['start'])

    new_files = []
    new_offset = 0

    tmp_dir = data_path.parent
    tmp_data = tmp_dir / 'soffice.data.slim.tmp'

    try:
        with open(data_path, 'rb') as src, open(tmp_data, 'wb') as dst:
            for filename, size, entry in kept_entries:
                old_start = entry['start']
                old_end = entry['end']
                chunk_size = old_end - old_start

                src.seek(old_start)
                remaining = chunk_size
                while remaining > 0:
                    read_size = min(remaining, 1024 * 1024)
                    buf = src.read(read_size)
                    if not buf:
                        break
                    dst.write(buf)
                    remaining -= len(buf)

                new_files.append({
                    'filename': filename,
                    'start': new_offset,
                    'end': new_offset + chunk_size
                })
                new_offset += chunk_size

        new_size = tmp_data.stat().st_size

        # Build new metadata
        new_metadata = {
            'files': new_files,
            'remote_package_size': new_size
        }

        # Write new metadata to temp file
        tmp_metadata = tmp_dir / 'soffice.data.js.metadata.slim.tmp'
        with open(tmp_metadata, 'w') as f:
            json.dump(new_metadata, f)

        # Replace originals atomically
        os.replace(tmp_data, data_path)
        os.replace(tmp_metadata, metadata_path)

        print(f"\n=== Repackaging Complete ===")
        print(f"New .data size:  {new_size/1024/1024:.1f} MB (was {original_size/1024/1024:.1f} MB)")
        print(f"Files retained:  {len(new_files)}")
        print(f"Files removed:   {len(stats['remove'])}")
        print(f"Bytes saved:     {(original_size - new_size)/1024/1024:.1f} MB")

    except Exception:
        # Clean up temp files on failure
        if tmp_data.exists():
            tmp_data.unlink()
        tmp_metadata = tmp_dir / 'soffice.data.js.metadata.slim.tmp'
        if tmp_metadata.exists():
            tmp_metadata.unlink()
        raise


def main():
    if len(sys.argv) < 2:
        print("Usage: slim_soffice_data.py <path> [--repackage] [--dry-run]")
        print("\n  <path>        Path to instdir/ or a module directory containing soffice.data")
        print("  --repackage   Repackage .data binary in-place (no Emscripten needed)")
        print("  --dry-run     Analyze only, don't modify anything")
        sys.exit(1)

    target_path = Path(sys.argv[1])
    dry_run = '--dry-run' in sys.argv
    do_repackage = '--repackage' in sys.argv

    if do_repackage:
        repackage(target_path, dry_run)
        return

    # Analyze mode
    data_path, metadata_path = find_data_files(target_path)
    if not metadata_path:
        print(f"Error: Metadata file not found in {target_path}")
        sys.exit(1)

    print("Analyzing soffice.data contents...")
    stats = analyze_metadata(str(metadata_path))

    print(f"\n=== Analysis Results ===")
    print(f"Files to KEEP:   {len(stats['keep'])} ({stats['keep_size']/1024/1024:.1f} MB)")
    print(f"Files to REMOVE: {len(stats['remove'])} ({stats['remove_size']/1024/1024:.1f} MB)")
    print(f"Estimated savings: {stats['remove_size']/1024/1024:.1f} MB")

    print(f"\n=== Files to REMOVE (top 15 by size) ===")
    for path, size, _ in sorted(stats['remove'], key=lambda x: -x[1])[:15]:
        print(f"  {size/1024:7.1f} KB  {path}")

    if dry_run:
        print("\n[DRY RUN] No files modified.")


if __name__ == '__main__':
    main()
