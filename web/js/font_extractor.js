// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
/**
 * font_extractor.js
 * Extracts font names from document files (DOCX, XLSX, PPTX, ODT, ODS, ODP)
 * by parsing the internal XML structure of these ZIP-based formats.
 *
 * Dependencies: JSZip (loaded from vendor/jszip.min.js)
 */

const FontExtractor = (function() {
    'use strict';

    // Track JSZip availability
    let jsZipLoaded = false;

    /**
     * Ensure JSZip is loaded
     */
    async function ensureJSZip() {
        if (jsZipLoaded || typeof JSZip !== 'undefined') {
            jsZipLoaded = true;
            return true;
        }

        // Try to dynamically load JSZip if not available
        if (typeof importScripts === 'function') {
            // In a worker context
            try {
                importScripts('/js/vendor/jszip.min.js');
                jsZipLoaded = true;
                return true;
            } catch (e) {
                console.warn('[FontExtractor] Failed to load JSZip in worker:', e);
                return false;
            }
        } else {
            // In browser context - should already be loaded
            console.warn('[FontExtractor] JSZip not available');
            return false;
        }
    }

    /**
     * Supported file formats for font extraction
     */
    const EXTRACTABLE_FORMATS = [
        'docx', 'docm', 'dotx', 'dotm',  // Word
        'xlsx', 'xlsm', 'xltx', 'xltm',  // Excel
        'pptx', 'pptm', 'potx', 'potm', 'ppsx',  // PowerPoint
        'odt', 'ods', 'odp', 'odg'       // OpenDocument
    ];

    /**
     * Formats that NAME fonts in plain text rather than inside a ZIP.
     *
     * These went unmatched for as long as the font system has existed, because
     * extraction was written around JSZip and nothing else was tried. The cost
     * was not "no substitution" but the same collapse FM-3 fixed for DOCX —
     * measured before this was added, with one paragraph per family:
     *
     *   HTML naming Futura / Gill Sans / Georgia -> all three drawn DejaVuSans
     *   RTF  naming Futura / Gill Sans / Georgia -> all three drawn DejaVuSerif
     *
     * Note the direction is wrong both ways: a serif request drawn sans in HTML,
     * two sans requests drawn serif in RTF. And because nothing was matched, the
     * resolver fell back to the generic essential set — 8.04 MB — for documents
     * naming three families we ship exact substitutes for, so matching is
     * expected to REDUCE bytes as well as fix the typeface.
     *
     * DOC/XLS/PPT name fonts too but are OLE2 binary; they are a separate piece
     * of work and are deliberately not claimed here.
     */
    const TEXT_FORMATS = ['html', 'htm', 'xhtml', 'rtf'];

    /**
     * Check if a file format supports font extraction
     */
    function canExtractFonts(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        return EXTRACTABLE_FORMATS.includes(ext) || TEXT_FORMATS.includes(ext);
    }

    // ------------------------------------------------------------------
    // F-6: bound what an untrusted archive can make us decompress.
    //
    // Every read below is of a ZIP entry from a file a stranger may have sent
    // the user. `.async('string')` materialises the ENTIRE inflated entry in
    // the tab's memory, so a small archive declaring a huge, highly
    // compressible part (XML compresses ~1000:1 — measured 1025:1 on a trivial
    // fixture) can exhaust memory. That failure is NOT catchable: an OOM kills
    // the tab, so the try/catch around extractFonts() cannot save it, and the
    // user loses the conversion with no message. It is their own tab, not a
    // server, but "works on first try" and "no silent failures" both fail.
    //
    // WHAT ACTUALLY STOPS EACH CASE (measured 2026-07-26, not assumed):
    //   * Honest bomb — declares its true, huge uncompressedSize. Caught HERE by
    //     the declared-size check below, for free, without inflating anything.
    //     This is the normal case: a ZIP records the real size because that is
    //     how decompressors size their output.
    //   * Lying bomb — central directory under-declares (say 1 KB) while the
    //     entry inflates to gigabytes. The size check is fooled, but JSZip's OWN
    //     integrity check then throws "uncompressed data size mismatch" and our
    //     error handler yields ''. Verified: the cap warning below never fires
    //     for this case, so do NOT claim the cap is what saves us here.
    //
    // The streaming read is therefore defence-in-depth, not the primary guard:
    // its job is to bound what WE retain, so a part we are going to reject never
    // becomes a 17 MB string in this tab first. Kept because it is cheap and the
    // failure it guards against (OOM) cannot be caught or reported.
    //
    // RESIDUAL LIMITATION, stated rather than hidden: pausing the stream does
    // not halt JSZip's inflate, so a lying header still costs the CPU of
    // decompressing the whole entry before anything rejects it. This bounds what
    // we RETAIN, not wall-clock, and it does not bound JSZip's own transient
    // allocations during inflate. A determined lying bomb can still make
    // extraction slow.
    const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
    // Wall-clock bound per entry, so a stream that never ends cannot hang the
    // conversion silently. Generous: a legitimate 16 MB inflate is far quicker.
    const READ_TIMEOUT_MS = 30 * 1000;

    /**
     * Size-checked binary read, for embedded FONT payloads.
     *
     * The text reader below is not usable for these (fonts are not text), but
     * they are just as attacker-controlled: an entry declaring a small size and
     * inflating to gigabytes would OOM the tab exactly the same way. Reported by
     * review — the first version of this file guarded every XML read and then
     * read font bytes with a bare .async(), which left the hole open in the very
     * change that closed it everywhere else.
     * @returns {Promise<Uint8Array|null>} null when missing or over budget
     */
    async function readEntryBytes(entry, label) {
        if (!entry) return null;
        const declared = entry._data && entry._data.uncompressedSize;
        if (typeof declared === 'number' && declared > MAX_ENTRY_BYTES) {
            console.warn(
                `[FontExtractor] Skipping oversized embedded font ${label}: declares ` +
                `${(declared / 1048576).toFixed(1)} MB (cap ${MAX_ENTRY_BYTES / 1048576} MB).`
            );
            return null;
        }
        try {
            const bytes = await entry.async('uint8array');
            if (bytes && bytes.length > MAX_ENTRY_BYTES) {
                console.warn(`[FontExtractor] Embedded font ${label} exceeded the cap once inflated — ignored.`);
                return null;
            }
            return bytes;
        } catch (e) {
            return null;   // corrupt entry: not self-supplied, so we download
        }
    }

    /**
     * Read a ZIP entry as text with a hard size bound. Returns '' when the
     * entry is missing or over budget — never throws, and never returns a
     * partially-truncated part as if it were whole (a clipped XML document
     * would silently lose the font declarations at its tail).
     * @param {Object} entry - a JSZip ZipObject
     * @param {string} label - path, for the warning
     * @returns {Promise<string>}
     */
    async function readEntryText(entry, label) {
        if (!entry) return '';
        const declared = entry._data && entry._data.uncompressedSize;
        if (typeof declared === 'number' && declared > MAX_ENTRY_BYTES) {
            console.warn(
                `[FontExtractor] Skipping oversized part ${label}: declares ` +
                `${(declared / 1048576).toFixed(1)} MB (cap ${MAX_ENTRY_BYTES / 1048576} MB). ` +
                `Font names from this part are not read; substitution still works.`
            );
            return '';
        }
        if (typeof entry.internalStream !== 'function') {
            // Older/!full JSZip build: fall back to the declared-size check only.
            return entry.async('string');
        }
        return new Promise((resolve) => {
            let out = '';
            let over = false;
            let settled = false;
            // A stream that emits neither 'end' nor 'error' would leave this
            // Promise pending forever. Font extraction runs BEFORE doConversion,
            // so no stall timer covers it — the conversion would hang with no
            // error at all, which is the one outcome this project forbids
            // outright. Bound it: extraction is an optimisation, and losing it
            // costs a broader font set, not the document.
            const done = (value, note) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (note) console.warn(`[FontExtractor] ${note}`);
                resolve(value);
            };
            const timer = setTimeout(
                () => done('', `Timed out reading ${label} — skipped.`),
                READ_TIMEOUT_MS);

            const stream = entry.internalStream('string');
            stream.on('data', (chunk) => {
                if (over || settled) return;           // stop RETAINING past the cap
                if (out.length + chunk.length > MAX_ENTRY_BYTES) {
                    over = true;
                    out = '';                          // release: the part is unusable
                    return;
                }
                out += chunk;
            });
            stream.on('error', () => done(''));
            stream.on('end', () => done(
                out,
                over
                    ? `Part ${label} exceeded ${MAX_ENTRY_BYTES / 1048576} MB while ` +
                      `inflating (its header under-declared the size) — skipped.`
                    : null
            ));
            stream.resume();
        });
    }

    // ------------------------------------------------------------------
    // Self-supplied (embedded) fonts.
    //
    // PROVEN 2026-07-26 in this WASM build: LibreOffice's embedded-font import
    // works, on BOTH the plain-ODF path and the obfuscated-OOXML path, with no
    // patch and no code change. Converting a document that carries its own font
    // produces a PDF embedding THAT font (verified by PostScript name), while
    // the same document with the font stripped falls back to a substitute.
    //
    // Consequence for bandwidth (the dominant production cost): for a family the
    // document supplies itself, downloading our substitute from the CDN is pure
    // waste — the engine will not use it. Detecting those families lets us skip
    // the fetch. The FIDELITY win needs no code at all; it already happens.
    //
    // THE ACCEPTANCE RULE IS NOT OURS TO INVENT. vcl/source/gdi/embeddedfontshelper.cxx
    // refuses an embedded font unless sufficientTTFRights(..., EditingAllowed):
    //     return copyright == 0 || ( copyright & 0x08 );
    // where `copyright` is the OS/2 fsType. If we skipped a download for a font
    // the engine then REFUSES, the user gets a substitute we never fetched —
    // i.e. tofu or the wrong face. So we mirror that exact rule, and we suppress
    // ONLY on positive proof: anything we cannot parse means "download it".
    // ------------------------------------------------------------------
    // LINEAR-TIME SCANNING (ReDoS follow-up to #572). A lazy `<x>[\s\S]*?</x>` block
    // pattern, or a `[^>]*` that may cross '<', rescans to the end of the input from
    // every unclosed opener: quadratic, so a crafted part of a few hundred KB froze the
    // tab for seconds to minutes. Two rules keep every scanner linear with the same
    // matches on well-formed XML:
    //  - a tag's attribute list never crosses '<' ([^<>], and no '<' in a quoted value:
    //    XML attribute values cannot hold one);
    //  - a block pattern scans only up to the LAST closer (untilLast): no match can end
    //    after it, so the cut changes nothing it could find.
    function untilLast(text, closer) {
        const s = text || '';
        const i = s.lastIndexOf(closer);
        return i < 0 ? '' : s.slice(0, i + closer.length);
    }

    /** untilLast for a closer given as a (global, linear) pattern, e.g. <\/(?:\w+:)?font>. */
    function untilLastMatch(text, closerRe) {
        const s = text || '';
        let end = -1;
        for (const m of s.matchAll(closerRe)) end = m.index + m[0].length;
        return end < 0 ? '' : s.slice(0, end);
    }

    /**
     * Element bodies for a forward scan over `xml`, in linear time (WAF review of #588).
     * Returns body(qname, pos): the text from `pos` (just after a non-self-closing opener)
     * to the FIRST `</qname>`, or '' when there is none or another `<qname` opener comes
     * first (these elements do not nest, so that is the same body as before for every
     * well-formed element). Lookups are cached: positions only move forward, so a cached
     * hit at or after `pos` is still the first one, and no span is searched twice.
     */
    function elementBodies(xml) {
        const cache = new Map();
        const find = (key, re, pos) => {
            let c = cache.get(key);
            if (c === undefined || (c !== -1 && c < pos)) {
                re.lastIndex = pos;
                const m = re.exec(xml);
                c = m ? m.index : -1;
                cache.set(key, c);
            }
            return c;
        };
        const res = new Map();
        return (qname, pos) => {
            let r = res.get(qname);
            if (!r) {
                const q = qname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                r = { close: new RegExp('</' + q + '>', 'g'), open: new RegExp('<' + q + '(?=[\\s>/])', 'g') };
                res.set(qname, r);
            }
            const close = find('c:' + qname, r.close, pos);
            if (close === -1) return '';
            const open = find('o:' + qname, r.open, pos);
            if (open !== -1 && open < close) return '';
            return xml.slice(pos, close);
        };
    }

    /** Apply `re` (global) with `fn` to `text` up to its last `closer`, the rest unchanged. */
    function replaceUntilLast(text, closer, re, fn) {
        const head = untilLast(text, closer);
        return head.replace(re, fn) + (text || '').slice(head.length);
    }

    /**
     * Id -> Target pairs of a .rels part, in document order. Each <Relationship> element
     * is read on its own (it cannot cross '<'), and within it, as the old
     * Id="…"[^>]*Target="…" did, the first Id and the last Target after it.
     */
    function relationshipTargets(rels) {
        const out = [];
        for (const el of (rels || '').matchAll(/<(?:\w+:)?Relationship\b([^<>]*)>/g)) {
            const a = el[1];
            const id = /Id="([^"]+)"/.exec(a);
            if (!id) continue;
            let target = null;
            for (const t of a.slice(id.index + id[0].length).matchAll(/Target="([^"]+)"/g)) target = t[1];
            if (target !== null) out.push([id[1], target]);
        }
        return out;
    }

    const FSTYPE_EDITABLE_BIT = 0x08;

    /**
     * Read OS/2 fsType from sfnt bytes. Returns null when the font cannot be read.
     * A readable font with NO rights information (no OS/2 table, or one shorter than the
     * 42 bytes the engine requires) returns 0: the engine reads it as Installable
     * (GetTTGlobalFontInfo leaves typeFlags 0), and so does the owner's rule
     * (docs/fonts/embedded-font-rights.md: the user supplied the file).
     */
    function readFsType(bytes) {
        // NTH-13: the one implementation lives in ConversionProtocol (the conversion worker needs it too, and the
        // worker does not load this file). Without it a font is "unreadable": not claimed, so its substitute is fetched.
        const P = sharedFontRights();
        return P ? P.readSfntFsType(bytes) : null;
    }

    /**
     * The engine's rights rule, mirrored exactly (docs/fonts/embedded-font-rights.md;
     * engine/patches/*embedded-fonts-pdf-only-viewing-rights-wasm.patch):
     *  - usage permission (bits 0-3): when several are set, the LEAST restrictive wins
     *    (OpenType OS/2 spec, fsType, "Version differences"), so 0x0A and 0x0E are
     *    Editable; only Restricted on its own (0x02) is "not used";
     *  - every output: Installable, Editable or Preview & Print (owner, 2026-10-22);
     *  - 0x100 (no subsetting) refuses only where the font is subsetted: PDF output;
     *  - 0x200 (bitmap embedding only) refuses for every output.
     * A font with no rights information arrives here as 0 (readFsType). An unreadable
     * font (null) is not claimed, so its substitute is still fetched.
     */
    const FSTYPE_RESTRICTED_BIT = 0x0002;
    const FSTYPE_PREVIEW_PRINT_BIT = 0x0004;
    const FSTYPE_NO_SUBSETTING_BIT = 0x0100;
    const FSTYPE_BITMAP_ONLY_BIT = 0x0200;
    function engineWillAcceptEmbedded(fsType, pdfOnly) {
        // NTH-13: single source in ConversionProtocol (see readFsType); unknown or absent means refused (fail safe).
        const P = sharedFontRights();
        return P ? P.engineWillAcceptEmbedded(fsType, pdfOnly) : false;
    }

    /** ConversionProtocol: the page and the worker have it as a global; node unit tests require it. */
    function sharedFontRights() {
        const P = (typeof window !== 'undefined' && window.ConversionProtocol)
            || (typeof self !== 'undefined' && self.ConversionProtocol)
            || (typeof module !== 'undefined' && module.exports && typeof require === 'function' ? require('./conversion_protocol.js') : null);
        return P && typeof P.readSfntFsType === 'function' && typeof P.engineWillAcceptEmbedded === 'function' ? P : null;
    }

    // ------------------------------------------------------------------
    // EOT (Embedded OpenType) — the wrapper PPTX uses. A PPTX's embedded fonts
    // suppress their substitute download only because this build's engine decodes
    // EOT (FG-054, 2026-10-29); until then they were detected here but never did.
    //
    // WHAT .fntdata ACTUALLY IS, determined from the bytes rather than assumed:
    // the 10 real `ppt/fonts/*.fntdata` parts in this repo's corpus
    // (test_corpus/fixtures/presentations/Graduate and Undergraduate Funding
    // Brown Bag 3_31_21.pptx — 8 of them — plus BoldonseFontEmbedded.pptx and
    // multiplelayoutfooter.pptx) every one begins with a little-endian uint32
    // that equals the part's own byte length, followed by FontDataSize, then
    // Version 0x00020002, and carries 0x504C — the EOT magic number — at offset
    // 34. None of them starts with an sfnt tag (0x00010000/'true'/'OTTO'), and
    // none is an OOXML-obfuscated TTF either: de-obfuscation needs a fontKey
    // GUID and PresentationML has no such attribute. Their Flags word is
    // 0x00000004 (TTEMBED_TTCOMPRESSED) or 0x00000005 (+TTEMBED_SUBSET), i.e.
    // the payload after the header is MicroType-Express COMPRESSED — so even
    // the OS/2 table is unreachable without an EOT decoder. The rights byte we
    // need is in the EOT header itself (fsType, uint16 at offset 32). The engine
    // (owner, 2026-10-29) judges the DECODED font's own OS/2 fsType with the same
    // rule as every other embedded font, so EOT and sfnt answer alike. It requires
    // the HEADER's fsType (the one read here) AND the decoded font's own OS/2 fsType
    // to pass. We see only the header, so we can never skip a substitute for a font
    // the engine refuses on the header; if the font's own table forbids what the
    // header allows, the worst case is one extra conversion (PR #580's retry),
    // never a missing glyph.
    //
    // WHY THIS IS A SWITCH (it was off until FG-054). oox/source/ppt/EmbeddedFontListContext.cxx
    // calls EmbeddedFontsHelper::addEmbeddedFont(..., /*eot=*/true), and in
    // vcl/source/gdi/embeddedfontshelper.cxx the ONLY thing that can set
    // `sufficientFontRights` for an eot stream lives inside `#if ENABLE_EOT`.
    // A build with ENABLE_EOT = 0 (libreoffice/config_host/config_eot.h; every
    // build until FG-054) never even writes the font out, `sufficientFontRights`
    // stays false, and the engine deletes it and substitutes. MEASURED end to end
    // on 2026-07-27, on a build without it, three independent ways:
    //   * test_corpus/fixtures/edge_cases/embedded_fonts/embedded_font.pptx
    //     (embeds Ubuntu-R as ZZEmbedTestFace) -> PDF embeds LiberationSans,
    //     byte-identical font list to embedded_font_control.pptx, which embeds
    //     nothing at all;
    //   * a real-world deck, BoldonseFontEmbedded.pptx (slide text set in the
    //     embedded "Boldonse") -> PDF embeds Carlito;
    //   * the control that proves the method can see a used embedded font:
    //     embedded_font.docx through the same harness -> PDF embeds
    //     Ubuntu-Regular, the document's own face.
    // Suppressing a download on such a build would have handed the user a face we
    // did not fetch and the engine refused — silent tofu, which is why this constant
    // existed and was false.
    //
    // FG-054 (2026-10-19, interim owner decision, option A): while libeot's decoder
    // was memory-unsafe on hostile input, EOT did not ship and a PPTX kept
    // downloading its substitutes. (2026-10-29, owner's go): the presentations module
    // is built with --enable-eot and libeot carrying the patches in
    // engine/patches/*libeot-hardening*presentations.patch.
    //
    // WHETHER IT DECODES IS THE HOST'S CHOICE, so this is too. The engine decodes EOT
    // only when INIT.allowEmbeddedEot is true (engine patch
    // embedded-fonts-eot-runtime-switch; the worker sets LO_WASM_ALLOW_EOT). The
    // website's driver sends it; the MCP, which loads this same file, sends nothing
    // and so gets an engine that refuses EOT. For such a host, skipping a PPTX's
    // substitute downloads would be silent tofu. Hence the DEFAULT here is false, and
    // a caller that has switched the engine on says so with options.acceptEot
    // (FontResolver passes it on; the driver sends both from
    // ConversionProtocol.WEBSITE_ACCEPTS_EMBEDDED_EOT).
    //
    // Gate embedded_font_import fails if that constant and the real engine disagree,
    // in either direction. And if the engine refuses a face we counted on anyway (a
    // decoding failure, or a rights rule our mirror missed), the driver's
    // post-conversion check (FG-054, PR #580, verifyEmbeddedFonts) converts once more
    // with every substitute.
    const ENGINE_ACCEPTS_EOT_EMBEDDED = false;
    // EOT header Flags bit 0: the payload is a subset (TTEMBED_SUBSET). Until the
    // owner decides D1 (can a subset lack a glyph we draw?), a subset face does
    // not suppress its substitute download: the substitute is the safety net.
    const TTEMBED_SUBSET = 0x00000001;
    const EOT_MAGIC = 0x504C;

    /**
     * fsType out of an EOT header. Returns null when the bytes are not a
     * plausible EOT — which, like every other unknown here, means "download it".
     */
    /** EOT header Flags (uint32 at offset 12), or 0xFFFFFFFF when not a plausible EOT. */
    function readEotFlags(bytes) {
        if (readEotFsType(bytes) === null) return 0xFFFFFFFF;
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
    }

    function readEotFsType(bytes) {
        try {
            if (!bytes || bytes.length < 36) return null;
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            if (dv.getUint16(34, true) !== EOT_MAGIC) return null;
            const eotSize = dv.getUint32(0, true);
            // The header's own length field must agree with the part we read.
            // Every real sample satisfies this exactly; a mismatch means we are
            // not looking at what we think we are looking at.
            if (eotSize !== bytes.length) return null;
            const version = dv.getUint32(8, true);
            if (version !== 0x00010000 && version !== 0x00020001 && version !== 0x00020002) {
                return null;
            }
            return dv.getUint16(32, true);
        } catch (e) {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // CMAP COVERAGE (NTH-07 / script fonts).
    //
    // A document that embeds a font covering the script it contains does not
    // need our script font at all — and those are the expensive ones
    // (DroidSansFallbackFull 3.85 MB, NanumGothic 2.05 MB, NotoEmoji 1.98 MB).
    // But script fonts are PROTECTED in the download budget precisely because
    // dropping one produces tofu, a correctness failure. So the only evidence
    // that may drop one is the font's OWN cmap saying it draws the code points
    // the document actually contains.
    //
    // OVERCLAIMING IS THE FAILURE MODE, so the parse is deliberately narrow:
    //   * only the best UNICODE subtable is read (format 12 preferred, else
    //     format 4). A (3,0) symbol subtable maps F0xx and would claim coverage
    //     it does not have;
    //   * format 4 is resolved code by code (at most 64 K steps) and a code
    //     whose glyph id works out to 0 is NOT counted — .notdef is a box;
    //   * anything unparseable returns null, which callers must read as "prove
    //     nothing".
    // ------------------------------------------------------------------

    /** Offset+length of one sfnt table, or null. */
    function findSfntTable(bytes, dv, want) {
        if (!bytes || bytes.length < 12) return null;
        const tag0 = dv.getUint32(0);
        if (tag0 !== 0x00010000 && tag0 !== 0x74727565 && tag0 !== 0x4F54544F) return null;
        const numTables = dv.getUint16(4);
        for (let i = 0; i < numTables; i++) {
            const rec = 12 + i * 16;
            if (rec + 16 > bytes.length) return null;
            const tag = String.fromCharCode(
                bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
            if (tag === want) {
                const off = dv.getUint32(rec + 8);
                const len = dv.getUint32(rec + 12);
                if (off + 4 > bytes.length) return null;
                return { offset: off, length: len };
            }
        }
        return null;
    }

    /**
     * @returns {{has:function(number):boolean}|null} the code points this font
     *   maps to a real (non-zero) glyph. null when it could not be determined.
     */
    function readCmapCoverage(bytes) {
        try {
            if (!bytes || bytes.length < 12) return null;
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const cmap = findSfntTable(bytes, dv, 'cmap');
            if (!cmap) return null;
            const base = cmap.offset;
            if (base + 4 > bytes.length) return null;
            const numSub = dv.getUint16(base + 2);

            let best = null, bestRank = 0;
            for (let i = 0; i < numSub; i++) {
                const rec = base + 4 + i * 8;
                if (rec + 8 > bytes.length) break;
                const platform = dv.getUint16(rec);
                const encoding = dv.getUint16(rec + 2);
                const off = base + dv.getUint32(rec + 4);
                if (off + 4 > bytes.length) continue;
                const format = dv.getUint16(off);
                // Unicode subtables only: (0,*) is Unicode by definition,
                // (3,1) is Windows BMP Unicode, (3,10) is Windows full Unicode.
                const unicode = platform === 0 ||
                                (platform === 3 && (encoding === 1 || encoding === 10));
                if (!unicode) continue;
                const rank = format === 12 ? 3 : (format === 4 ? 2 : 0);
                if (rank > bestRank) { bestRank = rank; best = { off, format }; }
            }
            if (!best) return null;

            if (best.format === 12) {
                const nGroups = dv.getUint32(best.off + 12);
                const ranges = [];
                for (let g = 0; g < nGroups; g++) {
                    const rec = best.off + 16 + g * 12;
                    if (rec + 12 > bytes.length) return null;
                    const start = dv.getUint32(rec);
                    const end = dv.getUint32(rec + 4);
                    const startGlyph = dv.getUint32(rec + 8);
                    if (end < start) continue;
                    // startGlyph 0 makes the FIRST code of the group .notdef.
                    const lo = startGlyph === 0 ? start + 1 : start;
                    if (lo <= end) ranges.push([lo, end]);
                }
                if (!ranges.length) return null;
                ranges.sort((a, b) => a[0] - b[0]);
                return { has: (cp) => rangesHave(ranges, cp) };
            }

            // format 4
            const segX2 = dv.getUint16(best.off + 6);
            const segs = segX2 >> 1;
            if (!segs) return null;
            const endBase = best.off + 14;
            const startBase = endBase + segX2 + 2;
            const deltaBase = startBase + segX2;
            const rangeOffBase = deltaBase + segX2;
            if (rangeOffBase + segX2 > bytes.length) return null;
            const set = new Set();
            for (let s = 0; s < segs; s++) {
                const end = dv.getUint16(endBase + s * 2);
                const start = dv.getUint16(startBase + s * 2);
                const delta = dv.getInt16(deltaBase + s * 2);
                const rangeOff = dv.getUint16(rangeOffBase + s * 2);
                if (start > end || start === 0xFFFF) continue;
                for (let cp = start; cp <= end; cp++) {
                    let glyph;
                    if (rangeOff === 0) {
                        glyph = (cp + delta) & 0xFFFF;
                    } else {
                        const gi = rangeOffBase + s * 2 + rangeOff + (cp - start) * 2;
                        if (gi + 2 > bytes.length) { glyph = 0; }
                        else {
                            glyph = dv.getUint16(gi);
                            if (glyph !== 0) glyph = (glyph + delta) & 0xFFFF;
                        }
                    }
                    if (glyph !== 0) set.add(cp);
                }
            }
            if (!set.size) return null;
            return { has: (cp) => set.has(cp) };
        } catch (e) {
            return null;
        }
    }

    function rangesHave(ranges, cp) {
        let lo = 0, hi = ranges.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (cp < ranges[mid][0]) hi = mid - 1;
            else if (cp > ranges[mid][1]) lo = mid + 1;
            else return true;
        }
        return false;
    }

    /**
     * Non-empty glyph count, mirroring the check LibreOffice applies to a font
     * a DOCX declares SUBSETTED (embeddedfontshelper.cxx: fewer than 26
     * non-empty glyphs => "Ignoring embedded font", substitute instead).
     * Returns null when it cannot be counted — a CFF/OTTO font has no `loca`,
     * and OpenTTFontBuffer fails there too, which the engine scores as 0 glyphs.
     */
    function countNonEmptyGlyphs(bytes) {
        try {
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const head = findSfntTable(bytes, dv, 'head');
            const maxp = findSfntTable(bytes, dv, 'maxp');
            const loca = findSfntTable(bytes, dv, 'loca');
            if (!head || !maxp || !loca) return null;
            if (head.offset + 52 > bytes.length || maxp.offset + 6 > bytes.length) return null;
            const longLoca = dv.getInt16(head.offset + 50) !== 0;
            const numGlyphs = dv.getUint16(maxp.offset + 4);
            const step = longLoca ? 4 : 2;
            if (loca.offset + (numGlyphs + 1) * step > bytes.length) return null;
            const at = (i) => longLoca
                ? dv.getUint32(loca.offset + i * 4)
                : dv.getUint16(loca.offset + i * 2) * 2;
            let n = 0;
            for (let i = 0; i < numGlyphs; i++) if (at(i) !== at(i + 1)) n++;
            return n;
        } catch (e) {
            return null;
        }
    }

    /** The engine's subsetted-font rule, mirrored. Unknown => refuse. */
    const MIN_SUBSET_GLYPHS = 26;
    function engineWillAcceptSubsetted(bytes, pdfOnly) {
        // D4: for PDF-only output the engine needs 1 drawable glyph instead of 26.
        const n = countNonEmptyGlyphs(bytes);
        return typeof n === 'number' && n >= (pdfOnly ? 1 : MIN_SUBSET_GLYPHS);
    }

    /**
     * Undo OOXML font obfuscation over the first 32 bytes.
     * The key is the fontKey GUID's 16 bytes, REVERSED, applied twice.
     */
    function deobfuscateOdttfHead(bytes, fontKeyGuid) {
        const hex = (fontKeyGuid || '').replace(/[{}\-]/g, '');
        if (hex.length !== 32) return null;
        const key = new Uint8Array(16);
        for (let i = 0; i < 16; i++) key[i] = parseInt(hex.substr(i * 2, 2), 16);
        key.reverse();
        const out = bytes.slice(0, Math.min(bytes.length, 32));
        for (let i = 0; i < out.length; i++) out[i] ^= key[i % 16];
        return out;
    }

    /**
     * PPTX embedded fonts: `ppt/fonts/*.fntdata` referenced from
     * `<p:embeddedFontLst>` in ppt/presentation.xml, resolved through
     * ppt/_rels/presentation.xml.rels.
     *
     * Consulted only when the host has switched the engine's EOT decoding on
     * (options.acceptEot; FG-054). Suppressing a download the engine will not
     * honour is silent tofu (see the note at ENGINE_ACCEPTS_EOT_EMBEDDED), so the
     * website's constant and the real engine are kept in agreement by gate
     * embedded_font_import, and the driver re-converts with every substitute if a
     * counted face is not taken (#580).
     *
     * @returns {Promise<{families:Set<string>, fonts:Array<Object>}>}
     *   families — typefaces every declared face of which the engine would take
     *   fonts    — cmap coverage of each accepted face (only when wanted)
     */
    // The style suffix LibreOffice appends to an embedded face's file name
    // (writerfilter FontTable, oox EmbeddedFontListContext).
    const EMBED_FILE_SUFFIX = { Regular: '', Bold: 'b', Italic: 'i', BoldItalic: 'bi' };
    /** comphelper OStorageHelper::IsValidZipEntryFileName(name, false), for a font file stem. */
    function embeddedFontFileNameIsValid(stem) {
        if (!stem) return false;
        for (const ch of stem) {
            const c = ch.codePointAt(0);
            if ('\\?<>"|:/'.includes(ch) || c < 32 || c > 0xFFFF) return false;
        }
        return true;
    }

    async function pptxEmbeddedFamilies(zip, wantCoverage, pdfOnly) {
        const families = new Set();
        const fonts = [];
        const faces = new Map();   // family -> ['Regular'|'Bold'|'Italic'|'BoldItalic']
        const pres = await readEntryText(zip.file('ppt/presentation.xml'), 'ppt/presentation.xml');
        if (!pres) return { families, fonts, faces };

        // The engine gates the WHOLE list on this attribute
        // (EmbeddedFontListContext::onEndElement: `if (!mbEmbedTrueType ...) return`),
        // so a deck that ships the parts but does not ask for them uses none of
        // them. Absent or "0"/"false" => nothing is self-supplied.
        const head = /<p:presentation\b[^<>]*>/.exec(pres);
        const flag = head && /\bembedTrueTypeFonts\s*=\s*"([^"]*)"/.exec(head[0]);
        if (!flag || /^(0|false)$/i.test(flag[1])) return { families, fonts, faces };

        const rels = await readEntryText(
            zip.file('ppt/_rels/presentation.xml.rels'), 'ppt/_rels/presentation.xml.rels');
        const relMap = new Map();
        for (const [id, target] of relationshipTargets(rels)) relMap.set(id, target.replace(/^\/+/, ''));

        for (const fm of untilLast(pres, '</p:embeddedFont>').matchAll(/<p:embeddedFont\b[^<>]*>([\s\S]*?)<\/p:embeddedFont>/g)) {
            const face = /<p:font\b[^<>]*\btypeface="([^"]+)"/.exec(fm[1]);
            if (!face) continue;
            // Every declared face must pass, exactly as on the DOCX path: the
            // engine gates each FILE separately, so a family whose bold is
            // refused still needs the substitute we would otherwise not fetch.
            const ids = [...fm[1].matchAll(
                /<p:(regular|bold|italic|boldItalic)\b[^<>]*r:id="([^"]+)"/g)].map(m => [m[0], m[2], m[1]]);
            if (!ids.length) continue;
            let allAccepted = true;
            const cov = [];
            for (const id of ids) {
                const target = relMap.get(id[1]);
                if (!target) { allAccepted = false; break; }
                const path = target.startsWith('ppt/') ? target : 'ppt/' + target;
                const raw = await readEntryBytes(zip.file(path), path);
                if (!raw) { allAccepted = false; break; }
                // The engine's rights rule (engineWillAcceptEmbedded), read from the
                // uncompressed header: Restricted alone (2) and bitmap-only are refused,
                // no-subsetting (0x100) refuses PDF output only.
                if (!engineWillAcceptEmbedded(readEotFsType(raw), pdfOnly)) { allAccepted = false; break; }
                if (readEotFlags(raw) & TTEMBED_SUBSET) { allAccepted = false; break; }
                // Coverage is NOT readable here: a TTCOMPRESSED payload needs an
                // EOT decoder we do not have. Recorded as null so a caller can
                // never mistake "not checked" for "not covered".
                if (wantCoverage) cov.push(null);
            }
            if (!allAccepted) continue;
            families.add(face[1].trim());
            faces.set(face[1].trim(), ids.map(id => id[2].charAt(0).toUpperCase() + id[2].slice(1)));
            for (const c of cov) if (c) fonts.push(c);
        }
        return { families, fonts, faces };
    }

    /**
     * Families the document supplies itself AND that the engine will accept,
     * plus the cmap coverage of the faces it accepted (NTH-07 script fonts).
     *
     * Covers the two paths proven to work in this build: OOXML
     * word/fonts/*.odttf (DOCX) and ODF Fonts/*.ttf. PPTX is parsed by
     * pptxEmbeddedFamilies() above but not consulted while
     * options.acceptEot is true (the website: its engine decodes the EOT-wrapped
     * .fntdata), so a PPTX that embeds a face skips that substitute. Without it (the
     * default, and the MCP) a PPTX keeps downloading substitutes, the safe direction.
     *
     * @param {boolean} [wantCoverage] parse each accepted font's cmap as well.
     *   Off by default: it is only needed when the document contains a script
     *   whose font we might otherwise fetch, and the caller knows that.
     * @returns {Promise<{families:Set<string>, coverage:{has:function}|null}>}
     *   families — family names safe to skip downloading
     *   coverage — union of the accepted faces' cmaps, or null when none could
     *              be read. NEVER "empty means nothing is covered": null and
     *              empty are the same answer here, "prove nothing".
     */
    async function extractEmbeddedFontFamilies(zip, ext, wantCoverage, pdfOnly, acceptEot) {
        const supplied = new Set();
        // Cmaps of every face the ENGINE will install, including faces whose
        // FAMILY is vetoed below: the veto governs whether we still fetch a
        // substitute for that family, not whether the engine has the glyphs.
        const covers = [];
        const noteCoverage = (bytes) => {
            if (!wantCoverage) return;
            const c = readCmapCoverage(bytes);
            if (c) covers.push(c);
        };
        // Any face we could NOT accept vetoes its whole family at the end. ODF
        // declares each weight as its own <style:font-face>, so a family can be
        // accepted via its regular face and only later turn out to have a
        // restricted bold one — order must not decide the outcome.
        const rejected = new Set();
        // FG-054: the files the engine will write for the faces we count on, so
        // the driver can check after the conversion that it really took them
        // (EmbeddedFontsHelper::fileUrlForTemporaryFont):
        //   DOCX/PPTX  <family><""|b|i|bi>.ttf, a name we can predict;
        //   ODF        <family><N>.ttf, N a process-wide counter (the style is "?");
        //   either     font<N>.ttf when the name is not a valid file name.
        // expectedByFamily: family -> predicted names; numberedByFamily: family ->
        // { stem, count } for the counter-named ones (only "how many new" is checkable).
        const expectedByFamily = new Map();
        const numberedByFamily = new Map();
        const expectNumbered = (family, stem) => {
            const cur = numberedByFamily.get(family) || { stem, count: 0 };
            cur.count++;
            numberedByFamily.set(family, cur);
        };
        const expectFace = (family, suffix) => {
            const f = family.trim();
            if (embeddedFontFileNameIsValid(f + suffix)) {
                if (!expectedByFamily.has(f)) expectedByFamily.set(f, []);
                expectedByFamily.get(f).push(f + suffix + '.ttf');
            } else {
                expectNumbered(f, 'font');
            }
        };
        try {
            if (['docx', 'docm', 'dotx', 'dotm'].includes(ext)) {
                const table = await readEntryText(zip.file('word/fontTable.xml'), 'word/fontTable.xml');
                if (!table) return { families: supplied, coverage: null, expected: { files: [], numbered: [] } };
                const rels = await readEntryText(
                    zip.file('word/_rels/fontTable.xml.rels'), 'word/_rels/fontTable.xml.rels');
                const relMap = new Map();
                for (const [id, target] of relationshipTargets(rels)) relMap.set(id, target.replace(/^\/+/, ''));
                // Each <w:font w:name="X"> ... <w:embedRegular r:id w:fontKey/>
                for (const fm of untilLast(table, '</w:font>').matchAll(/<w:font\b[^<>]*w:name="([^"]+)"[^<>]*>([\s\S]*?)<\/w:font>/g)) {
                    const family = fm[1];
                    // EVERY embedded face must pass, not just the first one found.
                    // Reported by review: a family can embed Regular (acceptable)
                    // AND Bold (restricted). The engine gates each FILE separately,
                    // so it would take the regular and drop the bold. Suppressing
                    // the family on the strength of the regular alone means the
                    // bold run loses the substitute we chose not to fetch.
                    //
                    // Measured caveat, so the comment does not overclaim: the
                    // always-loaded fallback set means the observed result there is
                    // a wrong FACE, not tofu — a document embedding only a regular
                    // face and using bold renders fine, from the embedded regular.
                    // This check is the conservative choice regardless, because it
                    // costs one download we would otherwise have skipped.
                    const embeds = [...fm[2].matchAll(/<w:embed(?:Regular|Bold|Italic|BoldItalic)\b[^<>]*>/g)];
                    if (!embeds.length) continue;
                    let allAccepted = true;
                    let smallSubset = false;
                    for (const e of embeds) {
                        const rid = /r:id="([^"]+)"/.exec(e[0]);
                        const fkey = /w:fontKey="([^"]+)"/.exec(e[0]);
                        const target = rid && relMap.get(rid[1]);
                        if (!target) { allAccepted = false; break; }
                        const path = target.startsWith('word/') ? target : 'word/' + target;
                        const raw = await readEntryBytes(zip.file(path), path);
                        if (!raw) { allAccepted = false; break; }
                        const head = fkey ? deobfuscateOdttfHead(raw, fkey[1]) : raw.slice(0, 32);
                        if (!head) { allAccepted = false; break; }
                        // Splice the de-obfuscated head back over the (unobfuscated)
                        // tail so the table directory and OS/2 offsets resolve.
                        const full = new Uint8Array(raw.length);
                        full.set(raw);
                        full.set(head, 0);
                        if (!engineWillAcceptEmbedded(readFsType(full), pdfOnly)) { allAccepted = false; break; }
                        // SUBSETTED FONTS GET A SECOND GATE, because the engine
                        // applies one: writerfilter passes w:subsetted through to
                        // addEmbeddedFont, which drops any font providing fewer
                        // than 26 non-empty glyphs. That case is not exotic on the
                        // path that matters most here — a document embedding just
                        // enough of a CJK face for its own text is exactly the
                        // shape whose script font we would otherwise stop fetching.
                        const subsetted = /w:subsetted="(?!0|false)[^"]*"/.test(e[0]);
                        if (subsetted && !engineWillAcceptSubsetted(full, pdfOnly)) { allAccepted = false; break; }
                        // D4: a SMALL subset (fewer than 26 glyphs) is used only for PDF, and a
                        // character it lacks falls back per glyph. Its family's substitute is
                        // still fetched, so that fallback is the metric-compatible face
                        // (Carlito for a Calibri subset) and not whatever the essential set
                        // offers; the face is not claimed as supplying the family or a script.
                        if (subsetted && !engineWillAcceptSubsetted(full, false)) { smallSubset = true; continue; }
                        noteCoverage(full);
                    }
                    if (allAccepted && !smallSubset) {
                        supplied.add(family.trim());
                        for (const e of embeds) {
                            const kind = /<w:embed(Regular|Bold|Italic|BoldItalic)\b/.exec(e[0])[1];
                            expectFace(family, EMBED_FILE_SUFFIX[kind]);
                        }
                    }
                }
            } else if (['pptx', 'pptm', 'potx', 'potm', 'ppsx'].includes(ext)) {
                // Consulted only when the host has switched the engine's EOT decoding
                // on (options.acceptEot; the default is ENGINE_ACCEPTS_EOT_EMBEDDED).
                if (typeof acceptEot === 'boolean' ? acceptEot : ENGINE_ACCEPTS_EOT_EMBEDDED) {
                    const p = await pptxEmbeddedFamilies(zip, wantCoverage, pdfOnly);
                    for (const f of p.families) supplied.add(f);
                    for (const [family, kinds] of p.faces) for (const k of kinds) expectFace(family, EMBED_FILE_SUFFIX[k]);
                    for (const c of p.fonts) if (c) covers.push(c);
                }
            } else if (['odt', 'ods', 'odp', 'odg'].includes(ext)) {
                for (const part of ['content.xml', 'styles.xml']) {
                    const xml = await readEntryText(zip.file(part), part);
                    if (!xml) continue;
                    // One block per <style:font-face>, split linearly. A self-closing
                    // declaration (`<style:font-face .../>`, the common case) has no
                    // content and so no embedded file. The earlier lazy match to the
                    // next </style:font-face> ran from a self-closing declaration into
                    // the NEXT one's font-face-uri, so 'Liberation Sans' was credited
                    // with Manbow Solid's embedded file (embed-unrestricted1.odt),
                    // which skipped Liberation Sans's substitute and, in FG-054,
                    // predicted the wrong file name (FG-054 corpus probe, 2026-10-19).
                    for (const seg of xml.split(/<style:font-face(?=[\s>\/])/).slice(1)) {
                        const tagEnd = seg.indexOf('>');
                        if (tagEnd === -1 || seg.charAt(tagEnd - 1) === '/') continue;
                        const close = seg.indexOf('</style:font-face>', tagEnd);
                        const block = close === -1 ? seg : seg.slice(0, close);
                        const href = /xlink:href="([^"]+)"/.exec(block);
                        if (!href) continue;
                        // BOTH names, not one. Reported by review: a run references
                        // the face through style:font-name, which points at
                        // style:name — while svg:font-family carries the real family
                        // and the two routinely differ. Recording only one meant the
                        // set never intersected what extractOdfFontDeclarations
                        // collected, so suppression silently never fired. Harmless
                        // (we just kept downloading) but it forfeited the whole win.
                        const names = [
                            /svg:font-family="([^"]+)"/.exec(block),
                            /style:name="([^"]+)"/.exec(block)
                        ].filter(Boolean).map(m => decodeFontEntities(m[1]).trim().replace(/^['"]|['"]$/g, '').trim());
                        if (!names.length) continue;
                        const raw = await readEntryBytes(
                            zip.file(href[1].replace(/^\/+/, '')), href[1]);
                        // ODF can declare the payload as EOT
                        // (<svg:font-face-format svg:string="embedded-opentype">),
                        // and xmloff passes that straight through as `eot=true`
                        // — which only the presentations module can decode (see
                        // ENGINE_ACCEPTS_EOT_EMBEDDED) and this path does not rely on
                        // even there (ODF EOT is rare). Anything but the two
                        // plain sfnt formats is therefore not proof of anything.
                        // Bounded to the one tag: `\b[^>]*svg:string=` over the block is
                        // quadratic on a crafted declaration (many unclosed
                        // <svg:font-face-format), and this runs on the main thread.
                        const fi = block.indexOf('<svg:font-face-format');
                        const fe = fi === -1 ? -1 : block.indexOf('>', fi);
                        // A format tag with no '>' before the next '<' is malformed: fail safe,
                        // treat it as not plain sfnt (the face keeps its substitute).
                        const lt = fi === -1 ? -1 : block.indexOf('<', fi + 1);
                        const unclosed = fi !== -1 && (fe === -1 || (lt !== -1 && lt < fe));
                        const fmt = (fi === -1 || unclosed) ? null : /\bsvg:string="([^"]*)"/.exec(block.slice(fi, fe));
                        const plainSfnt = !unclosed && (!fmt || /^(truetype|opentype)$/i.test(fmt[1].trim()));
                        const accepted = (raw && plainSfnt)
                            ? engineWillAcceptEmbedded(readFsType(raw), pdfOnly) : false;
                        if (accepted) noteCoverage(raw);
                        for (const n of names) {
                            if (!n) continue;
                            if (accepted) supplied.add(n); else rejected.add(n);
                        }
                        // One file per declaration, named after svg:font-family (the
                        // name xmloff passes) plus the engine's counter; counted once
                        // per block even when style:name repeats the same string.
                        if (accepted) expectNumbered(names[0], embeddedFontFileNameIsValid(names[0] + '0') ? names[0] : 'font');
                    }
                }
            }
        } catch (e) {
            // Never let this optimisation break extraction: on any error we
            // report nothing self-supplied, and every font downloads as before.
            console.warn('[FontExtractor] Embedded-font detection failed:', e.message || String(e));
            return { families: new Set(), coverage: null, expected: { files: [], numbered: [] } };
        }
        // Veto pass: a family with ANY unusable face keeps its substitute.
        for (const r of rejected) { supplied.delete(r); expectedByFamily.delete(r); numberedByFamily.delete(r); }
        if (supplied.size) {
            console.log('[FontExtractor] Document supplies its own fonts:', Array.from(supplied));
        }
        const coverage = covers.length
            ? { has: (cp) => covers.some(c => c.has(cp)) }
            : null;
        const byStem = new Map();
        for (const [f, { stem, count }] of numberedByFamily) {
            if (supplied.has(f)) byStem.set(stem, (byStem.get(stem) || 0) + count);
        }
        const expected = {
            files: [].concat(...[...expectedByFamily.entries()].filter(([f]) => supplied.has(f)).map(([, v]) => v)).sort(),
            numbered: [...byStem.entries()].sort().map(([stem, count]) => ({ stem, count }))
        };
        return { families: supplied, coverage, expected };
    }

    // ==================================================================
    // FACE USAGE (NTH-03) — which WEIGHT/STYLE combinations a document uses.
    //
    // WHY: getFontFiles() used to fetch every variant of every matched family.
    // Carlito is 4 faces / 2.73 MB; a document that sets Calibri in one weight
    // downloaded the bold, the italic and the bold-italic it will never render.
    // Bandwidth to the client is this product's dominant cost, so the faces a
    // document cannot possibly use are pure waste.
    //
    // THE DIRECTION OF ERROR IS NOT SYMMETRIC. Over-fetching costs bytes;
    // under-fetching costs a face the renderer then has to synthesise (an
    // approximate emboldening or a mechanical slant), or — for the upright
    // Regular — loses the family outright. So every ambiguity below resolves
    // TOWARDS fetching:
    //   * bold/italic are OR-ed up the style chain, never XOR-ed, even though
    //     OOXML's <w:b> is formally a TOGGLE property that XORs when it appears
    //     at two levels. OR can only ever claim bold where there is none.
    //   * an explicit OFF (w:val="0"/"false", fo:font-weight="normal") is
    //     honoured only to the extent of not ADDING bold. It never subtracts
    //     bold contributed by another level.
    //   * a run whose family we cannot pin down contributes its face to
    //     `unattributed`, which is added to EVERY family's allowed set.
    //   * any structural surprise (missing main part, unreadable XML, an
    //     exception) sets resolved=false, which restores the pre-NTH-03
    //     behaviour of fetching everything.
    //
    // The face vocabulary is FontMatcher.FACES — see the note there. The two
    // ends are pinned together by tests/unit/test_font_usage.js.
    // ==================================================================

    const FACE_REGULAR = 'regular';
    const FACE_BOLD = 'bold';
    const FACE_ITALIC = 'italic';
    const FACE_BOLD_ITALIC = 'bolditalic';
    const ALL_FACES = [FACE_REGULAR, FACE_BOLD, FACE_ITALIC, FACE_BOLD_ITALIC];

    function faceOf(bold, italic) {
        if (bold && italic) return FACE_BOLD_ITALIC;
        if (bold) return FACE_BOLD;
        if (italic) return FACE_ITALIC;
        return FACE_REGULAR;
    }

    /**
     * @returns {{resolved:boolean, faces:Map<string,Set<string>>,
     *            global:Set<string>, unattributed:Set<string>}}
     *   faces        — lower-cased document font name -> faces observed for it
     *   global       — every face observed anywhere in the document
     *   unattributed — faces of text whose FONT could not be determined
     *   resolved     — false means "believe none of the above"; the caller must
     *                  then fetch every face, exactly as before NTH-03.
     */
    function newUsage() {
        return { resolved: false, faces: new Map(), global: new Set(), unattributed: new Set() };
    }

    function noteFace(usage, fontName, face) {
        usage.global.add(face);
        // '+minorHAnsi' style theme placeholders are not font names. If a caller
        // hands one over unresolved, the run is honestly unattributable.
        const key = fontName ? String(fontName).replace(/^['"]|['"]$/g, '').trim().toLowerCase() : '';
        if (!key || key.charAt(0) === '+') { usage.unattributed.add(face); return; }
        let set = usage.faces.get(key);
        if (!set) { set = new Set(); usage.faces.set(key, set); }
        set.add(face);
    }

    /** A face we know is used, on a family we could not identify. */
    function noteUnattributed(usage, face) {
        usage.global.add(face);
        usage.unattributed.add(face);
    }

    /** Total doubt about one piece of text: it could be any family, any face. */
    function noteTotalDoubt(usage) {
        for (const f of ALL_FACES) noteUnattributed(usage, f);
    }

    // ---- tiny XML helpers -------------------------------------------------

    // One pass over well-formed-enough markup. The attribute alternation
    // ("[^"]*"|'[^']*'|[^>"']) exists so a '>' inside a quoted attribute value —
    // legal in XML, and emitted by some producers — cannot end the tag early.
    // The plain-character class must EXCLUDE both quote marks: if a quote can be
    // matched either way, an unclosed tag of `""` pairs backtracks 2^n times
    // (about 100 bytes froze the tab). tests/unit/test_font_extractor_redos.js.
    const TAG_RE = /<(\/?)([A-Za-z_][-A-Za-z0-9_.:]*)((?:"[^"<]*"|'[^'<]*'|[^<>"'])*?)(\/?)>/g;

    const attrCache = new Map();
    function attrOf(attrs, name) {
        if (!attrs) return null;
        let re = attrCache.get(name);
        if (!re) {
            re = new RegExp('(?:^|\\s)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                            '\\s*=\\s*"([^"]*)"');
            attrCache.set(name, re);
        }
        const m = re.exec(attrs);
        return m ? m[1] : null;
    }

    /**
     * Walk `xml` as a tag stream, maintaining an element stack.
     * `onOpen(el, stack)` sees the element BEFORE it is pushed (so `stack` is
     * its ancestors); `onClose(el, endIndex, stack)` sees it after it is popped.
     * Unbalanced closing tags are tolerated — this is a best-effort reader of
     * files a stranger produced, not a validating parser.
     */
    function walkTags(xml, onOpen, onClose) {
        const stack = [];
        TAG_RE.lastIndex = 0;
        let m;
        while ((m = TAG_RE.exec(xml)) !== null) {
            const name = m[2];
            if (m[1] === '/') {
                let idx = -1;
                for (let i = stack.length - 1; i >= 0; i--) {
                    if (stack[i].name === name) { idx = i; break; }
                }
                if (idx < 0) continue;
                while (stack.length > idx) {
                    const el = stack.pop();
                    if (onClose) onClose(el, m.index, stack);
                }
                continue;
            }
            const el = { name: name, attrs: m[3], contentStart: m.index + m[0].length };
            const selfClosing = m[4] === '/';
            if (onOpen) onOpen(el, stack, selfClosing);
            if (!selfClosing) stack.push(el);
            else if (onClose) onClose(el, m.index + m[0].length, stack);
        }
        // Anything still open at EOF (truncated part) is closed at EOF.
        while (stack.length) {
            const el = stack.pop();
            if (onClose) onClose(el, xml.length, stack);
        }
    }

    // ---- OOXML theme ------------------------------------------------------

    /** @returns {{major:{latin,ea,cs}, minor:{latin,ea,cs}}} — nulls when absent */
    function parseOoxmlTheme(xml) {
        const pick = (which) => {
            const block = new RegExp('<a:' + which + 'Font\\b[^<>]*>([\\s\\S]*?)</a:' + which + 'Font>')
                .exec(untilLast(xml || '', '</a:' + which + 'Font>'));
            const body = block ? block[1] : '';
            const one = (tag) => {
                const m = new RegExp('<a:' + tag + '\\b[^<>]*typeface="([^"]*)"').exec(body);
                return m && m[1] ? m[1] : null;
            };
            return { latin: one('latin'), ea: one('ea'), cs: one('cs') };
        };
        return { major: pick('major'), minor: pick('minor') };
    }

    /** Resolve '+mj-lt' / 'majorHAnsi' style references against a theme. */
    function resolveThemeRef(theme, ref) {
        if (!ref || !theme) return null;
        const major = /^\+?(mj|major)/i.test(ref);
        const minor = /^\+?(mn|minor)/i.test(ref);
        const set = major ? theme.major : (minor ? theme.minor : null);
        if (!set) return null;
        if (/-ea$|EastAsia$/i.test(ref)) return set.ea;
        if (/-cs$|Bidi$|Cs$/i.test(ref)) return set.cs;
        return set.latin;
    }

    // ---- DrawingML (shared by PPTX, and by charts/shapes inside DOCX/XLSX) --

    // `a:tcTxStyle` is in this list because TABLE STYLES format text through it
    // (ppt/tableStyles.xml, "bold the header row") and nothing else reaches that
    // markup. Scanning the PART was not enough: an earlier version inflated
    // ppt/tableStyles.xml and then matched nothing in it, which looked like
    // coverage and was not — four corpus decks rendered a bold header row while
    // the resolver reported the document as regular-only and declined every
    // bold face, including the Liberation fallbacks.
    const DML_RPR_RE = /<a:(rPr|defRPr|endParaRPr|tcTxStyle)\b((?:"[^"<]*"|[^<>"])*?)(\/?)>/g;
    const DML_TYPEFACE_RE = /<a:(?:latin|ea|cs|sym)\b[^<>]*typeface="([^"]*)"/g;

    /**
     * DrawingML run properties: bold/italic are ATTRIBUTES (b="1" i="1") and the
     * font is a child <a:latin typeface="..."/>. Runs that name no typeface get
     * theirs from the placeholder/list-style/theme chain, which is not resolvable
     * from the run alone — those contribute to `unattributed`.
     */
    function scanDrawingML(xml, usage, theme) {
        if (!xml) return;
        DML_RPR_RE.lastIndex = 0;
        const bodyOf = elementBodies(xml);
        let m;
        while ((m = DML_RPR_RE.exec(xml)) !== null) {
            const attrs = m[2];
            const body = m[3] !== '/' ? bodyOf('a:' + m[1], DML_RPR_RE.lastIndex) : '';
            // "on" belongs here as well as 1/true: a:rPr/@b is xsd:boolean, but
            // a:tcTxStyle/@b is ST_OnOffStyleType ("on"/"off"/"def") and real
            // table styles write b="on". Accepting it in one of the two places
            // and not the other is exactly how this bug came back.
            const bold = /(?:^|\s)b="(?:1|true|on)"/.test(attrs);
            const italic = /(?:^|\s)i="(?:1|true|on)"/.test(attrs);
            const face = faceOf(bold, italic);

            let attributed = false;
            DML_TYPEFACE_RE.lastIndex = 0;
            let t;
            while ((t = DML_TYPEFACE_RE.exec(body)) !== null) {
                let name = t[1];
                if (name && name.charAt(0) === '+') name = resolveThemeRef(theme, name);
                if (name) { noteFace(usage, name, face); attributed = true; }
            }
            if (!attributed) noteUnattributed(usage, face);
        }
    }

    // ---- WordprocessingML -------------------------------------------------

    const W_TOGGLES = {
        b: /<w:b(?:\s((?:"[^"<]*"|[^<>"])*?))?\/?>/,
        bCs: /<w:bCs(?:\s((?:"[^"<]*"|[^<>"])*?))?\/?>/,
        i: /<w:i(?:\s((?:"[^"<]*"|[^<>"])*?))?\/?>/,
        iCs: /<w:iCs(?:\s((?:"[^"<]*"|[^<>"])*?))?\/?>/
    };

    /** True when <w:b .../> is present AND not explicitly switched off. */
    function wToggleOn(rPr, key) {
        const m = W_TOGGLES[key].exec(rPr || '');
        if (!m) return false;
        const val = attrOf(m[1] || '', 'w:val');
        if (val === null) return true;
        return !/^(0|false|off)$/i.test(val);
    }

    /** Fonts named by a <w:rFonts .../> inside these run properties. */
    function wFontsOf(rPr, theme, out) {
        const m = /<w:rFonts\b((?:"[^"<]*"|[^<>"])*?)\/?>/.exec(rPr || '');
        if (!m) return false;
        let found = false;
        for (const a of ['w:ascii', 'w:hAnsi', 'w:eastAsia', 'w:cs']) {
            const v = attrOf(m[1], a);
            if (v) { out.add(v); found = true; }
        }
        for (const a of ['w:asciiTheme', 'w:hAnsiTheme', 'w:eastAsiaTheme', 'w:cstheme']) {
            const v = attrOf(m[1], a);
            if (!v) continue;
            const resolved = resolveThemeRef(theme, v);
            if (resolved) { out.add(resolved); found = true; }
        }
        return found;
    }

    function wRunProps(rPr, theme) {
        const fonts = new Set();
        wFontsOf(rPr, theme, fonts);
        return {
            fonts: fonts,
            bold: wToggleOn(rPr, 'b') || wToggleOn(rPr, 'bCs'),
            italic: wToggleOn(rPr, 'i') || wToggleOn(rPr, 'iCs'),
            rStyle: attrOf((/<w:rStyle\b((?:"[^"<]*"|[^<>"])*?)\/?>/.exec(rPr || '') || [])[1] || '', 'w:val')
        };
    }

    /**
     * Parse word/styles.xml into a resolvable table.
     * <w:style> elements do not nest, so a non-greedy block match is exact here.
     */
    function parseDocxStyles(xml, theme) {
        const table = {
            byId: new Map(),
            defaults: { fonts: new Set(), bold: false, italic: false },
            defaultParagraph: null,
            defaultCharacter: null
        };
        if (!xml) return table;

        const dd = /<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/.exec(untilLast(xml, '</w:docDefaults>'));
        if (dd) {
            const rd = /<w:rPrDefault>([\s\S]*?)<\/w:rPrDefault>/.exec(untilLast(dd[1], '</w:rPrDefault>'));
            if (rd) {
                const p = wRunProps(rd[1], theme);
                table.defaults = { fonts: p.fonts, bold: p.bold, italic: p.italic };
            }
        }

        const styleRe = /<w:style\b((?:"[^"<]*"|[^<>"])*?)>([\s\S]*?)<\/w:style>/g;
        let m;
        const styleXml = untilLast(xml, '</w:style>');
        while ((m = styleRe.exec(styleXml)) !== null) {
            const id = attrOf(m[1], 'w:styleId');
            if (!id) continue;
            const type = attrOf(m[1], 'w:type') || '';
            let body = m[2];

            // Conditional table formatting (<w:tblStylePr>: first row bold, and
            // so on) applies to text we cannot localise inside the table, so it
            // is folded into the style as "this style may also be bold/italic".
            let condBold = false, condItalic = false;
            body = replaceUntilLast(body, '</w:tblStylePr>', /<w:tblStylePr\b[\s\S]*?<\/w:tblStylePr>/g, (block) => {
                const inner = replaceUntilLast(block, '</w:pPr>', /<w:pPr>[\s\S]*?<\/w:pPr>/g, '');
                if (wToggleOn(inner, 'b') || wToggleOn(inner, 'bCs')) condBold = true;
                if (wToggleOn(inner, 'i') || wToggleOn(inner, 'iCs')) condItalic = true;
                return '';
            });
            // The <w:rPr> nested in <w:pPr> styles the paragraph MARK, not the
            // runs; dropping it first keeps the style's own run properties clean.
            body = replaceUntilLast(body, '</w:pPr>', /<w:pPr>[\s\S]*?<\/w:pPr>/g, '');

            const props = wRunProps(body, theme);
            table.byId.set(id, {
                basedOn: attrOf((/<w:basedOn\b((?:"[^"<]*"|[^<>"])*?)\/?>/.exec(body) || [])[1] || '', 'w:val'),
                fonts: props.fonts,
                bold: props.bold || condBold,
                italic: props.italic || condItalic
            });
            if (attrOf(m[1], 'w:default') && !/^(0|false)$/i.test(attrOf(m[1], 'w:default'))) {
                if (type === 'paragraph' && !table.defaultParagraph) table.defaultParagraph = id;
                if (type === 'character' && !table.defaultCharacter) table.defaultCharacter = id;
            }
        }
        return table;
    }

    /**
     * Resolve a style id through its w:basedOn chain.
     * @returns {{fonts:Set<string>, bold:boolean, italic:boolean, unknown:boolean}}
     *   unknown — a link in the chain is missing, so we cannot rule out that it
     *   contributed bold/italic. The caller escalates that to total doubt.
     */
    function resolveDocxStyle(table, id) {
        const empty = { fonts: new Set(), bold: false, italic: false, unknown: false };
        if (!id) return empty;
        if (!table.resolved) table.resolved = new Map();
        if (table.resolved.has(id)) return table.resolved.get(id);

        const out = { fonts: new Set(), bold: false, italic: false, unknown: false };
        table.resolved.set(id, out);            // cycle guard: self-reference resolves to "so far"
        const seen = new Set();
        let cur = id;
        while (cur && !seen.has(cur)) {
            seen.add(cur);
            const s = table.byId.get(cur);
            if (!s) { out.unknown = true; break; }
            if (!out.fonts.size && s.fonts.size) for (const f of s.fonts) out.fonts.add(f);
            if (s.bold) out.bold = true;
            if (s.italic) out.italic = true;
            cur = s.basedOn;
        }
        return out;
    }

    /**
     * Attribute every <w:r> in one WordprocessingML part.
     * Uses a stack walk rather than a `<w:p>...</w:p>` block regex because
     * paragraphs DO nest — a text box (<w:txbxContent>) holds whole paragraphs
     * inside a run — and a non-greedy block match would end the outer paragraph
     * at the inner paragraph's close, silently dropping the outer paragraph's
     * style from every run after the text box.
     */
    function scanDocxPart(xml, usage, table, theme) {
        if (!xml) return;
        walkTags(xml, (el, stack) => {
            switch (el.name) {
                case 'w:p':
                    el.pStyle = null;
                    break;
                case 'w:tbl':
                    el.tblStyle = null;
                    break;
                case 'w:r':
                    // Closed (including self-closed) runs are finished in the
                    // onClose handler below — walkTags calls it for both shapes,
                    // so doing it here as well would count the run twice.
                    el.rPr = null;
                    break;
                case 'w:pStyle': {
                    const p = nearest(stack, 'w:p');
                    if (p) p.pStyle = attrOf(el.attrs, 'w:val');
                    break;
                }
                case 'w:tblStyle': {
                    const t = nearest(stack, 'w:tbl');
                    if (t) t.tblStyle = attrOf(el.attrs, 'w:val');
                    break;
                }
                case 'w:rPr': {
                    // Only the run's OWN properties. An identically named element
                    // inside <w:pPr> is the paragraph mark's, and inside a nested
                    // paragraph it belongs to that paragraph's runs.
                    const parent = stack[stack.length - 1];
                    if (parent && parent.name === 'w:r') el.runOwner = parent;
                    break;
                }
                default:
                    break;
            }
        }, (el, endIndex, stack) => {
            if (el.name === 'w:rPr' && el.runOwner) {
                el.runOwner.rPr = xml.slice(el.contentStart, endIndex);
            } else if (el.name === 'w:r') {
                finishDocxRun(el, stack, usage, table, theme);
            }
        });
    }

    function nearest(stack, name) {
        for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === name) return stack[i];
        return null;
    }

    function finishDocxRun(runEl, stack, usage, table, theme) {
        const local = wRunProps(runEl.rPr || '', theme);
        const para = nearest(stack, 'w:p');
        const tbl = nearest(stack, 'w:tbl');

        const layers = [
            local,
            resolveDocxStyle(table, local.rStyle),
            resolveDocxStyle(table, para && para.pStyle),
            resolveDocxStyle(table, tbl && tbl.tblStyle),
            // The document's default paragraph style, for a run whose paragraph
            // names none (or that is not inside a paragraph at all — malformed,
            // but the safe reading is "the default applies", not "nothing does").
            resolveDocxStyle(table, (!para || !para.pStyle) ? table.defaultParagraph : null),
            table.defaults
        ];

        let bold = false, italic = false, unknown = false, fonts = null;
        for (const layer of layers) {
            if (!layer) continue;
            if (layer.bold) bold = true;
            if (layer.italic) italic = true;
            if (layer.unknown) unknown = true;
            if (!fonts && layer.fonts && layer.fonts.size) fonts = layer.fonts;
        }

        // A missing style id could have carried the bold we are about to deny,
        // so an unresolvable chain is total doubt, not just an unknown family.
        if (unknown) { noteTotalDoubt(usage); return; }
        const face = faceOf(bold, italic);
        if (!fonts || !fonts.size) { noteUnattributed(usage, face); return; }
        for (const f of fonts) noteFace(usage, f, face);
    }

    /** List markers carry their own run properties (a bold bullet is real text). */
    function scanDocxNumbering(xml, usage, theme) {
        if (!xml) return;
        for (const m of untilLast(xml, '</w:lvl>').matchAll(/<w:lvl\b[^<>]*>([\s\S]*?)<\/w:lvl>/g)) {
            const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(untilLast(m[1], '</w:rPr>'));
            if (!rPr) continue;
            const p = wRunProps(rPr[1], theme);
            const face = faceOf(p.bold, p.italic);
            if (!p.fonts.size) noteUnattributed(usage, face);
            else for (const f of p.fonts) noteFace(usage, f, face);
        }
    }

    // ---- SpreadsheetML ----------------------------------------------------

    const X_FONT_RE = /<(?:\w+:)?font(?:\s(?:"[^"<]*"|[^<>"])*?)?>([\s\S]*?)<\/(?:\w+:)?font>/g;
    const X_RPR_RE = /<(?:\w+:)?rPr>([\s\S]*?)<\/(?:\w+:)?rPr>/g;

    function xlToggleOn(body, tag) {
        const m = new RegExp('<(?:\\w+:)?' + tag + '(?:\\s((?:"[^"<]*"|[^<>"])*?))?/?>').exec(body);
        if (!m) return false;
        const val = attrOf(m[1] || '', 'val');
        if (val === null) return true;
        return !/^(0|false)$/i.test(val);
    }

    function scanXlsxFontRecords(xml, usage, theme, re, nameTag) {
        if (!xml) return;
        re.lastIndex = 0;
        // Only up to the last closer the pattern can end on (</font>, </x:rPr> ...): linear.
        const text = untilLastMatch(xml, new RegExp(re.source.slice(re.source.lastIndexOf('<\\/')), 'g'));
        let m;
        while ((m = re.exec(text)) !== null) {
            const body = m[1];
            const face = faceOf(xlToggleOn(body, 'b'), xlToggleOn(body, 'i'));
            const named = new RegExp('<(?:\\w+:)?' + nameTag + '\\b[^<>]*val="([^"]*)"').exec(body);
            if (named && named[1]) { noteFace(usage, named[1], face); continue; }
            // No explicit name: the record inherits the workbook theme's
            // major/minor font via <scheme val="..."/>.
            const scheme = /<(?:\w+:)?scheme\b[^<>]*val="([^"]*)"/.exec(body);
            const themed = scheme ? resolveThemeRef(theme, scheme[1]) : null;
            if (themed) noteFace(usage, themed, face);
            else noteUnattributed(usage, face);
        }
    }

    // ---- OpenDocument -----------------------------------------------------

    const ODF_FONT_ATTRS = [
        'style:font-name', 'style:font-name-asian', 'style:font-name-complex',
        'fo:font-family', 'style:font-family-asian', 'style:font-family-complex'
    ];
    const ODF_WEIGHT_ATTRS = ['fo:font-weight', 'style:font-weight-asian', 'style:font-weight-complex'];
    const ODF_STYLE_ATTRS = ['fo:font-style', 'style:font-style-asian', 'style:font-style-complex'];

    function odfIsBold(v) {
        if (!v) return false;
        if (/^bold$/i.test(v)) return true;
        const n = parseInt(v, 10);
        return !isNaN(n) && n >= 550;
    }
    function odfIsItalic(v) {
        return !!v && /^(italic|oblique)$/i.test(v);
    }

    /**
     * Collect <style:style> / <style:default-style> definitions from one ODF
     * part into `out`. Font-face declarations are recorded too, because a style
     * references a face by its style:name while the real family lives in
     * svg:font-family and the two routinely differ.
     */
    function parseOdfStyles(xml, out) {
        if (!xml) return;
        for (const m of xml.matchAll(/<style:font-face\b((?:"[^"<]*"|[^<>"])*?)\/?>/g)) {
            const name = attrOf(m[1], 'style:name');
            const family = attrOf(m[1], 'svg:font-family');
            if (name && family) out.faceNames.set(name.toLowerCase(), family);
        }
        const openRe = /<style:(style|default-style)\b((?:"[^"<]*"|[^<>"])*?)(\/?)>/g;
        const bodyOf = elementBodies(xml);
        let m;
        while ((m = openRe.exec(xml)) !== null) {
            const body = m[3] !== '/' ? bodyOf('style:' + m[1], openRe.lastIndex) : '';
            const tp = /<style:text-properties\b((?:"[^"<]*"|[^<>"])*?)\/?>/.exec(body);
            const attrs = tp ? tp[1] : '';
            const fonts = new Set();
            for (const a of ODF_FONT_ATTRS) {
                const v = attrOf(attrs, a);
                if (!v) continue;
                // A font-family list ("Foo, Bar") — the first entry is what renders.
                const first = v.split(',')[0].replace(/^['"]|['"]$/g, '').trim();
                if (first) fonts.add(first);
            }
            let bold = false, italic = false;
            for (const a of ODF_WEIGHT_ATTRS) if (odfIsBold(attrOf(attrs, a))) bold = true;
            for (const a of ODF_STYLE_ATTRS) if (odfIsItalic(attrOf(attrs, a))) italic = true;

            const record = {
                parent: attrOf(m[2], 'style:parent-style-name'),
                fonts: fonts, bold: bold, italic: italic
            };
            if (m[1] === 'default-style') {
                out.defaults.push(record);
            } else {
                const name = attrOf(m[2], 'style:name');
                if (name) out.byName.set(name, record);
            }
        }

        // LIST STYLES. `<text:list text:style-name="L1">` names a
        // <text:list-style>, NOT a <style:style>, so before this loop existed
        // every paragraph inside a list looked like a reference to a style we
        // could not find — which escalates to total doubt and forfeits the
        // narrowing for the whole document. Measured on the corpus sample: L1 /
        // L2 / WWNum1 / WW8Num15 were far and away the commonest "missing"
        // style names, and lists are ubiquitous.
        //
        // A list style carries no font for the paragraph TEXT, only for its
        // bullet, so it contributes no `fonts` — the paragraph's own style
        // still decides that. Its bold/italic ARE propagated, over-approximating
        // in the safe direction.
        const listRe = /<text:list-style\b((?:"[^"<]*"|[^<>"])*?)(\/?)>/g;
        let lm;
        while ((lm = listRe.exec(xml)) !== null) {
            const name = attrOf(lm[1], 'style:name');
            if (!name) continue;
            let body = '';
            if (lm[2] !== '/') {
                const end = xml.indexOf('</text:list-style>', listRe.lastIndex);
                if (end !== -1) body = xml.slice(listRe.lastIndex, end);
            }
            // A benign declaration. A list style formats its BULLET or NUMBER,
            // never the paragraph text beside it, so it contributes no font and
            // no weight to anything that references it — it exists here only so
            // that `<text:list text:style-name="L1">` resolves instead of
            // escalating the whole document to total doubt. The bullet's own
            // formatting is picked up by scanOdfListStyles().
            out.byName.set(name, { parent: null, fonts: new Set(), bold: false, italic: false });
            out.listStyles.push({ name: name, body: body });
        }
    }

    /**
     * Bullets and numbers are rendered text of their own, usually in a symbol
     * font the body never names (OpenSymbol, Wingdings). Note them separately —
     * the list style deliberately contributes no font to the paragraph above.
     */
    /**
     * Styles that format text WITHOUT being an ancestor of it.
     *
     * scanOdfContent() resolves a text element against its own style refs and
     * its ANCESTORS' — which is right for spans, cells and frames, and blind to
     * three constructs an adversarial review found in the real corpus:
     *
     *   1. `table:default-cell-style-name` on <table:table-column> /
     *      <table:table-row>. The column is a SIBLING of the rows it formats, so
     *      no amount of ancestor walking reaches it. Measured: 19 corpus ODS
     *      files use it, 5 of them to make whole sheets bold.
     *   2. `style:map` / `calcext:condition` conditional cell formats, whose
     *      `*apply-style-name` names a style LibreOffice applies during export
     *      when the condition holds. 11 corpus files.
     *   3. `draw:text-style-name` on a self-closing <draw:control>, whose text
     *      lives in a form element elsewhere in the part.
     *
     * These are folded in document-wide rather than per-element, which
     * over-approximates (a conditional format counts even where its condition is
     * false) in the safe direction.
     */
    function scanOdfAuxRefs(xml, usage, styles) {
        if (!xml) return;
        const refs = new Set();
        for (const m of xml.matchAll(
                /(?:^|\s)[A-Za-z0-9_.:-]*(?:default-cell-style-name|apply-style-name|text-style-name)\s*=\s*"([^"]*)"/g)) {
            if (m[1]) refs.add(m[1]);
        }
        // ODP placeholders that carry only `presentation:class` inherit
        // "<master page>-<class>" from the master. Rather than track which
        // master a slide uses, admit every declared style whose name ends in
        // "-<class>" — wider than the truth, and never narrower.
        const classes = new Set();
        for (const m of xml.matchAll(/(?:^|\s)presentation:class\s*=\s*"([^"]*)"/g)) {
            if (m[1]) classes.add(m[1]);
        }
        if (classes.size) {
            for (const name of styles.byName.keys()) {
                for (const c of classes) if (name.endsWith('-' + c)) refs.add(name);
            }
        }

        for (const ref of refs) {
            const r = resolveOdfStyle(styles, ref);
            if (!r) continue;
            // NOTE: an unresolvable ref here does NOT escalate to total doubt,
            // unlike the same situation in scanOdfContent. Two reasons.
            //
            // First, correctness: a name referenced but declared nowhere in the
            // package falls back to the default style, which `styles.defaults`
            // already contributes — there is no hidden formatting to fear.
            //
            // Second, this pass is purely ADDITIVE. Without it we saw none of
            // these styles at all; it must not be able to make the answer worse
            // than not running it. It could: `apply-style-name` also appears on
            // <style:map> inside <number:number-style>, pointing at another
            // NUMBER format (N104P0 and friends). Escalating on those took the
            // ODS narrowing rate from 60/60 to 22/60 for no fidelity gain
            // whatsoever. What the ref DID resolve is still recorded.
            const face = faceOf(r.bold, r.italic);
            if (!r.fonts.size) noteUnattributed(usage, face);
            else for (const f of r.fonts) noteFace(usage, f, face);
        }
    }

    function scanOdfListStyles(styles, usage) {
        for (const ls of styles.listStyles) {
            // (a) formatting written inline on the level.
            for (const tp of ls.body.matchAll(/<style:text-properties\b((?:"[^"<]*"|[^<>"])*?)\/?>/g)) {
                let bold = false, italic = false;
                for (const a of ODF_WEIGHT_ATTRS) if (odfIsBold(attrOf(tp[1], a))) bold = true;
                for (const a of ODF_STYLE_ATTRS) if (odfIsItalic(attrOf(tp[1], a))) italic = true;
                const face = faceOf(bold, italic);
                let named = false;
                for (const a of ODF_FONT_ATTRS) {
                    const v = attrOf(tp[1], a);
                    if (!v) continue;
                    const first = v.split(',')[0].replace(/^['"]|['"]$/g, '').trim();
                    if (!first) continue;
                    noteFace(usage, styles.faceNames.get(first.toLowerCase()) || first, face);
                    named = true;
                }
                if (!named) noteUnattributed(usage, face);
            }
            // (b) formatting reached through a CHARACTER STYLE the level names —
            // `<text:list-level-style-bullet text:style-name="Bullet_20_Symbols"/>`
            // is how LibreOffice writes a bold or symbol-font bullet, and it
            // leaves no style:text-properties on the level at all.
            for (const m of ls.body.matchAll(
                    /(?:^|\s)[A-Za-z0-9_.:-]*style-name\s*=\s*"([^"]*)"/g)) {
                const r = resolveOdfStyle(styles, m[1]);
                if (!r) continue;
                const face = faceOf(r.bold, r.italic);
                if (!r.fonts.size) { if (r.bold || r.italic) noteUnattributed(usage, face); }
                else for (const f of r.fonts) noteFace(usage, f, face);
            }
        }
    }

    function resolveOdfStyle(styles, name) {
        if (!name) return null;
        if (styles.resolvedCache.has(name)) return styles.resolvedCache.get(name);
        const out = { fonts: new Set(), bold: false, italic: false, unknown: false };
        styles.resolvedCache.set(name, out);
        const seen = new Set();
        let cur = name;
        while (cur && !seen.has(cur)) {
            seen.add(cur);
            const s = styles.byName.get(cur);
            if (!s) { out.unknown = true; break; }
            if (!out.fonts.size && s.fonts.size) {
                for (const f of s.fonts) out.fonts.add(styles.faceNames.get(f.toLowerCase()) || f);
            }
            if (s.bold) out.bold = true;
            if (s.italic) out.italic = true;
            cur = s.parent;
        }
        return out;
    }

    const ODF_TEXT_ELEMENTS = new Set(['text:p', 'text:h', 'text:span', 'text:a']);
    // ANY attribute whose name ENDS in `style-name` (or `class-names`), whatever
    // sits in front of it. The first version of this required the local name to
    // be exactly `style-name`, which quietly excluded `draw:text-style-name`
    // (shapes and form controls) and `table:default-cell-style-name` (ODS column
    // and row defaults) even though the comment claimed otherwise — an adversarial
    // review caught the claim and the corpus confirmed real documents losing
    // their bold because of it.
    const ODF_STYLE_REF_RE =
        /(?:^|\s)([A-Za-z0-9_.:-]*(?:style-name|class-names))\s*=\s*"([^"]*)"/g;
    /**
     * Walk ODF content and attribute each text element to (family, face).
     *
     * Style refs are harvested by SHAPE rather than from a list of known
     * attribute names, so a container we did not think of — presentation:style-name
     * on an ODP frame, draw:text-style-name on a shape, table:style-name on a
     * cell — still contributes its formatting instead of being silently ignored.
     */
    function scanOdfContent(xml, usage, styles) {
        if (!xml) return;
        walkTags(xml, (el, stack) => {
            el.styleRefs = null;
            ODF_STYLE_REF_RE.lastIndex = 0;
            let r;
            while ((r = ODF_STYLE_REF_RE.exec(el.attrs || '')) !== null) {
                for (const one of r[2].split(/\s+/)) {
                    if (!one) continue;
                    (el.styleRefs || (el.styleRefs = [])).push(one);
                }
            }
            if (!ODF_TEXT_ELEMENTS.has(el.name)) return;

            let bold = false, italic = false, unknown = false, fonts = null;
            // Deepest first: the nearest style that names a font is the one that
            // renders. bold/italic are OR-ed over the whole nesting, which claims
            // bold for a child that explicitly turns it back off — over-fetching,
            // the safe direction.
            const chainSources = [];
            if (el.styleRefs) chainSources.push(el.styleRefs);
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].styleRefs) chainSources.push(stack[i].styleRefs);
            }
            for (const refs of chainSources) {
                for (const ref of refs) {
                    const r2 = resolveOdfStyle(styles, ref);
                    if (!r2) continue;
                    if (r2.bold) bold = true;
                    if (r2.italic) italic = true;
                    if (r2.unknown) unknown = true;
                    if (!fonts && r2.fonts.size) fonts = r2.fonts;
                }
            }
            for (const d of styles.defaults) {
                if (d.bold) bold = true;
                if (d.italic) italic = true;
                if (!fonts && d.fonts.size) {
                    fonts = new Set();
                    for (const f of d.fonts) fonts.add(styles.faceNames.get(f.toLowerCase()) || f);
                }
            }

            if (unknown) { noteTotalDoubt(usage); return; }
            const face = faceOf(bold, italic);
            if (!fonts || !fonts.size) { noteUnattributed(usage, face); return; }
            for (const f of fonts) noteFace(usage, f, face);
        });
    }

    // ---- per-format drivers ----------------------------------------------

    async function collectDocxUsage(zip, usage) {
        const doc = await readEntryText(zip.file('word/document.xml'), 'word/document.xml');
        if (!doc) return;                                    // stays resolved:false
        const theme = parseOoxmlTheme(
            await readEntryText(zip.file('word/theme/theme1.xml'), 'word/theme/theme1.xml'));
        const table = parseDocxStyles(
            await readEntryText(zip.file('word/styles.xml'), 'word/styles.xml'), theme);

        const parts = ['word/document.xml'].concat(
            Object.keys(zip.files).filter(p =>
                /^word\/(header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(p)));
        for (const p of parts) {
            const xml = p === 'word/document.xml' ? doc : await readEntryText(zip.file(p), p);
            if (!xml) { if (p !== 'word/document.xml') return; continue; }
            scanDocxPart(xml, usage, table, theme);
            scanDrawingML(xml, usage, theme);                // shapes/charts inline in the part
        }
        scanDocxNumbering(
            await readEntryText(zip.file('word/numbering.xml'), 'word/numbering.xml'), usage, theme);

        // Charts and SmartArt live in their own parts and are pure DrawingML.
        for (const p of Object.keys(zip.files)) {
            if (!/^word\/(charts|diagrams|drawings)\/.*\.xml$/.test(p)) continue;
            scanDrawingML(await readEntryText(zip.file(p), p), usage, theme);
        }
        usage.resolved = true;
    }

    async function collectXlsxUsage(zip, usage) {
        const styles = await readEntryText(zip.file('xl/styles.xml'), 'xl/styles.xml');
        if (!styles) return;
        const theme = parseOoxmlTheme(
            await readEntryText(zip.file('xl/theme/theme1.xml'), 'xl/theme/theme1.xml'));

        // Every <font> record in xl/styles.xml is a complete, self-contained
        // description — bold, italic and name in one element — so SpreadsheetML
        // is the one format where attribution needs no inheritance at all.
        // Records are counted whether or not a cell references them, which
        // matches how their NAMES are already collected.
        scanXlsxFontRecords(styles, usage, theme, X_FONT_RE, 'name');
        scanXlsxFontRecords(
            await readEntryText(zip.file('xl/sharedStrings.xml'), 'xl/sharedStrings.xml'),
            usage, theme, X_RPR_RE, 'rFont');

        for (const p of Object.keys(zip.files)) {
            if (!/^xl\/(charts|drawings)\/.*\.xml$/.test(p)) continue;
            scanDrawingML(await readEntryText(zip.file(p), p), usage, theme);
        }
        await scanXlsxWorksheets(zip, usage, theme);
        usage.resolved = true;
    }

    // How much inflated worksheet XML we are willing to read looking for the two
    // constructs below. MEASURED over the 534 .xlsx in test_corpus: the total
    // worksheet XML is 0.00 MB at p50 and 0.01 MB at p90, so this budget costs
    // nothing at all for 99% of workbooks — but the tail is savage (p99 67 MB,
    // max 598 MB), and inflating that to look for a page header is not a trade
    // worth making. 8 of 534 workbooks exceed it.
    const MAX_SHEET_SCAN_BYTES = 8 * 1024 * 1024;

    /**
     * Two things that format cell or page text WITHOUT a <font> record in
     * xl/styles.xml, both living in xl/worksheets/sheetN.xml:
     *
     *   1. Page header/footer format codes — `<oddHeader>&B…&B</oddHeader>`
     *      bolds, `&I` italicises, and `&"Arial,Bold Italic"` names a family and
     *      a style together. Rare (1 workbook in 534) but real, and the earlier
     *      claim in this file that there were ZERO was simply a bad measurement:
     *      the codes sit inside CDATA, so they read `&B`, not `&amp;B`.
     *   2. Rich INLINE strings — `<c t="inlineStr"><is><r><rPr><b/>…`. Nothing
     *      in sharedStrings.xml, nothing in styles.xml. No corpus workbook uses
     *      them, but streaming writers emit them routinely.
     *
     * A worksheet we decline to read could contain either, so a skipped sheet
     * escalates to total doubt rather than being quietly assumed plain.
     */
    async function scanXlsxWorksheets(zip, usage, theme) {
        const sheets = Object.keys(zip.files)
            .filter(p => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort();
        let budget = MAX_SHEET_SCAN_BYTES;
        let skipped = false;

        for (const p of sheets) {
            const entry = zip.file(p);
            const declared = entry && entry._data && entry._data.uncompressedSize;
            // Checked BEFORE reading: readEntryText would inflate the whole
            // entry before rejecting it, which is the cost we are avoiding.
            if (typeof declared === 'number' && declared > budget) { skipped = true; continue; }
            const xml = await readEntryText(entry, p);
            if (!xml) { skipped = true; continue; }
            budget -= xml.length;

            // Rich inline strings reuse the sharedStrings reader verbatim.
            scanXlsxFontRecords(xml, usage, theme, X_RPR_RE, 'rFont');

            for (const hf of untilLast(xml, '</headerFooter>').matchAll(/<headerFooter\b[\s\S]*?<\/headerFooter>/g)) {
                const text = hf[0];
                // `&"Family,Bold Italic"` names the face outright.
                for (const m of text.matchAll(/&(?:amp;)?"([^"&]+)"/g)) {
                    const parts = m[1].split(',');
                    const family = parts[0].trim();
                    const desc = (parts[1] || '').toLowerCase();
                    if (!family || family === '-') continue;
                    noteFace(usage, family, faceOf(/bold/.test(desc), /italic|oblique/.test(desc)));
                }
                // Bare &B / &I toggles apply to whatever face the header already
                // had, which we cannot name even when a &"Family,…" code is also
                // present (the toggles may sit outside its scope) — so they
                // widen every family.
                const bold = /&(?:amp;)?B/.test(text);
                const italic = /&(?:amp;)?I/.test(text);
                if (bold || italic) noteUnattributed(usage, faceOf(bold, italic));
            }
        }
        if (skipped) noteTotalDoubt(usage);
    }

    async function collectPptxUsage(zip, usage) {
        const slides = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p));
        const themes = Object.keys(zip.files).filter(p => /^ppt\/theme\/.*\.xml$/.test(p));
        if (!slides.length && !themes.length) return;

        // One theme per master; merging them is an over-approximation of what any
        // single slide can reference, which is the safe direction.
        let theme = { major: { latin: null, ea: null, cs: null },
                      minor: { latin: null, ea: null, cs: null } };
        for (const p of themes) {
            const t = parseOoxmlTheme(await readEntryText(zip.file(p), p));
            for (const k of ['major', 'minor']) {
                for (const s of ['latin', 'ea', 'cs']) {
                    if (!theme[k][s] && t[k][s]) theme[k][s] = t[k][s];
                }
            }
        }
        // EVERY .xml part under ppt/, not a hand-picked list of directories.
        // scanDrawingML only reacts to <a:rPr>, so a part with no DrawingML text
        // costs one inflate and nothing else — whereas an enumerated list
        // silently omits whatever it did not think of. Two real examples it
        // omitted: ppt/tableStyles.xml (table styles bold the header row and
        // live at the ROOT of ppt/, not in a subdirectory) and
        // ppt/handoutMasters/. Relationship parts hold no text.
        for (const p of Object.keys(zip.files)) {
            if (!/^ppt\/.*\.xml$/.test(p) || p.includes('/_rels/')) continue;
            scanDrawingML(await readEntryText(zip.file(p), p), usage, theme);
        }
        usage.resolved = true;
    }

    async function collectOdfUsage(zip, usage) {
        const content = await readEntryText(zip.file('content.xml'), 'content.xml');
        if (!content) return;
        const stylesXml = await readEntryText(zip.file('styles.xml'), 'styles.xml');

        const styles = {
            byName: new Map(), faceNames: new Map(), defaults: [],
            listStyles: [], resolvedCache: new Map()
        };
        parseOdfStyles(stylesXml, styles);
        parseOdfStyles(content, styles);

        scanOdfListStyles(styles, usage);
        scanOdfAuxRefs(content, usage, styles);
        scanOdfAuxRefs(stylesXml, usage, styles);
        scanOdfContent(content, usage, styles);
        // Headers, footers and ODP master slides carry real text of their own.
        const master = /<office:master-styles>[\s\S]*?<\/office:master-styles>/.exec(untilLast(stylesXml || '', '</office:master-styles>'));
        if (master) scanOdfContent(master[0], usage, styles);
        usage.resolved = true;
    }

    /**
     * Which weight/style faces of which families the document actually uses.
     * Never throws: on any failure the report says resolved:false, and the
     * caller then fetches every face exactly as it did before NTH-03.
     */
    async function collectFaceUsage(zip, ext) {
        const usage = newUsage();
        try {
            if (['docx', 'docm', 'dotx', 'dotm'].includes(ext)) await collectDocxUsage(zip, usage);
            else if (['xlsx', 'xlsm', 'xltx', 'xltm'].includes(ext)) await collectXlsxUsage(zip, usage);
            else if (['pptx', 'pptm', 'potx', 'potm', 'ppsx'].includes(ext)) await collectPptxUsage(zip, usage);
            else if (['odt', 'ods', 'odp', 'odg'].includes(ext)) await collectOdfUsage(zip, usage);
        } catch (e) {
            console.warn('[FontExtractor] Face-usage scan failed (fetching all faces):',
                         e.message || String(e));
            return newUsage();
        }
        return usage;
    }

    /**
     * Extract all fonts from a document file
     * @param {File|Blob|ArrayBuffer} file - The document file
     * @param {string} filename - Filename (for extension detection)
     * @param {Object} [options] - see extractFontsDetailed()
     * @returns {Promise<Set<string>>} Set of font family names found
     */
    async function extractFonts(file, filename, options) {
        return (await extractFontsDetailed(file, filename, options)).fonts;
    }

    /**
     * As extractFonts(), but also reports which of those families the document
     * SUPPLIES ITSELF via an embedded font the engine will accept, and which
     * weight/style FACES it actually uses (NTH-03). The ZIP is parsed once and
     * shared, so this costs no extra inflate over extractFonts().
     *
     * @param {Object} [options]
     * @param {string[]|null} [options.detectedScripts] - script ids the CALLER
     *   has already proven present in this document's text (FontResolver's
     *   detectScripts). Enables theme per-script fallback pruning; omit it, or
     *   pass null, and every theme entry is harvested exactly as before.
     * @param {boolean} [options.wantCoverage] - also read the cmap of every
     *   embedded face the engine will accept, so the caller can decide whether
     *   a SCRIPT font is still needed. Costs one cmap parse per accepted face;
     *   ask for it only when a script was actually detected.
     * @returns {Promise<{fonts:Set<string>, selfSupplied:Set<string>,
     *                    usage:Object, embeddedCoverage:{has:function}|null}>}
     */
    /** Read a whole file as text, whatever shape the caller handed us. */
    async function readAsText(file) {
        if (typeof file === 'string') return file;
        if (file instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(file);
        if (typeof file.text === 'function') return await file.text();
        if (typeof file.arrayBuffer === 'function') {
            return new TextDecoder('utf-8').decode(await file.arrayBuffer());
        }
        throw new Error('Unsupported file type for text extraction');
    }

    // CSS generic families are not font names — asking the matcher for "serif"
    // would map a generic to a specific family and defeat the engine's own
    // default-font configuration.
    const CSS_GENERICS = new Set([
        'serif', 'sans-serif', 'sans serif', 'monospace', 'cursive', 'fantasy',
        'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
        'math', 'emoji', 'fangsong', 'inherit', 'initial', 'unset', 'revert'
    ]);

    function addFamily(raw, fonts) {
        const name = String(raw)
            // Control characters cannot appear in a real family name, and they
            // are not legal XML 1.0 either — one reaching the generated
            // fontconfig rules would make the config malformed, which fontconfig
            // discards SILENTLY, taking every substitution with it.
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .trim().replace(/^['"]|['"]$/g, '').trim();
        if (!name || name.length > 128) return;
        if (CSS_GENERICS.has(name.toLowerCase())) return;
        if (name.charAt(0) === '+' || name.charAt(0) === '-') return;   // theme/vendor tokens
        fonts.add(name);
    }

    /**
     * Decode the entity forms that appear INSIDE font declarations.
     *
     * Only the quote and ampersand forms, deliberately: exported HTML writes
     * `style="font-family: &quot;Gill Sans&quot;"`, and without decoding, the
     * `;` that ends `&quot;` reads as the end of the declaration — the family
     * came out as the string `&quot`. `&lt;`/`&gt;` are NOT decoded, because
     * turning them into real angle brackets could synthesise tag boundaries that
     * are not in the document.
     */
    function decodeFontEntities(s) {
        return String(s).replace(/&(?:quot|#0*34|#[xX]0*22|apos|#0*39|#[xX]0*27|amp|#0*38|#[xX]0*26);/g,
            (e) => (/quot|34|22/.test(e) ? '"' : /apos|39|27/.test(e) ? "'" : '&'));
    }

    function addFamilyList(value, fonts) {
        for (const raw of String(value).split(',')) addFamily(raw, fonts);
    }

    /**
     * Read one CSS font-family VALUE, starting just after the colon.
     *
     * Scanned rather than matched, because the two things a regex has to do
     * here are in direct conflict: a value may legally contain quotes
     * (font-family:'Gill Sans'), but the declaration must also stop at the
     * closing quote of the HTML attribute it lives in
     * (style="font-family:Futura"). Both regexes I tried got one and broke the
     * other, SILENTLY — one dropped every quoted family, the next swallowed
     * `Futura" class="lead" id="a` as a single family name and ran across tag
     * boundaries. Neither showed up in a conversion test, because a real
     * fixture writes `font-family:X; font-size:Y` and the `;` hides it.
     *
     * The rule that distinguishes them: a quote at the START of an item (after
     * the colon or a comma) OPENS a family name; a quote after content ENDS the
     * declaration, because it can only be the attribute's own delimiter.
     */
    function readFontFamilyValue(text, start) {
        const names = [];
        let cur = '';
        let atItemStart = true;
        let i = start;
        for (; i < text.length; i++) {
            const c = text[i];
            // `!` ends the value: `font-family: Futura !important` must yield
            // `Futura`, not `Futura !important`, which matches no family and
            // silently loses the substitution for every !important rule.
            if (c === ';' || c === '}' || c === '<' || c === '>' || c === '!') break;
            if (c === '"' || c === "'") {
                if (!atItemStart) break;                   // the attribute's own quote
                const close = text.indexOf(c, i + 1);
                if (close === -1) break;                   // unterminated: give up on this decl
                cur = text.slice(i + 1, close);
                i = close;
                atItemStart = false;
                continue;
            }
            if (c === ',') { names.push(cur); cur = ''; atItemStart = true; continue; }
            if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
                if (cur !== '') cur += c;                   // keep spaces INSIDE a name
                continue;
            }
            cur += c;
            atItemStart = false;
        }
        names.push(cur);
        return names;
    }

    /**
     * Which FACES a text-format document uses, document-wide.
     *
     * Deliberately NOT attributed per family. Doing that properly means running
     * the CSS cascade (or RTF's control-word state machine) to know which family
     * a bold run was in, and a wrong answer here silently drops a face the
     * document needs — the worst failure mode in this file. So every face found
     * goes to `global` AND `unattributed`, which allowedFaces() unions in for
     * every family: narrowing still happens document-wide (a page with no bold
     * anywhere fetches one face per family instead of four) without ever
     * claiming per-family knowledge we do not have.
     *
     * Detection is deliberately generous, per this module's rule that uncertain
     * paths resolve upward: h1-h6, th, b/strong, and bold-ish font-weight values
     * all count as bold, because HTML renders those bold by default.
     */
    function textFormatUsage(text, ext) {
        const usage = newUsage();
        usage.resolved = true;
        let bold = false;
        let italic = false;

        if (ext === 'rtf') {
            // A control word may carry a numeric argument: `\b` and `\b1` both
            // turn bold ON, `\b0` turns it off. Requiring no digit at all missed
            // `\b1`, which real emitters write — and the cost of missing it is
            // that the Bold face is never downloaded, so bold text renders
            // un-bold. `(?![a-z])` keeps \bin and \info from matching.
            const on = (word) =>
                new RegExp('\\\\' + word + '(?![a-z])(\\d+)?', 'ig');
            const anyOn = (word) => {
                for (const m of text.matchAll(on(word))) {
                    if (m[1] === undefined || Number(m[1]) !== 0) return true;
                }
                return false;
            };
            bold = anyOn('b');
            italic = anyOn('i');
        } else {
            // `font:` is the shorthand form and carries the weight/style as bare
            // keywords, e.g. `font: bold italic 16px Futura`. Missing it drops
            // the face silently.
            const shorthand = [...text.matchAll(/font\s*:\s*([^;}<>]*)/gi)]
                .map((m) => m[1]).join(' ');
            bold = /<\s*(b|strong|h[1-6]|th)\b/i.test(text)
                || /font-weight\s*:\s*(bold|bolder|[6-9]00)/i.test(text)
                || /\b(bold|bolder)\b/i.test(shorthand);
            italic = /<\s*(i|em|address|cite|var|dfn)\b/i.test(text)
                || /font-style\s*:\s*(italic|oblique)/i.test(text)
                || /\b(italic|oblique)\b/i.test(shorthand);
        }

        noteUnattributed(usage, FACE_REGULAR);
        if (bold) noteUnattributed(usage, FACE_BOLD);
        if (italic) noteUnattributed(usage, FACE_ITALIC);
        if (bold && italic) noteUnattributed(usage, FACE_BOLD_ITALIC);
        return usage;
    }

    /**
     * Font families named by an HTML or RTF document.
     *
     * `selfSupplied` is always empty: neither format can carry an embedded font
     * the engine will accept through this path (an HTML @font-face src would be
     * a network fetch, which this build does not make), so every family named
     * here needs a substitute from us.
     */
    async function extractTextFormatFonts(file, ext) {
        const text = await readAsText(file);
        const fonts = new Set();

        if (ext === 'rtf') {
            extractRtfFontTable(text, fonts);
        } else {
            // style="font-family: X" and any CSS in <style> blocks share this
            // one declaration form, so a single pass covers both.
            // Entity-decoded FIRST: exported HTML writes
            // style="font-family: &quot;Gill Sans&quot;", and the `;` closing
            // `&quot;` otherwise reads as the end of the declaration, yielding
            // the family name "&quot".
            const html = decodeFontEntities(text);

            const decl = /font-family\s*:\s*/gi;
            let m;
            while ((m = decl.exec(html)) !== null) {
                for (const name of readFontFamilyValue(html, decl.lastIndex)) {
                    addFamily(name, fonts);
                }
            }

            // The `font:` SHORTHAND also carries a family, and it is the last
            // component: `font: bold 16px/1.4 Futura, serif`. Missing it drops
            // the family entirely, not merely its weight. Everything up to and
            // including the size token is skipped; a value with no size token is
            // not a valid shorthand and is left alone.
            const short = /\bfont\s*:\s*([^;}<>!]*)/gi;
            while ((m = short.exec(html)) !== null) {
                // The size token must carry a UNIT or be a size KEYWORD. A bare
                // number is the WEIGHT: `font: small-caps 700 medium Georgia`
                // otherwise treated 700 as the size and yielded the family
                // "medium Georgia".
                const size = /(?:^|\s)(?:[\d.]+(?:px|pt|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pc|q|%)|xx?-(?:small|large)|small|medium|large|larger|smaller)(?:\s*\/\s*[^\s]+)?\s+/i.exec(m[1]);
                if (!size) continue;
                addFamilyList(m[1].slice(size.index + size[0].length), fonts);
            }

            // Legacy presentational markup, still common in exported HTML.
            //
            // Matched against the ORIGINAL text, not the decoded copy, and
            // decoded per value instead: `face="&quot;Gill Sans&quot;"` decodes
            // to `face=""Gill Sans""`, whose first quoted group is the EMPTY
            // string, so decoding first loses the name entirely.
            for (const fm of text.matchAll(/<\s*font\b(?:"[^"]*"|'[^']*'|[^<>"'])*?\bface\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
                addFamilyList(decodeFontEntities(fm[2] || fm[3] || fm[4] || ''), fonts);
            }
        }

        console.log(`[FontExtractor] ${ext}: ${fonts.size} font family(ies) named:`,
                    Array.from(fonts).join(', ') || '(none)');
        return {
            fonts,
            selfSupplied: new Set(),
            usage: textFormatUsage(text, ext),
            embeddedCoverage: null
        };
    }

    /**
     * RTF `\fonttbl` group. Entries look like `{\f0\froman\fcharset0 Georgia;}`
     * — the family name is whatever survives after the control words, up to the
     * terminating semicolon.
     *
     * Scanned by walking braces rather than by one regex: the group nests, and a
     * regex that stops at the first `}` truncates the table after one entry.
     */
    function extractRtfFontTable(text, fonts) {
        const start = text.indexOf('\\fonttbl');
        if (start === -1) return;

        let depth = 0;
        let end = text.length;
        for (let i = start; i < text.length; i++) {
            const c = text[i];
            if (c === '\\') { i++; continue; }             // skip escaped char
            if (c === '{') depth++;
            else if (c === '}') {
                if (depth === 0) { end = i; break; }        // closes \fonttbl's own group
                depth--;
            }
        }

        for (const entry of text.slice(start, end).split(';')) {
            // `\{`, `\}` and `\\` are LITERAL characters OF THE NAME, not
            // group delimiters or control words, so they must survive both
            // strips below. They are ENCODED to placeholders rather than merely
            // prefixed: a prefixed `{` is still a `{`, so the delimiter strip ate
            // it anyway and the name came back "Weird Name" instead of
            // "Weird{Name". U+0001..U+0003 cannot occur in RTF source. (Not
            // U+0000: a literal NUL byte in this file makes grep treat the whole
            // source as binary, which silently breaks searching it.)
            const PARK = { '{': '\u0001', '}': '\u0002', '\\': '\u0003' };
            const UNPARK = { '\u0001': '{', '\u0002': '}', '\u0003': '\\' };
            const name = entry
                .replace(/\\([\\{}])/g, (_, ch) => PARK[ch])
                // \'xx is a hex-escaped character of the NAME. The control-word
                // strip below does not match it (it is not [a-z]), so without
                // this a name like Lucida\'20Sans survived as "Lucida'20Sans"
                // and matched nothing.
                .replace(/\\'([0-9a-f]{2})/gi,
                         (_, hh) => String.fromCharCode(parseInt(hh, 16)))
                .replace(/\\\*/g, ' ')
                .replace(/\\[a-z]+-?\d*\s?/gi, ' ')          // control words
                .replace(/[{}]/g, ' ')                       // real group delimiters
                .replace(/[\u0001-\u0003]/g, (ch) => UNPARK[ch])
                .replace(/\s+/g, ' ')
                .trim();
            if (name && name.length <= 128) fonts.add(name);
        }
    }

    async function extractFontsDetailed(file, filename, options) {
        const empty = () => ({
            fonts: new Set(), selfSupplied: new Set(), usage: newUsage(), embeddedCoverage: null
        });

        const ext = (filename || file.name || '').split('.').pop().toLowerCase();

        // Text formats first: they are not ZIPs, so requiring JSZip below would
        // reject them for a reason that has nothing to do with them.
        if (TEXT_FORMATS.includes(ext)) {
            try {
                return await extractTextFormatFonts(file, ext);
            } catch (e) {
                // Never fail a conversion over font metadata; an empty result
                // just means the resolver falls back to the essential set, which
                // is exactly what these formats got before this existed.
                console.warn('[FontExtractor] text-format extraction failed:', e);
                return empty();
            }
        }

        if (!await ensureJSZip()) {
            console.warn('[FontExtractor] JSZip not available, returning empty font list');
            return empty();
        }

        if (!EXTRACTABLE_FORMATS.includes(ext)) {
            console.log('[FontExtractor] Format not extractable:', ext);
            return empty();
        }

        try {
            // Get ArrayBuffer from file
            let arrayBuffer;
            if (file instanceof ArrayBuffer) {
                arrayBuffer = file;
            } else if (file.arrayBuffer) {
                arrayBuffer = await file.arrayBuffer();
            } else {
                throw new Error('Unsupported file type');
            }

            const zip = await JSZip.loadAsync(arrayBuffer);
            const fonts = new Set();
            const detected = (options && Array.isArray(options.detectedScripts))
                ? options.detectedScripts : null;

            // Extract based on format type
            if (['docx', 'docm', 'dotx', 'dotm'].includes(ext)) {
                await extractDocxFonts(zip, fonts, detected);
            } else if (['xlsx', 'xlsm', 'xltx', 'xltm'].includes(ext)) {
                await extractXlsxFonts(zip, fonts, detected);
            } else if (['pptx', 'pptm', 'potx', 'potm', 'ppsx'].includes(ext)) {
                await extractPptxFonts(zip, fonts, detected);
            } else if (['odt', 'ods', 'odp', 'odg'].includes(ext)) {
                await extractOdfFonts(zip, fonts);
            }

            const embedded = await extractEmbeddedFontFamilies(
                zip, ext, !!(options && options.wantCoverage),
                // D4: the engine's rights rule depends on whether every output is PDF.
                String((options && options.targetFormat) || '').toLowerCase() === 'pdf',
                // FG-054: only a host that switched the engine's EOT decoding on.
                !!(options && options.acceptEot));
            const selfSupplied = embedded.families;
            const embeddedCoverage = embedded.coverage;
            const embeddedExpected = embedded.expected || { files: [], numbered: [] };
            const usage = await collectFaceUsage(zip, ext);

            console.log('[FontExtractor] Extracted fonts from', filename + ':', Array.from(fonts));
            if (usage.resolved) {
                console.log('[FontExtractor] Faces in use:', Array.from(usage.global).join(', ') || '(none)',
                            '| attributed families:', usage.faces.size,
                            '| unattributable faces:', Array.from(usage.unattributed).join(', ') || 'none');
            }
            return { fonts, selfSupplied, usage, embeddedCoverage, embeddedExpected };

        } catch (e) {
            console.error('[FontExtractor] Failed to extract fonts:', e);
            return empty();
        }
    }

    /**
     * Extract fonts from DOCX (Word) document
     * Font info is in word/fontTable.xml and word/document.xml
     */
    async function extractDocxFonts(zip, fonts, detectedScripts) {
        // Primary source: fontTable.xml
        const fontTableFile = zip.file('word/fontTable.xml');
        if (fontTableFile) {
            const content = await readEntryText(fontTableFile, 'word/fontTable.xml');
            // Match w:name="FontName" patterns
            const matches = content.matchAll(/w:name="([^"]+)"/g);
            for (const match of matches) {
                addFont(fonts, match[1]);
            }
        }

        // Secondary source: document.xml (rFonts elements)
        //
        // BUG (found 2026-07-26, fixed here): the old pattern was
        // `/w:(?:ascii|hAnsi|eastAsia|cs)="([^"]+)"/g` run over the WHOLE part.
        // That attribute set is not unique to <w:rFonts> -- <w:lang w:val="en-US"
        // w:eastAsia="ja-JP" w:bidi="ar-SA"/> also carries w:eastAsia, so a
        // LOCALE STRING ("ja-JP", "en-US", ...) was fed to the font matcher as
        // if it were a family name. Measured: 336 of 2,251 corpus DOCX files
        // (363 instances) produced a bogus "family" this way. Today it is inert
        // -- these strings match nothing in the registry and fall back to the
        // already-loaded default -- but it wastes matcher work and is a live
        // landmine: a locale code colliding with a real registry family would
        // silently trigger a download nothing asked for.
        //
        // FIX: scope the scan to attributes that occur INSIDE a <w:rFonts .../>
        // element. w:rFonts is the only WordprocessingML element with ascii/
        // hAnsi/cs attributes at all, and it is the only one where w:eastAsia
        // means "font family" rather than "locale". Reuses `attrOf`, the same
        // per-attribute matcher NTH-03's wFontsOf() already uses for exactly
        // this element -- confirmed there to skip the *Theme variants
        // (w:asciiTheme etc.) correctly, since "w:ascii" cannot match partway
        // through "w:asciiTheme=" (the literal '=' immediately after "ascii"
        // fails against "Theme...").
        const docFile = zip.file('word/document.xml');
        if (docFile) {
            const content = await readEntryText(docFile, 'word/document.xml');
            const rFontsTagPattern = /<w:rFonts\b((?:"[^"<]*"|[^<>"])*?)\/?>/g;
            let tagMatch;
            while ((tagMatch = rFontsTagPattern.exec(content)) !== null) {
                const attrs = tagMatch[1];
                for (const a of ['w:ascii', 'w:hAnsi', 'w:eastAsia', 'w:cs']) {
                    const v = attrOf(attrs, a);
                    if (v) addFont(fonts, v);
                }
            }
        }

        // Theme fonts from theme/theme1.xml
        const themeFile = zip.file('word/theme/theme1.xml');
        if (themeFile) {
            const variants = await eastAsianVariantsInParts(zip,
                ['word/settings.xml', 'word/styles.xml', 'word/document.xml']);
            await extractThemeFonts(themeFile, fonts, detectedScripts, variants);
        }
    }

    /**
     * Extract fonts from XLSX (Excel) document
     * Font info is in xl/styles.xml
     */
    async function extractXlsxFonts(zip, fonts, detectedScripts) {
        const stylesFile = zip.file('xl/styles.xml');
        if (stylesFile) {
            const content = await readEntryText(stylesFile, 'xl/styles.xml');
            // Match <name val="FontName"/> pattern
            const matches = content.matchAll(/<name\s+val="([^"]+)"/g);
            for (const match of matches) {
                addFont(fonts, match[1]);
            }
        }

        // Workbook theme
        const themeFile = zip.file('xl/theme/theme1.xml');
        if (themeFile) {
            // SpreadsheetML carries no language, so a workbook keeps neither
            // Chinese entry (FG-055); its cells name their fonts in styles.xml.
            await extractThemeFonts(themeFile, fonts, detectedScripts, new Set());
        }
    }

    /**
     * Extract fonts from PPTX (PowerPoint) document
     * Font info is in ppt/theme/*.xml and ppt/slides/*.xml
     */
    async function extractPptxFonts(zip, fonts, detectedScripts) {
        // Theme fonts
        const themeFiles = Object.keys(zip.files).filter(f =>
            f.startsWith('ppt/theme/') && f.endsWith('.xml')
        );
        const variants = await eastAsianVariantsInParts(zip, Object.keys(zip.files).filter(f =>
            /^ppt\/(slides|slideMasters|slideLayouts)\/[^/]+\.xml$/.test(f) || f === 'ppt/presentation.xml'));
        for (const themePath of themeFiles) {
            const themeFile = zip.file(themePath);
            if (themeFile) {
                await extractThemeFonts(themeFile, fonts, detectedScripts, variants);
            }
        }

        // Slide masters and layouts
        const masterFiles = Object.keys(zip.files).filter(f =>
            (f.startsWith('ppt/slideMasters/') || f.startsWith('ppt/slideLayouts/')) && f.endsWith('.xml')
        );
        for (const masterPath of masterFiles) {
            const file = zip.file(masterPath);
            if (file) {
                const content = await readEntryText(file, masterPath);
                extractTypefaceFromXml(content, fonts);
            }
        }

        // Individual slides
        const slideFiles = Object.keys(zip.files).filter(f =>
            f.startsWith('ppt/slides/slide') && f.endsWith('.xml')
        );
        for (const slidePath of slideFiles) {
            const file = zip.file(slidePath);
            if (file) {
                const content = await readEntryText(file, slidePath);
                extractTypefaceFromXml(content, fonts);
            }
        }
    }

    /**
     * Extract fonts from ODF (LibreOffice) documents
     * Font info is in styles.xml and content.xml
     */
    async function extractOdfFonts(zip, fonts) {
        // styles.xml
        const stylesFile = zip.file('styles.xml');
        if (stylesFile) {
            const content = await readEntryText(stylesFile, 'styles.xml');
            extractOdfFontDeclarations(content, fonts);
        }

        // content.xml
        const contentFile = zip.file('content.xml');
        if (contentFile) {
            const content = await readEntryText(contentFile, 'content.xml');
            extractOdfFontDeclarations(content, fonts);
        }
    }

    // ==================================================================
    // THEME FONTS — and the ONE distinction that keeps a pure-English page
    // from downloading 10 MB of CJK.
    //
    // <a:fontScheme> holds <a:majorFont> (headings) and <a:minorFont> (body).
    // Each contains TWO DIFFERENT KINDS of child, and they are not
    // interchangeable:
    //
    //   1. <a:latin typeface="Calibri"/>, <a:ea typeface="…"/>,
    //      <a:cs typeface="…"/>
    //      The theme's OWN typefaces. These are what `+mn-lt` / `+mj-ea` and
    //      w:asciiTheme / w:eastAsiaTheme / w:cstheme RESOLVE TO, so a
    //      document's body font routinely IS one of them. Always harvested.
    //
    //   2. <a:font script="Jpan" typeface="游明朝"/>
    //      Word's PER-SCRIPT FALLBACK LIST — one typeface for each of ~48
    //      scripts, written into every theme Word saves regardless of content.
    //      Nothing can reference an entry by name; it is consulted only when
    //      the text itself contains a character of that script.
    //
    // The old code ran one `typeface="…"` regex over the whole major/minor
    // block, which cannot tell (1) from (2) and so swallowed all 48 fallbacks.
    // MEASURED 2026-07-27 on test_corpus/fixtures/documents/DOCX_TestPage.docx,
    // an English test page: 46 families harvested, of which 游ゴシック Light and
    // 游明朝 resolved to BIZ UDPGothic + BIZ UDPMincho = 10.32 MB downloaded for
    // a document containing not one CJK character. Those names came from
    // <a:font script="Jpan">; the document's real fonts came from <a:latin>.
    //
    // THE RULE: a kind-(2) entry is dropped only on POSITIVE PROOF that its
    // script is absent — ConversionProtocol.themeScriptFallbackUnused, i.e. the
    // tag maps to a script detectScripts() can see AND the caller's trusted,
    // non-empty text sample did not contain it. No detection (`detectedScripts`
    // null), an untrusted/empty sample, an unmappable tag, or no
    // ConversionProtocol at all => harvest everything, exactly as before.
    // Over-fetching costs bytes; under-fetching costs glyphs.
    //
    // <a:ea> AND <a:cs> ARE DELIBERATELY NOT FILTERED, though <a:ea> is an East
    // Asian declaration that a document with no CJK text cannot use either.
    // Three measurements decided it:
    //   * Office themes leave both EMPTY (typeface="") — DOCX_TestPage included
    //     — so filtering them would have saved nothing on the very file that
    //     motivated this work.
    //   * Across 3,064 corpus OOXML files only 246 of 6,558 major/minor <a:ea>
    //     slots are non-empty, and 202 of those say "DejaVu Sans" (a
    //     LibreOffice-authored theme). DejaVu Sans is the ONLY face we ship
    //     that covers Arabic, Hebrew, Georgian, Armenian and Lao — scripts
    //     deliberately absent from SCRIPTS (see the note there), hence
    //     undetectable, hence impossible to prove unused. Dropping it on
    //     "no CJK detected" would be exactly the tofu trade this project bans.
    //   * Of the 18 slots that DO name a CJK face (9 files: ＭＳ Ｐゴシック,
    //     ヒラギノ角ゴ, SimSun, 微软雅黑, MS Gothic/Mincho, Microsoft YaHei),
    //     17 declare the SAME family somewhere outside the theme as well —
    //     ppt/slideMasters/*.xml, ppt/slides/*.xml, word/styles.xml,
    //     word/fontTable.xml — where it is harvested regardless. Exactly one
    //     slot in the whole corpus (MS Gothic, majorFont of
    //     test_corpus/extended/documents/tdf107969.docx) is theme-only. The
    //     entire measured prize for filtering <a:ea> is that one family in that
    //     one file.
    // The line this draws is defensible on its own: we only prune declarations
    // living in a part that contains NO TEXT OF ITS OWN (a theme), so there is
    // no unsampled text hiding behind the decision.
    // ==================================================================

    /** ConversionProtocol is a SOFT dependency: without it, nothing is pruned. */
    function protocol() {
        const p = (typeof window !== 'undefined' && window.ConversionProtocol) ||
                  (typeof self !== 'undefined' && self.ConversionProtocol) || null;
        return (p && typeof p.themeScriptFallbackUnused === 'function') ? p : null;
    }

    // FG-055: a theme's per-script list names a typeface for Simplified (Hans)
    // AND Traditional (Hant) Chinese, and both scripts are the same `han` to
    // detectScripts(), so han text alone cannot say which entry Word uses. Word
    // picks by the East Asian LANGUAGE: in DOCX by w:themeFontLang w:eastAsia
    // (word/settings.xml), which is also what LibreOffice's import reads
    // (writerfilter ThemeHandler::getFontNameForTheme). So a Hans or Hant entry
    // is kept only when the package declares that variant (w:themeFontLang or
    // w:lang in DOCX, lang/altLang in DrawingML). Without that, Office's 新細明體 (Hant)
    // would mount Noto Serif TC (7.9 MB) for every Japanese or Simplified
    // Chinese document, and glyph fallback then drew their text in it
    // (measured on theme_jpan_japanese.docx). Before these families were mapped
    // the two entries resolved to Liberation Sans and were inert, so skipping
    // them without evidence draws what was drawn before. Like the rule above,
    // it applies only when script evidence exists: with none, everything is
    // harvested.
    function eastAsianVariantOfLang(tag) {
        const t = String(tag || '').trim().toLowerCase().replace(/_/g, '-');
        if (t === 'ja' || t.startsWith('ja-')) return 'jpan';
        if (t !== 'zh' && !t.startsWith('zh-')) return null;
        if (/^zh-(hant\b|tw\b|hk\b|mo\b)/.test(t)) return 'hant';
        if (t === 'zh' || /^zh-(hans\b|cn\b|sg\b)/.test(t)) return 'hans';
        return null;
    }

    /** Hans/Hant variants declared in OOXML text: w:themeFontLang and w:lang (WordprocessingML), lang/altLang (DrawingML). */
    function eastAsianVariantsDeclared(xmlTexts) {
        const found = new Set();
        for (const xml of xmlTexts || []) {
            if (!xml) continue;
            // `[^<>"]`, not `[^>]`: with both alternatives able to take a quote, a
            // malformed tag with no closing `>` (`<w:lang a"b"a"b"…`) backtracked
            // exponentially — about 100 bytes froze the tab (WAF review of #571).
            // The gap also stops at '<' (#588's rule), so a tag never runs into the
            // next one. Linear; matches the same tags, including a `>` inside a quoted value.
            for (const m of xml.matchAll(/<w:(?:themeFontLang|lang)\b((?:"[^"<]*"|[^<>"])*?)\/?>/g)) {
                for (const a of ['w:eastAsia', 'w:val']) {
                    const v = eastAsianVariantOfLang(attrOf(m[1], a));
                    if (v) found.add(v);
                }
            }
            for (const m of xml.matchAll(/\s(?:lang|altLang)="([^"]*)"/g)) {
                const v = eastAsianVariantOfLang(m[1]);
                if (v) found.add(v);
            }
        }
        return found;
    }

    async function eastAsianVariantsInParts(zip, paths) {
        const texts = [];
        for (const path of paths) {
            const f = zip.file(path);
            if (f) texts.push(await readEntryText(f, path));
        }
        return eastAsianVariantsDeclared(texts);
    }

    /**
     * Extract theme fonts (shared by DOCX, XLSX, PPTX).
     * @param {Object} themeFile - JSZip entry for the theme part
     * @param {Set<string>} fonts - accumulator
     * @param {string[]|null} [detectedScripts] - script ids PROVEN present in
     *   the document's text. null/undefined => harvest every entry (pre-fix).
     * @param {Set<string>|null} [chineseVariants] - 'hans'/'hant'/'jpan' declared
     *   in the package (eastAsianVariantsDeclared). A Hans or Hant entry is kept
     *   only when its variant is in this set (FG-055); a Jpan entry when it is,
     *   or when the text has kana (`kana` in detectedScripts, FG-186).
     */
    async function extractThemeFonts(themeFile, fonts, detectedScripts, chineseVariants) {
        const content = await readEntryText(themeFile, 'theme');
        if (!content) return;
        const P = Array.isArray(detectedScripts) ? protocol() : null;
        const skipped = [];
        const skippedVariant = [];

        for (const which of ['major', 'minor']) {
            const block = new RegExp(
                '<a:' + which + 'Font\\b[^<>]*>([\\s\\S]*?)</a:' + which + 'Font>').exec(untilLast(content, '</a:' + which + 'Font>'));
            if (!block) continue;
            const body = block[1];

            // (1) the theme's own typefaces — always kept.
            for (const m of body.matchAll(/<a:(?:latin|ea|cs)\b[^<>]*\btypeface="([^"]*)"/g)) {
                addFont(fonts, m[1]);
            }

            // (2) the per-script fallback list — kept unless provably unused.
            for (const m of body.matchAll(/<a:font\b[^<>]*\/?>/g)) {
                const face = /\btypeface="([^"]*)"/.exec(m[0]);
                if (!face) continue;
                const tag = /\bscript="([^"]*)"/.exec(m[0]);
                // An <a:font> with NO script attribute is malformed for this
                // schema; there is nothing to prove absent, so keep it.
                if (P && tag && P.themeScriptFallbackUnused(tag[1], detectedScripts)) {
                    if (face[1]) skipped.push(tag[1] + ':' + face[1]);
                    continue;
                }
                const variant = P && tag && tag[1].trim().toLowerCase();
                if ((variant === 'hans' || variant === 'hant')
                    && !(chineseVariants && chineseVariants.has(variant))) {
                    if (face[1]) skippedVariant.push(tag[1] + ':' + face[1]);
                    continue;
                }
                // FG-186: the same for Japanese. Han text alone is not Japanese;
                // kana is, and so is a declared ja language. Without this, every
                // Chinese document (and every CJK-numbered list) fetched the
                // theme's BIZ UD Mincho and Gothic, 5.78 MB never drawn (measured).
                if (variant === 'jpan' && !detectedScripts.includes('kana')
                    && !(chineseVariants && chineseVariants.has('jpan'))) {
                    if (face[1]) skippedVariant.push(tag[1] + ':' + face[1]);
                    continue;
                }
                addFont(fonts, face[1]);
            }
        }

        if (skipped.length) {
            console.log(
                `[FontExtractor] Theme: skipped ${skipped.length} per-script fallback ` +
                `typeface(s) for scripts this document does not contain` +
                (detectedScripts.length ? ` (detected: ${detectedScripts.join(', ')})` : '') +
                ':', skipped.join(', '));
        }
        if (skippedVariant.length) {
            console.log(
                `[FontExtractor] Theme: skipped ${skippedVariant.length} Chinese per-script ` +
                `fallback(s) whose variant the document does not declare:`, skippedVariant.join(', '));
        }
    }

    /**
     * Extract typeface attributes from XML content
     */
    function extractTypefaceFromXml(content, fonts) {
        // Match typeface="FontName" patterns (PowerPoint, themes)
        const matches = content.matchAll(/typeface="([^"]+)"/g);
        for (const match of matches) {
            addFont(fonts, match[1]);
        }

        // Also match a:latin, a:ea, a:cs font elements
        const fontElements = content.matchAll(/<a:(?:latin|ea|cs)\s+typeface="([^"]+)"/g);
        for (const match of fontElements) {
            addFont(fonts, match[1]);
        }
    }

    /**
     * Extract font declarations from ODF content
     */
    function extractOdfFontDeclarations(content, fonts) {
        // Match style:font-name="FontName"
        const fontNameMatches = content.matchAll(/style:font-name="([^"]+)"/g);
        for (const match of fontNameMatches) {
            addFont(fonts, match[1]);
        }

        // Match svg:font-family="FontName" (used in font-face declarations)
        const svgFontMatches = content.matchAll(/svg:font-family="([^"]+)"/g);
        for (const match of svgFontMatches) {
            addFont(fonts, match[1]);
        }

        // Match fo:font-family="FontName"
        const foFontMatches = content.matchAll(/fo:font-family="([^"]+)"/g);
        for (const match of foFontMatches) {
            addFont(fonts, match[1]);
        }
    }

    /**
     * Add a font to the set, with normalization
     */
    function addFont(fonts, fontName) {
        if (!fontName) return;

        // Skip theme placeholders
        if (fontName.startsWith('+') || fontName === '') return;

        // Clean up font name
        let cleaned = fontName.trim();

        // Remove quotes if present
        cleaned = cleaned.replace(/^['"]|['"]$/g, '');

        // Skip if empty after cleaning
        if (!cleaned) return;

        fonts.add(cleaned);
    }

    /**
     * Entry paths (per format family) whose XML carries the document's visible
     * text. Used by extractTextSample() for BUG-12 script sniffing.
     */
    const TEXT_PART_PATTERNS = {
        word:  /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/,
        excel: /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/,
        ppt:   /^ppt\/(slides|notesSlides)\/(slide|notesSlide)\d+\.xml$/,
        odf:   /^(content|styles)\.xml$/
    };

    // Oversized parts are skipped by readEntryText (F-6, MAX_ENTRY_BYTES):
    // decompressing them to sniff a script is not worth the wall-clock, and
    // 200 KB of any real document is plenty of sample.
    const DEFAULT_MAX_CHARS = 200 * 1024;

    /**
     * Extract a sample of a ZIP-based document's TEXT (not its font metadata).
     *
     * BUG-12: a DOCX can hold Japanese under a Latin font name ("Calibri"), so
     * metadata-only extraction cannot tell whether a CJK/Thai/Devanagari font is
     * needed. Sniffing the actual content can.
     *
     * XML tags are stripped so only TEXT NODES are returned. That matters: Office
     * files routinely declare CJK font names ('SimSun, 宋体') or localized style
     * names in attributes, and counting those as content would load a 4 MB CJK
     * font — or raise a bogus "no Korean font" warning — for a document that is
     * pure Latin. Measured on 300 corpus files: 3 hits raw, 1 (a genuine 下划线)
     * after stripping.
     *
     * @param {File|Blob|ArrayBuffer} file
     * @param {string} filename
     * @param {number} [maxChars] - stop after this many characters
     * @returns {Promise<string>} sampled text ('' on any failure — never throws)
     */
    async function extractTextSample(file, filename, maxChars) {
        return (await extractTextSampleDetailed(file, filename, maxChars)).text;
    }

    /**
     * As extractTextSample(), but also says whether the sample is the WHOLE of
     * the document's text.
     *
     * WHY THAT MATTERS. Adding a font on the strength of a sample is safe: a
     * script seen in the first 200 KB is really there. DROPPING one is not.
     * "Every code point of this script in the document is covered by the font
     * the document embeds" is only a proof if we read every code point — a deck
     * whose first slides are Latin and whose last slide is Japanese would
     * otherwise lose its CJK font on the strength of never having looked.
     * `complete:false` means exactly that: no absence may be concluded.
     *
     * @returns {Promise<{text:string, complete:boolean}>}
     */
    /**
     * FG-186: characters the layout will generate for list labels, footnote
     * marks and page numbers in a CJK numbering format (甲 乙 丙, 一 二 三, ア イ
     * ウ, 가 나 다, ０ １ ２ …). They are in no text part, so without this the
     * text sample saw no CJK, no CJK face was mounted, and the labels drew as
     * boxes. Appended to the sample, they count as text for every decision that
     * reads it. The repertoires are ConversionProtocol's LIST_LABEL_CHARS.
     *
     * DOCX: only numberings a part actually references (w:numId in the
     * document, styles, headers, footers, notes; numId 0 means none), every level
     * of their abstractNum, plus level overrides. Footnote, endnote and page-
     * number formats are read from document.xml and settings.xml. ODF: every
     * style:num-format in content.xml and styles.xml (lists, page numbers,
     * notes). Never throws; '' when there is nothing to add.
     */
    // Literal label text ("第%1章") counts only for its CJK and Hangul characters:
    // a bullet list's literal is its bullet glyph, drawn in the level's own font,
    // and counting it fetched DejaVu Sans for two corpus documents (measured).
    function cjkOnly(text) {
        return String(text || '').replace(/[^\u1100-\u11FF\u3000-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFF00-\uFFEF]/g, '');
    }

    async function generatedLabelText(zip, ext) {
        const P = (typeof window !== 'undefined' && window.ConversionProtocol) ||
                  (typeof self !== 'undefined' && self.ConversionProtocol) || null;
        if (!P || typeof P.listLabelCharsForNumFmts !== 'function') return '';
        const read = async (path) => {
            const f = zip.file(path);
            return f ? (await readEntryText(f, path)) || '' : '';
        };
        try {
            if (['docx', 'docm', 'dotx', 'dotm'].includes(ext)) {
                // Linear by construction (no lazy match up to a closing tag, and
                // attribute runs bounded): numbering.xml is document-controlled.
                const ATTRS = '[^>]{0,512}?';
                const NUMFMT = new RegExp('<w:numFmt\\b' + ATTRS + '\\bw:val="([A-Za-z0-9]{1,64})"', 'g');
                const fmts = new Set();
                let literals = '';
                const numbering = await read('word/numbering.xml');
                if (numbering) {
                    const used = new Set();
                    const parts = Object.keys(zip.files).filter(p =>
                        /^word\/(document|styles|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(p));
                    const NUMID = new RegExp('<w:numId\\b' + ATTRS + '\\bw:val="(\\d{1,9})"', 'g');
                    for (const p of parts) {
                        for (const m of (await read(p)).matchAll(NUMID)) {
                            if (m[1] !== '0') used.add(m[1]);
                        }
                    }
                    const segment = (seg, close) => {
                        const end = seg.indexOf(close);
                        return end === -1 ? seg : seg.slice(0, end);
                    };
                    const abstracts = new Map();
                    for (const seg of numbering.split(/<w:abstractNum(?=[\s>\/])/).slice(1)) {
                        const id = new RegExp('^' + ATTRS + '\\bw:abstractNumId="(\\d{1,9})"').exec(seg);
                        if (id) abstracts.set(id[1], segment(seg, '</w:abstractNum>'));
                    }
                    // Each abstractNum is scanned ONCE, however many w:num point at it
                    // (rescanning it per num was quadratic on a crafted part; Fable review).
                    const LVLTEXT = new RegExp('<w:lvlText\\b' + ATTRS + '\\bw:val="([^"]{0,64})"', 'g');
                    const scanned = new Map();
                    const scan = (xml) => {
                        const f = new Set(), lit = [];
                        for (const m of xml.matchAll(NUMFMT)) f.add(m[1]);
                        // Literal label text ("第%1章", "%1．"): its own characters, not a format.
                        for (const m of xml.matchAll(LVLTEXT)) lit.push(m[1].replace(/%\d/g, ''));
                        return { f, lit: lit.join('') };
                    };
                    for (const seg of numbering.split(/<w:num(?=[\s>\/])/).slice(1)) {
                        const id = new RegExp('^' + ATTRS + '\\bw:numId="(\\d{1,9})"').exec(seg);
                        if (!id || !used.has(id[1])) continue;
                        const own = segment(seg, '</w:num>');
                        const abs = new RegExp('<w:abstractNumId\\b' + ATTRS + '\\bw:val="(\\d{1,9})"').exec(own);
                        if (abs && abstracts.has(abs[1]) && !scanned.has(abs[1])) scanned.set(abs[1], scan(abstracts.get(abs[1])));
                        for (const part of [abs && scanned.get(abs[1]), scan(own)]) {   // + lvlOverride levels
                            if (!part) continue;
                            part.f.forEach(x => fmts.add(x));
                            // Append only what still fits: re-concatenating the whole run and
                            // slicing afterwards was quadratic per w:num (WAF review of #573).
                            if (literals.length < 4096) literals += part.lit.slice(0, 4096 - literals.length);
                        }
                    }
                }
                const PGFMT = new RegExp('<w:pgNumType\\b' + ATTRS + '\\bw:fmt="([A-Za-z0-9]{1,64})"', 'g');
                for (const p of ['word/document.xml', 'word/settings.xml']) {
                    const x = await read(p);
                    for (const f of x.matchAll(NUMFMT)) fmts.add(f[1]);
                    for (const f of x.matchAll(PGFMT)) fmts.add(f[1]);
                }
                return P.listLabelCharsForNumFmts(Array.from(fmts)) + cjkOnly(literals);
            }
            if (['odt', 'ods', 'odp', 'odg', 'ott'].includes(ext)) {
                const values = [];
                let literals = '';
                for (const p of ['content.xml', 'styles.xml']) {
                    const x = await read(p);
                    for (const m of x.matchAll(/\bstyle:num-format="([^"]{0,64})"/g)) values.push(m[1]);
                    // Literal label text around the number ("第", "章", "．").
                    for (const m of x.matchAll(/\bstyle:num-(?:prefix|suffix)="([^"]{0,64})"/g)) {
                        if (literals.length < 4096) literals += m[1].slice(0, 4096 - literals.length);
                    }
                }
                return P.listLabelCharsForOdfNumFormats(values) + cjkOnly(literals);
            }
        } catch (e) {
            console.warn('[FontExtractor] List-label scan failed:', e.message || String(e));
        }
        return '';
    }

    async function extractTextSampleDetailed(file, filename, maxChars) {
        const limit = maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS;
        try {
            if (!await ensureJSZip()) return { text: '', complete: false };

            const ext = (filename || file.name || '').split('.').pop().toLowerCase();
            if (!EXTRACTABLE_FORMATS.includes(ext)) return { text: '', complete: false };

            let arrayBuffer;
            if (file instanceof ArrayBuffer) arrayBuffer = file;
            else if (file.arrayBuffer) arrayBuffer = await file.arrayBuffer();
            else return { text: '', complete: false };

            const zip = await JSZip.loadAsync(arrayBuffer);

            let pattern;
            if (['docx', 'docm', 'dotx', 'dotm'].includes(ext)) pattern = TEXT_PART_PATTERNS.word;
            else if (['xlsx', 'xlsm', 'xltx', 'xltm'].includes(ext)) pattern = TEXT_PART_PATTERNS.excel;
            else if (['pptx', 'pptm', 'potx', 'potm', 'ppsx'].includes(ext)) pattern = TEXT_PART_PATTERNS.ppt;
            else pattern = TEXT_PART_PATTERNS.odf;

            const paths = Object.keys(zip.files).filter(p => pattern.test(p)).sort();

            let sample = '';
            let complete = true;
            for (const p of paths) {
                if (sample.length >= limit) { complete = false; break; }
                const entry = zip.file(p);
                if (!entry) continue;
                // Bound via the shared helper (F-6): the declared-size check
                // this used to do alone missed a header that under-declares.
                const content = await readEntryText(entry, p);
                // '' is ambiguous — an empty part, or one we refused to read
                // (oversized, timed out, corrupt). Both must count as "did not
                // see this part's text", so nothing may be concluded absent.
                if (!content) { complete = false; continue; }
                const remaining = limit - sample.length;
                // Read a generous raw slice (markup is mostly tags), strip the
                // tags, then take what still fits in the budget.
                if (content.length > remaining * 8) complete = false;
                const stripped = content.slice(0, remaining * 8).replace(/<[^<>]*>/g, ' ');
                if (stripped.length > remaining) complete = false;
                sample += stripped.slice(0, remaining);
            }
            // FG-186: generated labels count as text. Appended even when the
            // budget is spent: a few dozen characters, and a font they need must
            // not be dropped for want of them.
            const labels = await generatedLabelText(zip, ext);
            if (labels) sample += ' ' + labels;
            return { text: sample, complete };
        } catch (e) {
            console.warn('[FontExtractor] Text sampling failed:', e.message || String(e));
            return { text: '', complete: false };
        }
    }

    /**
     * Get detailed font usage from a document (NTH-03).
     *
     * This used to return a hardcoded `weights:[400,700], styles:['normal',
     * 'italic']` for every family — an "assumption" that was really just the
     * over-fetch restated, and the reason the whole thing existed. It now
     * reports what the document's markup actually says, with `resolved:false`
     * standing for "we could not tell, fetch everything".
     *
     * @returns {Promise<Array<{family:string, faces:string[]}>>}
     */
    async function extractFontUsage(file, filename) {
        const detail = await extractFontsDetailed(file, filename);
        const usage = detail.usage;
        return Array.from(detail.fonts).map((family) => {
            const key = family.toLowerCase();
            let faces;
            if (!usage.resolved) faces = ALL_FACES.slice();
            else if (usage.faces.has(key)) {
                faces = Array.from(new Set([FACE_REGULAR]
                    .concat(Array.from(usage.faces.get(key)))
                    .concat(Array.from(usage.unattributed))));
            } else {
                faces = Array.from(new Set([FACE_REGULAR].concat(Array.from(usage.global))));
            }
            return { family, faces: faces.sort() };
        });
    }

    // Public API
    return {
        canExtractFonts,
        extractFonts,
        extractFontsDetailed,
        extractFontUsage,
        extractTextSample,
        extractTextSampleDetailed,
        EXTRACTABLE_FORMATS,
        // Exposed for unit tests: these two decide whether we SKIP a download,
        // so a wrong answer shows up as a missing glyph, not as an exception.
        _readFsType: readFsType,
        // FG-055: decides which Chinese theme fallback a document keeps.
        _eastAsianVariantOfLang: eastAsianVariantOfLang,
        _eastAsianVariantsDeclared: eastAsianVariantsDeclared,
        _engineWillAcceptEmbedded: engineWillAcceptEmbedded,
        _relationshipTargets: relationshipTargets,
        // NTH-07. Same reasoning, three more decisions of the same kind:
        //   _readEotFsType          — the PPTX rights byte
        //   _readCmapCoverage       — the ONLY evidence allowed to drop a
        //                             script font, i.e. to risk tofu
        //   _countNonEmptyGlyphs    — the engine's subsetted-font rule
        //   _pptxEmbeddedFamilies   — live for a host that passes acceptEot
        //                             (FG-054): decides which PPTX substitutes
        //                             are not downloaded
        //   _ENGINE_ACCEPTS_EOT_EMBEDDED — so a test asserts the SHIPPED value
        //                             rather than restating it
        _readEotFsType: readEotFsType,
        _readEotFlags: readEotFlags,
        _readCmapCoverage: readCmapCoverage,
        _countNonEmptyGlyphs: countNonEmptyGlyphs,
        _pptxEmbeddedFamilies: pptxEmbeddedFamilies,
        _ENGINE_ACCEPTS_EOT_EMBEDDED: ENGINE_ACCEPTS_EOT_EMBEDDED,

        // NTH-03 face usage. Exposed because every one of these decides which
        // faces are NOT downloaded, and a wrong answer is silent in the output.
        _faceOf: faceOf,
        // Theme harvesting: this decides which theme typefaces are NOT
        // downloaded, and a wrong answer is silent in the output.
        _extractThemeFonts: extractThemeFonts,
        // HTML/RTF font names. Same reasoning as everything above: these decide
        // which families reach the matcher at all, so a family missed here is a
        // font we never download and never draw — visible only as the wrong
        // typeface. They also parse UNTRUSTED text with regular expressions,
        // which is worth testing directly rather than only through a conversion.
        _extractTextFormatFonts: extractTextFormatFonts,
        _extractRtfFontTable: extractRtfFontTable,
        _textFormatUsage: textFormatUsage
        // NOTE: 16 further internals (newUsage, walkTags, parseOoxmlTheme,
        // resolveThemeRef, parseDocxStyles, scanDocxPart, scanDrawingML,
        // scanOdfContent, scanOdfListStyles, scanOdfAuxRefs, parseOdfStyles,
        // scanXlsxFontRecords, scanXlsxWorksheets, X_FONT_RE, X_RPR_RE,
        // ALL_FACES) were exported here "for unit tests" and NO TEST EVER
        // REFERENCED ONE. tests/gates/test_test_only_export_coverage.js caught
        // it -- the gate added earlier in this same session catching a
        // regression introduced later in it. They are unexported rather than
        // retro-fitted with tests: the usage extraction is covered through
        // extractFontUsage/extractFontsDetailed, which is the contract that
        // matters, and an export claiming a coverage that does not exist is
        // exactly the false signal the gate exists to stop. Re-export any of
        // them the moment a test genuinely needs it.
    };
})();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FontExtractor;
}
