#!/usr/bin/env python3
"""Merge adjacent WASM active data segments to cut per-segment framing overhead.

WHY
---
LLVM/emcc emits one data segment per contiguous initialised region, hitting
Binaryen's 100,000-segment web limit (measured: 99,998 segments pre-wasm-opt).
wasm-opt's `memory-packing` pass then re-splits on zero runs and lands at
~83,800 segments for the `documents` module. Every segment costs a header of
flags + `i32.const <offset>` + `end` + size -- ~8 bytes of high-entropy LEB
that brotli cannot compress away, because the offsets are all different.

Bridging a gap costs the gap's bytes as explicit zeros. Zeros are almost free
after brotli; the headers are not. So trading zero padding for fewer headers is
strongly favourable, even though it makes the RAW binary bigger.

MEASURED on web/modules/documents/soffice.wasm (83,829,930 B raw / 20,483,909 B
brotli -q 11, i.e. the shipped artifact):

    gap_max   segments    raw delta     brotli        wire saved
    (none)      83,828           --   20,483,909             --
         16      18,897     +220,570   20,295,046        188,863
         64       2,072     +502,139   20,209,922        273,987
        256         303     +673,234   20,204,985        278,924
       1024           7     +776,080   20,198,356        285,553
         -1           1     +788,950   20,198,036        285,873

The curve plateaus at ~285 KB. gap-max 1024 captures 99.9% of it; gap-max 64 is
the conservative setting at 95.8%. BOTH were validated end-to-end by converting
real documents (see the accompanying build.sh patch).

SAFETY
------
Merging is a semantic no-op. WebAssembly linear memory declared by the module
is zero-initialised, so writing an explicit zero into a gap between two active
data segments stores the value that was already there. The transform therefore
cannot change program behaviour.

It is refused outright if the module has any passive segment, because passive
segments are addressed by index from `memory.init`/`data.drop` in the code
section and renumbering them would corrupt the module.

usage: merge_wasm_data_segments.py IN.wasm [-o OUT.wasm] [--gap-max N]
       --gap-max N   bridge gaps of at most N bytes (default 1024)
                     -1 merges the whole data section into a single segment
"""

import argparse
import sys


def read_uleb(buf, pos):
    result = shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, pos


def read_sleb(buf, pos):
    result = shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            if shift < 64 and byte & 0x40:
                result |= -(1 << shift)
            return result, pos


def write_uleb(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def write_sleb(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        done = (value == 0 and not byte & 0x40) or (value == -1 and byte & 0x40)
        out.append(byte if done else byte | 0x80)
        if done:
            return bytes(out)


SECTION_DATA = 11
SECTION_DATACOUNT = 12


def split_sections(buf):
    if buf[:4] != b'\0asm':
        raise ValueError('not a wasm module')
    sections = []
    pos = 8
    while pos < len(buf):
        start = pos
        sid = buf[pos]
        pos += 1
        size, pos = read_uleb(buf, pos)
        sections.append((sid, start, pos, pos + size))
        pos += size
    if pos != len(buf):
        raise ValueError('truncated module')
    return sections


def parse_data_segments(buf, body_start, body_end):
    pos = body_start
    count, pos = read_uleb(buf, pos)
    segments = []
    for _ in range(count):
        flags, pos = read_uleb(buf, pos)
        if flags == 1:
            raise ValueError('passive data segment present; refusing to merge '
                             '(segment indices are referenced by memory.init/data.drop)')
        if flags == 2:
            mem_index, pos = read_uleb(buf, pos)
            if mem_index != 0:
                raise ValueError('multi-memory module; refusing to merge')
        elif flags != 0:
            raise ValueError(f'unsupported data segment flags {flags}')
        if buf[pos] != 0x41:
            raise ValueError('data segment offset is not a constant i32.const; refusing to merge')
        pos += 1
        offset, pos = read_sleb(buf, pos)
        if buf[pos] != 0x0B:
            raise ValueError('malformed data segment offset expression')
        pos += 1
        length, pos = read_uleb(buf, pos)
        segments.append((offset, buf[pos:pos + length]))
        pos += length
    if pos != body_end:
        raise ValueError('data section walk did not consume the section exactly')
    return segments


def merge(segments, gap_max):
    segments = sorted(segments, key=lambda s: s[0])
    merged = []
    cur_offset, cur = segments[0][0], bytearray(segments[0][1])
    zero_fill = 0
    for offset, blob in segments[1:]:
        gap = offset - (cur_offset + len(cur))
        if gap < 0:
            raise ValueError('overlapping data segments; refusing to merge')
        if gap_max < 0 or gap <= gap_max:
            cur += b'\0' * gap
            cur += blob
            zero_fill += gap
        else:
            merged.append((cur_offset, bytes(cur)))
            cur_offset, cur = offset, bytearray(blob)
    merged.append((cur_offset, bytes(cur)))
    return merged, zero_fill


def build_data_section(merged):
    body = bytearray(write_uleb(len(merged)))
    for offset, blob in merged:
        body += b'\x00'                                    # active, memory 0
        body += b'\x41' + write_sleb(offset) + b'\x0b'      # i32.const <off> end
        body += write_uleb(len(blob))
        body += blob
    return bytes(body)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input')
    ap.add_argument('-o', '--output', help='defaults to rewriting the input in place')
    ap.add_argument('--gap-max', type=int, default=1024,
                    help='largest address gap to bridge with zeros (default 1024; -1 = merge all)')
    args = ap.parse_args()

    src = open(args.input, 'rb').read()
    sections = split_sections(src)

    data_sections = [s for s in sections if s[0] == SECTION_DATA]
    if not data_sections:
        sys.stderr.write('merge_wasm_data_segments: no data section, nothing to do\n')
        return 0
    _, _, body_start, body_end = data_sections[0]

    segments = parse_data_segments(src, body_start, body_end)
    merged, zero_fill = merge(segments, args.gap_max)
    body = build_data_section(merged)

    out = bytearray(src[:8])
    for sid, hdr_start, body_beg, body_fin in sections:
        if sid == SECTION_DATA:
            out += bytes([SECTION_DATA]) + write_uleb(len(body)) + body
        elif sid == SECTION_DATACOUNT:
            count = write_uleb(len(merged))
            out += bytes([SECTION_DATACOUNT]) + write_uleb(len(count)) + count
        else:
            out += src[hdr_start:body_fin]

    dest = args.output or args.input
    open(dest, 'wb').write(out)

    sys.stderr.write(
        f'merge_wasm_data_segments: segments {len(segments):,} -> {len(merged):,}, '
        f'zero-fill {zero_fill:,} B, raw {len(src):,} -> {len(out):,} B '
        f'({len(out) - len(src):+,}); brotli is expected to shrink\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
