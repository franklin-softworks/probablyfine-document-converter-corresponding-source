#!/usr/bin/env python3
# Copyright (c) 2025-2026 Franklin Softworks LLC
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Convert bsdiff4 patches to browser-friendly BSPATCH1 format.

The standard bsdiff4 format uses bzip2 compression internally.
This tool decompresses the bzip2 blocks and writes a simpler format
that can be parsed in the browser without a bzip2 decoder.

The output format (BSPATCH1) is designed to be served with HTTP
Content-Encoding (e.g., Brotli) for wire compression.

Format:
  Header (24 bytes):
    magic      8 bytes  "BSPATCH1"
    new_size   4 bytes  uint32 LE
    ctrl_count 4 bytes  uint32 LE
    diff_size  4 bytes  uint32 LE
    extra_size 4 bytes  uint32 LE
  Body:
    controls   ctrl_count * 12 bytes (add:i32, copy:i32, seek:i32 LE)
    diff_data  diff_size bytes
    extra_data extra_size bytes

Usage:
    python3 engine/tools/convert_bsdiff.py <input.bsdiff> <output.bspatch>
"""

import struct
import bz2
import sys
import os


def offtin(buf):
    """Decode bsdiff's custom 64-bit signed integer format (LE, sign in MSB)."""
    y = buf[7] & 0x7F
    for i in range(6, -1, -1):
        y = y * 256 + buf[i]
    if buf[7] & 0x80:
        y = -y
    return y


def read_bsdiff4(path):
    """Read and decompress a bsdiff4 patch file."""
    with open(path, 'rb') as f:
        header = f.read(32)

    if len(header) < 32:
        raise ValueError(f'File too small to be a bsdiff4 patch: {len(header)} bytes')

    magic = header[:8]
    if magic != b'BSDIFF40':
        raise ValueError(f'Not a bsdiff4 file: magic={magic!r}')

    ctrl_len = offtin(header[8:16])
    diff_len = offtin(header[16:24])
    new_size = offtin(header[24:32])

    if ctrl_len < 0 or diff_len < 0 or new_size < 0:
        raise ValueError(f'Invalid bsdiff4 header: ctrl_len={ctrl_len}, diff_len={diff_len}, new_size={new_size}')

    with open(path, 'rb') as f:
        f.seek(32)
        ctrl_bz2 = f.read(ctrl_len)
        diff_bz2 = f.read(diff_len)
        extra_bz2 = f.read()

    ctrl_raw = bz2.decompress(ctrl_bz2)
    diff_raw = bz2.decompress(diff_bz2)
    extra_raw = bz2.decompress(extra_bz2)

    # Parse control tuples (each is 3 x int64)
    controls = []
    for i in range(0, len(ctrl_raw), 24):
        add = offtin(ctrl_raw[i:i + 8])
        copy = offtin(ctrl_raw[i + 8:i + 16])
        seek = offtin(ctrl_raw[i + 16:i + 24])
        controls.append((add, copy, seek))

    return new_size, controls, diff_raw, extra_raw


def write_bspatch1(path, new_size, controls, diff_data, extra_data):
    """Write the browser-friendly BSPATCH1 format."""
    with open(path, 'wb') as f:
        # Header (24 bytes)
        f.write(b'BSPATCH1')
        f.write(struct.pack('<I', new_size))
        f.write(struct.pack('<I', len(controls)))
        f.write(struct.pack('<I', len(diff_data)))
        f.write(struct.pack('<I', len(extra_data)))

        # Control entries (each: add i32, copy i32, seek i32 — all signed LE)
        for add, copy, seek in controls:
            f.write(struct.pack('<i', add))
            f.write(struct.pack('<i', copy))
            f.write(struct.pack('<i', seek))

        # Diff and extra data
        f.write(diff_data)
        f.write(extra_data)


def verify_patch(old_path, new_path, new_size, controls, diff_data, extra_data):
    """Verify patch produces the expected output (optional, for testing)."""
    with open(old_path, 'rb') as f:
        old = f.read()

    out = bytearray(new_size)
    old_pos = 0
    new_pos = 0
    diff_pos = 0
    extra_pos = 0

    for add, copy, seek in controls:
        # Add diff bytes to old bytes
        for j in range(add):
            val = diff_data[diff_pos + j]
            if 0 <= old_pos + j < len(old):
                val = (val + old[old_pos + j]) & 0xFF
            out[new_pos + j] = val

        diff_pos += add
        new_pos += add
        old_pos += add

        # Copy extra bytes
        out[new_pos:new_pos + copy] = extra_data[extra_pos:extra_pos + copy]
        extra_pos += copy
        new_pos += copy

        # Adjust old position
        old_pos += seek

    with open(new_path, 'rb') as f:
        expected = f.read()

    if bytes(out) == expected:
        return True
    else:
        # Find first difference
        for i in range(min(len(out), len(expected))):
            if out[i] != expected[i]:
                print(f'  First difference at byte {i}: got {out[i]:#04x}, expected {expected[i]:#04x}')
                break
        return False


def main():
    if len(sys.argv) < 3:
        print(f'Usage: {sys.argv[0]} <input.bsdiff> <output.bspatch> [--verify old_file new_file]')
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    verify = False
    old_path = new_path = None
    if len(sys.argv) >= 5 and sys.argv[3] == '--verify':
        verify = True
        old_path = sys.argv[4]
        new_path = sys.argv[5] if len(sys.argv) > 5 else None

    print(f'Converting bsdiff4 to BSPATCH1:')
    print(f'  Input:  {input_path} ({os.path.getsize(input_path):,} bytes)')

    new_size, controls, diff_data, extra_data = read_bsdiff4(input_path)

    print(f'  New size:  {new_size:,} bytes')
    print(f'  Controls:  {len(controls):,} entries')
    print(f'  Diff data: {len(diff_data):,} bytes')
    print(f'  Extra data:{len(extra_data):,} bytes')

    write_bspatch1(output_path, new_size, controls, diff_data, extra_data)

    out_size = os.path.getsize(output_path)
    print(f'  Output: {output_path} ({out_size:,} bytes)')

    if verify and old_path and new_path:
        print(f'  Verifying patch...')
        if verify_patch(old_path, new_path, new_size, controls, diff_data, extra_data):
            print(f'  Verification: PASS')
        else:
            print(f'  Verification: FAIL')
            sys.exit(1)


if __name__ == '__main__':
    main()
