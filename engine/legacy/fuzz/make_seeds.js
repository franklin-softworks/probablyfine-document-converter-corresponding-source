// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

// Synthetic seeds for the legacy bridge's fuzzing and mutation runs (FF-6 option C). NO third-party file: headers and tiny bodies made here.
// usage: node make_seeds.js <out-dir>
'use strict';
const fs = require('fs'), path = require('path');
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const wp = (major, minor, key, body, prodType = 1, fileType = 0x0a) => { const off = 0x80, h = Buffer.alloc(off + body.length); h[0] = 0xff; h.write('WPC', 1, 'latin1'); h.writeUInt32LE(off, 4); h[8] = prodType; h[9] = fileType; h[10] = major; h[11] = minor; h.writeUInt16LE(key, 12); Buffer.from(body, 'latin1').copy(h, off); return h; };
const ole = (shift) => { const b = Buffer.alloc(2048); Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b, 0); b.writeUInt16LE(0x3e, 0x18); b.writeUInt16LE(3, 0x1a); b.writeUInt16LE(0xfffe, 0x1c); b.writeUInt16LE(shift, 0x1e); b.writeUInt16LE(6, 0x20); b.writeUInt32LE(1, 0x2c); b.writeUInt32LE(1, 0x30); b.writeUInt32LE(4096, 0x38); b.writeUInt32LE(0xfffffffe, 0x3c); b.writeUInt32LE(0xfffffffe, 0x44); return b; };
const text = 'Hello synthetic world\nA second line, with <markup> & "quotes".\n' + 'x'.repeat(300) + '\n';
const seeds = {
    'wp5.bin': wp(0, 0, 0, text), 'wp51.bin': wp(0, 1, 0, text), 'wp6.bin': wp(2, 0, 0, text), 'wp7.bin': wp(2, 1, 0, text),
    'wp5_encrypted.bin': wp(0, 0, 0x1234, text), 'wp_mac.bin': wp(2, 0, 0, text, 1, 0x2c), 'wp_header_only.bin': wp(0, 0, 0, ''),
    'ole_ok_shift.bin': ole(9), 'ole_shift31.bin': ole(31), 'ole_shift0.bin': ole(0),
    'text.bin': Buffer.from(text), 'empty.bin': Buffer.alloc(0), 'ff_wpc_only.bin': Buffer.from([0xff, 0x57, 0x50, 0x43]),
    'macwrite_like.bin': Buffer.concat([Buffer.from([0x00, 0x06]), Buffer.alloc(256, 0x20), Buffer.from(text)]),
    'claris_like.bin': Buffer.concat([Buffer.alloc(4), Buffer.from('BOBO'), Buffer.alloc(512), Buffer.from(text)]),
    'works_dos_like.bin': Buffer.concat([Buffer.from([0xff, 0x00, 0x02, 0x00, 0x04, 0x04]), Buffer.alloc(200), Buffer.from(text)]),
};
for (const [n, b] of Object.entries(seeds)) fs.writeFileSync(path.join(out, n), b);
console.log(`${Object.keys(seeds).length} synthetic seeds in ${out}`);
