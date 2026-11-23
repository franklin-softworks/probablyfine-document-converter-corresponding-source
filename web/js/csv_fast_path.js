// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
/**
 * CSV Fast Path - Pure JavaScript CSV to PDF conversion
 *
 * Bypasses the 127MB WASM module for CSV files since they have no formatting.
 * Results in ~250x smaller download and ~20x faster conversion.
 *
 * Parsing uses a single-pass, quote-aware, RFC 4180-tolerant state machine
 * (parseCSVDocument) that treats newlines inside quoted fields as field content.
 * Parse/decode anomalies surface to the user as an in-PDF notice line and a
 * `csv-fast-path-warning` CustomEvent — never console.warn alone.
 *
 * Text rendering (BUG-15): jsPDF's built-in `helvetica` is a standard-14 Type1
 * font with WinAnsiEncoding, so every non-ASCII codepoint came out mangled or
 * dropped. When (and only when) the decoded content contains a non-ASCII
 * codepoint we load `fonts/DejaVuSans{,-Bold}.ttf` on demand and embed it via
 * addFileToVFS/addFont. Pure-ASCII files keep the old font, the old metrics and
 * the old (zero-download) cost path exactly. Codepoints the embedded font
 * cannot render (CJK, Thai, Devanagari, emoji — no font for those is shipped)
 * are detected from the font's own cmap and reported to the user; they are
 * never silently mojibaked.
 *
 * Dependencies: jsPDF (bundled), conversion_protocol.js (BOM sniff + strict
 * UTF-8 probe — see `_P` below; index.html loads it before this file).
 */

