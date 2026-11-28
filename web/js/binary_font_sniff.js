// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
/**
 * binary_font_sniff.js
 * Recover the font families a LEGACY BINARY Office file asks for.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `.ppt`, `.doc` and `.xls` are OLE compound files, not ZIPs, so `FontExtractor`
 * (which unzips) cannot read them. `FontResolver` therefore took a shortcut for
 * every binary input: mount ESSENTIAL_FONT_FAMILIES and do NO font matching.
 *
 * That set is Liberation x3 + DejaVu x3 + Liberation Sans Narrow. **Carlito is
 * not in it** — so a document asking for Calibri, the Office default since 2007,
 * never had Carlito mounted and the engine drew DejaVu Sans, which is metrically
 * WIDER. Text then overruns the margins and is clipped.
 *
 * Found by human review 2026-08-23 on
 * `presentations/rmb170901_fellowship_workshop.ppt` p12/p27: "the line is
 * centered on the slide and runs off both at the left and right cutting off the
 * words. spaced too wide", and "text is slightly different size on all slides".
 * The deck asks for Arial, Calibri and Courier New; the output embedded
 * DejaVuSans and no Carlito.
 *
 * MOUNTING IS THE WHOLE FIX. Per web/CLAUDE.md, `Calibri -> Carlito` is a
 * hardcoded table in LibreOffice's `PhysicalFontCollection.cxx` — no fontconfig
 * rule is needed for the metric-compatible pairs. The engine simply cannot use a
 * face that was never mounted.
 *
 * HOW IT WORKS, AND WHY NOT THE OBVIOUS WAY
 * -----------------------------------------
 * ONE pass over the bytes, extracting printable runs (8-bit and UTF-16LE), then
 * an EXACT lookup of each run against the family set.
 *
 * The first cut instead searched the file once per family. Measured on the deck
 * above: **666 ms** for 110 families over 1.8 MB, and it matched `Rockwell` and
 * `ＭＳ Ｐゴシック` on incidental byte sequences — the latter would have mounted
 * a 3.85 MB CJK font for a document that never asked for one. Exact matching on
 * extracted tokens cannot do that, and it costs one pass instead of 110.
 */