const CSVFastPath = (function() {
    'use strict';

    // The encoding decision this file makes ("is this UTF-8? if not, assume
    // windows-1252") is the same one conversion_driver.js has to make for a
    // legacy .txt on the WASM path (BUG-12). It lives in ConversionProtocol so
    // there is exactly one definition; this file consumes it. Same lookup
    // pattern as font_resolver.js — global in page/worker, require() in node.
    const _P = (typeof window !== 'undefined' && window.ConversionProtocol) ||
               (typeof self !== 'undefined' && self.ConversionProtocol) ||
               (typeof require === 'function' ? require('./conversion_protocol.js') : null);
    if (!_P) {
        throw new Error('csv_fast_path.js requires conversion_protocol.js to be loaded first');
    }

    // Configuration
    const CONFIG = {
        fontSize: 10,            // PDF font size
        headerFontSize: 11,      // Header font size
        cellPadding: 3,          // Cell padding in points
        pageMargin: 30,          // Page margin in points (reduced)
        maxColWidth: 120,        // Max column width in points
        minColWidth: 25,         // Min column width in points
        chunkSize: 2000,         // Rows per chunk for async processing
        // Char-width estimates (points per character) — kept slightly conservative
        // so estimated column widths and wrap points agree and text never overflows.
        charWidth: 5.5,          // data cells (10 pt helvetica)
        headerCharWidth: 6.0,    // header cells (11 pt bold)
        minScale: 0.72,          // scale-to-fit floor before switching to column banding
        // Performance modes
        drawBorders: true,       // Draw light gray gridlines for data rows
        drawPageNumbers: false,  // Skip page numbers for large files (>100 pages)
    };

    // ------------------------------------------------------------------
    // User-visible warning mechanism (shared by parser, decoder, layout)
    // Warnings are aggregated by `code` with a `count` so that a million
    // bad rows produce a single entry, never a million-entry array.
    // ------------------------------------------------------------------
    // A note printed INTO the document may describe THE DOCUMENT. It must not
    // direct the reader to act somewhere else, and it must not carry diagnostic
    // detail a reader cannot act on. (Owner review, 2026-08-22.)
    //
    // A PDF may be opened a year later, on another machine, by someone who never
    // saw this site — "pick an encoding in Advanced Options" is meaningless there,
    // and "CJK: U+4E2D" is debugging output that escaped into a user-facing
    // artifact. Both belong in the UI, next to the control they refer to.
    //
    // So each warning has two forms:
    //   doc — the FACT, printed in the PDF. Always present.
    //   ui  — fact + what to do about it, for the csv-fast-path-warning event
    //         that ui-v2.js surfaces. Falls back to `doc` when there is no
    //         action to offer.
    //
    // The column-split note (see `notices.push` in the layout code) is the model
    // of a good in-document note and is deliberately unchanged: it tells the
    // reader where the data is on the page they are holding.
    const WARNING_MESSAGES = {
        'unterminated-quote': {
            doc: (n) => `${n} unterminated quoted field(s) at the end of the file were kept as literal text - please verify the output.`,
        },
        'text-after-closing-quote': {
            doc: (n) => `${n} row(s) had unexpected text after a closing quote; it was kept as literal text.`,
        },
        'decoded-as-windows-1252': {
            doc: () => `Input was not valid UTF-8; decoded as Windows-1252. Some characters may be wrong.`,
            ui: () => `Input was not valid UTF-8; decoded as Windows-1252. If characters look wrong, pick an encoding in Advanced Options.`,
        },
        'decoded-as-utf16-without-bom': {
            doc: (n, endian) => `Input had no byte-order mark but its bytes are UTF-16 (${endian}-endian), so it was read that way.`,
            ui: (n, endian) => `Input had no byte-order mark but its bytes are UTF-16 (${endian}-endian), so it was read that way. If characters look wrong, re-save the file as UTF-8.`,
        },
        'decoded-as-gb18030': {
            doc: () => `Input was not valid UTF-8; its bytes are Simplified Chinese (GB18030/GBK), so it was read that way.`,
            ui: () => `Input was not valid UTF-8; it was read as Simplified Chinese (GB18030/GBK). If characters look wrong, re-save the file as UTF-8.`,
        },
        'decoded-as-legacy': {
            doc: (n, name) => `Input was not valid UTF-8; its bytes are ${name}, so it was read that way.`,
            ui: (n, name) => `Input was not valid UTF-8; it was read as ${name}. If characters look wrong, re-save the file as UTF-8.`,
        },
        'invalid-bytes-for-encoding': {
            doc: () => `The file contains byte sequences that are not valid for the selected encoding; those characters were replaced.`,
        },
        'bom-overrode-encoding': {
            doc: () => `The file starts with a byte-order mark (BOM); the selected encoding was ignored in favour of the BOM's encoding.`,
        },
        'unknown-encoding': {
            doc: () => `The selected encoding was not recognised; automatic detection was used instead.`,
        },
        // BUG-15 — non-ASCII rendering
        'font-load-failed': {
            doc: () => `The Unicode font could not be loaded, so accented, Cyrillic and Greek text may render incorrectly.`,
            ui: () => `The Unicode font could not be loaded, so accented, Cyrillic and Greek text may render incorrectly in the PDF. Check your connection and retry, or convert to XLSX/CSV instead (Advanced Options); those keep the text exactly.`,
        },
        // The DOC form deliberately omits the U+XXXX enumeration: a reader cannot
        // act on "CJK: U+4E2D". That it happened, how many, and the stand-in glyph
        // are the parts that help someone reading the page.
        'unsupported-characters': {
            doc: (n, detail) => `${n} distinct character(s) in this file have no glyph in the embedded font (${String(detail || '').split(':')[0]}) and are shown as ${UNCOVERED_STANDIN}. The text itself is intact.`,
            ui: (n, detail) => `${n} distinct character(s) in this file have no glyph in the embedded font (${detail}) and are shown as ${UNCOVERED_STANDIN} in the PDF. No font covering ${detail === 'unknown script' ? 'them' : 'those scripts'} ships with this app. The text itself is intact - convert to XLSX, ODS or CSV instead (Advanced Options) to keep it.`,
        },
        'font-coverage-unknown': {
            doc: () => `The embedded font's character coverage could not be verified; unusual characters may render blank.`,
        },
        // FF-7: a value that cannot be kept on one line even at the smallest text size is wrapped, never cut; the count is stated
        'long-values-wrapped': {
            doc: (n, pt) => `${n} value${n === 1 ? ' was' : 's were'} wider than a page even at ${pt} pt and ${n === 1 ? 'was' : 'were'} wrapped.`,
            ui: (n, pt) => `${n} value${n === 1 ? ' was' : 's were'} wider than a page even at ${pt} pt and ${n === 1 ? 'was' : 'were'} wrapped. Every character is in the PDF. A smaller "Smallest text size" in the settings keeps more of them on one line.`,
        },
    };

    function formatWarning(code, count, detail, variant) {
        const t = WARNING_MESSAGES[code];
        if (!t) return `${count} issue(s) of type ${code}.`;
        const fn = (variant === 'ui' && t.ui) ? t.ui : t.doc;
        return fn(count, detail);
    }

    /**
     * Add (or increment) a warning entry in `list`, keeping the C3 shape.
     * `detail` is an optional extra string some messages interpolate; it is
     * remembered on the entry so re-formatting on increment keeps it.
     */
    function addWarning(list, code, count, detail) {
        count = count || 1;
        const existing = list.find(w => w.code === code);
        if (existing) {
            existing.count += count;
            if (detail !== undefined) existing.detail = detail;
            existing.message = formatWarning(code, existing.count, existing.detail);
        } else {
            const entry = { code, count, message: formatWarning(code, count, detail) };
            if (detail !== undefined) entry.detail = detail;
            list.push(entry);
        }
    }

    /** A constant that is not a positive finite number must never turn the guard off (fail closed): use the measured default. */
    function positiveOr(value, fallback) {
        return (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : fallback;
    }
    const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;     // = ConversionProtocol.CSV_FAST_PATH_MAX_BYTES (BUG-73); the local copies are the fallback only
    const DEFAULT_MAX_ROWS = 110000;               // = ConversionProtocol.CSV_FAST_PATH_MAX_ROWS
    const DEFAULT_MAX_CELLS = 600000;              // = ConversionProtocol.CSV_FAST_PATH_MAX_CELLS

    /**
     * Upper bounds of the rows and the cells in a CSV/TSV: rows = line breaks (a CRLF counts once) + 1; cells = every delimiter byte
     * (comma, tab, semicolon, pipe) + every line break + 1; quotes ignored. They can only OVER-count (a break or delimiter inside
     * quotes), and an over-count only sends a file to the engine. O(n), no allocation; 4 MiB takes a few milliseconds.
     * @param {Uint8Array|ArrayBuffer} bytes
     * @returns {{rows: number, cells: number}}
     */
    function estimateSize(bytes) {
        const u8 = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null);
        if (!u8) return { rows: 0, cells: 0 };
        let breaks = 0, delims = 0;
        for (let i = 0; i < u8.length; i++) {
            const c = u8[i];
            if (c === 0x0a) breaks++;
            else if (c === 0x0d) { if (u8[i + 1] !== 0x0a) breaks++; }   // lone CR; the CR of a CRLF is counted by its LF
            else if (c === 0x2c || c === 0x09 || c === 0x3b || c === 0x7c) delims++;
        }
        return { rows: breaks + 1, cells: breaks + delims + 1 };
    }
    /** Cells only (kept for callers that want the one number). */
    function estimateCells(bytes) { return estimateSize(bytes).cells; }

    const _sizeCache = new WeakMap();   // File -> {rows, cells} (a staged file is looked at again and again by the UI)

    /** The estimate for a File/Blob, memoised. Never rejects: a read failure is Infinity (the engine decides). */
    async function estimateSizeOfFile(file) {
        if (file && typeof file === 'object' && _sizeCache.has(file)) return _sizeCache.get(file);
        let n = { rows: Infinity, cells: Infinity };
        try { n = estimateSize(await file.arrayBuffer()); } catch (e) { /* unreadable: leave it to the engine */ }
        if (file && typeof file === 'object') _sizeCache.set(file, n);
        return n;
    }
    /** The memoised estimate, or undefined when estimateSizeOfFile has not finished for this file yet. */
    function cachedSizeEstimate(file) {
        return (file && typeof file === 'object' && _sizeCache.has(file)) ? _sizeCache.get(file) : undefined;
    }

    /**
     * Check if a file should use the fast path. Returns false for large files that would overwhelm jsPDF: by size always, and by
     * estimated cells when the caller has an estimate (the driver always does; the UI uses the memoised one once it exists).
     * @param {string} filename
     * @param {number} [fileSize]
     * @param {{rows: number, cells: number}} [estimate] from estimateSize / estimateSizeOfFile
     */
    function shouldUseFastPath(filename, fileSize, estimate) {
        if (!filename) return false;
        const ext = filename.toLowerCase().split('.').pop();
        if (ext !== 'csv' && ext !== 'tsv') return false;

        // BUG-73: jsPDF holds the whole document, so the tab's memory follows the rows drawn. Above these sizes the file goes to the
        // engine (measured numbers: the comment at CSV_FAST_PATH_MAX_BYTES in conversion_protocol.js). Two constants, read by the
        // driver, the UI and the MCP; a missing or invalid one falls back to the measured value, never to "no limit".
        const maxBytes = positiveOr(_P.CSV_FAST_PATH_MAX_BYTES, DEFAULT_MAX_BYTES);
        if (fileSize && fileSize > maxBytes) {
            console.log(`[CSV] File too large for the fast path (${(fileSize / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB), using WASM`);
            return false;
        }
        if (estimate && typeof estimate === 'object') {   // the memory follows ROWS (about 6 KB each) and, less, cells
            const maxRows = positiveOr(_P.CSV_FAST_PATH_MAX_ROWS, DEFAULT_MAX_ROWS);
            const maxCells = positiveOr(_P.CSV_FAST_PATH_MAX_CELLS, DEFAULT_MAX_CELLS);
            const show = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US') : 'unknown');
            if (!(estimate.rows <= maxRows)) {   // NaN and Infinity go to the engine too
                console.log(`[CSV] Too many rows for the fast path (about ${show(estimate.rows)} > ${maxRows.toLocaleString('en-US')}), using WASM`);
                return false;
            }
            if (!(estimate.cells <= maxCells)) {
                console.log(`[CSV] Too many cells for the fast path (about ${show(estimate.cells)} > ${maxCells.toLocaleString('en-US')}), using WASM`);
                return false;
            }
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Encoding (M9): honor the encoding option; sniff BOMs; UTF-8-fatal ->
    // Windows-1252 fallback with a user-visible warning. Never silent mojibake.
    // ------------------------------------------------------------------
    const ENCODING_LABELS = {
        'UTF-8': 'utf-8',
        'ISO-8859-1': 'iso-8859-1',   // WHATWG maps this to windows-1252 (correct for real files)
        'WINDOWS-1252': 'windows-1252'
    };

    /**
     * BOM sniff — one definition, shared with conversion_driver.js's legacy-text
     * path via ConversionProtocol.
     * @returns {'utf-8'|'utf-16le'|'utf-16be'|null}
     */
    const sniffBOM = _P.sniffBOM;

    // FG-151: the marks NFC can compose onto a preceding character, and the
    // conjoining Hangul Jamo it composes into syllables.
    const COMPOSABLE_MARKS = '\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F\u3099\u309A';
    const NEEDS_NFC_RE = new RegExp('[' + COMPOSABLE_MARKS + '\u1100-\u11FF]');
    // One cluster: a character followed by composable marks, or a run of
    // conjoining Jamo (optionally after a precomposed syllable, for a trailing T).
    const NFC_CLUSTER_RE = new RegExp(
        '[\uAC00-\uD7A3]?[\u1100-\u11FF]+|[^' + COMPOSABLE_MARKS + '][' + COMPOSABLE_MARKS + ']+', 'g');

    /**
     * FG-151: does this text contain a combining mark or conjoining Hangul Jamo,
     * i.e. anything NFC could compose? Cheap pre-check so plain text skips the pass.
     * @param {string} text
     * @returns {boolean}
     */
    function needsNfc(text) {
        return NEEDS_NFC_RE.test(text);
    }

    /**
     * decodeBuffer, then compose decomposed text (FG-151) for layout. NFD text, as
     * macOS and some exporters write it, carries combining marks that jsPDF draws at
     * the pen position with no GPOS: on a capital they sit at lowercase height and
     * collide with the letter (measured: NFD "CAFÉ", "Ångström"). It also composes
     * conjoining Hangul Jamo into syllables the Hangul font covers (FG-140).
     *
     * Only each base-plus-marks cluster (and each Jamo run) is normalized, NOT the
     * whole text: whole-string NFC would also rewrite canonical singletons
     * elsewhere in the file -- CJK compatibility ideographs U+F900-FAFF (common in
     * legacy Korean hanja), U+212B ANGSTROM SIGN, U+2126 OHM SIGN -- changing code
     * points the author chose. Composition only ever spans a starter and the
     * non-starters after it, so per-cluster NFC equals whole-string NFC on those
     * spans and leaves everything else byte-identical.
     * @param {ArrayBuffer|Uint8Array} buffer
     * @param {string|null} requestedEncoding  options.csv.encoding or null
     * @returns {{text: string, encodingUsed: string, warnings: Array}}
     */
    function decodeForLayout(buffer, requestedEncoding) {
        const decoded = decodeBuffer(buffer, requestedEncoding);
        if (needsNfc(decoded.text)) {
            decoded.text = decoded.text.replace(NFC_CLUSTER_RE, (m) => m.normalize('NFC'));
        }
        return decoded;
    }

    /**
     * Decode raw bytes to text, honoring an optional requested encoding.
     * @param {ArrayBuffer|Uint8Array} buffer
     * @param {string|null} requestedEncoding  options.csv.encoding or null
     * @returns {{ text: string, encodingUsed: string,
     *             warnings: Array<{code:string, count:number, message:string}> }}
     */
    function decodeBuffer(buffer, requestedEncoding) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const warnings = [];

        const bom = sniffBOM(bytes);
        const reqRaw = requestedEncoding ? String(requestedEncoding).trim() : '';
        const reqKey = reqRaw ? reqRaw.toUpperCase() : null;
        const reqLabel = reqKey ? ENCODING_LABELS[reqKey] : undefined;

        // 1. BOM sniff — a BOM always wins over the requested encoding.
        if (bom === 'utf-16le' || bom === 'utf-16be') {
            if (reqLabel && reqLabel !== bom) addWarning(warnings, 'bom-overrode-encoding');
            // TextDecoder strips the BOM automatically.
            return { text: new TextDecoder(bom).decode(bytes), encodingUsed: bom, warnings };
        }
        if (bom === 'utf-8') {
            if (reqLabel && reqLabel !== 'utf-8') addWarning(warnings, 'bom-overrode-encoding');
            return { text: new TextDecoder('utf-8').decode(bytes), encodingUsed: 'utf-8', warnings };
        }

        // 2. Explicit user encoding (no overriding BOM).
        if (reqKey) {
            if (!reqLabel) {
                addWarning(warnings, 'unknown-encoding');
                // fall through to the auto path below
            } else {
                try {
                    const text = new TextDecoder(reqLabel, { fatal: true }).decode(bytes);
                    return { text, encodingUsed: reqLabel, warnings };
                } catch (e) {
                    // Invalid bytes for the chosen encoding (only utf-8/utf-16 can fail):
                    // honor the user's choice but decode non-fatally and warn.
                    const text = new TextDecoder(reqLabel).decode(bytes);
                    addWarning(warnings, 'invalid-bytes-for-encoding');
                    return { text, encodingUsed: reqLabel, warnings };
                }
            }
        }

        // 3. Auto: THE shared CSV encoding detector (FEAT-14 Q6,
        // ConversionProtocol.detectCsvEncoding), the same one the engine path and the
        // MCP use: UTF-16 without a BOM (by its NUL bytes), valid UTF-8, GB18030 (FG-155),
        // another legacy charset (FG-056), else Windows-1252. Every guess is reported.
        const d = _P.detectCsvEncoding(bytes);
        if (d.reason === 'utf16-without-bom') {
            addWarning(warnings, 'decoded-as-utf16-without-bom', 1, d.encoding === 'utf-16le' ? 'little' : 'big');
            return { text: new TextDecoder(d.encoding).decode(bytes), encodingUsed: d.encoding, warnings };
        }
        if (d.reason === 'valid-utf-8' || d.reason === 'empty') {
            return { text: new TextDecoder('utf-8').decode(bytes), encodingUsed: 'utf-8', warnings };
        }
        if (d.reason === 'gb18030') {
            addWarning(warnings, 'decoded-as-gb18030');
            return { text: d.text, encodingUsed: 'gb18030', warnings };
        }
        if (d.reason === 'legacy') {
            addWarning(warnings, 'decoded-as-legacy', 1, _P.LEGACY_CHARSET_NAMES[d.encoding]);
            return { text: d.text, encodingUsed: d.encoding, warnings };
        }
        // 'windows-1252', or 'not-utf8-with-nul' (no answer): this path reads Windows-1252.
        const text = new TextDecoder('windows-1252').decode(bytes); // cannot fail
        addWarning(warnings, 'decoded-as-windows-1252');
        return { text, encodingUsed: 'windows-1252', warnings };
    }

    /**
     * Score a candidate delimiter's parse result. Consistency of field counts
     * dominates; column count is a weak secondary signal; single-column and
     * quote-fighting warnings are penalized. Exposed for unit tests.
     */
    function scoreDelimiterCandidate(result) {
        const rows = result.data.length;
        if (rows === 0) return -Infinity;

        const freq = Object.create(null);
        for (const row of result.data) {
            const n = row.length;
            freq[n] = (freq[n] || 0) + 1;
        }
        let mode = 0, modeFreq = 0;
        for (const k in freq) {
            if (freq[k] > modeFreq) { modeFreq = freq[k]; mode = parseInt(k, 10); }
        }

        const consistency = modeFreq / rows;   // 0..1, dominant term
        const cols = mode;
        const warnPenalty = 2 * result.warnings.length;

        return consistency * 10
            + Math.min(cols, 20) * 0.5
            - (cols < 2 ? 4 : 0)
            - warnPenalty;
    }

    /** Most frequent field count across a parse result (for logging). */
    function modeColumns(result) {
        const freq = Object.create(null);
        for (const row of result.data) freq[row.length] = (freq[row.length] || 0) + 1;
        let mode = 0, modeFreq = 0;
        for (const k in freq) {
            if (freq[k] > modeFreq) { modeFreq = freq[k]; mode = parseInt(k, 10); }
        }
        return mode;
    }

    /**
     * Auto-detect the delimiter by parsing a bounded sample with each candidate
     * (quote-aware, via parseCSVDocument) and scoring by field-count consistency.
     * The best-scoring candidate wins; ties resolve by real-world prevalence order.
     * This subsumes "fall back to the runner-up" — a known-inconsistent delimiter
     * never wins over a consistent one.
     * @returns {string} the detected delimiter character.
     */
    function detectDelimiter(content, filename) {
        // If TSV extension, use tab
        if (filename?.toLowerCase().endsWith('.tsv')) {
            console.log(`[CSV] Using delimiter: 'TAB'`);
            return '\t';
        }

        const SAMPLE_LIMIT = 65536;
        const truncated = content.length > SAMPLE_LIMIT;
        const sample = truncated ? content.slice(0, SAMPLE_LIMIT) : content;

        // Candidates in tie-break priority order (by real-world prevalence).
        const candidates = [',', '\t', ';', '|'];
        let best = null;
        let bestScore = -Infinity;
        let bestCols = 0;

        for (const cand of candidates) {
            const res = parseCSVDocument(sample, cand.charCodeAt(0), { maxRows: 10 });
            // If the sample was cut mid-file and the final parsed row ran into the
            // end of the sample (rather than a real newline), it may be truncated
            // mid-content — drop it before scoring. This applies even when maxRows
            // was hit, since the maxRows-th row can coincide with the slice cut (L-1).
            if (truncated && res.lastRowEndedAtEOF && res.data.length > 1) {
                res.data = res.data.slice(0, res.data.length - 1);
            }
            const score = scoreDelimiterCandidate(res);
            if (score > bestScore) {
                bestScore = score;
                best = cand;
                bestCols = modeColumns(res);
            }
        }

        // No delimiter present at all (single-column data) → default to comma.
        if (best === null || bestCols < 2) {
            console.log(`[CSV] Using delimiter: ','`);
            return ',';
        }

        console.log(`[CSV] Auto-detected delimiter: '${best === '\t' ? 'TAB' : best}' (${bestCols} columns)`);
        return best;
    }

    /**
     * Single-pass, quote-aware CSV parser (RFC 4180-tolerant).
     *
     * Newlines inside quoted fields are treated as field content. Handles
     * escaped quotes (`""`), all three line endings (`\r\n`/`\n`/`\r`), and
     * an unterminated quote at EOF (kept as literal text + a warning). It is
     * O(n) in the input length: quoted regions are scanned with the native
     * `String.prototype.indexOf`; unquoted regions with a tight charCode loop.
     * No intermediate per-line array is materialized.
     *
     * @param {string} input       Full decoded text.
     * @param {number} delimCode   Delimiter char code (44 ',', 9 tab, 59 ';', 124 '|').
     * @param {object} [opts]       { maxRows?: number }  // for M9 delimiter sampling.
     * @returns {{ data: string[][], maxCols: number,
     *             rowsTruncatedByMaxRows: boolean,
     *             lastRowEndedAtEOF: boolean,
     *             warnings: Array<{code:string, count:number, message:string}> }}
     */
    // C0 controls (plus DEL) that must never reach the renderer, EXCLUDING \n and
    // \r — those are legal inside a quoted field and multi-line cells already
    // render correctly.
    //
    // Two literals on purpose: the non-global one is safe for .test() (a /g regex
    // carries lastIndex between calls and would skip every other cell), the /g one
    // is for .replace().
    const CSV_CONTROL_CHARS = /[\t\v\f\u0000-\u0008\u000E-\u001F\u007F]/;
    const CSV_CONTROL_CHARS_G = new RegExp(CSV_CONTROL_CHARS.source, 'g');

    const LONG_VALUES_MODES = ['auto', 'wrap', 'nowrap'];
    const MIN_FONT_PT_DEFAULT = 6, MIN_FONT_PT_MIN = 4, MIN_FONT_PT_MAX = 10;
    /** The user's choice of how long values are laid out: Auto (the default), Always wrap or Never wrap. Anything else is Auto. */
    function resolveLongValues(options) {
        const v = options && options.csv && options.csv.longValues;
        return LONG_VALUES_MODES.includes(v) ? v : 'auto';
    }
    /** The smallest text size (points) a page may be scaled to: 4 to 10, default 6. */
    function clampMinFontPt(v) {
        const n = (typeof v === 'number' && Number.isFinite(v)) ? v : MIN_FONT_PT_DEFAULT;
        return Math.min(MIN_FONT_PT_MAX, Math.max(MIN_FONT_PT_MIN, n));
    }
    /** options.csv.minFontPt (a request), else the remembered setting, else 6. */
    function resolveMinFontPt(options) {
        const own = options && options.csv && options.csv.minFontPt;
        if (typeof own === 'number' && Number.isFinite(own)) return clampMinFontPt(own);
        let remembered;
        try { remembered = _P.resolveBrowserConversionSettings().csvMinFontPt; } catch (e) { remembered = undefined; }
        return clampMinFontPt(remembered);
    }
    // FF-7: a "token" is a value that has no place to break: no whitespace AND no script that is written without spaces (Han, kana, Thai,
    // Lao, Khmer, Myanmar, Tibetan: such a sentence wraps between any two characters, which is right for it). Only a token is kept whole in Auto.
    const UNSPACED_SCRIPT = /[\u0E00-\u0FFF\u1000-\u109F\u1780-\u17FF\u2E80-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u{20000}-\u{3FFFF}]/u;
    const isToken = (text) => !/\s/.test(text) && !UNSPACED_SCRIPT.test(text);
    const TOKEN_MIN_LENGTH = 20;   // 20 characters is below the 120 pt column cap at 10 pt: a shorter value is never wider than a column
    function parseCSVDocument(input, delimCode, opts) {
        opts = opts || {};
        const maxRows = (typeof opts.maxRows === 'number' && opts.maxRows > 0) ? opts.maxRows : Infinity;

        const CH_QUOTE = 34; // "
        const CH_CR = 13;    // \r
        const CH_LF = 10;    // \n

        const len = input.length;
        const data = [];
        const warnCounts = Object.create(null);
        let maxCols = 0;
        const colWidest = [];   // widest cell seen per column, across ALL rows
        // FG-135: the widest by INK, not by character count. Carried on the same
        // array (colWidest.byInk) so every existing hand-off passes it along.
        colWidest.byInk = [];
        // FF-7: the widest value WITHOUT whitespace per column (a number, an id, a hash, a URL: a "token"), kept apart from colWidest because Auto
        // keeps tokens whole while prose wraps. Only values long enough to pass the column cap can matter, so the test (a regex) runs
        // only for a value that would set a new record.
        colWidest.tokens = [];
        const inkScore = [];
        let rowsTruncatedByMaxRows = false;
        let lastRowEndedAtEOF = false; // did the last emitted row end at end-of-input (no newline)?
        let pos = 0;
        let hitEOFInQuote = false;

        function warn(code) { warnCounts[code] = (warnCounts[code] || 0) + 1; }

        while (pos < len) {
            const row = [];
            let rowDone = false;
            let rowEndedAtEOF = false;

            while (!rowDone) {
                let field;

                if (input.charCodeAt(pos) === CH_QUOTE) {
                    // ---- QUOTED FIELD ----
                    pos++; // consume opening quote
                    let acc = '';
                    for (;;) {
                        const q = input.indexOf('"', pos);
                        if (q === -1) {
                            // Unterminated quote: keep the rest of the file as content.
                            acc += input.slice(pos);
                            pos = len;
                            warn('unterminated-quote');
                            hitEOFInQuote = true;
                            break;
                        }
                        if (input.charCodeAt(q + 1) === CH_QUOTE) {
                            // Escaped quote "" -> literal "
                            acc += input.slice(pos, q) + '"';
                            pos = q + 2;
                        } else {
                            // Closing quote
                            acc += input.slice(pos, q);
                            pos = q + 1;
                            break;
                        }
                    }
                    field = acc;

                    // AFTER CLOSING QUOTE: absorb any stray text until a terminator.
                    if (!hitEOFInQuote) {
                        const extraStart = pos;
                        while (pos < len) {
                            const c = input.charCodeAt(pos);
                            if (c === delimCode || c === CH_CR || c === CH_LF) break;
                            pos++;
                        }
                        if (pos > extraStart) {
                            field += input.slice(extraStart, pos);
                            warn('text-after-closing-quote');
                        }
                    }
                } else {
                    // ---- UNQUOTED FIELD ---- (bare quotes are literal, PapaParse-compatible)
                    const start = pos;
                    while (pos < len) {
                        const c = input.charCodeAt(pos);
                        if (c === delimCode || c === CH_CR || c === CH_LF) break;
                        pos++;
                    }
                    field = input.slice(start, pos);
                }

                row.push(field);

                // What terminated this field?
                if (hitEOFInQuote || pos >= len) {
                    rowDone = true;
                    rowEndedAtEOF = true;
                } else {
                    const c = input.charCodeAt(pos);
                    if (c === delimCode) {
                        pos++; // next field
                    } else if (c === CH_CR) {
                        pos++;
                        if (pos < len && input.charCodeAt(pos) === CH_LF) pos++; // \r\n
                        rowDone = true;
                    } else { // CH_LF
                        pos++;
                        rowDone = true;
                    }
                }
            }

            // skipEmptyLines parity: drop a row that is a single empty/whitespace field.
            if (!(row.length === 1 && row[0].trim() === '')) {
                data.push(row);
                lastRowEndedAtEOF = rowEndedAtEOF;
                if (row.length > maxCols) maxCols = row.length;
                // Widest cell per column, over EVERY row. calculateColumnWidths
                // samples only the first 100 rows plus the last 10, so a column
                // whose long values live in the unsampled middle was sized from
                // data that did not represent it — on crosslingual_winograd.tsv
                // a column sized from a 1-character maximum had to render 201
                // characters, and came out one to two characters per line.
                // Recorded here because the parser already visits every cell:
                // no extra pass, and one string per column of memory.
                // Strip C0 controls BEFORE the width survey, and in place, so the
                // string that gets measured is the string that gets drawn.
                //
                // A quoted field may legitimately contain the delimiter:
                // "Item<TAB>with<TAB>tabs" in a .tsv is ONE field, tabs and all.
                // Doing this later (on `data` alone, at the parseCSV boundary) was
                // tried and is NOT enough — colWidest is computed here, so the
                // column was still sized from the pre-normalisation string and the
                // text overflowed into the next column: reviewer report on
                // tsv_quoted_tabs.tsv, "two layers of text overlaying", which
                // survived that first attempt as `here300`.
                //
                // \n and \r are deliberately NOT stripped: they are also legal
                // inside a quoted field, and multi-line cells already render
                // correctly. Nothing is lost — a tab becomes a space.
                for (let ci = 0; ci < row.length; ci++) {
                    let cell = row[ci];
                    if (typeof cell === 'string' && CSV_CONTROL_CHARS.test(cell)) {
                        cell = cell.replace(CSV_CONTROL_CHARS_G, ' ');
                        row[ci] = cell;
                    }
                    if (cell && (colWidest[ci] === undefined || cell.length > colWidest[ci].length)) {
                        colWidest[ci] = cell;
                    }
                    if (cell && cell.length > TOKEN_MIN_LENGTH && (colWidest.tokens[ci] === undefined || cell.length > colWidest.tokens[ci].length) && isToken(cell)) {
                        colWidest.tokens[ci] = cell;
                    }
                    // Cheap bound first: a value cannot out-ink the best unless
                    // length x widest-advance could exceed the best score.
                    if (cell && cell.length * MAX_ADVANCE > (inkScore[ci] || 0)) {
                        const sc = approxAdvance(cell);
                        if (sc > (inkScore[ci] || 0)) { inkScore[ci] = sc; colWidest.byInk[ci] = cell; }
                    }
                }
                if (data.length >= maxRows) { rowsTruncatedByMaxRows = true; break; }
            }

            if (hitEOFInQuote) break;
        }

        const warnings = [];
        for (const code in warnCounts) {
            warnings.push({ code, count: warnCounts[code], message: formatWarning(code, warnCounts[code]) });
        }

        return { data, maxCols, colWidest, rowsTruncatedByMaxRows, lastRowEndedAtEOF, warnings };
    }

    /**
     * Parse CSV file content into rows using the quote-aware state machine.
     * @param {string} content - Decoded file content
     * @param {string} filename - Original filename
     * @param {string|null} userDelimiter - User-selected delimiter code ('auto'|'44'|'9'|'59'|'124')
     * @returns {{ data: string[][], maxCols: number,
     *             warnings: Array, delimiter: string }}
     */
    function parseCSV(content, filename, userDelimiter = null) {
        let delimiter;

        if (userDelimiter && userDelimiter !== 'auto') {
            // User specified a delimiter (as ASCII code string like '44' for comma)
            const code = parseInt(userDelimiter, 10);
            delimiter = String.fromCharCode(code);
            console.log(`[CSV] Using user-selected delimiter: '${delimiter === '\t' ? 'TAB' : delimiter}' (code ${code})`);
        } else {
            // Auto-detect
            delimiter = detectDelimiter(content, filename);
        }

        const result = parseCSVDocument(content, delimiter.charCodeAt(0), {});

        return {
            data: result.data,
            maxCols: result.maxCols,
            colWidest: result.colWidest,
            warnings: result.warnings,
            delimiter: delimiter
        };
    }

    // ==================================================================
    // BUG-15: Unicode text rendering
    //
    // jsPDF's built-in `helvetica` is a standard-14 Type1 font with
    // WinAnsiEncoding — every non-ASCII codepoint is mangled or dropped. We
    // embed a real TTF, but ONLY when the file actually needs it, so the
    // (overwhelmingly common) pure-ASCII case pays nothing: no fetch, no
    // ~750 KB font, no changed metrics, no changed output.
    // ==================================================================

    /** The font we embed when non-ASCII text is present. Both files ship in web/fonts/. */
    const UNICODE_FONT = {
        family: 'DejaVuSans',
        faces: [
            { style: 'normal', file: 'DejaVuSans.ttf', url: 'fonts/DejaVuSans.ttf' },
            { style: 'bold', file: 'DejaVuSans-Bold.ttf', url: 'fonts/DejaVuSans-Bold.ttf' }
        ]
    };

    /**
     * FG-135: approximate ink width, used ONLY to choose which value per column
     * is measured exactly when sizing it. Advances of DejaVu Sans (the fast
     * path's face) for ASCII 32..126 in 1/1000 em, read from the font itself;
     * any other character counts as 1000 (the widest ASCII advance), so a
     * non-ASCII value is never under-ranked. Sizing still measures the chosen
     * value exactly -- this table never decides a width.
     */
    const ASCII_ADVANCE = [318,401,460,838,636,950,780,275,390,390,500,838,318,361,318,337,636,636,636,636,636,636,636,636,636,636,337,337,838,838,838,531,1000,684,686,698,770,632,575,775,752,295,295,656,557,863,748,787,603,787,695,635,611,732,684,989,685,611,685,390,337,390,838,500,500,613,635,550,635,615,352,635,634,278,278,579,278,974,634,612,635,635,411,521,392,634,592,818,592,592,525,636,337,636,838];
    const MAX_ADVANCE = 1000;
    function approxAdvance(text) {
        let w = 0;
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            w += (c >= 32 && c <= 126) ? ASCII_ADVANCE[c - 32] : MAX_ADVANCE;
        }
        return w;
    }

    /**
     * CJK FALLBACK, IN TIERS.
     *
     * DejaVuSans covers Latin, Cyrillic, Greek and the symbol blocks, and NO CJK
     * whatsoever — measured from its own cmap, not assumed. So a Japanese or
     * Chinese CSV had every CJK glyph left blank.
     *
     * Droid Sans Fallback is the reverse: it covers CJK and NO Latin at all (not
     * even `A`). It is a FALLBACK face, meant to sit beside a Latin font rather
     * than replace it, which is why this cannot be a font swap and has to be a
     * per-run selection.
     *
     * Two tiers, smallest first, because the common Japanese/Chinese CSV does not
     * need the full repertoire:
     *
     *   GB2312 subset  1.1 MB   kana, common Chinese, fullwidth punctuation
     *   full          4.0 MB   adds the rarer Han (漢 U+6F22 is NOT in the subset)
     *
     * THE COST OF THE PROBE, STATED PLAINLY: choosing a tier means reading the
     * candidate's own cmap, and that means fetching it. A file that needs the
     * full font therefore downloads the subset first and discards it — 5.2 MB
     * rather than 4.0 MB. The alternative is guessing coverage from Unicode
     * blocks, which is exactly the guessing this file refuses to do everywhere
     * else. Only the chosen tier is embedded, so the PDF is unaffected.
     *
     * Korean/Hangul (FG-047): a NanumGothic tier is tried first when the missing
     * set contains Hangul. One face is still embedded -- the tier leaving the
     * FEWEST codepoints undrawable -- so a mixed Korean+Chinese file gets the
     * better of the two and the rest keep the existing notice.
     */
    // The family name is the font's own PostScript name, not an invented alias:
    // jsPDF writes it into the PDF as the embedded font's name, and that is what
    // identifies the face to everything downstream. An alias like "CJKFallback"
    // renders identically and then makes tests/lib/tofu_check.js report tofu,
    // because it looks for the name the registry knows. Both tiers carry the
    // same PostScript name (verified), and only one is ever embedded.
    const CJK_FONT_TIERS = [
        // FG-047: Hangul. NanumGothic draws all 11,172 precomposed syllables (and
        // Latin; no Han, no kana) -- measured from its cmap. Precomposed Hangul needs
        // no shaping, so jsPDF draws it correctly. Tried FIRST only when the text
        // contains Hangul (see hangulFirst), so Chinese/Japanese files never fetch it.
        { family: 'NanumGothic', file: 'NanumGothic-Regular.ttf',
          url: 'fonts/NanumGothic-Regular.ttf', label: 'Hangul (NanumGothic)', hangul: true },
        { family: 'DroidSansFallback', file: 'DroidSansFallback-GB2312.ttf',
          url: 'fonts/DroidSansFallback-GB2312.ttf', label: 'GB2312 subset' },
        { family: 'DroidSansFallback', file: 'DroidSansFallbackFull.ttf',
          url: 'fonts/DroidSansFallbackFull.ttf', label: 'full' }
    ];

    /** Font descriptor used by every draw call. `helvetica` == today's behaviour. */
    const DEFAULT_FONTS = { family: 'helvetica', hasBold: true, hasItalic: true };

    /**
     * ASCII baseline the CONFIG.charWidth constants were tuned against (10 pt
     * helvetica). Used to rescale those constants for a different font/script —
     * see computeMetrics().
     */
    const METRICS_REF_SAMPLE =
        'The quick brown fox jumps over the lazy dog 0123456789 ' +
        'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ .,-_/()';

    /** Matches any codepoint outside 7-bit ASCII. Non-global: `.test` is stateless. */
    const NON_ASCII_RE = /[^\x00-\x7F]/;

    /** Module-level cache: base64 font payloads survive across conversions. */
    let fontPayloadCache = null;   // Promise<{ [file]: base64 } | null>
    let fontCoverageCache = null;  // { has(cp) } | null  (null == unknown)

    /** True if any cell (or header) in `data` holds a non-ASCII codepoint. */
    function dataHasNonAscii(data) {
        if (!data) return false;
        for (let r = 0; r < data.length; r++) {
            const row = data[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                const v = row[c];
                if (v != null && NON_ASCII_RE.test(v)) return true;
            }
        }
        return false;
    }

    /** Every distinct non-ASCII codepoint in `data` (surrogate pairs combined). */
    function collectNonAsciiCodepoints(data) {
        const set = new Set();
        if (!data) return set;
        for (let r = 0; r < data.length; r++) {
            const row = data[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                const v = row[c];
                if (v == null) continue;
                const s = String(v);
                if (!NON_ASCII_RE.test(s)) continue;   // fast reject: pure-ASCII cell
                for (const ch of s) {
                    const cp = ch.codePointAt(0);
                    if (cp > 0x7F) set.add(cp);
                }
            }
        }
        return set;
    }

    /**
     * FG-047: which CSVs are handed to the engine.
     *
     * jsPDF does no shaping (Indic conjuncts and vowel-sign reordering, Thai/Lao/
     * Khmer/Myanmar/Tibetan mark placement, joining scripts) and cannot embed the
     * variable emoji face, so those were drawn as boxes. The engine shapes them
     * with the Noto faces it ships (measured 2026-10-05: Devanagari क्ष, Thai
     * marks, Tamil and emoji all drawn).
     *
     * The script list is NOT a second hand-kept range table: it is
     * ConversionProtocol.detectScripts(), the same detector the font resolver
     * uses to decide which script fonts the engine loads. Every script it reports
     * goes to the engine EXCEPT the ones this renderer already draws correctly
     * (FAST_PATH_SCRIPTS: Han/kana and Hangul via the CJK tiers; Arabic, Georgian
     * and Armenian via DejaVu Sans). Latin, Greek, Cyrillic and Hebrew are never
     * reported and stay here.
     *
     * TWO CONDITIONS keep the hand-off from LOSING text (Fable review, 2026-10-05):
     *   1. Every such script in the file must also be in the first
     *      SCRIPT_SAMPLE_BYTES, decoded exactly as the resolver decodes them
     *      (decodeTextSample). The resolver reads only that sample; a script that
     *      first appears later gets no font in the engine and is drawn as nothing,
     *      with no notice. Such a file stays here: boxes, and the notice.
     *   2. Size: the engine's PDF export reports no progress, and the driver stops
     *      it after 30 s. Measured on Thai, 6 columns, with column autofit:
     *      20k rows 6 s, 60k 14 s, 120k 24 s, 200k 39 s; 300k rows (1.8M cells)
     *      STOPPED and its retry too. Export time follows pages, i.e. rows times
     *      page-columns, so both rows and cells are bounded. Above either bound
     *      the file stays here and converts COMPLETELY (boxes + notice): a
     *      complete conversion beats a failed one (CLAUDE.md principle 1). FG-173
     *      records the export stall itself.
     * If the engine still fails after a hand-off, the driver re-runs this path
     * with { noEngineHandoff: true } (third safety net).
     */
    const FAST_PATH_SCRIPTS = new Set(['han', 'hangul', 'arabic', 'georgian', 'armenian']);
    const SCRIPT_SAMPLE_BYTES = 256 * 1024;   // = font_resolver.js SCRIPT_SAMPLE_BYTES
    const ENGINE_HANDOFF_MAX_CELLS = 1000000;
    const ENGINE_HANDOFF_MAX_ROWS = 150000;

    /** Scripts in `text` that the engine draws and this renderer does not. */
    function engineScriptsIn(text) {
        if (!text || typeof _P.detectScripts !== 'function') return [];
        return _P.detectScripts(text, 1).filter(id => !FAST_PATH_SCRIPTS.has(id));
    }

    /**
     * FG-047 hand-off decision. Pure; exported for tests.
     * @param {string} content  the whole decoded file
     * @param {Uint8Array} rawBytes  the file's bytes (for the resolver's sample)
     * @param {number} rows
     * @param {number} cols
     * @returns {{handOff: boolean, scripts: string[], reason: string}}
     */
    function engineHandoffDecision(content, rawBytes, rows, cols) {
        const scripts = engineScriptsIn(content);
        if (!scripts.length) return { handOff: false, scripts, reason: 'no-engine-script' };
        if (rows > ENGINE_HANDOFF_MAX_ROWS || rows * Math.max(1, cols) > ENGINE_HANDOFF_MAX_CELLS) {
            return { handOff: false, scripts, reason: 'too-large-for-engine' };
        }
        const sampleText = (rawBytes && typeof _P.decodeTextSample === 'function')
            ? _P.decodeTextSample(rawBytes.subarray(0, SCRIPT_SAMPLE_BYTES), 'csv') : '';
        const seen = new Set(engineScriptsIn(sampleText));
        const late = scripts.filter(id => !seen.has(id));
        if (late.length) return { handOff: false, scripts, reason: 'script-after-font-sample:' + late.join(',') };
        return { handOff: true, scripts, reason: 'engine' };
    }

    /** @returns {Error} the hand-off the driver turns into an engine conversion. */
    function needsEngineError() {
        const err = new Error('CSV contains a script that needs text shaping; converting with the engine');
        err.code = 'CSV_NEEDS_ENGINE';
        return err;
    }

    /** Coarse script name for a codepoint — used only to describe what we cannot draw. */
    function scriptOf(cp) {
        if (cp >= 0x0590 && cp <= 0x05FF) return 'Hebrew';
        if ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F)) return 'Arabic';
        if (cp >= 0x0700 && cp <= 0x074F) return 'Syriac';
        if (cp >= 0x0900 && cp <= 0x097F) return 'Devanagari';
        if (cp >= 0x0980 && cp <= 0x09FF) return 'Bengali';
        if (cp >= 0x0A00 && cp <= 0x0D7F) return 'Indic';
        if (cp >= 0x0D80 && cp <= 0x0DFF) return 'Sinhala';
        if (cp >= 0x0E00 && cp <= 0x0E7F) return 'Thai';
        if (cp >= 0x0E80 && cp <= 0x0EFF) return 'Lao';
        if (cp >= 0x0F00 && cp <= 0x0FFF) return 'Tibetan';
        if (cp >= 0x1000 && cp <= 0x109F) return 'Myanmar';
        if (cp >= 0x1780 && cp <= 0x17FF) return 'Khmer';
        if (cp >= 0x1200 && cp <= 0x137F) return 'Ethiopic';
        if (cp >= 0x3040 && cp <= 0x30FF) return 'Japanese (kana)';
        if ((cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF) ||
            (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x20000 && cp <= 0x2FA1F)) return 'CJK';
        if ((cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0x1100 && cp <= 0x11FF)) return 'Korean';
        if (cp >= 0xFF00 && cp <= 0xFFEF) return 'CJK (full-width)';
        if ((cp >= 0x1F000 && cp <= 0x1FAFF) || (cp >= 0x1F300 && cp <= 0x1F9FF)) return 'emoji';
        return 'unknown script';
    }

    /**
     * Human-readable description of codepoints the font cannot draw. Uses U+XXXX
     * notation plus coarse script names so the notice stays legible even when
     * rendered in a font that (by definition) has no glyph for the characters.
     */
    function describeCodepoints(cps) {
        return `${describeScripts(cps)}: ${describeCodepointList(cps)}`;
    }

    /**
     * SCRIPT NAMES ONLY — what goes in the document.
     *
     * "CJK" or "Devanagari" tells a reader which writing system could not be
     * drawn, which is something they can act on (find the source, pick another
     * output format). The U+XXXX list beside it is debugging output: the owner's
     * review put it plainly — "A human user cannot decipher 'CJK: U+4E2D' and make
     * sense of what character was replaced."
     */
    function describeScripts(cps) {
        const scripts = [];
        for (const cp of cps) {
            const s = scriptOf(cp);
            if (scripts.indexOf(s) === -1) scripts.push(s);
        }
        scripts.sort();
        return scripts.join(', ');
    }

    /** The codepoint enumeration — diagnostic, so UI/console only, never the PDF. */
    function describeCodepointList(cps) {
        const sorted = Array.from(cps).sort((a, b) => a - b);
        const shown = sorted.slice(0, 6)
            .map(cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'));
        if (sorted.length > shown.length) shown.push('…');
        return shown.join(' ');
    }

    // U+25A1 WHITE SQUARE. DejaVuSans covers it (verified), so this needs no new
    // font work. Chosen over '?' because '?' is indistinguishable from a '?' that
    // was actually in the data — it trades one ambiguity for another.
    const UNCOVERED_STANDIN = '□';
    const UNCOVERED_STANDIN_CP = 0x25A1;

    /**
     * Replace codepoints the embedded font cannot draw with a visible box.
     *
     * Without this an uncovered glyph renders as NOTHING, which is
     * indistinguishable from an empty cell in the source — the user cannot tell
     * "we could not draw this" from "there was nothing here". See
     * docs/design/cjk-glyph-standin.md; this is an interim measure and does not replace
     * shipping a CJK-capable font.
     *
     * Iterates by CODEPOINT (`for…of`), not by UTF-16 code unit: an astral
     * character must become one box, not two.
     *
     * Returns the SAME STRING REFERENCE when nothing changed, so the common case
     * (a document where most cells contain no uncovered glyph) allocates nothing
     * and the caller can skip the write.
     */
    function substituteUncovered(text, missing) {
        if (!missing || !missing.size || text == null) return text;
        const s = String(text);
        let out = null;              // allocated only on the first substitution
        let i = 0;
        for (const ch of s) {
            if (missing.has(ch.codePointAt(0))) {
                if (out === null) out = s.slice(0, i);
                out += UNCOVERED_STANDIN;
            } else if (out !== null) {
                out += ch;
            }
            i += ch.length;          // ch.length is 2 for an astral character
        }
        return out === null ? text : out;
    }

    /**
     * Apply substituteUncovered across the whole table and the per-column widest
     * strings, mutating in place. Called once, only when `missing` is non-empty,
     * so a document with full font coverage pays a single Set-size check.
     *
     * In place rather than mapped: `data` can be millions of rows, and a copy
     * would double peak memory on exactly the documents least able to afford it.
     * substituteUncovered returns the original reference when a cell is
     * unchanged, so untouched cells are not rewritten.
     *
     * Known edge, accepted: substitution never lengthens a string but DOES
     * shorten one containing astral characters (two UTF-16 units become one
     * box), so a colWidest entry chosen by length before substitution may no
     * longer be the longest after it. The consequence is a column bound that is
     * slightly narrow, which wrapping handles without losing content — and
     * calculateColumnWidths still samples ~110 rows of the substituted data and
     * takes the max, so the bound can only widen from there.
     */
    function substituteInPlace(data, colWidest, missing) {
        if (!missing || !missing.size) return;
        if (data) {
            for (let r = 0; r < data.length; r++) {
                const row = data[r];
                if (!row) continue;
                for (let c = 0; c < row.length; c++) {
                    const cell = row[c];
                    if (cell == null || cell === '') continue;
                    const sub = substituteUncovered(cell, missing);
                    if (sub !== cell) row[c] = sub;
                }
            }
        }
        if (colWidest && colWidest.byInk) {
            for (let i = 0; i < colWidest.byInk.length; i++) {
                if (colWidest.byInk[i] != null) colWidest.byInk[i] = substituteUncovered(colWidest.byInk[i], missing);
            }
        }
        if (colWidest && colWidest.tokens) {
            for (let i = 0; i < colWidest.tokens.length; i++) {
                if (colWidest.tokens[i] != null) colWidest.tokens[i] = substituteUncovered(colWidest.tokens[i], missing);
            }
        }
        if (colWidest) {
            for (let i = 0; i < colWidest.length; i++) {
                if (colWidest[i] == null) continue;
                colWidest[i] = substituteUncovered(colWidest[i], missing);
            }
        }
    }

    // ---------------- TrueType cmap coverage ----------------
    // We do not guess which blocks DejaVu covers — we read the font's own cmap
    // and ask it. A codepoint that maps to glyph 0 (.notdef) cannot be drawn.

    /**
     * Wrap a raw cmap probe so that a malformed (or hostile) font can never take
     * a conversion down with it.
     *
     * The probe walks byte offsets that come out of the font file itself, so a
     * truncated/corrupt table can make a DataView read land out of bounds and
     * throw a RangeError. `has()` is called from the layout path with no
     * try/catch above it, so such a throw used to reject the conversion promise:
     * a *font parsing* problem failed the user's CSV. That is strictly worse
     * than the mojibake this code exists to warn about.
     *
     * Contract after the guard: `has()` never throws. The first failure latches
     * `unreliable = true` and every subsequent answer is `true` ("assume drawable")
     * so a broken probe cannot invent a list of "missing" characters either.
     * Callers check `.unreliable` and report coverage as UNKNOWN.
     */
    function guardCoverage(probe) {
        if (!probe || typeof probe.has !== 'function') return null;
        const guarded = {
            unreliable: false,
            has(cp) {
                if (guarded.unreliable) return true;
                try {
                    return probe.has(cp) === true;
                } catch (e) {
                    guarded.unreliable = true;
                    console.warn('[CSV] Font cmap probe failed; coverage unknown:', e && e.message);
                    return true;
                }
            }
        };
        return guarded;
    }

    /**
     * Build a coverage predicate from TTF bytes.
     * @returns {{has:(cp:number)=>boolean, unreliable:boolean}|null}
     *          null when the cmap can't be read at all.
     */
    function parseTTFCoverage(bytes) {
        try {
            const dv = new DataView(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
            const numTables = dv.getUint16(4);
            let cmapOff = -1;
            for (let i = 0; i < numTables; i++) {
                const rec = 12 + 16 * i;
                const tag = String.fromCharCode(
                    dv.getUint8(rec), dv.getUint8(rec + 1), dv.getUint8(rec + 2), dv.getUint8(rec + 3));
                if (tag === 'cmap') { cmapOff = dv.getUint32(rec + 8); break; }
            }
            if (cmapOff < 0) return null;

            const nSub = dv.getUint16(cmapOff + 2);
            let best = null, bestScore = -1;
            for (let i = 0; i < nSub; i++) {
                const p = cmapOff + 4 + 8 * i;
                const plat = dv.getUint16(p);
                const enc = dv.getUint16(p + 2);
                const off = cmapOff + dv.getUint32(p + 4);
                const fmt = dv.getUint16(off);
                // Prefer full-Unicode (format 12) tables, then BMP (format 4).
                let score = -1;
                if (fmt === 12 && ((plat === 3 && enc === 10) || (plat === 0 && enc >= 4))) score = 4;
                else if (fmt === 4 && ((plat === 3 && enc === 1) || (plat === 0))) score = 2;
                if (score > bestScore) { bestScore = score; best = { fmt, off }; }
            }
            if (!best || bestScore < 0) return null;

            if (best.fmt === 12) {
                const nGroups = dv.getUint32(best.off + 12);
                const base = best.off + 16;
                return guardCoverage({
                    has(cp) {
                        let lo = 0, hi = nGroups - 1;
                        while (lo <= hi) {
                            const mid = (lo + hi) >> 1;
                            const g = base + mid * 12;
                            const start = dv.getUint32(g), end = dv.getUint32(g + 4);
                            if (cp < start) hi = mid - 1;
                            else if (cp > end) lo = mid + 1;
                            else {
                                // startGlyphID == 0 means this group's glyph range is
                                // anchored on .notdef. The old code returned
                                // `0 + (cp - start) !== 0`, which reported EVERY
                                // codepoint above the group start as covered — the
                                // exact tofu we exist to warn about, silently passed.
                                // Treat the whole group as uncovered.
                                const startGid = dv.getUint32(g + 8);
                                return startGid !== 0;
                            }
                        }
                        return false;
                    }
                });
            }

            // Format 4 (BMP only).
            const segX2 = dv.getUint16(best.off + 6);
            const segCount = segX2 / 2;
            const endBase = best.off + 14;
            const startBase = endBase + segX2 + 2;
            const deltaBase = startBase + segX2;
            const rangeBase = deltaBase + segX2;
            return guardCoverage({
                has(cp) {
                    if (cp > 0xFFFF) return false;   // no format-12 table => no astral glyphs
                    for (let s = 0; s < segCount; s++) {
                        const end = dv.getUint16(endBase + s * 2);
                        if (cp > end) continue;
                        const start = dv.getUint16(startBase + s * 2);
                        if (cp < start) return false;   // falls in a gap
                        const ro = dv.getUint16(rangeBase + s * 2);
                        let gid;
                        if (ro === 0) {
                            gid = (cp + dv.getInt16(deltaBase + s * 2)) & 0xFFFF;
                        } else {
                            const gi = rangeBase + s * 2 + ro + (cp - start) * 2;
                            // getUint16 reads TWO bytes at `gi`, so both ends must
                            // hold. `gi + 2 > byteLength` is the upper bound stated
                            // in the form it is actually needed in (it is equivalent
                            // to the previous `gi + 1 >= byteLength`); `gi < 0` is
                            // the new half — cheap insurance against a garbage or
                            // hostile offset, since every other read in this probe
                            // is likewise driven by font-controlled values and a
                            // negative index is the one case a RangeError from here
                            // could not be traced back to a length.
                            if (gi < 0 || gi + 2 > dv.byteLength) return false;
                            gid = dv.getUint16(gi);
                            if (gid !== 0) gid = (gid + dv.getInt16(deltaBase + s * 2)) & 0xFFFF;
                        }
                        return gid !== 0;
                    }
                    return false;
                }
            });
        } catch (e) {
            console.warn('[CSV] Could not parse font cmap:', e && e.message);
            return null;
        }
    }

    /** Binary -> base64 without blowing the argument limit on ~750 KB payloads. */
    function bytesToBase64(bytes) {
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        if (typeof btoa === 'function') return btoa(binary);
        return Buffer.from(binary, 'binary').toString('base64');   // Node (tests)
    }

    /**
     * Fetch + cache the Unicode font payloads. Resolves to null on any failure
     * (offline, 404, no fetch) — the caller then degrades to helvetica + warning.
     */
    function fetchFontPayloads() {
        if (fontPayloadCache) return fontPayloadCache;
        fontPayloadCache = (async () => {
            if (typeof fetch !== 'function') return null;
            const out = {};
            for (const face of UNICODE_FONT.faces) {
                const res = await fetch(face.url);
                // B1: 429 -> fail the conversion with the busy message.
                const limited = _P.rateLimitErrorFromResponse(res, Date.now());
                if (limited) throw limited;
                if (!res || !res.ok) throw new Error(`HTTP ${res && res.status} for ${face.url}`);
                const bytes = new Uint8Array(await res.arrayBuffer());
                if (bytes.length < 4) throw new Error(`empty font ${face.url}`);
                if (face.style === 'normal' && fontCoverageCache === null) {
                    fontCoverageCache = parseTTFCoverage(bytes);
                }
                out[face.file] = bytesToBase64(bytes);
            }
            return out;
        })().catch(err => {
            console.warn('[CSV] Unicode font load failed:', err && err.message);
            fontPayloadCache = null;   // allow a retry on the next conversion
            // B1: not a degrade-to-helvetica case. The server said to stop
            // asking; the user is told when to come back instead.
            if (_P.isRateLimitedError(err)) throw err;
            return null;
        });
        return fontPayloadCache;
    }

    /**
     * Register the Unicode font on `doc`.
     * @returns {{family:string, hasBold:boolean, hasItalic:boolean}|null}
     */
    async function loadUnicodeFont(doc) {
        if (typeof doc.addFileToVFS !== 'function' || typeof doc.addFont !== 'function') return null;
        const payloads = await fetchFontPayloads();
        if (!payloads) return null;
        try {
            let hasBold = false;
            for (const face of UNICODE_FONT.faces) {
                const b64 = payloads[face.file];
                if (!b64) continue;
                doc.addFileToVFS(face.file, b64);
                doc.addFont(face.file, UNICODE_FONT.family, face.style);
                if (face.style === 'bold') hasBold = true;
            }
            return { family: UNICODE_FONT.family, hasBold, hasItalic: false };
        } catch (e) {
            console.warn('[CSV] Unicode font registration failed:', e && e.message);
            return null;
        }
    }

    /**
     * Embed a CJK fallback face covering as much of `missing` as a shipped tier
     * can, and report what it still cannot draw.
     *
     * Returns null when nothing could be loaded — the caller then behaves exactly
     * as before (blanks + the existing notice), because a failed enhancement must
     * never be worse than not attempting it.
     */
    async function loadCjkFallback(doc, missing) {
        if (!missing || !missing.size) return null;
        if (typeof fetch !== 'function') return null;
        if (typeof doc.addFileToVFS !== 'function' || typeof doc.addFont !== 'function') return null;

        let last = null;
        // Hangul present -> try NanumGothic first; absent -> never fetch it.
        const isHangul = (cp) => (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0x3130 && cp <= 0x318F);
        let hangulFirst = false;
        try { for (const cp of missing) { if (isHangul(cp)) { hangulFirst = true; break; } } } catch (e) { /* keep false */ }
        const tiers = hangulFirst
            ? CJK_FONT_TIERS.filter((t) => t.hangul).concat(CJK_FONT_TIERS.filter((t) => !t.hangul))
            : CJK_FONT_TIERS.filter((t) => !t.hangul);
        for (let i = 0; i < tiers.length; i++) {
            const tier = tiers[i];
            let bytes, cov;
            try {
                const res = await fetch(tier.url);
                const limited = _P.rateLimitErrorFromResponse(res, Date.now());
                if (limited) throw limited;   // B1: rethrown below, fails the conversion
                if (!res || !res.ok) continue;
                bytes = new Uint8Array(await res.arrayBuffer());
                if (bytes.length < 4) continue;
                cov = parseTTFCoverage(bytes);
            } catch (e) {
                if (_P.isRateLimitedError(e)) throw e;   // B1
                console.warn('[CSV] CJK tier ' + tier.label + ' failed to load:', e && e.message);
                continue;
            }
            if (!cov || cov.unreliable) continue;

            const remaining = new Set();
            try {
                for (const cp of missing) if (!cov.has(cp)) remaining.add(cp);
            } catch (e) { continue; }

            // Keep the tier that leaves the fewest codepoints undrawable (FG-047: with
            // a Hangul tier in the list, the last one tried is no longer the best).
            if (!last || remaining.size < last.remaining.size) last = { tier, bytes, cov, remaining };
            // Good enough: this tier draws everything DejaVu could not.
            if (remaining.size === 0) break;
            // Otherwise try the next (larger) tier; if there is none, `last`
            // holds the best we have and is used below.
        }
        if (!last) return null;

        try {
            doc.addFileToVFS(last.tier.file, bytesToBase64(last.bytes));
            doc.addFont(last.tier.file, last.tier.family, 'normal');
        } catch (e) {
            console.warn('[CSV] CJK font registration failed:', e && e.message);
            return null;
        }
        console.log('[CSV] CJK fallback: ' + last.tier.label + ' (' + last.tier.file + '), ' +
            (missing.size - last.remaining.size) + ' of ' + missing.size + ' codepoint(s) now drawable');
        return { family: last.tier.family, coverage: last.cov,
                 remaining: last.remaining, label: last.tier.label };
    }

    /**
     * Select a font face, degrading styles the embedded family does not have.
     * (We ship regular + bold only; italic falls back to regular.)
     */
    function applyFont(doc, fonts, style, family) {
        const f = fonts || DEFAULT_FONTS;
        const fam = family || f.family;
        let s = style || 'normal';
        if (fam !== 'helvetica') {
            if (s === 'bolditalic') s = f.hasBold ? 'bold' : 'normal';
            else if (s === 'italic' && !f.hasItalic) s = 'normal';
            if (s === 'bold' && !f.hasBold) s = 'normal';
        }
        // The CJK fallback ships REGULAR ONLY. Asking jsPDF for a bold face it
        // was never given throws, which would fail the whole conversion for a
        // header cell — so bold silently degrades for that family alone.
        if (family && f.cjkFamily && family === f.cjkFamily) s = 'normal';
        doc.setFont(fam, s);
    }

    /**
     * Split `text` into runs by which embedded family can draw each character.
     *
     * Latin and CJK live in DIFFERENT faces here (Droid Sans Fallback has no
     * Latin at all), so a mixed cell — which is most of a bilingual corpus —
     * cannot be drawn or measured in one call. Runs are contiguous so a
     * single-script cell, the common case, yields exactly one run and costs one
     * comparison per character.
     *
     * A character neither family covers stays with the Latin face, where the
     * uncovered-glyph stand-in already handles it.
     */
    function splitFontRuns(text, fonts) {
        const latin = (fonts && fonts.family) || DEFAULT_FONTS.family;
        const cjk = fonts && fonts.cjkFamily;
        if (!cjk || !text) return [{ family: latin, text: String(text == null ? '' : text) }];
        const covers = fonts.cjkCovers;
        const runs = [];
        let cur = null;
        for (let i = 0; i < text.length; i++) {
            let cp = text.charCodeAt(i);
            let ch = text[i];
            if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < text.length) {
                const lo = text.charCodeAt(i + 1);
                if (lo >= 0xDC00 && lo <= 0xDFFF) {
                    cp = (cp - 0xD800) * 0x400 + lo - 0xDC00 + 0x10000;
                    ch = text[i] + text[i + 1];
                    i++;
                }
            }
            // Latin face wins wherever it can draw the character, so existing
            // output is byte-identical for everything DejaVu already covered.
            const fam = (cp > 0x7F && covers && covers(cp)) ? cjk : latin;
            if (cur && cur.family === fam) cur.text += ch;
            else { cur = { family: fam, text: ch }; runs.push(cur); }
        }
        return runs.length ? runs : [{ family: latin, text: '' }];
    }

    /** Draw `text` at (x, y), switching faces per run. Returns the width drawn. */
    function drawTextRuns(doc, text, x, y, fonts, style) {
        const runs = splitFontRuns(text, fonts);
        if (runs.length === 1) {
            applyFont(doc, fonts, style, runs[0].family);
            doc.text(runs[0].text, x, y);
            return;
        }
        let cx = x;
        for (const r of runs) {
            if (!r.text) continue;
            applyFont(doc, fonts, style, r.family);
            doc.text(r.text, cx, y);
            cx += doc.getTextWidth(r.text);
        }
    }

    /** Today's metrics: the tuned constants, no measurement, no jsPDF calls. */
    function defaultMetrics() {
        return {
            charWidth: CONFIG.charWidth,
            headerCharWidth: CONFIG.headerCharWidth,
            measure: null,
            // Upper bound on the width ONE UTF-16 code unit can contribute.
            // 0 == unknown. Only meaningful together with `measure` (C2).
            maxCharWidth: 0,
            maxHeaderCharWidth: 0
        };
    }

    /**
     * Metrics for the font actually in use — including built-in helvetica.
     *
     * The layout is built on a per-character width budget (`maxChars`), tuned as
     * `charWidth = 5.5` for 10 pt helvetica. That constant is an average, not an
     * upper bound, so it must be rescaled — not reused — when the font (DejaVu is
     * ~14 % wider than Helvetica for Latin) or the script (Cyrillic ~22 % wider)
     * changes, or wrapped lines overflow their column into the next one.
     *
     * THE SAME IS TRUE WITHIN HELVETICA ITSELF, which is why this no longer
     * returns early for it. Helvetica's own glyphs range from ~2.8 pt (`i`, `l`)
     * to ~9.2 pt (`W`, `@`, `M`) at 10 pt. Treating the 5.5 pt average as if it
     * were a bound under-counts a wide cell by ~40 %, and it did so TWICE: once
     * in calculateColumnWidths (columns came out too narrow) and again in
     * measureRow (the wrap point allowed more characters than fit). A cell of
     * capitals therefore drew past its own column into the next one — the
     * ~50 pt overflow this fixes.
     *
     * Deliberate consequence: pagination can change. `scale` is clamped at >= 1
     * so nothing ever gets tighter than the shipped tuning, and a document of
     * ordinary mixed-case text measures a ratio near 1.0 and is essentially
     * unaffected. What changes is documents with wide-glyph-heavy content, which
     * are exactly the ones rendering incorrectly today.
     *
     * Scale factor = (average advance of THIS document's characters in THIS font)
     *                / (average advance of an ASCII baseline in 10 pt helvetica).
     * That preserves the existing tuning exactly for ASCII-in-helvetica (ratio 1)
     * and widens the budget proportionally for anything wider.
     *
     * Column-width estimation (calculateColumnWidths) additionally switches to
     * real getTextWidth measurement — it only samples ~110 rows, so exact
     * measurement there is free.
     *
     * C2 addition — `maxCharWidth` / `maxHeaderCharWidth`: an UPPER bound on what
     * a single UTF-16 code unit can contribute, measured over every distinct
     * character this document actually contains (all printable ASCII + `cps`,
     * the full-document non-ASCII codepoint set the coverage check already
     * collected). jsPDF's getTextWidth is a plain sum of per-glyph advances (no
     * kerning), so `text.length * maxCharWidth >= getTextWidth(text)` holds for
     * every string in the document. measureRow uses that as an O(1) proof of fit
     * and only pays for a real measurement when the proof fails.
     */
    function computeMetrics(doc, fonts, data, cps) {
        const base = defaultMetrics();
        // Helvetica is measured too now (see above). Without getTextWidth there
        // is nothing to measure with, so fall back to the tuned averages — that
        // is the pre-existing behaviour and it still renders, just loosely.
        if (!fonts) fonts = DEFAULT_FONTS;
        if (typeof doc.getTextWidth !== 'function') return base;

        try {
            const prevSize = doc.getFontSize ? doc.getFontSize() : CONFIG.fontSize;

            doc.setFontSize(CONFIG.fontSize);
            doc.setFont('helvetica', 'normal');
            const refAvg = doc.getTextWidth(METRICS_REF_SAMPLE) / METRICS_REF_SAMPLE.length;

            const sample = sampleDocumentText(data);
            applyFont(doc, fonts, 'normal');
            const docAvg = sample.length
                ? doc.getTextWidth(sample) / sample.length
                : doc.getTextWidth(METRICS_REF_SAMPLE) / METRICS_REF_SAMPLE.length;

            doc.setFontSize(prevSize || CONFIG.fontSize);

            if (!(refAvg > 0) || !(docAvg > 0)) return base;
            const ratio = docAvg / refAvg;
            // Never NARROWER than today's budget: shrinking it could only make
            // columns tighter than the tuning that ships, for no benefit.
            const scale = Math.max(1, ratio);
            // NB: deliberately re-selects the face on every call. drawRowChunk
            // changes the document's font between rows, so caching "the face is
            // already right" here would silently measure in the wrong font.
            // Run-aware, because Latin and CJK are in different faces. This is
            // what keeps the per-CODEPOINT width table correct without any other
            // change: buildCharWidthTables measures one character at a time, so
            // each codepoint is measured in the face that will actually draw it,
            // and sumCharWidths then adds up widths that are already right for a
            // mixed string. The multi-character path matters too — cellInkWidth
            // falls back to measure() whenever the table cannot answer.
            const measure = (text, isHeader) => {
                doc.setFontSize(isHeader ? CONFIG.headerFontSize : CONFIG.fontSize);
                const style = isHeader ? 'bold' : 'normal';
                const runs = splitFontRuns(text, fonts);
                if (runs.length === 1) {
                    applyFont(doc, fonts, style, runs[0].family);
                    return doc.getTextWidth(runs[0].text);
                }
                let w = 0;
                for (const r of runs) {
                    if (!r.text) continue;
                    applyFont(doc, fonts, style, r.family);
                    w += doc.getTextWidth(r.text);
                }
                return w;
            };
            const tables = buildCharWidthTables(measure, cps);
            console.log(`[CSV] Unicode font metrics: advance ratio ${ratio.toFixed(3)} ` +
                `(charWidth ${CONFIG.charWidth} -> ${(CONFIG.charWidth * scale).toFixed(2)}, ` +
                `max/char ${tables.maxData.toFixed(2)}, ${tables.data.size} glyph widths cached)`);
            return {
                charWidth: CONFIG.charWidth * scale,
                headerCharWidth: CONFIG.headerCharWidth * scale,
                measure,
                widthOf: (text, isHeader) =>
                    sumCharWidths(isHeader ? tables.header : tables.data, text),
                maxCharWidth: tables.maxData,
                maxHeaderCharWidth: tables.maxHeader
            };
        } catch (e) {
            console.warn('[CSV] Font metric probe failed, using default metrics:', e && e.message);
            return base;
        }
    }

    /**
     * Per-glyph advance tables for the whole alphabet this document can draw:
     * all printable ASCII plus every distinct non-ASCII codepoint in the file
     * (`cps`, already collected for the coverage check). ONE jsPDF measurement
     * per DISTINCT character, not per cell.
     *
     * Two things fall out of this, and both are why measureRow can afford to be
     * exact at all:
     *   - `sumCharWidths()` reproduces getTextWidth() with plain Map lookups —
     *     jsPDF's width is a straight sum of advances, no kerning — so the hot
     *     loop never has to call into jsPDF (setFont + setFontSize + string walk).
     *   - `maxData`/`maxHeader` bound what ONE UTF-16 code unit can contribute,
     *     giving measureRow an O(1) "this provably fits" test. Astral characters
     *     span two code units and are charged their full width to each, which
     *     over-estimates — the safe direction.
     *
     * @returns {{data:Map, header:Map, maxData:number, maxHeader:number}}
     *          empty maps + 0 bounds when the probe fails.
     */
    function buildCharWidthTables(measure, cps) {
        const empty = { data: new Map(), header: new Map(), maxData: 0, maxHeader: 0 };
        try {
            // 0x00–0x1F as well as the printable range: a control character can
            // survive inside a quoted cell, and a codepoint MISSING from the table
            // would weaken the `maxCharWidth` bound (its true advance would not
            // have been counted when the maximum was taken).
            const codes = [];
            for (let c = 0x00; c <= 0x7E; c++) codes.push(c);
            if (cps && typeof cps.forEach === 'function') cps.forEach(cp => codes.push(cp));

            const data = new Map(), header = new Map();
            let maxData = 0, maxHeader = 0;
            // Two passes (not one alternating pass) so the font face is selected
            // in runs rather than flipped on every character.
            for (const cp of codes) {
                let ch;
                try { ch = String.fromCodePoint(cp); } catch (e) { continue; }  // lone surrogate
                const w = measure(ch, false);
                if (!(w >= 0)) return empty;
                data.set(cp, w);
                if (w > maxData) maxData = w;
            }
            for (const cp of codes) {
                let ch;
                try { ch = String.fromCodePoint(cp); } catch (e) { continue; }
                const w = measure(ch, true);
                if (!(w >= 0)) return empty;
                header.set(cp, w);
                if (w > maxHeader) maxHeader = w;
            }
            return { data, header, maxData, maxHeader };
        } catch (e) {
            console.warn('[CSV] Glyph width probe failed:', e && e.message);
            return empty;   // 0 bounds + empty tables -> measureRow falls back to measure()
        }
    }

    /**
     * Exact width of `text` from a glyph table, or -1 if any character is absent
     * (then the caller must ask jsPDF directly). Indexed loop + surrogate pairing
     * rather than `for…of`, which allocates a string per character.
     */
    function sumCharWidths(table, text) {
        if (!table || table.size === 0) return -1;
        let w = 0;
        for (let i = 0; i < text.length; i++) {
            let cp = text.charCodeAt(i);
            if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < text.length) {
                const lo = text.charCodeAt(i + 1);
                if (lo >= 0xDC00 && lo <= 0xDFFF) { cp = (cp - 0xD800) * 0x400 + lo - 0xDC00 + 0x10000; i++; }
            }
            const v = table.get(cp);
            if (v === undefined) return -1;
            w += v;
        }
        return w;
    }

    /**
     * Exact width of one cell: the glyph table when it can answer (the common
     * case, and cheap), jsPDF otherwise. Deliberately not a closure — measureRow
     * calls this per cell for millions of rows.
     */
    function cellInkWidth(metrics, text, isHeader) {
        if (metrics.widthOf) {
            const w = metrics.widthOf(text, isHeader);
            if (w >= 0) return w;
        }
        return metrics.measure(text, isHeader);
    }

    /** A bounded, representative slice of the document's own text (for metrics). */
    function sampleDocumentText(data) {
        const LIMIT = 4000;
        let out = '';
        if (!data) return out;
        const rows = data.length <= 120 ? data : data.slice(0, 100).concat(data.slice(-20));
        for (const row of rows) {
            if (!row) continue;
            for (const cell of row) {
                if (cell == null) continue;
                out += String(cell);
                if (out.length >= LIMIT) return out.slice(0, LIMIT);
            }
        }
        return out;
    }

    /**
     * Decide how to render this document's text and report anything we cannot.
     * Pure-ASCII input short-circuits before any fetch — identical to the old path.
     * @returns {Promise<{fonts:object, metrics:object, warnings:Array}>}
     */
    async function prepareTextRendering(doc, data, hasNonAscii, noticeText) {
        const warnings = [];
        if (hasNonAscii === undefined || hasNonAscii === null) hasNonAscii = dataHasNonAscii(data);
        // Safety net: the notice block is drawn with the same font as the data,
        // so non-ASCII prose in a warning message must also force the real font.
        // (Today's messages are deliberately ASCII, so this never fires — it just
        // stops a future message from silently reintroducing mojibake.)
        if (!hasNonAscii && noticeText && NON_ASCII_RE.test(noticeText)) hasNonAscii = true;
        if (!hasNonAscii) {
            // Pure ASCII: no embedded font is needed, but we still MEASURE. This
            // used to return defaultMetrics() — the tuned 5.5 pt average with no
            // `measure` — which is what let a capitals-heavy cell draw ~50 pt past
            // its own column. Helvetica is proportional too (`i` ~2.8 pt, `W`
            // ~9.2 pt at 10 pt), so an average is no more a bound here than it is
            // for an embedded face. `cps` is empty because there is no non-ASCII;
            // buildCharWidthTables covers 0x00-0x7E regardless, which is the whole
            // repertoire of such a document.
            return {
                fonts: DEFAULT_FONTS,
                metrics: computeMetrics(doc, DEFAULT_FONTS, data, new Set()),
                warnings
            };
        }

        const fonts = await loadUnicodeFont(doc);
        if (!fonts) {
            // Degrade, don't crash — but say so. (Old behaviour + a warning.)
            // Measured in helvetica for the same reason as the ASCII path above:
            // the text still has to fit the columns we drew.
            addWarning(warnings, 'font-load-failed');
            return {
                fonts: DEFAULT_FONTS,
                metrics: computeMetrics(doc, DEFAULT_FONTS, data, new Set()),
                warnings
            };
        }

        // Which of this file's codepoints does the embedded font actually cover?
        const cps = collectNonAsciiCodepoints(data);
        // Belt and braces: `has()` is already guarded (guardCoverage), but this
        // probe must NEVER be able to fail a conversion. A font-parsing problem
        // degrades to "coverage unknown" and the user is told, nothing more.
        let probeFailed = false;
        const missing = new Set();
        if (fontCoverageCache) {
            try {
                for (const cp of cps) if (!fontCoverageCache.has(cp)) missing.add(cp);
                if (fontCoverageCache.unreliable) { probeFailed = true; missing.clear(); }
            } catch (e) {
                probeFailed = true;
                missing.clear();
                console.warn('[CSV] Font coverage check failed; coverage unknown:', e && e.message);
            }
        }
        // Anything DejaVu cannot draw gets a second chance from a CJK fallback
        // face before the user is told it is lost. Done HERE, after `missing` is
        // known and before the warning is composed, so the notice describes what
        // is genuinely undrawable rather than everything non-Latin.
        //
        // Purely additive: if this returns null, or covers nothing, `missing` is
        // unchanged and the old behaviour (stand-in box + notice) is exactly what
        // happens. A file with no CJK never fetches anything.
        if (!probeFailed && missing.size > 0) {
            const cjk = await loadCjkFallback(doc, missing);
            if (cjk) {
                fonts.cjkFamily = cjk.family;
                fonts.cjkCovers = (cp) => {
                    try { return cjk.coverage.has(cp); } catch (e) { return false; }
                };
                const recovered = missing.size - cjk.remaining.size;
                missing.clear();
                for (const cp of cjk.remaining) missing.add(cp);
                if (recovered > 0) {
                    warnings.push({ code: 'cjk-font-loaded', message:
                        `${recovered} character(s) needed a CJK font; loaded the ` +
                        `${cjk.label} fallback so they render.` });
                }
            }
        }

        if (probeFailed) {
            addWarning(warnings, 'font-coverage-unknown');
        } else if (fontCoverageCache) {
            if (missing.size > 0) {
                addWarning(warnings, 'unsupported-characters', missing.size, describeCodepoints(missing));
                console.warn(`[CSV] ${missing.size} codepoint(s) not covered by ${UNICODE_FONT.family}: ` +
                    describeCodepoints(missing));
            }
        } else if (cps.size > 0) {
            addWarning(warnings, 'font-coverage-unknown');
        }

        // The box we substitute for uncovered glyphs has to be in the width
        // tables, or every substituted cell falls off sumCharWidths' fast path
        // into a per-cell jsPDF call. One extra measurement, not per cell.
        if (missing.size > 0) cps.add(UNCOVERED_STANDIN_CP);

        return { fonts, metrics: computeMetrics(doc, fonts, data, cps), warnings, missing };
    }

    /**
     * Estimate a width for every column (0..maxCols-1) from a sample of rows.
     * Iterates maxCols (the true widest-row count from the parser), not row 0,
     * so ragged CSVs keep all their columns. Width is only an estimate —
     * wrapping guarantees no content is lost regardless of the estimate.
     *
     * With an embedded font (`metrics.measure`) the sampled cells are measured
     * for real via jsPDF instead of assumed to be charWidth points wide; only
     * ~110 rows are sampled, so exact measurement costs nothing.
     *
     * C1: when row 0 is the header it must be measured AS a header — 11 pt bold,
     * ~30 % wider than the 10 pt normal the data uses. Measuring it as data made
     * every header column too narrow, so header text wrapped or clipped even
     * though the column had been sized "to fit" it.
     *
     * @param {boolean} [hasHeaderRow] true when data[0] is the header row.
     */
    function calculateColumnWidths(data, maxCols, metrics, hasHeaderRow, colWidest, mode) {
        if (!data || data.length === 0 || maxCols === 0) return [];
        metrics = metrics || defaultMetrics();
        // FF-7. 'wrap' (Always wrap, and what every caller without a mode gets) is the original: every column is capped at maxColWidth.
        // 'nowrap' lifts the cap for every value; 'auto' lifts it only for a value with no whitespace (a token: kept whole), while a value
        // with whitespace (prose) keeps the cap and wraps at its spaces.
        const capFor = (text) => (mode === 'nowrap' ? Infinity : (mode === 'auto' && isToken(text)) ? Infinity : CONFIG.maxColWidth);

        const widths = new Array(maxCols).fill(CONFIG.minColWidth);

        // Sample rows for width calculation (first 100 + last 10). Indexed rather
        // than sliced so row 0 can be recognised as the header.
        const lastStart = Math.max(0, data.length - 10);
        for (let r = 0; r < data.length; r++) {
            if (r >= 100 && r < lastStart) continue;
            const row = data[r];
            if (!row) continue;
            const isHeader = !!hasHeaderRow && r === 0;
            const charWidth = isHeader ? metrics.headerCharWidth : metrics.charWidth;
            for (let i = 0; i < maxCols; i++) {
                const cellText = row[i] == null ? '' : String(row[i]);
                // Two constraints, both must hold:
                //  - the real ink width (exact, from the font) must fit, and
                //  - the char budget measureRow() will later use to decide where
                //    to wrap must agree, or a cell that physically fits gets
                //    wrapped anyway. Take whichever is larger.
                // FG-135: also take the wrap pass's own measurement (cellInkWidth:
                // the glyph table first, then measure()). Sizing used measure() alone,
                // the two can disagree by a fraction of a point, and the widest value
                // then wrapped its last character onto a line of its own.
                const textWidth = metrics.measure
                    ? Math.max(metrics.measure(cellText, isHeader), cellText.length * charWidth,
                               cellInkWidth(metrics, cellText, isHeader))
                    : cellText.length * charWidth;
                const cellWidth = Math.min(
                    textWidth + CONFIG.cellPadding * 2,
                    capFor(cellText)
                );
                if (cellWidth > widths[i]) widths[i] = cellWidth;
            }
        }

        // The TRUE widest cell per column, recorded by the parser over every row
        // (see colWidest in parseCSVDocument). The sample above covers the first
        // 100 rows and the last 10 — 2.8% of a 3,961-row file — so a column
        // whose long values sit in the middle was sized from data that did not
        // represent it and rendered one to two characters per line.
        //
        // This can only ever WIDEN a column: it takes the max against what the
        // sample already produced, so the common case is unchanged and no
        // column can be made narrower than before.
        if (colWidest) {
            for (let i = 0; i < maxCols; i++) {
              // FG-135: size from the longest value AND the widest-by-ink value.
              for (const cellText of [colWidest[i], colWidest.byInk && colWidest.byInk[i], mode === 'auto' && colWidest.tokens ? colWidest.tokens[i] : undefined]) {
                if (!cellText) continue;
                const textWidth = metrics.measure
                    ? Math.max(metrics.measure(cellText, false), cellText.length * metrics.charWidth,
                               cellInkWidth(metrics, cellText, false))   // FG-135, as above
                    : cellText.length * metrics.charWidth;
                const cellWidth = Math.min(textWidth + CONFIG.cellPadding * 2, capFor(cellText));
                if (cellWidth > widths[i]) widths[i] = cellWidth;
              }
            }
        }

        return widths;
    }

    /**
     * BUG-35: the largest cut index <= maxChars that does not split a grapheme
     * cluster (a surrogate pair such as an emoji or CJK Extension B character, or
     * a letter and its combining marks). Never returns 0: a single cluster wider
     * than the budget is kept whole rather than broken apart.
     */
    function graphemeSafeCut(word, maxChars) {
        if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
            let cut = 0;
            for (const { index, segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word)) {
                const end = index + segment.length;
                if (end > maxChars) return cut > 0 ? cut : end;
                cut = end;
            }
            return cut;
        }
        // Fallback without Intl.Segmenter: step back off a low surrogate and off
        // combining marks so the cut lands before the cluster they belong to.
        let i = maxChars;
        const isLow = (c) => c >= 0xDC00 && c <= 0xDFFF;
        while (i > 0 && i < word.length && (isLow(word.charCodeAt(i)) || /\p{M}/u.test(word[i]))) i--;
        return i > 0 ? i : Math.min(word.length, maxChars + (isLow(word.charCodeAt(maxChars)) ? 1 : 0));
    }

    /**
     * Greedy word-wrap to a character budget. Leading spaces are kept on the
     * first line; the space at a wrap point is dropped. Words longer than maxChars are
     * hard-broken; an embedded newline (`\n`, `\r\n`, or lone `\r` — reachable
     * since C3) forces a new line. Returns at least ['']. Pure and jsPDF-free
     * so it is fast and unit-testable.
     */
    function wrapText(text, maxChars) {
        text = (text == null) ? '' : String(text);
        if (!(maxChars >= 1)) maxChars = 1;

        const lines = [];
        // Each of \r\n, lone \r, and \n counts as exactly ONE break (L-2).
        const paragraphs = text.split(/\r\n?|\n/);
        for (let p = 0; p < paragraphs.length; p++) {
            const para = paragraphs[p];
            if (para.length === 0) { lines.push(''); continue; }
            if (para.length <= maxChars) { lines.push(para); continue; }

            let line = '';
            // The author's leading spaces are content (owner decision 2026-10-11,
            // verification/docs/space-padded-alignment.md): they stay on the first
            // line, glued to the first word. The space at each wrap point is
            // still dropped (ordinary line wrapping; a run of spaces falling
            // exactly at the wrap goes with it), so no continuation line starts
            // with a space.
            const lead = /^ */.exec(para)[0];
            const words = para.slice(lead.length).split(' ');
            words[0] = lead + words[0];
            for (let w = 0; w < words.length; w++) {
                let word = words[w];
                // Hard-break tokens longer than the column budget.
                while (word.length > maxChars) {
                    if (line.length > 0) { lines.push(line); line = ''; }
                    const cut = graphemeSafeCut(word, maxChars);
                    if (cut >= word.length) break;   // one cluster wider than the budget: keep it whole
                    lines.push(word.slice(0, cut));
                    word = word.slice(cut);
                }
                if (line.length === 0) {
                    line = word;
                } else if (line.length + 1 + word.length <= maxChars) {
                    line += ' ' + word;
                } else {
                    lines.push(line);
                    line = word;
                }
            }
            if (line.length > 0) lines.push(line);
        }
        if (lines.length === 0) lines.push('');
        return lines;
    }

    /**
     * Greedily pack consecutive columns into bands whose total width fits
     * contentWidth. A single column wider than contentWidth is capped and gets
     * its own band (its text wraps — no loss).
     * @returns {Array<{start:number, end:number, width:number}>}
     */
    function planBands(colWidths, contentWidth) {
        const bands = [];
        let start = 0;
        while (start < colWidths.length) {
            let width = 0;
            let end = start;
            while (end < colWidths.length) {
                const w = Math.min(colWidths[end], contentWidth);
                if (end > start && width + w > contentWidth) break;
                width += w;
                end++;
            }
            if (end === start) { // safety: single oversized column
                width = Math.min(colWidths[start], contentWidth);
                end = start + 1;
            }
            bands.push({ start, end, width });
            start = end;
        }
        return bands;
    }

    /**
     * Decide column widths and how to lay the columns out across the page width:
     * one band if it fits, a scaled single band if only mildly wide, otherwise
     * horizontal bands (Calc-style "down, then across").
     * @returns {{ colWidths:number[], bands:Array, scaled:boolean }}
     */
    function computeColumnLayout(data, maxCols, contentWidth, metrics, hasHeaderRow, colWidest, layoutOpts) {
        const mode = (layoutOpts && layoutOpts.mode) || 'wrap';
        let colWidths = calculateColumnWidths(data, maxCols, metrics, hasHeaderRow, colWidest, mode);
        const totalWidth = colWidths.reduce((a, b) => a + b, 0);
        let scaled = false;
        let bands;

        if (mode !== 'wrap') return computeScaledLayout(colWidths, contentWidth, (layoutOpts && layoutOpts.floorScale) || 0.6);

        if (totalWidth <= contentWidth) {
            bands = [{ start: 0, end: maxCols, width: totalWidth }];
        } else if (contentWidth / totalWidth >= CONFIG.minScale) {
            const scale = contentWidth / totalWidth;
            colWidths = colWidths.map(w => w * scale);
            scaled = true;
            bands = [{ start: 0, end: maxCols, width: contentWidth }];
        } else {
            // Cap any single column wider than the page so drawing never overflows.
            colWidths = colWidths.map(w => Math.min(w, contentWidth));
            bands = planBands(colWidths, contentWidth);
        }

        return { colWidths, bands, scaled };
    }

    /**
     * FF-7 layout for 'auto' and 'nowrap': values are kept whole by making their columns as wide as the value, and the PAGE is scaled down
     * instead of the columns squeezed: a band is laid out on a virtual page `1/scale` times as big and drawn through one scale transform, so
     * its text is `scale` times the normal size. The scale never goes below `floorScale` (minimum text size / body size, default 6/10).
     *   - a column wider than the page can ever hold at the floor (`contentWidth / floorScale`) must wrap whatever is done: a WRAP COLUMN.
     *     It stays in the SAME group as the other columns (a reader matches a long description to its id on one page) and takes the page
     *     width left after them, at least twice the Always wrap cap when that can be had at a scale of 1 and the cap itself at the floor;
     *     only when even that leaves it less than the cap does it get a group of its own (below);
     *   - everything fits one page width: one band, scale 1 (the same as Always wrap would give for such a table, widths aside);
     *   - everything fits at a scale of at least the floor: ONE band, scale = page width / total width;
     *   - otherwise columns are packed into bands as before, and a column wider than a page gets its own band at scale = page / column.
     * @returns {{ colWidths:number[], bands:Array<{start:number,end:number,width:number,scale:number,floorLimited:boolean}>, scaled:boolean,
     *             wrapColumns:number[] }}   wrapColumns: the columns that wrap even at the floor (the caller counts their values)
     */
    function computeScaledLayout(colWidths, contentWidth, floorScale) {
        colWidths = colWidths.slice();
        const n = colWidths.length;
        const limit = contentWidth / floorScale;
        const wrapColumns = [];
        for (let i = 0; i < n; i++) if (colWidths[i] > limit) wrapColumns.push(i);
        if (wrapColumns.length) {
            const isWrap = new Set(wrapColumns);
            let rest = 0;
            for (let i = 0; i < n; i++) if (!isWrap.has(i)) rest += colWidths[i];
            const k = wrapColumns.length, minWidth = CONFIG.maxColWidth, wantedWidth = CONFIG.maxColWidth * 2;
            const scale = Math.max(floorScale, Math.min(1, contentWidth / (rest + wantedWidth * k)));
            const room = contentWidth / scale - rest;   // the virtual width left for the wrap columns
            if (room >= minWidth * k) {
                for (const i of wrapColumns) colWidths[i] = room / k;
                return { colWidths, bands: [{ start: 0, end: n, width: rest + room, scale, floorLimited: false }], scaled: scale < 1, wrapColumns };
            }
        }
        const total = colWidths.reduce((a, b) => a + b, 0);
        if (total <= contentWidth) return { colWidths, bands: [{ start: 0, end: n, width: total, scale: 1, floorLimited: false }], scaled: false, wrapColumns };
        if (contentWidth / total >= floorScale) {
            const scale = contentWidth / total;
            return { colWidths, bands: [{ start: 0, end: n, width: total, scale, floorLimited: false }], scaled: true, wrapColumns };
        }
        const bands = [];
        let start = 0;
        while (start < n) {
            if (colWidths[start] > contentWidth) {   // a column wider than a page: its own band, scaled to fit, or to the floor
                const floorLimited = colWidths[start] > limit;
                if (floorLimited) colWidths[start] = limit;
                bands.push({ start, end: start + 1, width: colWidths[start], scale: Math.max(floorScale, contentWidth / colWidths[start]), floorLimited });
                start++;
                continue;
            }
            let width = 0, end = start;
            while (end < n && colWidths[end] <= contentWidth && (end === start || width + colWidths[end] <= contentWidth)) { width += colWidths[end]; end++; }
            bands.push({ start, end, width, scale: 1, floorLimited: false });
            start = end;
        }
        return { colWidths, bands, scaled: false, wrapColumns };
    }

    /**
     * Wrap every cell in a band's column range and report the row's line count.
     * Plain rows (no cell overflows, no embedded newline) short-circuit to
     * lineCount 1 with no arrays allocated (cells === null), keeping the common
     * case allocation-free for million-row files.
     * @returns {{ cells: (string[][]|null), lineCount:number, anyWrap:boolean }}
     */
    function measureRow(row, band, colWidths, isHeader, metrics) {
        metrics = metrics || defaultMetrics();
        const charWidth = isHeader ? metrics.headerCharWidth : metrics.charWidth;
        // `measure` is null on the helvetica/ASCII path — everything below that
        // depends on it is then skipped entirely, so that path is unchanged.
        const measure = metrics.measure || null;
        const maxCharWidth = (isHeader ? metrics.maxHeaderCharWidth : metrics.maxCharWidth) || 0;
        let lineCount = 1;
        let anyWrap = false;
        let cells = null;

        for (let i = band.start; i < band.end; i++) {
            const cellText = row[i] == null ? '' : String(row[i]);
            const avail = colWidths[i] - CONFIG.cellPadding * 2;
            // 1e-9 slack: colWidths are derived from the same charWidth, so an
            // exactly-fitting cell must not be pushed to floor()-1 by a binary
            // rounding error (6*6.1765/6.1765 == 5.999999...).
            const maxChars = Math.max(1, Math.floor(avail / charWidth + 1e-9));
            let needsWrap = cellText.length > maxChars ||
                cellText.indexOf('\n') !== -1 || cellText.indexOf('\r') !== -1; // lone \r wraps too (L-2)

            // C2: `charWidth` is an AVERAGE advance, so "length <= maxChars" does
            // not prove the string physically fits — with a proportional embedded
            // font, W/M/Cyrillic/CJK runs are wider than average and used to be
            // drawn straight through the next column. Resolve it exactly, but only
            //   (a) when an embedded font is active at all (ASCII path pays nothing), and
            //   (b) when the O(1) widest-glyph bound cannot already prove it fits.
            if (measure && !needsWrap && cellText.length > 0 &&
                !(maxCharWidth > 0 && cellText.length * maxCharWidth <= avail)) {
                if (cellInkWidth(metrics, cellText, isHeader) > avail) needsWrap = true;
            }

            if (!needsWrap) {
                if (cells) cells[i - band.start] = [cellText];
            } else {
                if (!cells) {
                    // Lazily materialize the preceding single-line cells.
                    cells = [];
                    for (let j = band.start; j < i; j++) {
                        cells[j - band.start] = [row[j] == null ? '' : String(row[j])];
                    }
                }
                const wrapped = measure
                    ? wrapToWidth(cellText, maxChars, avail, isHeader, metrics)
                    : wrapText(cellText, maxChars);
                cells[i - band.start] = wrapped;
                anyWrap = true;
                if (wrapped.length > lineCount) lineCount = wrapped.length;
            }
        }

        return { cells, lineCount, anyWrap };
    }

    /** How many times wrapToWidth may shrink the budget before falling back. */
    const WRAP_REFIT_ATTEMPTS = 3;

    /**
     * Wrap to a character budget, then CHECK the result against the real column
     * width and shrink the budget until the widest produced line actually fits.
     *
     * wrapText breaks strictly on `length`, which is the C2 defect: a line of
     * `maxChars` wide glyphs overflows a column sized from average glyphs. Each
     * retry rescales the budget by (available / widest measured line) and is
     * forced at least one character narrower, so the loop terminates. If the
     * proportional retries are exhausted we fall back to `avail / maxCharWidth`,
     * a budget derived from the widest glyph in the document, which cannot
     * overflow (short of a single glyph being wider than the whole column).
     */
    function wrapToWidth(text, maxChars, avail, isHeader, metrics) {
        const maxCharWidth = (isHeader ? metrics.maxHeaderCharWidth : metrics.maxCharWidth) || 0;
        let budget = maxChars;
        let lines = wrapText(text, budget);
        for (let attempt = 0; attempt < WRAP_REFIT_ATTEMPTS; attempt++) {
            let worst = 0, worstLen = 0;
            for (let k = 0; k < lines.length; k++) {
                const w = cellInkWidth(metrics, lines[k], isHeader);
                if (w > worst) { worst = w; worstLen = lines[k].length; }
            }
            if (worst <= avail || budget <= 1) return lines;

            let next;
            if (attempt === WRAP_REFIT_ATTEMPTS - 1 && maxCharWidth > 0) {
                next = Math.floor(avail / maxCharWidth);       // provably-fitting budget
            } else {
                next = Math.floor(worstLen * (avail / worst));  // proportional estimate
            }
            budget = Math.max(1, Math.min(budget - 1, next));
            lines = wrapText(text, budget);
        }
        return lines;
    }

    /**
     * Decide header semantics for the fast path:
     *   hasHeader === true  -> row 0 is the header
     *   hasHeader === false -> all rows are data
     *   absent              -> existing detectHeader heuristic
     * @returns {{ headerRow: (string[]|null), dataStartRow: number }}
     */
    function resolveHeader(data, csvOptions) {
        let hasHeader;
        if (csvOptions && typeof csvOptions.hasHeader === 'boolean') {
            hasHeader = csvOptions.hasHeader;
        } else {
            hasHeader = detectHeader(data);
        }
        if (hasHeader && data.length >= 1) {
            return { headerRow: data[0], dataStartRow: 1 };
        }
        return { headerRow: null, dataStartRow: 0 };
    }

    /**
     * Yield control to prevent browser freeze during long operations
     */
    function yieldControl() {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    /**
     * Draw the document header block (title, metadata, notices) on band 0/page 1.
     * @returns {number} the new y cursor.
     */
    function drawDocumentHeader(doc, filename, rowCount, maxCols, notices, contentWidth, y, fonts) {
        doc.setFontSize(12);
        applyFont(doc, fonts, 'bold');
        doc.setTextColor(0, 0, 0);
        const title = filename ? filename.replace(/\.[^/.]+$/, '') : 'CSV Data';
        doc.text(title, CONFIG.pageMargin, y);
        y += 20;

        doc.setFontSize(8);
        applyFont(doc, fonts, 'normal');
        doc.setTextColor(128, 128, 128);
        doc.text(`${rowCount.toLocaleString()} rows, ${maxCols} columns`, CONFIG.pageMargin, y);
        y += 15;

        if (notices && notices.length > 0) {
            doc.setTextColor(150, 90, 0);
            for (const n of notices) {
                const text = 'Note: ' + n;
                const wrapped = doc.splitTextToSize ? doc.splitTextToSize(text, contentWidth) : [text];
                for (const wl of wrapped) {
                    doc.text(wl, CONFIG.pageMargin, y);
                    y += 11;
                }
            }
            y += 4;
        }
        doc.setTextColor(0, 0, 0);
        return y;
    }

    /**
     * Draw one horizontal slice of a (possibly multi-line) row: for each cell in
     * the band, render its wrapped lines [lineStart, lineStart+linesInChunk).
     * Handles the header fill/border and the light data gridlines. When `cells`
     * is null the row is single-line and drawn directly from `rawRow`.
     * @returns {number} the new y cursor.
     */
    function drawRowChunk(doc, cells, rawRow, band, colWidths, y, lineStart, linesInChunk, isHeader, startX, fonts) {
        const fontSize = isHeader ? CONFIG.headerFontSize : CONFIG.fontSize;
        const lineHeight = fontSize + 2;
        const chunkHeight = linesInChunk * lineHeight + CONFIG.cellPadding * 2;

        let bandWidth = 0;
        for (let i = band.start; i < band.end; i++) bandWidth += colWidths[i];

        if (isHeader) {
            doc.setFillColor(230, 230, 230);
            doc.rect(startX, y, bandWidth, chunkHeight, 'F');
            doc.setDrawColor(180, 180, 180);
            doc.rect(startX, y, bandWidth, chunkHeight, 'S');
        }

        doc.setFontSize(fontSize);
        applyFont(doc, fonts, isHeader ? 'bold' : 'normal');

        const firstBaseline = y + CONFIG.cellPadding + fontSize * 0.8;
        let x = startX;
        for (let i = band.start; i < band.end; i++) {
            const cellLines = cells ? cells[i - band.start] : null;
            for (let ln = 0; ln < linesInChunk; ln++) {
                const lineIdx = lineStart + ln;
                let text;
                if (cellLines) {
                    text = lineIdx < cellLines.length ? cellLines[lineIdx] : '';
                } else {
                    text = lineIdx === 0 ? (rawRow[i] == null ? '' : String(rawRow[i])) : '';
                }
                if (text) {
                    drawTextRuns(doc, text, x + CONFIG.cellPadding,
                                 firstBaseline + ln * lineHeight, fonts,
                                 isHeader ? 'bold' : 'normal');
                }
            }
            x += colWidths[i];
        }

        if (!isHeader && CONFIG.drawBorders) {
            doc.setDrawColor(200, 200, 200);
            doc.setLineWidth(0.25);
            doc.line(startX, y + chunkHeight, startX + bandWidth, y + chunkHeight);
            let vx = startX;
            for (let i = band.start; i <= band.end; i++) {
                doc.line(vx, y, vx, y + chunkHeight);
                if (i < band.end) vx += colWidths[i];
            }
        }

        return y + chunkHeight;
    }

    /**
     * Generate PDF from parsed CSV data — renders ALL columns and full cell text.
     * Wide tables are split into horizontal bands (Calc-style "down, then
     * across"); long cells wrap; rows taller than a page split across pages.
     * No silent column/cell truncation. Uses chunked async yielding for large
     * files to prevent browser freeze.
     * @param {object} [meta] - { maxCols, warnings, csvOptions, hasNonAscii, creationDate }
     */
    async function generatePDF(data, filename, onProgress, meta) {
        meta = meta || {};
        const maxCols = meta.maxCols || (data[0]?.length || 0);
        const colWidest = meta.colWidest || null;   // true widest cell per column (all rows)
        const warnings = meta.warnings || [];
        const csvOptions = meta.csvOptions || null;

        // Load jsPDF dynamically if not already loaded
        if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
            await loadJsPDF();
        }

        const jsPDF = window.jspdf?.jsPDF || window.jsPDF;
        if (!jsPDF) {
            throw new Error('jsPDF library not available');
        }

        // Orientation from the true column count (not row 0).
        const orientation = maxCols > 6 ? 'landscape' : 'portrait';
        // BUG-11: a CSV declares no page size, so this path has to pick one —
        // and it hardcoded 'letter', consulting no locale at all. This is the
        // one place BUG-11 was a REAL product bug rather than an artefact of
        // the harness that reported it: the engine already follows the browser
        // locale, so a German user's TXT came out A4 while their CSV came out
        // Letter. It is also the path MOST csv users take — everything under
        // CSV_FAST_PATH_MAX_BYTES is rendered here and never reaches WASM. Uses the same single
        // decision function as the engine path, so the two cannot disagree.
        // The format locale does not apply here: cells are printed as written.
        const paperFormat = ConversionProtocol.resolveBrowserConversionSettings().paperSize;
        const doc = new jsPDF({ orientation, unit: 'pt', format: paperFormat, compress: true });
        // Conversion time (docs/design/conversion-time.md §7, N7: one "now" for
        // the whole output, this path included). jsPDF stamps /CreationDate from
        // `new Date()`, which no worker pin can reach — this runs on the main
        // thread — so set it to the conversion time explicitly. A Date, not a
        // string: jsPDF's string form only accepts 1970-2037. It is written as
        // local wall time + this computer's offset, the engine's own rule (§2).
        if (meta.creationDate) doc.setCreationDate(meta.creationDate);

        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const contentWidth = pageWidth - CONFIG.pageMargin * 2;
        const pageBottom = pageHeight - CONFIG.pageMargin;
        const contentHeight = pageHeight - CONFIG.pageMargin * 2;

        // BUG-15: pick the text font BEFORE laying out — the font decides the
        // metrics. Pure-ASCII data keeps helvetica and the tuned constants.
        const text = await prepareTextRendering(
            doc, data, meta.hasNonAscii, warnings.map(w => w.message).join(' '));
        const fonts = text.fonts;
        const metrics = text.metrics;
        const allWarnings = warnings.concat(text.warnings);

        // Uncovered glyphs become a visible box BEFORE anything measures the
        // text, not at draw time. A box has real width where a dropped glyph has
        // none, so substituting after layout would size every affected column
        // from text that is not what gets drawn — the difference showing up as
        // extra wrapping, which is exactly the defect class recorded in
        // bugs/csv_fast_path_column_widths_sample_too_few_rows.md.
        //
        // colWidest is substituted too, and must be: it is the per-column width
        // bound, and if it still held the un-substituted string the bound would
        // be computed from ~zero-width glyphs while the page drew boxes.
        if (text.missing && text.missing.size) {
            substituteInPlace(data, colWidest, text.missing);
        }

        // Header semantics first: the header row is drawn 11 pt bold, so column
        // widths cannot be computed without knowing which row it is (C1).
        const { headerRow, dataStartRow } = resolveHeader(data, csvOptions);

        // Layout: column widths + horizontal bands.
        // FF-7: Always wrap ('wrap', what a caller without a mode gets) is the original layout; 'auto' and 'nowrap' keep values whole (see
        // computeScaledLayout) and scale the page down, never below the minimum text size.
        const mode = (meta.longValues === 'auto' || meta.longValues === 'nowrap') ? meta.longValues : 'wrap';
        const minFontPt = clampMinFontPt(meta.minFontPt);
        const floorScale = minFontPt / CONFIG.fontSize;
        const layout = computeColumnLayout(data, maxCols, contentWidth, metrics, !!headerRow, colWidest, { mode, floorScale });
        const colWidths = layout.colWidths;
        const bands = layout.bands;
        const layoutWarnings = [];
        if (mode !== 'wrap') {   // values still wider than a page at the smallest size: wrapped inside their column, counted, never cut
            let wide = 0;
            const limit = contentWidth / floorScale;
            for (const col of layout.wrapColumns || []) {
                for (let r = dataStartRow; r < data.length; r++) {
                    const t = data[r] && data[r][col];
                    if (!t || (mode === 'auto' && !isToken(t))) continue;   // Auto: only a token is kept whole; Never wrap: every value is
                    const w = metrics.measure ? Math.max(metrics.measure(t, false), t.length * metrics.charWidth) : t.length * metrics.charWidth;
                    if (w + CONFIG.cellPadding * 2 > limit) wide++;
                }
            }
            if (wide > 0) {
                addWarning(layoutWarnings, 'long-values-wrapped', wide, String(minFontPt));
                addWarning(allWarnings, 'long-values-wrapped', wide, String(minFontPt));
            }
        }

        // Notices: parse/decode/font warnings + (if banding) a reading-order note.
        const notices = allWarnings.map(w => w.message);
        if (bands.length > 1) {
            notices.push(`${maxCols} columns don't fit one page width - columns are split into ${bands.length} page groups; read each group top-to-bottom, then continue with the next column group.`);
        }

        const dataLineHeight = CONFIG.fontSize + 2;
        const dataRowCount = data.length - dataStartRow;
        const totalWorkUnits = Math.max(bands.length * dataRowCount, 1);
        let workDone = 0;
        const renderStartTime = performance.now();

        // FF-7: a band drawn at a scale below 1 is laid out on a virtual page `1/scale` times as big and drawn through one scale transform
        // (see computeScaledLayout), so these are per band; at scale 1 they are the page's own numbers, exactly as before.
        let curScale = 1, curMargin = CONFIG.pageMargin, curPageBottom = pageBottom, curContentHeight = contentHeight;
        let scaleOpen = false;
        const beginScale = () => {   // a transform that keeps the real margins: x' = s*x, y' = H - s*y_virtual
            if (curScale === 1) return;
            doc.internal.write(`q ${curScale.toFixed(6)} 0 0 ${curScale.toFixed(6)} 0 ${(pageHeight * (1 - curScale)).toFixed(4)} cm`);
            scaleOpen = true;
        };
        const endScale = () => { if (scaleOpen) { doc.internal.write('Q'); scaleOpen = false; } };
        const newPage = () => { endScale(); doc.addPage(); beginScale(); };

        function drawHeaderRow(band, y) {
            const m = measureRow(headerRow, band, colWidths, true, metrics);
            return drawRowChunk(doc, m.cells, headerRow, band, colWidths, y, 0, m.lineCount, true, curMargin, fonts);
        }

        let firstPage = true;
        for (let b = 0; b < bands.length; b++) {
            const band = bands[b];
            endScale();
            if (!firstPage) doc.addPage();
            firstPage = false;
            curScale = band.scale || 1;
            curMargin = CONFIG.pageMargin / curScale;
            curPageBottom = curScale === 1 ? pageBottom : (pageHeight - CONFIG.pageMargin) / curScale;
            curContentHeight = curScale === 1 ? contentHeight : contentHeight / curScale;
            let y = CONFIG.pageMargin;

            // Title/metadata/notices on band 0; a small continuation label on later bands.
            if (b === 0) {
                y = drawDocumentHeader(doc, filename, data.length, maxCols, notices, contentWidth, y, fonts);
            } else {
                doc.setFontSize(10);
                applyFont(doc, fonts, 'italic');
                doc.setTextColor(100, 100, 100);
                doc.text(`Columns ${band.start + 1}-${band.end} (continued)`, CONFIG.pageMargin, y);
                doc.setTextColor(0, 0, 0);
                y += 16;
            }
            // the title / label above is drawn at real size; the rows below go through the scale
            if (curScale !== 1) { beginScale(); y = y / curScale; }

            if (headerRow) y = drawHeaderRow(band, y);

            let processedRows = 0;
            for (let r = dataStartRow; r < data.length; r++) {
                const row = data[r];
                const measured = measureRow(row, band, colWidths, false, metrics);
                const rowHeight = measured.lineCount * dataLineHeight + CONFIG.cellPadding * 2;

                // Try to keep a page-sized-or-smaller row together: move it to a
                // fresh page if it won't fit where we are.
                if (rowHeight <= curContentHeight && y + rowHeight > curPageBottom) {
                    newPage();
                    y = curMargin;
                    if (headerRow) y = drawHeaderRow(band, y);
                }

                if (y + rowHeight <= curPageBottom) {
                    // Fits on the current page (H-1: this re-check runs AFTER any
                    // header was redrawn, so a wrapped header + tall data row can no
                    // longer overflow past pageBottom).
                    y = drawRowChunk(doc, measured.cells, row, band, colWidths, y, 0, measured.lineCount, false, curMargin, fonts);
                } else {
                    // Doesn't fit even on a fresh page — either the row is taller than
                    // a full page, or a tall (wrapped) header consumed enough of the
                    // fresh page that the row no longer fits. Split its lines across
                    // pages, computing room from the POST-header y each time (no loss).
                    let lineStart = 0;
                    while (lineStart < measured.lineCount) {
                        if (y + dataLineHeight + CONFIG.cellPadding * 2 > curPageBottom) {
                            newPage();
                            y = curMargin;
                            if (headerRow) y = drawHeaderRow(band, y);
                        }
                        const roomLines = Math.max(1, Math.floor((curPageBottom - y - CONFIG.cellPadding * 2) / dataLineHeight));
                        const chunkLines = Math.min(measured.lineCount - lineStart, roomLines);
                        y = drawRowChunk(doc, measured.cells, row, band, colWidths, y, lineStart, chunkLines, false, curMargin, fonts);
                        lineStart += chunkLines;
                    }
                }

                processedRows++;
                workDone++;

                if (processedRows % CONFIG.chunkSize === 0) {
                    const percent = Math.round((workDone / totalWorkUnits) * 100);
                    if (percent % 10 === 0 && percent > 0) {
                        console.log(`[CSV] Rendering: ${percent}% (${workDone.toLocaleString()} row-bands)`);
                    }
                    if (onProgress) {
                        onProgress({ stage: 'rendering', percent: 50 + percent * 0.45, rows: processedRows, totalRows: dataRowCount });
                    }
                    await yieldControl();
                }
            }
        }
        endScale();   // FF-7: the last band's transform is closed before the page numbers are added

        const renderEndTime = performance.now();
        console.log(`[CSV] Rendering complete: ${dataRowCount.toLocaleString()} rows × ${bands.length} band(s) in ${((renderEndTime - renderStartTime) / 1000).toFixed(1)}s`);

        const totalPages = doc.internal.getNumberOfPages();

        // Skip page numbers for large documents (>100 pages) - saves significant time
        if (totalPages <= 100 || CONFIG.drawPageNumbers) {
            if (onProgress) {
                onProgress({ stage: 'finalizing', percent: 96 });
            }
            await yieldControl();

            console.log(`[CSV] Adding page numbers to ${totalPages} pages...`);
            for (let i = 1; i <= totalPages; i++) {
                doc.setPage(i);
                doc.setFontSize(7);
                applyFont(doc, fonts, 'normal');
                doc.setTextColor(150, 150, 150);
                doc.text(
                    `Page ${i} of ${totalPages}`,
                    pageWidth / 2,
                    pageHeight - 15,
                    { align: 'center' }
                );

                // Yield every 200 pages
                if (i % 200 === 0) {
                    await yieldControl();
                }
            }
        } else {
            console.log(`[CSV] Skipping page numbers for ${totalPages} pages (performance optimization)`);
        }

        if (onProgress) {
            onProgress({ stage: 'generating', percent: 98 });
        }
        await yieldControl();

        console.log(`[CSV] Generating PDF blob...`);
        const blobStartTime = performance.now();
        const blob = doc.output('blob');
        const blobEndTime = performance.now();
        console.log(`[CSV] Blob generated: ${(blob.size / 1024 / 1024).toFixed(1)}MB in ${((blobEndTime - blobStartTime) / 1000).toFixed(1)}s`);

        // `warnings` here are the ones raised BY rendering (font load/coverage);
        // the caller merges them so they reach the toast and the stats too.
        return { blob, bands: bands.length, warnings: text.warnings.concat(layoutWarnings), font: fonts.family };
    }

    /**
     * Detect if first row is a header
     */
    function detectHeader(data) {
        if (data.length < 2) return false;

        const firstRow = data[0];
        const secondRow = data[1];

        // Check if first row is all strings and second row has numbers
        let firstRowAllStrings = true;
        let secondRowHasNumbers = false;

        for (let i = 0; i < Math.min(firstRow.length, 10); i++) {
            const first = String(firstRow[i] || '');
            const second = String(secondRow[i] || '');

            // Check if first cell looks numeric
            if (/^-?\d+\.?\d*$/.test(first.trim())) {
                firstRowAllStrings = false;
            }

            // Check if second cell is numeric
            if (/^-?\d+\.?\d*$/.test(second.trim())) {
                secondRowHasNumbers = true;
            }
        }

        return firstRowAllStrings && secondRowHasNumbers;
    }

    /**
     * Load jsPDF library dynamically
     */
    async function loadJsPDF() {
        return new Promise((resolve, reject) => {
            // Check if already loaded
            if (window.jspdf || window.jsPDF) {
                resolve();
                return;
            }

            const script = document.createElement('script');
            script.src = 'js/vendor/jspdf.umd.min.js';
            script.onload = () => {
                console.log('[CSV] jsPDF loaded');
                resolve();
            };
            script.onerror = () => {
                reject(new Error('Failed to load jsPDF'));
            };
            document.head.appendChild(script);
        });
    }

    /**
     * Dispatch a user-facing warning event (WP3 can attach a toast). Guarded
     * so the parser stays usable in Node unit tests.
     */
    function dispatchWarnings(filename, warnings) {
        if (!warnings || warnings.length === 0) return;
        if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
        try {
            // The UI gets the ACTIONABLE form — it is the one place where
            // "pick an encoding in Advanced Options" is something the reader can
            // actually do. The PDF keeps the fact-only `doc` form.
            const uiWarnings = warnings.map((w) => ({
                ...w,
                message: formatWarning(w.code, w.count, w.detail, 'ui'),
            }));
            window.dispatchEvent(new CustomEvent('csv-fast-path-warning', {
                detail: { filename, warnings: uiWarnings }
            }));
        } catch (e) {
            // CustomEvent unavailable — the in-PDF notice already covers the user.
        }
    }

    /**
     * Main conversion function
     * @param {File} file - The CSV file to convert
     * @param {Function} onProgress - Progress callback
     * @param {Object} options - Optional conversion options
     * @param {Object} options.csv - CSV-specific options
     * @param {string} options.csv.delimiter - Delimiter ('auto', '44', '9', '59', '124')
     */
    async function convert(file, onProgress, options = null) {
        const startTime = performance.now();

        // Conversion time (docs/design/conversion-time.md §7, N7), decided by the
        // same function as the worker's so the two paths cannot disagree. A CSV
        // stores no date (§4), so `document` is the computer clock with the
        // fallback flag, `system` is the computer clock, and an explicit value is
        // the instant whose wall time here is the one typed (§5).
        const timeSetting = _P.parseConversionTime(_P.resolveBrowserConversionSettings().conversionTime);
        if (!timeSetting.ok) throw new Error('Invalid conversion time setting: ' + timeSetting.reason);
        const clock = _P.conversionClockOf(timeSetting, null, Date.now());

        if (onProgress) onProgress({ stage: 'reading', percent: 5 });

        // Read raw bytes and decode honoring the requested encoding (BOM sniff,
        // UTF-8-fatal -> Windows-1252 fallback with a user-visible warning).
        const requestedEncoding = options?.csv?.encoding || null;
        const rawBuffer = await file.arrayBuffer();
        const rawBytes = new Uint8Array(rawBuffer);   // FG-047: the resolver's sample
        const decoded = decodeForLayout(rawBuffer, requestedEncoding);
        const content = decoded.text;

        if (onProgress) onProgress({ stage: 'parsing', percent: 15 });

        // Get user-selected delimiter if provided
        const userDelimiter = options?.csv?.delimiter || null;

        // Parse CSV
        const parsed = parseCSV(content, file.name, userDelimiter);
        const data = parsed.data;

        if (!data || data.length === 0) {
            throw new Error('CSV file is empty or could not be parsed');
        }

        // Merge decode warnings (encoding) with parse warnings (structure).
        const warnings = decoded.warnings.concat(parsed.warnings);

        // BUG-15: one cheap native scan of the decoded text decides whether the
        // renderer needs a real Unicode font. Every cell value is a slice of
        // `content`, so this is a complete (and conservative) test — and for the
        // common pure-ASCII file it is the only extra work the fix costs.
        const hasNonAscii = NON_ASCII_RE.test(content);

        // FG-047: hand a file with shaped scripts or emoji to the engine BEFORE any
        // warning is dispatched, so the user sees one conversion, not a fast-path
        // notice followed by an engine result. Same single native scan as above.
        if (hasNonAscii && !(options && options.noEngineHandoff)) {
            const d = engineHandoffDecision(content, rawBytes, data.length, parsed.maxCols);
            if (d.handOff) throw needsEngineError();
            if (d.scripts.length) console.log(`[CSV] Kept on the fast path (${d.reason}); scripts: ${d.scripts.join(', ')}`);
        }

        console.log(`[CSV] Parsed ${data.length.toLocaleString()} rows, ${parsed.maxCols} columns (encoding: ${decoded.encodingUsed})`);

        // Surface warnings to the UI (never console-only for user-affecting issues)
        dispatchWarnings(file.name, warnings);

        if (onProgress) onProgress({ stage: 'rendering', percent: 50 });

        // Generate PDF (complete conversion — no row, column, or cell truncation)
        const pdfResult = await generatePDF(data, file.name, onProgress, {
            maxCols: parsed.maxCols,
            colWidest: parsed.colWidest,
            warnings: warnings,
            csvOptions: options?.csv || null,
            longValues: resolveLongValues(options),
            minFontPt: resolveMinFontPt(options),
            hasNonAscii,
            creationDate: new Date(clock.instant)
        });
        const pdfBlob = pdfResult.blob;

        // Rendering can raise its own user-affecting warnings (font unavailable,
        // characters with no glyph). They are already in the PDF's notice block;
        // surface them to the UI as well — never console-only.
        const renderWarnings = pdfResult.warnings || [];
        if (renderWarnings.length > 0) {
            dispatchWarnings(file.name, renderWarnings);
            for (const w of renderWarnings) warnings.push(w);
        }

        if (onProgress) onProgress({ stage: 'complete', percent: 100 });

        const elapsed = performance.now() - startTime;
        console.log(`[CSV] Fast path complete: ${data.length.toLocaleString()} rows in ${(elapsed / 1000).toFixed(1)}s`);

        return {
            blob: pdfBlob,
            filename: file.name.replace(/\.[^/.]+$/, '.pdf'),
            // The same three fields as the worker's CONVERT_DONE (CONTRACT_VERSION 3).
            conversionTime: clock.conversionTime,
            conversionTimeFallback: clock.fallback,
            conversionTimeOffsetChanged: clock.offsetChanged,
            stats: {
                rows: data.length,
                cols: parsed.maxCols,
                bands: pdfResult.bands,
                timeMs: elapsed,
                method: 'fast-path',
                encoding: decoded.encodingUsed,
                font: pdfResult.font,
                warnings: warnings
            }
        };
    }

    // Public API
    return {
        shouldUseFastPath,
        estimateSize,
        estimateCells,
        estimateSizeOfFile,
        cachedSizeEstimate,
        // FG-171: the driver uses the same detector for CSV/TSV that goes through
        // the engine, so both paths split a file the same way.
        detectDelimiter,
        convert,
        CONFIG,
        // Exposed for unit tests and for M9 detection. Not a stable public API.
        _internals: {
            needsNfc,
            decodeForLayout,
            FAST_PATH_SCRIPTS,
            ENGINE_HANDOFF_MAX_CELLS,
            ENGINE_HANDOFF_MAX_ROWS,
            engineHandoffDecision,
            parseCSVDocument,
            parseCSV,
            detectDelimiter,
            detectHeader,
            decodeBuffer,
            sniffBOM,
            scoreDelimiterCandidate,
            wrapText,
            wrapToWidth,
            computeColumnLayout,
            computeScaledLayout,
            resolveLongValues,
            resolveMinFontPt,
            clampMinFontPt,
            planBands,
            measureRow,
            resolveHeader,
            generatePDF,
            calculateColumnWidths,
            // BUG-15 (Unicode rendering)
            dataHasNonAscii,
            collectNonAsciiCodepoints,
            describeCodepoints,
            scriptOf,
            substituteUncovered,
            substituteInPlace,
            UNCOVERED_STANDIN,
            parseTTFCoverage,
            guardCoverage,
            prepareTextRendering,
            splitFontRuns,
            CJK_FONT_TIERS,
            computeMetrics,
            buildCharWidthTables,
            sumCharWidths,
            applyFont,
            defaultMetrics,
            UNICODE_FONT,
            _resetFontCache() { fontPayloadCache = null; fontCoverageCache = null; }
        }
    };
})();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CSVFastPath;
}