const BinaryFontSniff = (function() {

    // Font names are short; anything longer is not one, and bounding the run
    // length keeps a pathological stretch of text cheap.
    const MAX_NAME = 64;
    const MIN_NAME = 3;

    const isPrintable = (b) => b >= 0x20 && b <= 0x7E;

    /**
     * @param {Uint8Array} bytes          the file (or a prefix of it)
     * @param {string[]}   knownFamilies  families the registry can substitute
     * @param {{keyComparisons:number}} [stats]  optional: counts the key comparisons made (tests assert the work is bounded)
     * @returns {string[]} families named by the document, in registry casing
     */
    function sniffBinaryFontFamilies(bytes, knownFamilies, stats) {
        if (!bytes || !bytes.length || !Array.isArray(knownFamilies)) return [];

        // Lower-cased lookup so casing in the file need not match the registry,
        // while the RESULT keeps the registry's casing (the matcher expects it).
        const want = new Map();
        for (const f of knownFamilies) {
            if (typeof f === 'string' && f.length >= MIN_NAME) want.set(f.toLowerCase(), f);
        }
        if (!want.size) return [];

        const hits = new Set();
        const n = bytes.length;

        // Family names are looked for INSIDE each extracted run, with
        // alphanumeric-boundary checks, rather than by exact-matching the whole
        // run. A run can pick up neighbours: an arbitrary byte followed by the
        // padding zero in front of a UTF-16 name decodes as a printable
        // character and glues onto it, turning "Calibri" into "HCalibri". Exact
        // matching then finds nothing — which is precisely how the first version
        // of this function failed its own test.
        //
        // Searching inside runs keeps the precision that matters: the candidate
        // text is real extracted text, not raw bytes, so incidental byte
        // sequences cannot masquerade as a font name the way they did when this
        // searched the file directly.
        const isAlnumChar = (c) => c !== '' && /[A-Za-z0-9]/.test(c);
        // BUG-81 (WAF review of #780): this runs on the page's main thread and in the MCP's event loop, and EVERY run of at least MIN_NAME characters used to be
        // compared with ALL the family keys, though nearly every key is longer than the run: a hostile 16 MB file of 3-character runs took 7.6 s. The keys are
        // sorted by length once; a run shorter than the shortest key returns at once, and the walk over the keys stops at the first key longer than the run.
        // The result is the same set of families (the keys skipped could not occur in the run).
        const wantByLen = Array.from(want).sort((a, b) => a[0].length - b[0].length);
        const minKey = wantByLen[0][0].length;
        const consider = (chars) => {
            if (chars.length < MIN_NAME || chars.length < minKey) return;
            const hay = chars.toLowerCase();
            for (const [key, canonical] of wantByLen) {
                if (key.length > hay.length) break;
                if (stats) stats.keyComparisons++;
                if (hits.has(canonical)) continue;
                let from = 0;
                for (;;) {
                    const i = hay.indexOf(key, from);
                    if (i < 0) break;
                    const before = i === 0 ? '' : hay[i - 1];
                    const after = hay[i + key.length] || '';
                    if (!isAlnumChar(before) && !isAlnumChar(after)) { hits.add(canonical); break; }
                    from = i + 1;
                }
            }
        };

        // A UTF-16 run can acquire exactly ONE spurious leading character: the
        // byte in front of the name pairs with the name's padding zero and
        // decodes as printable, so "Calibri" is extracted as e.g. "HCalibri".
        // The boundary check then rejects it, because 'H' is alphanumeric and
        // indistinguishable from a real prefix.
        //
        // So the run is also considered without its first character. Only one,
        // and only here: the 8-bit walk cannot glue this way, and stripping more
        // would start inventing names that are not in the file.
        const considerUtf16Run = (chars) => {
            consider(chars);
            if (chars.length > MIN_NAME) consider(chars.slice(1));
        };

        // --- 8-bit runs -----------------------------------------------------
        let run = '';
        for (let i = 0; i < n; i++) {
            const b = bytes[i];
            if (isPrintable(b)) {
                run += String.fromCharCode(b);
                if (run.length > MAX_NAME) run = run.slice(-MAX_NAME);
            } else {
                if (run) { consider(run); run = ''; }
            }
        }
        if (run) consider(run);

        // --- UTF-16LE runs, both alignments ---------------------------------
        // A name is not guaranteed to begin on an even offset in an OLE stream,
        // so both are walked. A run ends at the first non-printable unit.
        for (let start = 0; start < 2; start++) {
            let u = '';
            for (let i = start; i + 1 < n; i += 2) {
                const lo = bytes[i], hi = bytes[i + 1];
                if (hi === 0 && isPrintable(lo)) {
                    u += String.fromCharCode(lo);
                    if (u.length > MAX_NAME) u = u.slice(-MAX_NAME);
                } else {
                    if (u) { considerUtf16Run(u); u = ''; }
                }
            }
            if (u) considerUtf16Run(u);
        }

        return Array.from(hits);
    }


    // ------------------------------------------------------------------
    // PDF inputs (D3, owner decision 2026-10-18): the families a PDF's text is set in,
    // read from its font dictionaries' /BaseFont names, so the same substitutes as for a
    // DOCX are mounted (Carlito for Calibri, Caladea for Cambria, ...). Only /BaseFont is
    // read: never content streams or text, so a family named in the document's TEXT is
    // not taken as a request (why PDFs were left out of the byte sniff above). Font
    // dictionaries are plain objects or, since PDF 1.5, packed into object streams
    // (/Type /ObjStm, FlateDecode), which are inflated under an output cap; content
    // streams are never inflated. An encrypted PDF's object streams do not inflate and
    // are skipped (names in plain dictionaries are not encrypted).
    //
    // Normalisation: subset tags (ABCDEF+), PostScript suffixes (PS, MT, PSMT), style
    // suffixes after '-' or ','; the longer known family wins (Calibri-Light ->
    // Calibri Light). A name is kept only if it matches a known family, compared with
    // case, spaces and punctuation removed.

    const MAX_OBJSTM_INFLATED = 8 * 1024 * 1024;   // per object stream
    const MAX_TOTAL_INFLATED = 64 * 1024 * 1024;   // per document
    const MAX_OBJSTMS = 4096;
    const CHUNK = 8 * 1024 * 1024;
    // Every pass over the PDF bytes beyond the one plain scan (dictionary windows, endstream
    // searches) is charged here, so a crafted file cannot make the main thread rescan the
    // same bytes thousands of times (WAF review of #587: 4,096 indirect-/Length streams
    // without `endstream` took 223 s).
    const MAX_SCANNED = 64 * 1024 * 1024;
    const ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d];   // 'endstream'

    function compactName(s) {
        return String(s).toLowerCase().replace(/[^0-9a-z\u0080-￿]/g, '');
    }

    /** Decode a PDF name's bytes (after the slash): #xx escapes, then UTF-8 if valid, else Latin-1. */
    function decodeName(raw) {
        const bytes = [];
        for (let i = 0; i < raw.length; i++) {
            const c = raw.charCodeAt(i);
            if (c === 0x23 && i + 2 < raw.length + 0 && /^[0-9A-Fa-f]{2}$/.test(raw.substr(i + 1, 2))) {
                bytes.push(parseInt(raw.substr(i + 1, 2), 16));
                i += 2;
            } else {
                bytes.push(c & 0xff);
            }
        }
        const u8 = new Uint8Array(bytes);
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(u8);
        } catch (e) {
            return String.fromCharCode.apply(null, bytes);
        }
    }

    // PDF name characters end at whitespace or a delimiter.
    const BASEFONT_RE = /\/BaseFont\s*\/([^\s\/\[\]<>(){}%]+)/g;

    function scanText(text, out) {
        BASEFONT_RE.lastIndex = 0;
        let m;
        while ((m = BASEFONT_RE.exec(text)) !== null) out.add(decodeName(m[1]));
    }

    function latin1(bytes, start, end) {
        let s = '';
        for (let i = start; i < end; i += 0x8000) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 0x8000)));
        }
        return s;
    }

    /** First index of `pat` (byte array) in bytes[from, to), or -1. No string is built. */
    function indexOfBytes(bytes, pat, from, to) {
        const last = to - pat.length;
        for (let i = bytes.indexOf(pat[0], from); i !== -1 && i <= last; i = bytes.indexOf(pat[0], i + 1)) {
            let k = 1;
            while (k < pat.length && bytes[i + k] === pat[k]) k++;
            if (k === pat.length) return i;
        }
        return -1;
    }

    async function inflate(data, cap) {
        if (typeof DecompressionStream === 'undefined') return null;
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(data).catch(() => {});
        writer.close().catch(() => {});
        const reader = ds.readable.getReader();
        const parts = [];
        let n = 0;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                n += value.length;
                if (n > cap) { parts.push(value.subarray(0, value.length - (n - cap))); n = cap; reader.cancel().catch(() => {}); break; }
                parts.push(value);
            }
        } catch (e) {
            if (!n) return null;  // not deflate (encrypted, or another filter)
        }
        const out = new Uint8Array(n);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    /**
     * Every /BaseFont name in the PDF (decoded, not normalised).
     * @param {Uint8Array} bytes
     * @returns {Promise<string[]>}
     */
    async function readPdfBaseFontNames(bytes) {
        const names = new Set();
        const objStms = [];
        const OBJSTM_RE = /\/Type\s*\/ObjStm\b/g;
        // Plain objects: scan in overlapping chunks (a name never spans more than 256 bytes here).
        for (let start = 0; start < bytes.length; start += CHUNK) {
            const end = Math.min(bytes.length, start + CHUNK + 256);
            const text = latin1(bytes, start, end);
            scanText(text, names);
            OBJSTM_RE.lastIndex = 0;
            let m;
            while ((m = OBJSTM_RE.exec(text)) !== null) {
                const at = start + m.index;
                if (m.index < CHUNK && objStms.length < MAX_OBJSTMS) objStms.push(at);
            }
        }
        // Object streams: the stream data follows the dictionary's `stream` keyword.
        let total = 0;
        let scanned = 0;
        let noEndstreamFrom = Infinity;   // an endstream search reached EOF from here: none later
        for (const at of objStms) {
            if (total >= MAX_TOTAL_INFLATED || scanned >= MAX_SCANNED) break;
            // The dictionary may hold /Type /ObjStm anywhere: read it from its object's start.
            const back = Math.max(0, at - 2048);
            const before = latin1(bytes, back, at);
            const objAt = before.lastIndexOf(' obj');
            const from = objAt >= 0 ? back + objAt : at;
            const lookEnd = Math.min(bytes.length, at + 4096);
            const look = latin1(bytes, from, lookEnd);
            scanned += (at - back) + (lookEnd - from);
            const s = look.search(/stream(\r\n|\n|\r)/);
            const e = look.indexOf('endobj');
            if (s < 0 || (e >= 0 && e < s)) continue;
            const dict = look.slice(0, s);
            if (!/\/FlateDecode\b/.test(dict)) continue;
            // A filter chain (/Filter [/A /B]) is not plain deflate: skip it. Linear: one
            // array, read to its closing bracket.
            const fi = dict.search(/\/Filter\s*\[/);
            if (fi >= 0) {
                const open = dict.indexOf('[', fi);
                const close = dict.indexOf(']', open);
                const arr = dict.slice(open + 1, close < 0 ? dict.length : close);
                if ((arr.match(/\/[A-Za-z0-9]+/g) || []).length > 1) continue;
            }
            const dataStart = from + s + look.slice(s).match(/^stream(\r\n|\n|\r)/)[0].length;
            // (?!\d): without it "/Length 12 0 R" read as a direct length of 1.
            const lenM = /\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)/.exec(dict);
            let dataEnd;
            if (lenM) {
                dataEnd = Math.min(bytes.length, dataStart + parseInt(lenM[1], 10));
            } else {
                // Indirect /Length: find endstream in the bytes, within the shared budget.
                if (dataStart >= noEndstreamFrom) continue;
                const limit = Math.min(bytes.length, dataStart + MAX_OBJSTM_INFLATED, dataStart + (MAX_SCANNED - scanned));
                const k = indexOfBytes(bytes, ENDSTREAM, dataStart, limit);
                scanned += (k < 0 ? limit : k) - dataStart;
                if (k < 0) {
                    if (limit === bytes.length) noEndstreamFrom = dataStart;
                    continue;
                }
                dataEnd = k;
            }
            const cap = Math.min(MAX_OBJSTM_INFLATED, MAX_TOTAL_INFLATED - total);
            const out = await inflate(bytes.subarray(dataStart, dataEnd), cap);
            if (!out) continue;
            total += out.length;
            scanText(latin1(out, 0, out.length), names);
        }
        return Array.from(names);
    }

    /**
     * Map PostScript /BaseFont names to known families.
     * @param {string[]} baseFonts
     * @param {string[]} knownFamilies
     * @returns {string[]} known family names, in first-seen order, deduplicated
     */
    function familyIndex(knownFamilies) {
        const byKey = new Map();
        for (const f of knownFamilies || []) {
            const k = compactName(f);
            if (k && !byKey.has(k)) byKey.set(k, f);
        }
        return byKey;
    }

    /** The known family one /BaseFont name names, or null (byKey from familyIndex). */
    function familyOf(raw, byKey) {
        const strip = (s) => s.replace(/(psmt|mt|ps)$/, '');
        const name = String(raw).replace(/^[A-Z]{6}\+/, '');
        const full = compactName(name);
        const b = compactName(name.split(/[,-]/)[0]);
        for (const c of [full, strip(full), b, strip(b)]) {
            if (c && byKey.has(c)) return byKey.get(c);
        }
        return null;
    }

    function familiesFromPdfBaseFonts(baseFonts, knownFamilies) {
        const byKey = familyIndex(knownFamilies);   // once, not per name (WAF review, item C)
        const out = [];
        const seen = new Set();
        for (const raw of baseFonts || []) {
            const fam = familyOf(raw, byKey);
            if (fam && !seen.has(fam)) { seen.add(fam); out.push(fam); }
        }
        return out;
    }

    /**
     * The faces each known family is used in, from the style part of its /BaseFont names
     * (Calibri-Bold, Arial,BoldItalic, TimesNewRomanPS-BoldItalicMT, Arial-ItalicMT ...).
     * A name with no style part is Regular. Semibold/Demi/Black/Heavy count as bold, and
     * Oblique as italic. Used to mount only the faces a PDF draws in.
     * @returns {Object<string, string[]>} family -> faces ('regular'|'bold'|'italic'|'bolditalic')
     */
    function pdfFamilyFaces(baseFonts, knownFamilies) {
        const out = {};
        const byKey = familyIndex(knownFamilies);
        for (const raw of baseFonts || []) {
            const fam = familyOf(raw, byKey);
            if (!fam) continue;
            const name = String(raw).replace(/^[A-Z]{6}\+/, '');
            const cut = name.search(/[,-]/);
            let style = cut >= 0 ? name.slice(cut + 1).toLowerCase() : '';
            // A style that is part of the family's own name (Segoe UI Semibold,
            // Calibri Light) names the family, not a face of it.
            if (style && compactName(fam).endsWith(compactName(style).replace(/(psmt|mt|ps)$/, ''))) style = '';
            const bold = /bold|semibold|demi|black|heavy/.test(style);
            const italic = /italic|oblique|\bit\b/.test(style);
            const face = bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
            (out[fam] = out[fam] || new Set()).add(face);
        }
        for (const k of Object.keys(out)) out[k] = Array.from(out[k]).sort();
        return out;
    }
    return { sniffBinaryFontFamilies, readPdfBaseFontNames, familiesFromPdfBaseFonts, pdfFamilyFaces, MAX_NAME, MIN_NAME };
})();

if (typeof self !== 'undefined') self.BinaryFontSniff = BinaryFontSniff;
if (typeof window !== 'undefined') window.BinaryFontSniff = BinaryFontSniff;
if (typeof module !== 'undefined' && module.exports) module.exports = BinaryFontSniff;
