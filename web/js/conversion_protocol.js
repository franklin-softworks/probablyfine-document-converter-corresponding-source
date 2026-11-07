// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
/**
 * conversion_protocol.js
 * Shared driver <-> worker message protocol: the single definition of every
 * message-type constant exchanged between conversion_driver.js (main thread)
 * and conversion_worker.js (Web Worker), plus pure helpers used by both sides
 * and by node unit tests.
 *
 * Loading it in both contexts (and a conformance unit test) prevents the class
 * of bug in finding H2, where the worker posted `CONVERSION_ERROR` but the
 * driver only handled `CONVERT_ERROR`, silently dropping init failures.
 *
 * Dual environment: attaches to `self` (page + worker) and `module.exports`
 * (node unit tests). No ES modules, matching project style.
 */

const ConversionProtocol = (function() {
    'use strict';

    // Every message `type` exchanged between driver and worker. Keys and values
    // are identical strings so `MSG.CONVERT_ERROR === 'CONVERT_ERROR'`.
    // Note: the sheet-info request/reply round trip was removed (finding M12) —
    // it had no driver-side sender/handler and its C++ backend is now
    // WASM_DEBUG-only. No dead protocol constants remain.
    const MSG = {
        // Driver -> worker
        INIT: 'INIT',
        CONVERT: 'CONVERT',
        SHUTDOWN: 'SHUTDOWN',
        // Worker -> driver
        LOK_READY: 'LOK_READY',
        ERROR: 'ERROR',
        PROGRESS: 'PROGRESS',
        CONVERSION_PROGRESS: 'CONVERSION_PROGRESS',
        CONVERT_DONE: 'CONVERT_DONE',
        CONVERT_ERROR: 'CONVERT_ERROR',
        SHUTDOWN_COMPLETE: 'SHUTDOWN_COMPLETE'
    };

    // ------------------------------------------------------------------
    // Shared helpers — STUBS filled in by later plans in the WP4 protocol
    // group. They are intentionally not wired to any caller yet; each throws
    // loudly (no silent success) so accidental early use is caught. The plan
    // that adds a caller fills the corresponding stub in the same change.
    // ------------------------------------------------------------------

    /**
     * Produce a VFS-safe, ASCII-only extension token from a user file name (H1).
     * Used to stage inputs/outputs at fixed paths (/tmp/input.<ext>) so non-ASCII
     * / special-character filenames (Résumé.docx, budget 50%.docx, notes#1.docx)
     * can never break the VFS write or the C++ file:// URL.
     *
     * Behavior: take the substring after the last '.', lowercase it, keep only
     * [a-z0-9]; if the result is empty or longer than 8 chars, return 'bin'
     * (a >8-char "extension" is almost always a dotted filename with no real
     * extension). Examples: Résumé.docx->docx, archive.tar.gz->gz, noext->bin,
     * .gitignore->bin (gitignore is 9 chars), weird.名前->bin.
     * @param {string} nameOrExt
     * @returns {string}
     */
    function sanitizeExtension(nameOrExt) {
        const s = String(nameOrExt == null ? '' : nameOrExt);
        const dot = s.lastIndexOf('.');
        // No dot => no real extension (e.g. 'noext') => safe default.
        if (dot < 0) return 'bin';
        const cleaned = s.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (cleaned.length === 0 || cleaned.length > 8) return 'bin';
        return cleaned;
    }

    /**
     * Produce a VFS-safe, ASCII-only base name (no directory, no extension) from
     * a user file name, for staging the input under the user's own name (FG-161).
     *
     * LibreOffice computes a document's FILENAME field (DOC/DOCX FILENAME, ODT
     * text:file-name) from the URL it loaded the document from. Staging every
     * input at /tmp/input.<ext> made that field print "input.doc" or
     * "/tmp/input.doc" in the converted output instead of the user's name.
     *
     * The H1 safety idea with a deliberately wider set than sanitizeExtension's
     * [a-z0-9] (a base name needs case, '.', '_' and '-'): only [A-Za-z0-9._-] survive, so a
     * name can never break the VFS write or the C++ file:// URL. Accents are
     * decomposed first (Résumé -> Resume); every other run of characters becomes
     * one '_'; leading/trailing '.', '_', '-' are trimmed; at most 64 characters.
     * A name with no ASCII letter or digit left (e.g. all-Arabic) -> 'document'.
     * Examples: 'Q3 report.docx' -> 'Q3_report', 'Résumé.docx' -> 'Resume',
     * 'C:\\docs\\a.b.doc' -> 'a.b', '名前.docx' -> 'document', '.docx' -> 'document'.
     * @param {string} fileName
     * @returns {string}
     */
    function sanitizeBaseName(fileName) {
        let s = String(fileName == null ? '' : fileName);
        s = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
        const dot = s.lastIndexOf('.');
        if (dot > 0) s = s.slice(0, dot);
        else if (dot === 0) s = '';
        s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        s = s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
        if (!/[A-Za-z0-9]/.test(s)) return 'document';
        return s.slice(0, 64).replace(/[._-]+$/, '');
    }

    /**
     * Decide whether a progress event should reset the conversion stall timer
     * (finding M3). Both `libreoffice-progress` (module/lazy-init phases) and
     * `libreoffice-conversion-progress` (C++ phases) count as liveness, so a slow
     * first-conversion font/init phase no longer trips the 30s stall timeout.
     * A progress event tagged with a *different* module (e.g. a background
     * pre-warm) must NOT mask a real stall for the active module.
     * @param {Object} detail - Event detail (may include `module`)
     * @param {string} activeModuleName - Module of the active conversion
     * @returns {boolean} True if the stall timer should be reset
     */
    function shouldResetStallTimer(detail, activeModuleName) {
        if (!detail) return false;
        if (detail.module && activeModuleName && detail.module !== activeModuleName) return false;
        return true;
    }

    /**
     * Input formats that cannot carry document fonts (#594 WAF F3; owner guidance
     * 2026-10-23: a font that comes from a document lives only for that document's
     * conversion). The engine keeps every font a document registers for the engine's
     * lifetime, so a worker that converted any other input is never reused: an ALLOWLIST,
     * so a new input format defaults to a fresh worker.
     */
    const INPUTS_WITHOUT_DOCUMENT_FONTS = Object.freeze(['txt', 'csv', 'tsv']);

    /**
     * May this input carry fonts of its own (embedded in a PDF, an Office or an ODF file)?
     * True for every format not on the allowlist. An allowlisted extension is believed only
     * when its bytes are plain text, because the engine detects txt/csv/tsv input by CONTENT
     * (a renamed DOCX, RTF, HTML or PDF is opened as what it is). Plain text here means the
     * first 4 KB (the WAF's rule asks for 1 KB; the type detectors read up to 1 KB) are valid
     * UTF-8 with no NUL, carry no BOM other than UTF-8's, and contain none of "<" (HTML, XML,
     * flat ODF), "{\\rtf" or "%PDF". No bytes, or a detached buffer, counts as "may carry".
     * @param {string} extension - input extension, with or without the leading dot
     * @param {Uint8Array|ArrayBuffer} [bytes] - the input (only the first 4 KB are read)
     * @returns {boolean}
     */
    function inputMayCarryDocumentFonts(extension, bytes) {
        const ext = String(extension || '').toLowerCase().replace(/^\./, '');
        if (!INPUTS_WITHOUT_DOCUMENT_FONTS.includes(ext)) return true;
        const SNIFF = 4096;
        const u8 = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, SNIFF))
            : Object.prototype.toString.call(bytes) === '[object ArrayBuffer]' ? new Uint8Array(bytes, 0, Math.min(bytes.byteLength, SNIFF))
                : null;
        if (!u8 || !u8.length) return true;                                 // no bytes (or detached): assume it may
        if ((u8[0] === 0xfe && u8[1] === 0xff) || (u8[0] === 0xff && u8[1] === 0xfe)) return true;   // UTF-16/32 BOM
        if (u8[0] === 0x00 && u8[1] === 0x00 && u8[2] === 0xfe && u8[3] === 0xff) return true;      // UTF-32 BE BOM
        if (u8.includes(0x00)) return true;                                 // NUL: UTF-16/32 or binary (ZIP, OLE)
        // Valid UTF-8. Only when the file runs past the window may its last 1-3 bytes be the
        // start of a character the window cut; a whole file gets no such allowance.
        const truncated = bytes.byteLength > SNIFF;
        let valid = isValidUtf8(u8);
        for (let cut = 1; !valid && truncated && cut <= 3; cut++) valid = isValidUtf8(u8.subarray(0, u8.length - cut));
        if (!valid) return true;
        if (u8.includes(0x3c)) return true;                                 // '<'
        if (indexOfBytes(u8, asciiBytes('{\\rtf'), 0, u8.length) >= 0) return true;
        if (indexOfBytes(u8, asciiBytes('%PDF'), 0, u8.length) >= 0) return true;
        return false;
    }

    // ------------------------------------------------------------------
    // Size-deadline extension (BUG-38; owner decision 2026-10-23, option (a):
    // "Extend the limit while the engine keeps reporting real progress").
    //
    // The size deadline (calculateTimeout + font allowance) still applies. When
    // it is reached, the conversion continues only while REAL engine progress
    // keeps arriving. The rule, exactly: past the size deadline, the conversion
    // is stopped if (phase, position) has not advanced for the no-progress
    // watchdog's interval (30 s for documents), and it is always stopped at the
    // input's existing overall maximum (maxTimeout 600 s; pdfMaxTimeout 1800 s
    // for PDF inputs), which stays a hard cap.
    //
    // Only the engine's own CONVERSION_PROGRESS counts (the bridge's import,
    // layout and export reporting, engine/bridge/wasm_bridge.cpp). Repeated
    // identical ticks do not advance; module-load, lazy-init and per-font
    // progress never extend anything; no timer in the worker or the page does.
    // The no-progress watchdog itself is unchanged.
    // ------------------------------------------------------------------

    const ENGINE_PHASE_ORDER = Object.freeze({ import: 1, layout: 2, export: 3 });
    const ENGINE_STAGE_ORDER = Object.freeze({ LOADING: 1, LOADED: 2, EXPORTING: 3 });

    /**
     * The comparable progress key of one engine CONVERSION_PROGRESS detail, or
     * null when it carries none. Positioned messages (BUG-38 engines) give
     * `{ kind: 'position', major: phase order, minor: position }`; older engines
     * and other modules give `{ kind: 'percent', major: stage order, minor: percent }`.
     * @param {Object} detail - libreoffice-conversion-progress event detail
     * @returns {{kind: string, major: number, minor: number}|null}
     */
    function engineProgressKey(detail) {
        if (!detail) return null;
        const phase = ENGINE_PHASE_ORDER[detail.phase];
        const position = Number(detail.position);
        if (phase && Number.isFinite(position)) {
            return { kind: 'position', major: phase, minor: position };
        }
        const stage = ENGINE_STAGE_ORDER[detail.stage];
        const percent = Number(detail.percent);
        if (stage && Number.isFinite(percent)) {
            return { kind: 'percent', major: stage, minor: percent };
        }
        return null;
    }

    /**
     * Tracks whether engine progress advances, and decides what happens once the
     * size deadline has passed. Pure: the caller passes the clock.
     * @param {Object} cfg
     * @param {number} cfg.startTime - when the conversion started (ms)
     * @param {number} cfg.stallMs - the no-progress watchdog's interval (ms)
     * @param {number} cfg.capMs - the hard cap, from startTime (ms)
     */
    function createDeadlineExtension(cfg) {
        const startTime = Number(cfg.startTime);
        const stallMs = Number(cfg.stallMs);
        const capMs = Number(cfg.capMs);
        const best = { position: null, percent: null };
        let lastAdvance = startTime;

        return {
            /**
             * Record one engine progress detail.
             * @returns {boolean} true if (phase, position) advanced
             */
            noteEngineProgress(detail, now) {
                const key = engineProgressKey(detail);
                if (!key) return false;
                const prev = best[key.kind];
                const advanced = !prev || key.major > prev.major ||
                    (key.major === prev.major && key.minor > prev.minor);
                if (advanced) {
                    best[key.kind] = { major: key.major, minor: key.minor };
                    lastAdvance = now;
                }
                return advanced;
            },
            /**
             * What to do at `now`, once the size deadline has passed:
             * 'continue', 'stalled' (no advance for stallMs) or 'cap' (hard cap reached).
             */
            decide(now) {
                if (now - startTime >= capMs) return 'cap';
                if (now - lastAdvance >= stallMs) return 'stalled';
                return 'continue';
            },
            /** Milliseconds until decide() can next change its answer (>= 1). */
            nextCheckIn(now) {
                const untilStall = lastAdvance + stallMs - now;
                const untilCap = startTime + capMs - now;
                return Math.max(1, Math.min(untilStall, untilCap));
            },
            lastAdvanceTime() { return lastAdvance; }
        };
    }

    /**
     * Is this error a WebAssembly memory-safety trap (BUG-28)?
     *
     * MITIGATION SUPPORT, NOT A FIX. BUG-28 is an unfixed, layout-sensitive memory
     * corruption in PDF-import-into-Writer: a stray write damages linear memory and
     * the trap surfaces wherever the damaged value is next used. It is stochastic —
     * the same file on the same build succeeds on one attempt and traps on the next
     * — so a fresh WASM instance is a genuinely independent try. See
     * `bugs/BUG-28-pdf-import-parser-handoff-crash.md`.
     *
     * The three strings are the complete observed set across ~150 measured runs.
     * They are the WASM runtime's own wording for "an indirect call went through a
     * damaged function-table entry" and "a load/store left linear memory", i.e.
     * conditions that CANNOT be produced by a malformed input document — the engine
     * reports those as ordinary conversion errors. That is what makes retrying safe
     * here and wrong in general.
     *
     * DELIBERATELY NARROW. Retrying an ordinary conversion failure would burn a
     * ~25 MB module load and up to a minute per attempt to fail identically, and
     * would hide real defects behind a slow "sometimes it works". Matching is on
     * the message only; `unreachable` is NOT included, because that is a plain
     * C++ abort (LibreOffice's own assertion path) and is reproducible, not
     * stochastic.
     *
     * @param {Error|{message?:string}|string|null} error
     * @returns {boolean} True if a fresh-instance retry is worth attempting
     */
    var WASM_TRAP_SIGNATURES = [
        'table index is out of bounds',
        'function signature mismatch',
        'memory access out of bounds',
    ];
    function isWasmMemoryTrap(error) {
        if (!error) return false;
        var msg = typeof error === 'string' ? error : (error && error.message);
        if (typeof msg !== 'string' || !msg) return false;
        var lower = msg.toLowerCase();
        for (var i = 0; i < WASM_TRAP_SIGNATURES.length; i++) {
            if (lower.indexOf(WASM_TRAP_SIGNATURES[i]) !== -1) return true;
        }
        return false;
    }

    /**
     * Map UI CSV options to the arguments for the C++ convert_csv_with_options()
     * (finding H7). Pure and node-testable.
     *  - delimiter: 'auto'/null -> 0 (auto-detect); else the ASCII code
     *    ('44'|'9'|'59'|'124'); garbage -> 0 (NaN guard).
     *  - encoding: 'UTF-8' (default) | 'ISO-8859-1' | 'Windows-1252'.
     *  - startRow: ALWAYS 1 — the header row is NEVER skipped (project principle:
     *    complete conversions only). The "Header row" checkbox is a fast-path
     *    rendering feature (styled/repeated header, plan C4); LibreOffice CSV
     *    import cannot style a header without dropping it, so the WASM path always
     *    renders the header as the first data row regardless of hasHeader. Setting
     *    startRow=2 would DELETE the header (data loss) — hence it stays 1.
     * @param {Object} csvOpts
     * @returns {{delimiter:number, encoding:string, startRow:number}}
     */
    /**
     * Target format for the staged Advanced-Options convert.
     *
     * Lives here, not in ui-v2.js, because ui-v2 self-initialises against a real
     * DOM and cannot be required in a unit test — which is precisely how the bug
     * this guards survived. ui-v2 hardcoded `startConversion(file, 'pdf')`, so
     * the Advanced format grid tracked a selection that nothing ever read:
     * choosing DOCX produced a PDF, silently.
     *
     * A null/empty/non-string selection means the user picked nothing, and PDF is
     * both the documented default and the previous behaviour for that case.
     * Non-strings are coerced too because startConversion() calls
     * `targetFormat.toUpperCase()` for its progress label.
     * @param {string|null} selected - FormatSelector.getSelectedFormat()
     * @returns {string}
     */
    function resolveStagedTargetFormat(selected) {
        return (typeof selected === 'string' && selected) ? selected : 'pdf';
    }

    /**
     * Option-attachment policy (H6/H-2/FF-1 3b-full): decide whether a set of
     * UI-read options is "non-default" and therefore must be attached to the
     * conversion request, or is untouched and should be omitted so the request
     * stays on the plain/fast conversion route (byte-identical to no options at
     * all). Moved out of ui-v2.js's buildConversionOptions so the CONTRACT —
     * which fields count as "touched" — is pinned by a node test instead of
     * only by reading the DOM-coupled function that also decides panel
     * visibility. ui-v2.js still owns reading values out of the DOM panels and
     * validating free text (isValidPageRange/isValidPrintArea); these functions
     * only answer "given already-read values, is this default or not".
     *
     * All three intentionally return a boolean, not the options object itself:
     * the caller already has the (possibly just-sanitized, e.g. an invalid page
     * range blanked to '') values in hand and knows what shape to attach.
     */

    /**
     * @param {{pageRange?: string, quality?: number, maxImageResolution?: number}} pdfOpts
     * @returns {boolean} true if ANY field is non-default (attach `options.pdf`)
     */
    function isNonDefaultPdfOptions(pdfOpts) {
        const o = pdfOpts || {};
        return !!(o.pageRange || o.quality || o.maxImageResolution);
    }

    /**
     * @param {{sheetIndex?: number, printArea?: string}} sheetOpts
     * @returns {boolean} true if a specific sheet or a print area was chosen
     *   (attach `options.sheetIndex`/`options.printArea`); sheetIndex -1 means
     *   "all sheets", the default.
     */
    function isNonDefaultSheetOptions(sheetOpts) {
        const o = sheetOpts || {};
        return o.sheetIndex !== -1 || !!o.printArea;
    }

    /**
     * @param {{delimiter?: string, encoding?: string, hasHeader?: boolean}} csvOpts
     * @returns {boolean} true if any field is non-default (attach `options.csv`).
     *   hasHeader is TRI-STATE: 'auto'/undefined (untouched) stays on the
     *   auto-detect path; an EXPLICIT boolean — true OR false — is a deliberate
     *   choice and must be honored, so `typeof hasHeader === 'boolean'` is the
     *   test, not `hasHeader === true` (H-2).
     */
    function isNonDefaultCsvOptions(csvOpts) {
        const o = csvOpts || {};
        return o.delimiter !== 'auto' || o.encoding !== 'UTF-8'
            || typeof o.hasHeader === 'boolean';
    }

    function csvOptionsToBridgeArgs(csvOpts) {
        const o = csvOpts || {};
        const delimiter = (o.delimiter === 'auto' || o.delimiter == null)
            ? 0
            : parseInt(o.delimiter, 10);
        const encoding = o.encoding || 'UTF-8';
        const startRow = 1; // header preserved; see note above
        return { delimiter: Number.isNaN(delimiter) ? 0 : delimiter, encoding, startRow };
    }

    // ------------------------------------------------------------------------
    // Plain sentences for engine refusals: raw engine text never reaches a user.
    //
    // A file the engine cannot read used to show the user "Error: LOAD_FAILED: Failed to load document (LOK:
    // loadComponentFromURL returned an empty reference)", "RuntimeError: null function" or "[object
    // WebAssembly.Exception]". The machine code stays in the protocol (err.code, err.message are untouched, for the MCP and
    // the console); the page asks userMessageFor() for the text it shows. A message that is not engine text (every sentence
    // this code base writes for a user) passes through exactly as it was.
    // ------------------------------------------------------------------------
    // one contraction style throughout (the code base's user sentences use them: "can't", "isn't"); each sentence has a next step
    const USER_TEXT_LOAD_FAILED = "The converter couldn't open this file. It may be damaged, or it may not be the kind of file its name says. " +
        'Check that it opens in the app that made it, then save a fresh copy and try again.';
    const USER_TEXT_EXPORT_FAILED = "The converter opened this file but couldn't create the result. Try a different output format, or save a fresh copy of the file and try again.";
    // A trap is not necessarily a bad file: it can be our own defect (BUG-28 on valid PDFs), so this never says the file is damaged.
    const USER_TEXT_ENGINE_STOPPED = 'The converter stopped unexpectedly while processing this file. Please try again. If it happens again, save a fresh copy of the file and try that.';
    const USER_TEXT_BAD_REQUEST = "The converter couldn't process this file with these settings. Please check the options and try again.";
    const USER_TEXT_INTERNAL = "The converter couldn't process this file. Please reload the page and try again.";
    const CONVERSION_FAILED_TEXT = 'Conversion failed. Please try again.';
    // The note the driver appends to an engine refusal of a PDF that has an /Encrypt entry. ONE constant: the driver appends it and
    // userMessageFor recognises it by the same text.
    const ENCRYPTED_PDF_HINT = "This PDF is encrypted and may need a password, which the converter can't use yet: " +
        'if it asks for one when you open it, save a copy without a password and drop that copy here.';
    const RAW_TRAP = /RuntimeError|WebAssembly\.|\[object [A-Za-z.]*Exception\]|\bnull function\b|memory access out of bounds|function signature mismatch|table index is out of bounds|Aborted\(/;
    const RAW_CODE_PREFIX = /^(?:[A-Za-z]*Error: )?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):/;

    /**
     * The sentence to show a user for a conversion error. Pure.
     * @param {Error|string|null} err - an error (or its message) from a conversion
     * @returns {string}
     */
    function userMessageFor(err) {
        const msg = typeof err === 'string' ? err : String((err && err.message) || '');
        if (!msg) return CONVERSION_FAILED_TEXT;
        // the authored encrypted-PDF note appended to an engine refusal is a sentence for the user: keep it (one shared constant)
        const tail = msg.indexOf(ENCRYPTED_PDF_HINT) >= 0 ? ' ' + ENCRYPTED_PDF_HINT : '';
        const m = RAW_CODE_PREFIX.exec(msg);
        const code = m ? m[1] : null;
        if (/LOAD_FAILED/.test(msg)) return USER_TEXT_LOAD_FAILED + tail;
        if (/EXPORT_FAILED/.test(msg)) return USER_TEXT_EXPORT_FAILED + tail;
        if (RAW_TRAP.test(msg)) return USER_TEXT_ENGINE_STOPPED + tail;
        if (code === 'INVALID_PARAM') return USER_TEXT_BAD_REQUEST;
        if (code === 'INPUT_MISSING' || code === 'INIT_FAILED' || code === 'INTERNAL_ERROR') return USER_TEXT_INTERNAL;
        return msg;
    }

    // ------------------------------------------------------------------------
    // BUG-65: a file that is not a document must not "convert successfully".
    //
    // Given a typed filter it cannot satisfy, LibreOfficeKit quietly falls back to its TEXT importer for the Writer family and
    // for PDF, so random bytes, a zero-byte file, one byte and plain text named .odt/.docx/.doc/.rtf/.pdf came out as a PDF or
    // DOCX (noise as hundreds of KB of garbled text, a zero-byte file as a blank page). The worker checks the bytes BEFORE the
    // engine and refuses with NOT_A_DOCUMENT. The rule looks at the container only, never at the content, so a damaged but real
    // document still goes to the engine (which recovers what it can). Measured on the corpus and the 256-case matrix in
    // bugs/not_a_document_converts.md. Nothing is decided for txt, csv, tsv, html (any bytes are text there).
    // ------------------------------------------------------------------------
    const SANITY_NAMES = {
        docx: 'a Word document', docm: 'a Word document', dotx: 'a Word template', doc: 'a Word 97-2003 document', rtf: 'an RTF document',
        odt: 'an OpenDocument text file', xlsx: 'an Excel workbook', xlsm: 'an Excel workbook', xltx: 'an Excel template',
        xls: 'an Excel 97-2003 workbook', ods: 'an OpenDocument spreadsheet', pptx: 'a PowerPoint presentation',
        ppt: 'a PowerPoint 97-2003 presentation', odp: 'an OpenDocument presentation', pdf: 'a PDF'
    };
    // Every other covered type (the zip-based formats, ppt, pdf) must be a recognised container: plain text and noise are refused.
    // These formats' Office application also opens plain text (Word: .doc/.rtf; Excel: .xls as text/CSV/HTML):
    const SANITY_TEXT_OK = new Set(['doc', 'rtf', 'xls']);

    function leadIndex(u8) {
        let i = 0;
        if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) i = 3;
        while (i < u8.length && i < 1024 && (u8[i] === 0x20 || u8[i] === 0x09 || u8[i] === 0x0a || u8[i] === 0x0d)) i++;
        return i;
    }

    /**
     * Old word processors whose files are still named .doc and are real documents: Word 2.0 for Windows (0xDB 0xA5), Word for
     * DOS and Word 1.x-5.x (0x31 0xBE and 0x32 0xBE) and WordPerfect (0xFF 'WPC'). Whether or not the engine imports them, it
     * gets to try, as before, and fails with its own code if it cannot: the sanity check must never call a genuine document
     * "not a document". (Other old word processors: FF-6.)
     */
    function isLegacyWordProcessor(u8) {
        if (u8.length >= 2 && u8[0] === 0xdb && u8[1] === 0xa5) return true;                                           // Word 2.0
        if (u8.length >= 2 && (u8[0] === 0x31 || u8[0] === 0x32) && u8[1] === 0xbe) return true;                      // Word for DOS, Word 1.x-5.x
        if (u8.length >= 4 && u8[0] === 0xff && u8[1] === 0x57 && u8[2] === 0x50 && u8[3] === 0x43) return true;      // WordPerfect
        return false;
    }

    /** ZIP, OLE2, RTF, PDF or XML/HTML: a container the engine reads by its content, whatever the file is called. */
    function isRecognisedContainer(u8) {
        if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) return true;      // ZIP
        if (u8.length >= 8 && CFB_MAGIC.every((b, i) => u8[i] === b)) return true;                                    // OLE2
        if (indexOfBytes(u8, asciiBytes('%PDF-'), 0, Math.min(u8.length, 1024)) >= 0) return true;                   // PDF
        const lead = leadIndex(u8);
        if (matchesAt(u8, asciiBytes('{\\rtf'), lead)) return true;                                                     // RTF
        if (u8[lead] === 0x3c) return isTextLike(u8);                                                                  // '<': XML, HTML, flat ODF (and it must be text: random bytes start with '<' 1 time in 256)
        return false;
    }

    /** Is this plain text (UTF-16, or fewer than 2% control bytes in the first 4 KB)? Random bytes are over 10%. */
    function isTextLike(u8) {
        const bom = sniffBOM(u8);
        if (bom === 'utf-16le' || bom === 'utf-16be') return true;
        if (sniffUtf16WithoutBom(u8, { allowValidUtf8: true })) return true;
        const n = Math.min(u8.length, 4096);
        if (n === 0) return true;
        let ctl = 0;
        for (let i = 0; i < n; i++) {
            const c = u8[i];
            if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 12 && c !== 13) || c === 127) ctl++;
        }
        return ctl / n < 0.02;
    }

    /**
     * BUG-65: is this input obviously not the kind of file its name says? null when the engine should be asked, else
     * {code: 'NOT_A_DOCUMENT', reason: 'empty' | 'not-this-type', ext, message} (the message is the sentence to show the user;
     * it names the type and never any content of the file). Reads the first 1 KB and a 4 KB sample only.
     * @param {Uint8Array|ArrayBuffer} bytes
     * @param {string} ext - the declared extension ('docx', '.docx' or a file name)
     */
    function inputSanityError(bytes, ext) {
        const e = String(ext == null ? '' : ext).toLowerCase().replace(/^.*\./, '');
        const label = SANITY_NAMES[e];
        if (!label) return null;                                           // txt, csv, tsv, html and anything else: no opinion
        const u8 = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : Object.prototype.toString.call(bytes) === '[object ArrayBuffer]' ? new Uint8Array(bytes) : null;
        if (!u8) return null;
        if (u8.length === 0) {
            return { code: 'NOT_A_DOCUMENT', reason: 'empty', ext: e, message: 'This file is empty (0 bytes), so there is nothing to convert.' };
        }
        let ok;
        if (e === 'pdf') ok = indexOfBytes(u8, asciiBytes('%PDF-'), 0, Math.min(u8.length, 1024)) >= 0;
        else if (e === 'ppt') ok = (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04)
            || (u8.length >= 8 && CFB_MAGIC.every((b, i) => u8[i] === b));
        else if (isRecognisedContainer(u8)) ok = true;
        else if (e === 'doc' && isLegacyWordProcessor(u8)) ok = true;
        else if (e === 'xls' && u8.length >= 2 && u8[0] === 0x09 && (u8[1] === 0x00 || u8[1] === 0x02 || u8[1] === 0x04 || u8[1] === 0x08)) ok = true;   // BIFF2-4
        else ok = SANITY_TEXT_OK.has(e) && isTextLike(u8);
        if (ok) return null;
        return {
            code: 'NOT_A_DOCUMENT', reason: 'not-this-type', ext: e,
            message: "This file isn't " + label + " (." + e + "): it doesn't start the way one does, so it may be damaged or have the wrong file name. " +
                "If it's plain text, rename it to .txt."
        };
    }

    // ------------------------------------------------------------------------
    // BUG-70: the engine path must not silently drop rows or columns.
    //
    // Calc holds at most 1,048,576 rows and 16,384 columns per sheet. A CSV/TSV with more is read up to the limit and the
    // rest is DROPPED with no error (a 1,100,000-row file came out with 1,048,576 rows, 51,425 rows lost). "Complete
    // conversions only": the worker counts the rows and the widest row BEFORE the file reaches the engine and refuses, with
    // a specific code, when either limit would be passed. Splitting across sheets is a future feature, not this.
    // The same count runs in the MCP (it runs this worker), so both surfaces refuse the same files.
    // ------------------------------------------------------------------------
    /**
     * The target format as the engine bridge compares it. The bridge keys on exact lower-case names ("pdf", "xlsx", ...), so a
     * host that sends "PDF" (the MCP builds its own CONVERT) used to get the WRONG branch silently: the exact-text CSV import
     * and the PDF-only choices all key on "pdf" (WAF nit on #715). Lower-cases a string; anything else is returned as it came.
     */
    function normalizeTargetFormat(targetFormat) {
        return typeof targetFormat === 'string' ? targetFormat.toLowerCase() : targetFormat;
    }

    const ENGINE_MAX_ROWS = 1048576;
    const ENGINE_MAX_COLS = 16384;

    /**
     * Count the records (rows) and the widest record (fields) of delimited text, as Calc's CSV import reads them. Works on the
     * BYTES (the delimiter, the quote and the line ends are ASCII in every encoding offered, and in UTF-16 each is still found
     * as its own byte), so no decoding and no byte-as-string hazards.
     *  - a record ends at LF, CR or CRLF outside quotes; a blank line is a record (Calc keeps it as an empty row);
     *    a final line end does not start another record
     *  - a quote opens a quoted field only at the START of a field; "" inside quotes is one literal quote
     *  - a delimiter or a line end inside a quoted field is content
     * @param {Uint8Array} bytes
     * @param {number} delimiter - the field separator's byte
     * @param {number} [quote=34]
     * @returns {{rows: number, maxCols: number}}
     */
    function delimitedExtent(bytes, delimiter, quote) {
        const D = delimiter, Q = quote === undefined ? 34 : quote;
        const n = bytes.length;
        let rows = 0, maxCols = 0, cols = 1, i = 0;
        let atFieldStart = true, inQuote = false, openRecord = false;
        while (i < n) {
            const b = bytes[i];
            if (inQuote) {
                if (b === Q) {
                    if (i + 1 < n && bytes[i + 1] === Q) { i += 2; continue; }
                    inQuote = false;
                }
                i++;
                continue;
            }
            if (b === 10 || b === 13) {
                rows++;
                if (cols > maxCols) maxCols = cols;
                cols = 1; atFieldStart = true; openRecord = false;
                if (b === 13 && i + 1 < n && bytes[i + 1] === 10) i++;
                i++;
                continue;
            }
            openRecord = true;
            if (b === D) { cols++; atFieldStart = true; i++; continue; }
            if (atFieldStart && b === Q) { inQuote = true; atFieldStart = false; i++; continue; }
            atFieldStart = false;
            i++;
        }
        if (openRecord) { rows++; if (cols > maxCols) maxCols = cols; }
        return { rows, maxCols };
    }

    /**
     * The bytes a delimiter or limit scan reads: a UTF-8 or UTF-16 byte-order mark dropped, and UTF-16 (by its BOM, or by the
     * parity of its NUL bytes) folded to one byte per character, so a character above U+00FF becomes a filler (1) that is none
     * of the special bytes. The scans only have to keep the delimiter, the quote, the line ends and the field starts where they
     * were. Anything else is returned as it came.
     */
    function scanBytesOf(bytes) {
        const bom = sniffBOM(bytes);
        if (bom === 'utf-8') return bytes.subarray(3);
        let u16 = bom === 'utf-16le' || bom === 'utf-16be' ? bom : null;
        if (!u16) {
            const g = sniffUtf16WithoutBom(bytes, { allowValidUtf8: true });
            u16 = g === 'utf-16le' || g === 'utf-16be' ? g : null;
        }
        if (!u16) return bytes;
        const le = u16 === 'utf-16le';
        const first = bom ? 1 : 0;                       // the BOM is one unit
        const n = (bytes.length >> 1) - first;
        const folded = new Uint8Array(Math.max(0, n));
        for (let i = 0; i < n; i++) {
            const at = 2 * (i + first);
            const lo = le ? bytes[at] : bytes[at + 1], hi = le ? bytes[at + 1] : bytes[at];
            folded[i] = hi === 0 ? lo : 1;
        }
        return folded;
    }

    /**
     * CB-012: THE delimiter detector for the engine path. The bridge's "auto" (delimiter 0) is an EMPTY separator that Calc
     * does not resolve: every row comes out as one column. The website's driver resolved it before the worker (FG-171), but a
     * host that calls the worker directly (the MCP) never did. So the worker resolves it, here, with the fast path's own rule
     * (csv_fast_path.js detectDelimiter), on bytes: parse the first 10 non-blank rows of a 64 KB sample with each of
     * , TAB ; | (quote-aware), score by how consistent the field counts are (dominant), then column count, minus a penalty
     * for quote trouble; ties go in that order; a .tsv is a tab; no delimiter at all is a comma.
     * @param {Uint8Array} bytes
     * @param {string} ext - 'csv' or 'tsv'
     * @returns {number} a delimiter byte (44, 9, 59 or 124), never 0
     */
    function detectCsvDelimiterCode(bytes, ext) {
        if (String(ext || '').toLowerCase() === 'tsv') return 9;
        return detectDelimiterOnScanBytes(scanBytesOf(bytes));
    }

    function detectDelimiterOnScanBytes(all) {
        const LIMIT = 65536;
        const truncated = all.length > LIMIT;
        const sample = truncated ? all.subarray(0, LIMIT) : all;
        let best = 44, bestScore = -Infinity, bestCols = 0;
        for (const cand of [44, 9, 59, 124]) {
            const res = sampleFieldCounts(sample, cand, 10);
            if (truncated && res.lastRowEndedAtEOF && res.counts.length > 1) res.counts.pop();
            const score = scoreFieldCounts(res.counts, res.warnings);
            if (score > bestScore) {
                bestScore = score;
                best = cand;
                bestCols = modeOf(res.counts);
            }
        }
        return bestCols < 2 ? 44 : best;
    }

    function modeOf(counts) {
        const freq = new Map();
        for (const n of counts) freq.set(n, (freq.get(n) || 0) + 1);
        let mode = 0, modeFreq = 0;
        // ascending field count, the first to reach the top frequency wins (an object's integer keys, as the fast path iterates)
        for (const k of [...freq.keys()].sort((x, y) => x - y)) if (freq.get(k) > modeFreq) { modeFreq = freq.get(k); mode = k; }
        return mode;
    }

    function scoreFieldCounts(counts, warnings) {
        if (counts.length === 0) return -Infinity;
        const freq = new Map();
        for (const n of counts) freq.set(n, (freq.get(n) || 0) + 1);
        let modeFreq = 0;
        for (const v of freq.values()) if (v > modeFreq) modeFreq = v;
        const cols = modeOf(counts);
        return (modeFreq / counts.length) * 10 + Math.min(cols, 20) * 0.5 - (cols < 2 ? 4 : 0) - 2 * warnings;
    }

    /**
     * The field count of each of the first `maxRows` non-blank records, read the way the fast path's parser reads them: a quote
     * opens a quoted field only at a field start; "" is a literal quote; after the closing quote any text up to the next
     * delimiter or line end belongs to the field (a warning); an unterminated quote swallows the rest (a warning); a record
     * that is one empty or white-space field is skipped.
     * @returns {{counts: number[], warnings: number, lastRowEndedAtEOF: boolean}} warnings = DISTINCT kinds, as the fast path counts
     */
    function sampleFieldCounts(b, D, maxRows) {
        const len = b.length;
        const counts = [];
        const warned = new Set();
        let pos = 0, lastRowEndedAtEOF = false, hitEofInQuote = false;
        const isWs = (c) => c === 32 || (c >= 9 && c <= 13);
        while (pos < len) {
            let count = 0, firstBlank = false, rowDone = false, rowEndedAtEOF = false;
            while (!rowDone) {
                let nonWs = false;
                if (b[pos] === 34) {
                    pos++;
                    for (;;) {
                        let q = pos;
                        while (q < len && b[q] !== 34) { if (!isWs(b[q])) nonWs = true; q++; }
                        if (q >= len) { pos = len; warned.add('unterminated-quote'); hitEofInQuote = true; break; }
                        if (q + 1 < len && b[q + 1] === 34) { nonWs = true; pos = q + 2; }
                        else { pos = q + 1; break; }
                    }
                    if (!hitEofInQuote) {
                        const extraStart = pos;
                        while (pos < len && b[pos] !== D && b[pos] !== 13 && b[pos] !== 10) { if (!isWs(b[pos])) nonWs = true; pos++; }
                        if (pos > extraStart) warned.add('text-after-closing-quote');
                    }
                } else {
                    while (pos < len && b[pos] !== D && b[pos] !== 13 && b[pos] !== 10) { if (!isWs(b[pos])) nonWs = true; pos++; }
                }
                count++;
                if (count === 1) firstBlank = !nonWs;
                if (hitEofInQuote || pos >= len) { rowDone = true; rowEndedAtEOF = true; }
                else if (b[pos] === D) pos++;
                else if (b[pos] === 13) { pos++; if (pos < len && b[pos] === 10) pos++; rowDone = true; }
                else { pos++; rowDone = true; }
            }
            if (!(count === 1 && firstBlank)) {
                counts.push(count);
                lastRowEndedAtEOF = rowEndedAtEOF;
                if (counts.length >= maxRows) break;
            }
            if (hitEofInQuote) break;
        }
        return { counts, warnings: warned.size, lastRowEndedAtEOF };
    }

    /**
     * Which separator will the engine split this CSV/TSV on? The bridge is told one (csvOptionsToBridgeArgs); with none
     * chosen, the worker resolves it with detectCsvDelimiterCode before the bridge (CB-012), so the limit check and the
     * conversion agree. Without any CSV options: the extension's (comma for csv, tab for tsv).
     */
    function engineCsvDelimiter(bytes, ext, csvOpts) {
        const lower = String(ext || '').toLowerCase();
        const dflt = lower === 'tsv' ? 9 : 44;
        if (!csvOpts) return dflt;
        const { delimiter } = csvOptionsToBridgeArgs(csvOpts);
        if (delimiter > 0) return delimiter;
        return detectCsvDelimiterCode(bytes, lower);
    }

    /**
     * CB-012: the CSV options the worker hands the bridge, with a missing or "auto" delimiter resolved to a real code (never
     * 0). Returns `options` itself when nothing changes: an explicit delimiter is respected, and a CSV/TSV with no CSV options
     * whose detected separator is the extension's own (comma for csv, tab for tsv) stays on the plain route, byte for byte.
     * @param {Uint8Array} bytes - the input as the engine will get it
     * @param {string} ext - 'csv' or 'tsv'
     * @param {Object|null|undefined} options - the CONVERT options
     */
    function resolveCsvDelimiterOptions(bytes, ext, options) {
        const csv = options && options.csv;
        const chosen = csv && csv.delimiter;
        if (csv && chosen != null && chosen !== 'auto') return options;
        const code = detectCsvDelimiterCode(bytes, ext);
        if (csv) return Object.assign({}, options, { csv: Object.assign({}, csv, { delimiter: String(code) }) });
        const dflt = String(ext || '').toLowerCase() === 'tsv' ? 9 : 44;
        if (code === dflt) return options;
        return Object.assign({}, options, { csv: { delimiter: String(code), encoding: 'UTF-8', hasHeader: 'auto' } });
    }

    function groupThousands(n) {
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /**
     * BUG-70: does this CSV/TSV pass the engine's row or column limit? null when it fits; else
     * {code: 'ROW_LIMIT' | 'COLUMN_LIMIT', rows, cols, limit, message} (the message is the sentence to show the user).
     * Pure and synchronous; ~0.5 s per 100 MB.
     * @param {Uint8Array} bytes
     * @param {string} ext - the file's extension (csv or tsv)
     * @param {Object} [csvOpts] - options.csv as the worker received it
     */
    function engineTableLimitError(bytes, ext, csvOpts) {
        if (!bytes || !bytes.length) return null;
        bytes = scanBytesOf(bytes);
        const { rows, maxCols } = delimitedExtent(bytes, engineCsvDelimiter(bytes, ext, csvOpts));
        if (rows > ENGINE_MAX_ROWS) {
            return {
                code: 'ROW_LIMIT', rows, cols: maxCols, limit: ENGINE_MAX_ROWS,
                message: 'This file has ' + groupThousands(rows) + ' rows, and the spreadsheet engine can hold at most ' +
                    groupThousands(ENGINE_MAX_ROWS) + ' rows in one sheet. Nothing was converted, because a file with rows missing ' +
                    'would not be your file. Split it into files of at most ' + groupThousands(ENGINE_MAX_ROWS) + ' rows and convert each.'
            };
        }
        if (maxCols > ENGINE_MAX_COLS) {
            return {
                code: 'COLUMN_LIMIT', rows, cols: maxCols, limit: ENGINE_MAX_COLS,
                message: 'This file has a row with ' + groupThousands(maxCols) + ' columns, and the spreadsheet engine can hold at most ' +
                    groupThousands(ENGINE_MAX_COLS) + ' columns in one sheet. Nothing was converted, because a file with columns missing ' +
                    'would not be your file. Split it into files of at most ' + groupThousands(ENGINE_MAX_COLS) + ' columns and convert each.'
            };
        }
        return null;
    }

    /**
     * Read the categorized last-error string exported by the C++ bridge (H11).
     * Returns the "<CATEGORY>: <message>" text (INIT_FAILED | INPUT_MISSING |
     * LOAD_FAILED | EXPORT_FAILED | INVALID_PARAM | INTERNAL_ERROR) or null when
     * unavailable. Feature-detected: on an OLD WASM build without the export it
     * returns null and callers fall back to the generic message (byte-identical
     * to pre-H11 behavior). Never throws.
     * @param {Object} mod - the Emscripten Module
     * @returns {string|null}
     */
    function readBridgeError(mod) {
        try {
            if (mod && typeof mod._get_last_error === 'function' &&
                typeof mod.ccall === 'function') {
                const msg = mod.ccall('get_last_error', 'string', [], []);
                if (msg && msg.length > 0) return msg;
            }
        } catch (e) {
            // Old build (export absent) or call failure — degrade to generic.
        }
        return null;
    }

    // ------------------------------------------------------------------
    // M14 JS mirror validators (defense-in-depth). The C++ bridge is the trust
    // boundary for the positional CSV option string and the comma-joined saveAs
    // options; these mirror its rules so the worker can fail fast with the same
    // INVALID_PARAM category before a bridge round-trip. Keep in sync with
    // canonicalEncoding / isValidPageRange / isValidPrintArea in wasm_bridge.cpp.
    // ------------------------------------------------------------------

    const CSV_ENCODINGS = ['UTF-8', 'ISO-8859-1', 'Windows-1252'];

    /**
     * @returns {string|null} the canonical encoding token, or null if not allowed.
     */
    function canonicalEncoding(enc) {
        if (enc == null) return 'UTF-8';
        const lower = String(enc).toLowerCase();
        for (const e of CSV_ENCODINGS) {
            if (e.toLowerCase() === lower) return e;
        }
        return null;
    }

    /** Page range like "1-5" or "1,3,5": first char a digit, then only [0-9,-]; len<=64. */
    function isValidPageRange(s) {
        if (typeof s !== 'string' || s.length === 0 || s.length > 64) return false;
        return /^[0-9][0-9,\-]*$/.test(s);
    }

    /**
     * Print area: a cell range (A1:M50 / $A$1:$M$50), optionally sheet-qualified
     * (Sheet1!A1:B2), or a page range; len<=64.
     *
     * MUST STAY IN LOCKSTEP WITH isValidPrintArea() in engine/bridge/wasm_bridge.cpp.
     * They diverged once and it cost users their conversion: the UI's own
     * (third, looser) copy of this rule accepted `Sheet1!A1:B2`, this one
     * rejected it, and the worker then threw INVALID_PARAM after the user had
     * already committed to the conversion. `!` is now accepted on BOTH sides.
     *
     * Quotes and spaces are deliberately still rejected, so sheet names
     * containing spaces ('My Sheet'!A1:B2) are unsupported — but they are now
     * rejected UP FRONT with a message rather than mid-conversion.
     */
    function isValidPrintArea(s) {
        if (typeof s !== 'string' || s.length === 0 || s.length > 64) return false;
        return /^[A-Za-z0-9:$.!]{1,64}$/.test(s) || isValidPageRange(s);
    }

    // ------------------------------------------------------------------
    // F-7: opt-in HTML export link sanitization (default OFF).
    //
    // HTML export passes hyperlink href/src/action schemes through exactly as
    // authored (security finding F-7) -- a `javascript:`/`vbscript:`/`data:`
    // link in the source document survives into the exported HTML, so opening
    // the file can execute script. The OWNER'S DECISION is that this stays an
    // opt-in option (default OFF): existing behavior must be byte-identical
    // unless the caller explicitly asks for sanitization. See CLAUDE.md.
    //
    // Scope is intentionally narrow: this is NOT a general HTML sanitizer. It
    // only inspects the URL scheme of href/src/action attributes and removes
    // the WHOLE attribute (never rewrites the value, e.g. to "#") when the
    // scheme is dangerous, so link TEXT always survives ("complete
    // conversions only").
    // ------------------------------------------------------------------

    const DANGEROUS_URL_SCHEMES = ['javascript', 'vbscript', 'data'];

    // Minimal HTML character-reference decoder used ONLY to defeat the two
    // evasions this project actually tests for: numeric refs (&#106; / &#x6A;)
    // and the two named refs that inject whitespace (&Tab; / &NewLine;). This
    // is deliberately NOT the full ~2000-entry HTML5 named character reference
    // table -- an entity that hides a scheme character behind some OTHER named
    // reference (there is no such named ref for a letter, but e.g. `&colon;`
    // for the ':' itself) is NOT decoded here and would NOT be caught.
    function decodeHtmlAttrEntities(value) {
        let s = String(value);
        s = s.replace(/&#(x[0-9a-fA-F]+|\d+);/gi, (m, n) => {
            const isHex = n[0] === 'x' || n[0] === 'X';
            const cp = isHex ? parseInt(n.slice(1), 16) : parseInt(n, 10);
            if (Number.isNaN(cp) || cp < 0 || cp > 0x10FFFF) return m;
            try { return String.fromCodePoint(cp); } catch (e) { return m; }
        });
        s = s.replace(/&(Tab|NewLine);/gi, (m, name) =>
            name.toLowerCase() === 'tab' ? '\t' : '\n');
        return s;
    }

    /**
     * Clean an attribute value down to the substring used for scheme
     * detection: decode the limited entity set above, then strip ASCII
     * tab/CR/LF WHEREVER they occur (per the WHATWG URL spec, these are
     * stripped from a URL regardless of position -- this is what defeats
     * `java\tscript:` / `java\nscript:`), then trim leading/trailing
     * whitespace (Unicode, via \s) and C0 controls/DEL (this defeats
     * ` javascript:` and similar).
     * @param {string} raw
     * @returns {string}
     */
    function cleanUrlForSchemeCheck(raw) {
        let s = decodeHtmlAttrEntities(raw);
        s = s.replace(/[\t\r\n]/g, '');
        s = s.replace(/^[\s\x00-\x1f\x7f]+|[\s\x00-\x1f\x7f]+$/g, '');
        return s;
    }

    /**
     * Extract the lowercased URL scheme (the part before the first ':'), or
     * null if the cleaned value doesn't start with a valid scheme token.
     * @param {string} cleaned
     * @returns {string|null}
     */
    function extractUrlScheme(cleaned) {
        const m = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(cleaned);
        return m ? m[1].toLowerCase() : null;
    }

    /**
     * Neutralize dangerous URL schemes (javascript:, vbscript:, data:) in
     * href/src/action attributes of an HTML string, by REMOVING the whole
     * attribute (never rewriting the value -- a rewritten target is worse
     * than a dead anchor, and removing the attribute keeps the visible link
     * TEXT intact, satisfying "complete conversions only"). Pure and
     * node-testable; operates on the raw markup text (no DOM parser), so it
     * is fast and dependency-free but NOT a general HTML sanitizer.
     *
     * Covered evasions: case variation (JaVaScRiPt:), tab/newline/CR anywhere
     * in the scheme (java\tscript:), leading/trailing whitespace or C0
     * controls, decimal/hex numeric character references (&#106;avascript:,
     * &#x6A;avascript:), and the &Tab;/&NewLine; named references. Single-
     * quoted, double-quoted, and unquoted attribute values are all handled.
     *
     * Known NOT covered (stated honestly, not implied to be handled):
     *  - The full HTML5 named character-reference table. An entity encoding
     *    punctuation other than via &Tab;/&NewLine; (e.g. `javascript&colon;`
     *    hiding the ':' itself) is not decoded and would NOT be caught.
     *  - Percent-encoding (%6A for 'j') is not decoded.
     *  - Unicode homoglyphs / fullwidth look-alike characters.
     *  - Any vector other than href/src/action URL schemes: inline event
     *    handlers (onclick=...), <script> tags, CSS url()/expression(),
     *    meta-refresh, SVG payloads inside otherwise-safe-looking markup.
     *    Scope is strictly "URL schemes in link-bearing attributes", per the
     *    F-7 finding -- this function makes no broader sanitization claim.
     *
     * @param {string} html
     * @returns {{ html: string, removed: Array<{scheme: string, count: number}> }}
     */
    function sanitizeHtmlLinks(html) {
        const src = String(html == null ? '' : html);
        const removedCounts = new Map();
        // Match href/src/action attributes with double-quoted, single-quoted,
        // or unquoted values. The leading \s anchors to an actual attribute
        // boundary (won't match e.g. "xhref=" or "data-href=").
        const ATTR_RE = /\s(href|src|action)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
        const out = src.replace(ATTR_RE, (full, attrName, rawValue) => {
            let value = rawValue;
            if (value.length >= 2 &&
                ((value[0] === '"' && value[value.length - 1] === '"') ||
                 (value[0] === "'" && value[value.length - 1] === "'"))) {
                value = value.slice(1, -1);
            }
            const scheme = extractUrlScheme(cleanUrlForSchemeCheck(value));
            if (scheme && DANGEROUS_URL_SCHEMES.includes(scheme)) {
                removedCounts.set(scheme, (removedCounts.get(scheme) || 0) + 1);
                return ''; // Drop the whole attribute (incl. its leading space).
            }
            return full; // Safe/unknown scheme or no scheme: byte-identical passthrough.
        });
        const removed = Array.from(removedCounts, ([scheme, count]) => ({ scheme, count }));
        return { html: out, removed };
    }

    // ------------------------------------------------------------------
    // BUG-12 (font half): script coverage table + content sniffing.
    //
    // The PDF text layer was always correct; what was missing was a font that
    // actually has the glyphs, so non-Latin text rendered as tofu boxes. Fonts
    // are NOT in soffice.data — they are fetched from /fonts/ at runtime and
    // written into the worker's MEMFS, so adding coverage costs 0 bytes of
    // module download. LibreOffice's fontconfig glyph fallback then engages.
    //
    // HARD CONSTRAINT: loading all 319 fonts hangs init_office() during the
    // fontconfig scan (see conversion_worker.js ESSENTIAL_FONT_FAMILIES). So
    // detection is per-script and additive: Latin-only content loads EXACTLY
    // what it loaded before (zero extra files, zero extra startup cost).
    //
    // This table is the single source of truth shared by font_resolver.js
    // (main thread) and conversion_worker.js (fallback path) so the two can
    // never drift apart.
    //
    // `files` are basenames that MUST exist in web/fonts/fonts.json.
    // An empty `files` = a script we can DETECT but cannot RENDER: the user is
    // told (no silent tofu), rather than the gap being papered over.
    //
    // AS OF 2026-07-27 NO ENTRY HAS AN EMPTY `files`. The last two gaps (Korean
    // and pictographic emoji) were closed by adding NanumGothic-Regular.ttf and
    // NotoEmoji[wght].ttf. The empty-`files` MECHANISM is deliberately kept --
    // it is how the next script gets added honestly, and it stays under test via
    // a synthetic entry (see tests/unit/test_protocol_helpers.js, "the declared-
    // gap mechanism") so the warning channel cannot rot just because nothing is
    // currently using it.
    //
    // Emoji is SPLIT into two entries, because DejaVuSans -- which is already in
    // the always-loaded essential set -- draws some of the emoji range and none
    // of the rest. See the `emoji` / `emoji-pictographic` entries below.
    //
    // RANGE PRECISION IS LOAD-BEARING. A range wider than the font's real
    // coverage does not merely waste bytes: it makes this table LIE, and both
    // gates (tests/unit/test_font_coverage.js, tests/gates/test_font_embedding.js)
    // read the table as the specification of what the PDF must embed. A range
    // wider than the script's real block does the opposite damage -- it triggers
    // a font download (and, historically, a phantom user warning) for documents
    // that contain no such script. Every range below was derived from the
    // chosen font's actual cmap, not from memory; Extended/Supplement blocks are
    // included ONLY where that font was measured to cover them.
    //
    // NOT LISTED ON PURPOSE: Hebrew, Arabic, Georgian, Armenian and Lao.
    // DejaVuSans.ttf is always loaded and already draws all five, so an entry
    // would buy nothing and cost an extra download per document. Verified by
    // cmap probe; asserted in tests/unit/test_protocol_helpers.js so nobody
    // "helpfully" adds them back.
    // ------------------------------------------------------------------
    /**
     * CJK FONT COVERAGE, MEASURED PER SHIPPED FILE.
     *
     * One table answers two questions, and it is keyed by FILE because the font
     * on disk is the only thing either answer is true of:
     *
     *   1. SUBSET FONT TIERS — ship a small font when the document's characters
     *      fit in it, the full one otherwise (selectFontTier).
     *   2. SCRIPT-FONT SUPPRESSION (NTH-12) — drop the han safety net entirely
     *      when a font we are ALREADY downloading provably draws every CJK code
     *      point the document contains (see font_resolver.js).
     *
     * WHY TIERS. Noto Serif SC is 8.49 MB raw / 5.88 MB brotli, and it is
     * fetched for any document naming SimSun — the default body face of most
     * Chinese business documents. The overwhelming majority of such documents
     * use only the GB2312 repertoire, which a 2.53 MB / 1.84 MB subset covers.
     *
     * WHY SUPPRESSION. Such a document ALSO fetches Droid Sans Fallback (1.10 MB
     * as a subset, 3.85 MB full) purely as a safety net for han. When the serif
     * face already draws every CJK character present, that net catches nothing.
     *
     * THE RULE, and it is one-directional for both uses: act on positive proof
     * only, and fail UP — to the full font, or to keeping the safety net — on any
     * doubt. Suppression additionally requires detection.complete === true (the
     * text sample was the WHOLE document, not a bounded prefix), which is the
     * same bar scriptsStillNeeded() already applies.
     *
     * WHY FAILING DOWN WOULD BE SEVERE, not cosmetic: LibreOffice picks ONE
     * covering font per run, so a single uncovered character does not fall back
     * for that character — it demotes the ENTIRE document to the sans fallback.
     * Measured 2026-07-28: ordinary GB2312 text plus the single rare hanzi 兒
     * embedded DroidSansFallback only, with no NotoSerifSC anywhere.
     *
     * WHY THE RANGES ARE WIDER THAN "HAN". The tier decision only ever needed
     * CJK Unified Ideographs, because the Latin and punctuation ranges are in
     * both tiers and can never decide it. Suppression is a different question:
     * it removes a font, so the proof has to cover every character that font was
     * the only loaded one able to draw. MEASURED 2026-07-29 against the shipped
     * cmaps — LiberationSerif-Regular.ttf and DejaVuSans.ttf draw ZERO code
     * points in every block below, including U+3002 IDEOGRAPHIC FULL STOP and
     * U+FF0C FULLWIDTH COMMA, which occur in essentially every Chinese sentence
     * and are NOT matched by the `han` script pattern. Proving only the pattern's
     * own code points would therefore have dropped the one font drawing the
     * document's punctuation. The blocks below are exactly where a CJK face is
     * load-bearing; everything outside them is covered by the Latin set that is
     * always loaded.
     *
     * THE TABLE IS GENERATED FROM EACH SHIPPED FONT'S OWN CMAP, never from a
     * parallel list of GB2312, so the two cannot drift. 29,760 code points →
     * 3,720 bytes → 4,960 base64 chars per font; 20 KB for the four fonts, 2.7 KB
     * gzipped, against a 1.10-3.85 MB download it removes.
     *
     * A FONT ABSENT FROM THIS TABLE CAN NEVER JUSTIFY A SUPPRESSION OR A SUBSET.
     * That is the fail-up direction and it is why adding an entry is the ONLY way
     * to opt a font in. Regenerate with tests/gates/test_font_tiers.js --regenerate.
     */
    const CJK_COVERAGE_RANGES = [
        [0x2E80, 0x2FE0],   // CJK Radicals Supplement, Kangxi Radicals
        [0x3000, 0x4DC0],   // CJK Symbols and Punctuation, Kana, Bopomofo, Kanbun, Ext-A
        [0x4E00, 0xA000],   // CJK Unified Ideographs
        [0xF900, 0xFB00],   // CJK Compatibility Ideographs
        [0xFE10, 0xFE20],   // Vertical Forms
        [0xFE30, 0xFE50],   // CJK Compatibility Forms
        [0xFF00, 0xFFF0]    // Halfwidth and Fullwidth Forms
    ];
    const CJK_COVERAGE = {
        'NotoSerifTC-Regular.ttf':
            '////+/////////////8PAP//////////////////////////////////PwD///////////7///////////9//v///////////////+D///////7//////+//////f///////D/////8PAP//////f////////////////////////////////////////////+///////////////////////////////////wAAAAAAACAAARQAABAACGQAAEgAIIAAEAIBAIBQAAAIQAAAAAAAAEAAAAoCAiCFARAAgAEiIACAokREKAAADkgAAgAFKCAgQoBDAIACAAAEAgAABCAUIxK6AVggZgAgAAolABAsMA0ECQAAAASAAAAAAIAAAQAAQgAAQAAAAAQJAIAAAgEgQAEAAAAACAAgAAAAAAABAAAACBASAAAAAAQAARAAgAAEgAAgAAAIAAABAQYEChIAAAEAAAAQJBAASUoAgAEABhAAAAiEUMAAAAAAAIAAAAgAIAAAAEABACUIAEAAAgQIAAIEAAABAQAGGAEAYAICAABQFACAIAAQHAAAICIBAAAAAAAAEAAAAAAAAAgAAAAAAAAAKEIQAIgAAAAADCAAAAQIQFACgASGICAghQIAICAQgMAyCAiACZgwQAAAAAAAAAAJASAAAAAQAAAAAAAAJwKBhBTDTIYaGZTRQAAAAAAAAAAACAMIAAAQAAAIAAAAAAABAYAQICAABhACACAAAAACIACIACSEAgAAAAAAAAEQiAABAIEAAAAFHEIAAAAABgAAAAAAgFAAkAIAAQAAAAQAEIQACACgAAIAAAIACAAAAAEAAAABBEAEABAQAAQAIBIAAAAAAAAQGAAEAAAACAAAAAAAAABAAAAAAIAEAAAABAIAAIIAIAUABgAIACAgAAAAAAAAAAAABACAAoAFAIEgKUAA4BIeEAAYCkAogEBIqAgAJhEGJIABIAAAAEAACAAAAAAEAAYAAEiAoAAAAAAAAAAACAAAAAQBAAAAAkAACACAAQAAAKAAAAAIAQAAQAAQwAAAAAAAEAAAAAFAAAAAAAAgAAAgEAABCAAAAACAAAAAACAAAAIAAAAACABgAAAAAAEgACAIBEAAAkAgpCFQIAAKACAEBAAAAgAAggAAAAAAAICgAAAAAIAAIBAAIAAAAAAAAAAAAAAAQAAQABABAAACABAAAIAAAAECARCAAAAAAAAAgAVIAEDJIAAAAGABAAAAAAAAAJBAAAAAAARIgQCACAAggCgiAAAAEECBAAAgAAAGIAAAgAIBAAAAEAAAAAAAAADAAAACAhAAAAAAm/9z11b9z7us60z/AAYIwf97Ps9/ecie32/w9zpP/6k/778nBLPd/+77//+f3v3//6/3fQTJ/a6//9v/M9D/Z+n7/t/v/7sY6//q/X///SSveXd/TPD//fbv+67793v7/3+/lXduv7/7O/b+r3/yE8Wn/lW1Xf9z+P+f+Rcge3fvX8/w80f/Hdr+9P4H/7y/n7/bj1t/IFqvMu/rX4q732Lv57aftJ/7v3ee9Nvyv/sUxNz39X9VCi4/149//+9Z2v9f//v///vv/RAA/7///ff5/1X//9////tBRP/vjr3+/59F6P3/2/vv7/B+Du763/8/t/5/P57//////tfn/nfz//iv9v3vb/edZ3//39///q338v3+8m8/2uy37IOunz98/Q33Hejv/peI1q///A29uf+/RHj/3tm18P/y/3//fxV7//f/r5H/vv88u37+789f9+vfa/zmy3//nZsd/vz09ra1/pZRsce7Fad+//s/5t3n/9H///v/X397////D77u37t+6HP/N////3+D/17d//733v//3//q/39//e+uu/vu+/0V8fv9+718e/+9v9vt//x1+YP/fP/L/99vhbr/f9Q9FYvf8/97c733Gl9ovz/2///rBcbf/88g9/O7w/j37/3T//fvX+dKrJuX//dvvPaX//c3z6r26edJv+JcXvavP2vYYT/9uPvP/33/3b/kHv19/2P2f///79Pe37b9vK38Y+sdef/Tc76+3/vvH8fb8//m/j+y9+s77bqtAf7/fv//vgr/Pj3v/P+lwPt39fzdAf//+/+6/98D///7/32/jdvV6Pf/ff//3f92j35/v5b//9fvv0nF/W/n/5t3d46/ft3mz38fX3/h3/7/1/8hUP97+/7//58g+P//j/t7AQD//n////MnsPvnv7//1/u//wNi///v///vf1vA/v3d//397wtoH//j+/+/pL/v9336X/i/7t0v/7+f/dv2+/t//v3raqf69/y9/J//G/f6t93t+3743+xv8z+8/f8/8f/pfwa+v47+/93ff/F/96cX7//v0f9Ef9l739M///3r7316//D76/aH/P///vq/txHQ/49//9///P7/1x8g3f1n7/5///97ICDo9vv/n9+53/9/Ivp///Xb3/8///+/DyCU/ft/3/7/////D21k+9/////6X/57AvZ73v//v/r/6zs8//v7/+//r1LEv/b//v/5/m/svxv/o91LHz2Pz2crsf7/7n/32v+k1M9f9/LL/ezttPu/3V3fnY3/f7t7v/vd/+9P/rX/4+9/7///fb8E/N////7//q//L4L//8fv9f///wdAgN//9/f/////BTDcvv/1v///f///fj2EIL///3//++7////L3hNA693//8z/////fz8E+/b////81//+//8bwP/93/7d//d//eD//3//3/84/9/71937/vL/35+/338/9/3/3/P3fs5+h/v6u3/x/f/3F4D7/3V+if5v239M//7f9/9f/33319f/v7e/9//Pd7/3eXf77/b57vx/Ye/Xn+3/z9bd+/f7/+3+9zWkf37Xl18P2P+Xnc977H//3z/3h+/n3//9/9/88fc//N/9//1//+/4//8/9v5///+X/////r//f/bvP7X/+6/372+d+f//U/fpvfn/92b/v+/F/Tq+/fzF59n8N2e8DH//v/23/9+g//+Pv3v+/7M/Pc3z35f39n//1s9tfnLsse18d1z++va/X7rfL+79q/5/+fx03+//hP+/+6r/r73//rz+uX/t859/bPMf8e//vzO8fx9wdf8D3vvz+se/v19fuv+/7b/3v/52Up96+v9+//ef//+/Lx/2z+3/v/d/3+9z/3fx3X7SDX19v99F/Yf++X/Qnad7d+/7n//DDd//3b+PCr/97sD+c98f7/3/Pwv9/3cB//L/CbT99z8f8LZD894x//8fn//v/if67z+p+7032775/j3/e3f20e7RPv+sf//2xfX/e/////8n22///+R//c7vD757+/7w3/+///f+nf/71/9+iP///L/u////E//fr//9/8f9/p8QEAAEgIAAgAAAAABAAAAAAADA57v/P/nrf+//6P/+fP/z//+v/rf47/+////59/tz1/v6yIVXfd6Q7+P1nm2/ru72Nfz38397sn9/71f0776+l2bc/X9e9/rft92/qP/tX//+/7en7//33N+3P3f9Z7/897XK/99++/b/uewf7///+/8dhP/b//3///87wH/1v/6/v//fAEyA+P3q//9//d8B4v//+vu//3//+v5fGVv6///9f/////v/51Xh3/+f/1f/9/7fTLbf3//9///3+/8baf9//u///+tf///7/9+H++f/6+f3f//X//e+29//937f7Xl92r7/n17gfP93v6f///8b2/9cv+BP/38uX/93v91P8P/////7L/673/08/v//f1/e///9/N5/v/u7///v+3/97G6/7/fyn/vv/5dd9ven/vX/wtn//+de/8f+/u953rrf/3/+3t7vj/r5/vbE9kMAfL7/O9/dndXv+aw+U/9z9/dLz3v/3v64f1f7n1X//bv+/9ft/9/3/f///f3r/u////ftv5Hvf9193wEAAEAAAAAABAAAAAAAAAAAAID67v/ztHa/7y93tr//v7/9/7+1/v7/f79//b//OwAAAAAAAAAA0PvdLzf2f5rr//zW7/n7v9/fH/T/5v///2979/f/+f7/t/5d93//5fs/RTYN/p799/v23+9v//959v3b/+///99AAAAAAAiY6eH/33b+/wR/bfH/f7n3/h/g/vHW/n97n/v9//+ts8vvxX/puk3wvz+/P/7/69f/3/9/z/v/79e/1/0X//5P/q///37/+vu3/H/65//3/1f6bf/3c///7f/4xf////o//1/+3v//v+v7/9//3/t97///exP///ff/3/7f//39///97+p3f3//99R+//b//8r8f/v//2/t2m9///7LwAAgAQAAAAKAAAQAABAAAAAAAAAIAAAgAAAAAAAgL1t+9/b/3/n/uk/f9w/ARAAAAAAcB/1D78//Fv5Hr7/efvv/lu+V1u7/3/8/y6H96/960/7/993598P5v1Hd9/9v++Q/3993u//+/3za2Bv7//1//nb670L+v/P+/2fPwAAAAAAAPPe/99fANjvvnZ2rVf/37L/r/+vf//7DgAAAAAAwHv6/T8/vvr/v/928//+/nP+//73/3/3/d/9HwAAAIAAAACp3//HpP+Rz/je/n7/98e9777ef/13j9OT8/zv6a/sd+1ho9uH+H73P5Oh5H+9uHu7/v7z//3jzWG+HwAAAAAAAAAAAAAAAOAm/r79E/Xrb+Pb6z/e3/+D/7/7/x/d//+//v+/////fvv9///+v/8AAAAAAAAAAAAAIL7/f///9//z+N/xe/316f//x8ftX/3//2v///3//973zwBg95P1/w8AgA8BAAAAAADuLKAkACCCBoglBECkAUxDQUQg2CAAICxgAQBxkQIwpOQ1AAAAADgEAAoAYAAAAAAAAAAAAAAAAAAAAAAAAAAA/wP//////v/////////////////////////+//9//Pz8HH9/',
        'NotoSerifSC-Regular.ttf':
            '////+/////////////8PAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///////////7///////////9//v///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wMAAAAA/v/////////////////////////+//9//Pz8HH9/',
        'NotoSerifSC-GB2312.ttf':
            '////+/////////////8PAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///////////7///////////9//v///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAi397f7Q9Ve+o+13zQwILQED7Po33eyyM/2764zod7agC5oPP9YxVNUjgq/+5klnYGKuSKOnXIIA4xIP1SucKRQCwFJdidwBUiNEgFCAQwMghIQAAqBMEDACAQATAcCgIwAgEAAIAAIB7K3IUJHn7Oycz5Bo1mO840ZoCKBOoab/PZcYvEWvJrw80U1CihgSgBgEJ6A8/DsCICkWBEAABxmGh4SZLRADOqsfu1N/Ku4V0OiClbENAiAY/0ot5/+87Wvfv6Mv7NltJDf0bVAHuOVXYdS7Yvxqp1/O/9uBnDLTCghMIndSL0FoGYRDydOBZn48Ss4AAqmowMl6wep2sYAPTAMmYMFaKAHCQExQfQhhgwAgACICAEAAEkOwXKDPmWAcAkAj3CU6F9IP8U6/IGHwYDAjfahQBDMg0pxGgECfFKCJCEwQhABAwEkEgGABAKwIMxgADABAiACIAEFhJApSgcJaw7pIXlsvyBSUAWCPeJcxCOM8ESkAMnzUoEQCK+hMKkSkCVhBBBiAEhATwhAAABAwABCxBBhJUEUsKAgAAAsAAAACUAAEAu798Fisku5uof38MeeP0EA3gMkEBn1KGcjW0EBL/J88jQmvAAoYGMdMfDDqqoRIIBAJyJQEIzEBQSNBiEGCAHAApAJoQAAQAACIAAIAAICAAaObLnmBukXM/wGCCOTQQMEgGAFy90Yz71uEg6EMABk4IAAXQxB+NqonhpgIWAQDtIVY2ixq3H6UTAmWgMHiyxyOTbCLpf+R0OuOPIJgOKCUmnL9JvxgyVKxJuRYZYAwitcH7WQZD4yCE2QgAgABVIiCEAaEAAEgQIIATgEAEDRYAQAAggED95402VJjgi3seCcj+SdIRBu6NNxkiuvR33Z/s89rwhkNC7D+NBCZs+iHAjmLCDIXXRQGtd5lVUOJFQAsmVKEnmBlYQzQQpPIFFEGAIgAHtABmQhByoRUlYIVBVAAAAAECBAEgyHDLIJNiakwYlQCAGIuasqoBMnrYxADl88METdQ4oqGhclAKmPyEUsHRRJQQwiCAQRBCAAAAOkACndIBL7GoQL0yJE3TS9Ajp63Qkgqhdayt6QEagB93JZIboKHfyiACBoxzf1c7AP8L0ABqgIgAxKEpAAUqJAUJQCMWImgFgBEgEaIEAJBkSUiCE9UjMBmAKZIIAlQRiAEgBKAABICBAoUiYJAAAQsiAAISEUCDAAEaAAAAAAAAAAAAAAAAAACfAIRGyBIAAvwEABreLkwMAgS4gCao/AoCjCgi4KB7j9bHNSHHBrH4EwdVYm6TGYr6bg77MBb5SC/N632SWIROoEwueurtHlZJxpARJFM66NvPJIHxGEJjU1iKGiB00yQ7qhQFGGBYiQBIAMBoggGRpITWLIaIusR3AxACRII4ABGuSkDAKABRRGAUFRBzABCCAEgCBQIGQAPAAAAAAAIMCAAgAgCQAEAAuGHRIUZ0MgD4ijsPBQCL0LuAIgAGaQdAgEMAIFQAUNBBDCUQhBCDAREoAghAMAChQAACQAAAIAAV46uAMUSqxsIkxhOsBIAAsNEDHmGFQgPznx0KROh4Jl6SwwAghQABsABAkEpCiATKjQwFpwNCoSIEAGiGAQxkVXkQAgCg3gAgwUCLSAFQgAMABAAABFBdwNCAEKAKlyC7r00h2RAeYAQUg0iI1qY72D9zvCd0SdwNE5IrFKGLdS450QkwUFAIiABp1ElKAhBAFoBk5deJIMAWU5IrAIZFo+AViwADDG4ZAOIxcAaApRYpqAAggBisekjhBzLWtegykV+hUOUgAHyAEIByip2qAB9CIg4xAgARlAQiAAhAEAAQXEMDyPyloYAFM4QABIAACG5LKiaB2KoBKU1okEQJAIi6QACCAAAA0YdbIeaxYTEIgAAIQMJpoACmWI0ySnFdClWgmlctBUCmSiEgsTDGPxIBwhAKJmJEglCAmECAwAQAgQMgAAAAABg4AAKm8TREDnKiNeCSAYEACQAEAACFiAAAAAAAAABAgAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAiCAAAAAAAAAAQAAIj/v+/n//+//+/v//3/+/6///9/BTQAs4UGRxZCAlQQ5JKABbMiVDCBY0ILGHs49RPlB+qpTDwUBQAGAoDZGki9N+6W9F9wwH6yv181ROZfRQCQRkFAHTsGoWIT/gWFAjlIBQgMTxQAAIg0GFh3MBXYDr37S5CKAIUAwR3mFO2Gs3L/m2OS/b7Ze4iSCv7TshyAuXoXyYIX3Pv/gDlgQgxZAQ/fN6OUULEjBgcjWvgCMfABAjFAAIIeCjpqBYRbgBICgBSnEiZLoGkQAZAAEIqEAhiAPwgHQEIQARROsIAAGBDFgQICgikQEAIAiCAAQgCAAgARAOATRARYAv4HPCgwmJdzBNHOE8sQYh9DjSesVS5CksiAU4gCOUBReCwpiIAAuSgkQQwOCCFEAEIIBGgIBgAEEjEwkAI+W4XgNilEEBQoghBmQjSDPAEbUwQEDQ4iDFEAEgAAwEAAAIhKAAAAAAAAAPbfR1RoiAgAgQAAAAAAAEAAAQAAAAAAAgAGCAAAAAAAAAAAAAAAAACAAAAAQAAAAAAAAABAEAAAAAAAAP/v/fd///7///v////9/7////8AwhIgBAYMCAckFhABAAAAAAAAAAAAAAAAAAAA4P7//////3l/3yj5ADIMEoAIADrVWNjC7BidqC8glhDgDNYiJpcPBgJAslWQooARUACYBAQAQAAAAAAAAAAAAAAAAAAAAAAAAMD7///+7/vfCAtDYrZBO/t0b4kjf67X7EfgYFmWoI8JLGEwoA0JqipO1HtPssSLOMapEGEUAABCDIACAkj+hWQ+1vfjoDoHDAzkMASA9gIQAAAAAAAAAAAAAAAAAAAAAAAAEAAAQAAAAEAAAAABAAAAAAAAAAAAAAAAAEAAAAAAAAQAAACAAAAAAAAAAARAAAAAAAAAAAAAAAAAQAAAAAAACAAA4P+9/v////9/f+f7v///9////+9+//ff9/bf+/6/T4AAAAAAAAAAAAAAAAAA7/9/f//3tgZEfrj1OzGIlhf0AGCpkROAAEly8/IkAAGHyELT40hQACQFQwAATEonAlgQICgWAQmoFAAAAAAAwD5oAAAAAAAAAAAAAAAAAAAA4P//t9v99wAAAABALseAAQAAACABAABAAAAAADAAqP/3tPOt/wMgAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8Pv/953P/b8BwxUnGAqBQqgACgiBCIAIgAQYvqMSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkOZpN9z/a/89+Pz58wQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIBvv+7n/t+iXdg/C8CECQygQAAQaRDiErmlhgBaAGiJAgWQgGoQAAMAAAAAgPkfAI4BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wMAAAAA/v/////////////////////////+//9//Pz8HH9/',
        'DroidSansFallbackFull.ttf':
            'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADv/P/z/gMAAP7///////////8ffv////////////9/eOD/////A/7/////////////fwAAAAAAAAAAAAAAAAAAAAAAAP8DBgIAAAAAAAAAgAAAAAD4AQAAAAAAAAAAAAAIIBABzAhACAAmggAAAAB4H///////////5285AAAAAP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////z8A//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8/AAAAAAAAAAAAAAD/////////////////////////////////////////////////PwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wP7/3/+/v////////////9//v////////8AAAAAAAAAAH8A',
        'DroidSansFallback-GB2312.ttf':
            'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADv/P/z/gMAAP7///////////8ffv////////////9/eOD/////A/7/////////////fwAAAAAAAAAAAAAAAAAAAAAAAP8DBgIAAAAAAAAAgAAAAAD4AQAAAAAAAAAAAAAIIBABzAhACAAmggAAAAB4H///////////5285AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAi397f7Q9Ve+o+13zQwILQED7Po33eyyM/2764zod7agC5oPP9YxVNUjgq/+5klnYGKuSKOnXIIA4xIP1SucKRQCwFJdidwBUiNEgFCAQwMghIQAAqBMEDACAQATAcCgIwAgEAAIAAIB7K3IUJHn7Oycz5Bo1mO840ZoCKBOoab/PZcYvEWvJrw80U1CihgSgBgEJ6A8/DsCICkWBEAABxmGh4SZLRADOqsfu1N/Ku4V0OiClbENAiAY/0ot5/+87Wvfv6Mv7NltJDf0bVAHuOVXYdS7Yvxqp1/O/9uBnDLTCghMIndSL0FoGYRDydOBZn48Ss4AAqmowMl6wep2sYAPTAMmYMFaKAHCQExQfQhhgwAgACICAEAAEkOwXKDPmWAcAkAj3CU6F9IP8U6/IGHwYDAjfahQBDMg0pxGgECfFKCJCEwQhABAwEkEgGABAKwIMxgADABAiACIAEFhJApSgcJaw7pIXlsvyBSUAWCPeJcxCOM8ESkAMnzUoEQCK+hMKkSkCVhBBBiAEhATwhAAABAwABCxBBhJUEUsKAgAAAsAAAACUAAEAu798Fisku5uof38MeeP0EA3gMkEBn1KGcjW0EBL/J88jQmvAAoYGMdMfDDqqoRIIBAJyJQEIzEBQSNBiEGCAHAApAJoQAAQAACIAAIAAICAAaObLnmBukXM/wGCCOTQQMEgGAFy90Yz71uEg6EMABk4IAAXQxB+NqonhpgIWAQDtIVY2ixq3H6UTAmWgMHiyxyOTbCLpf+R0OuOPIJgOKCUmnL9JvxgyVKxJuRYZYAwitcH7WQZD4yCE2QgAgABVIiCEAaEAAEgQIIATgEAEDRYAQAAggED95402VJjgi3seCcj+SdIRBu6NNxkiuvR33Z/s89rwhkNC7D+NBCZs+iHAjmLCDIXXRQGtd5lVUOJFQAsmVKEnmBlYQzQQpPIFFEGAIgAHtABmQhByoRUlYIVBVAAAAAECBAEgyHDLIJNiakwYlQCAGIuasqoBMnrYxADl88METdQ4oqGhclAKmPyEUsHRRJQQwiCAQRBCAAAAOkACndIBL7GoQL0yJE3TS9Ajp63Qkgqhdayt6QEagB93JZIboKHfyiACBoxzf1c7AP8L0ABqgIgAxKEpAAUqJAUJQCMWImgFgBEgEaIEAJBkSUiCE9UjMBmAKZIIAlQRiAEgBKAABICBAoUiYJAAAQsiAAISEUCDAAEaAAAAAAAAAAAAAAAAAACfAIRGyBIAAvwEABreLkwMAgS4gCao/AoCjCgi4KB7j9bHNSHHBrH4EwdVYm6TGYr6bg77MBb5SC/N632SWIROoEwueurtHlZJxpARJFM66NvPJIHxGEJjU1iKGiB00yQ7qhQFGGBYiQBIAMBoggGRpITWLIaIusR3AxACRII4ABGuSkDAKABRRGAUFRBzABCCAEgCBQIGQAPAAAAAAAIMCAAgAgCQAEAAuGHRIUZ0MgD4ijsPBQCL0LuAIgAGaQdAgEMAIFQAUNBBDCUQhBCDAREoAghAMAChQAACQAAAIAAV46uAMUSqxsIkxhOsBIAAsNEDHmGFQgPznx0KROh4Jl6SwwAghQABsABAkEpCiATKjQwFpwNCoSIEAGiGAQxkVXkQAgCg3gAgwUCLSAFQgAMABAAABFBdwNCAEKAKlyC7r00h2RAeYAQUg0iI1qY72D9zvCd0SdwNE5IrFKGLdS450QkwUFAIiABp1ElKAhBAFoBk5deJIMAWU5IrAIZFo+AViwADDG4ZAOIxcAaApRYpqAAggBisekjhBzLWtegykV+hUOUgAHyAEIByip2qAB9CIg4xAgARlAQiAAhAEAAQXEMDyPyloYAFM4QABIAACG5LKiaB2KoBKU1okEQJAIi6QACCAAAA0YdbIeaxYTEIgAAIQMJpoACmWI0ySnFdClWgmlctBUCmSiEgsTDGPxIBwhAKJmJEglCAmECAwAQAgQMgAAAAABg4AAKm8TREDnKiNeCSAYEACQAEAACFiAAAAAAAAABAgAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAiCAAAAAAAAAAQAAIj/v+/n//+//+/v//3/+/6///9/BTQAs4UGRxZCAlQQ5JKABbMiVDCBY0ILGHs49RPlB+qpTDwUBQAGAoDZGki9N+6W9F9wwH6yv181ROZfRQCQRkFAHTsGoWIT/gWFAjlIBQgMTxQAAIg0GFh3MBXYDr37S5CKAIUAwR3mFO2Gs3L/m2OS/b7Ze4iSCv7TshyAuXoXyYIX3Pv/gDlgQgxZAQ/fN6OUULEjBgcjWvgCMfABAjFAAIIeCjpqBYRbgBICgBSnEiZLoGkQAZAAEIqEAhiAPwgHQEIQARROsIAAGBDFgQICgikQEAIAiCAAQgCAAgARAOATRARYAv4HPCgwmJdzBNHOE8sQYh9DjSesVS5CksiAU4gCOUBReCwpiIAAuSgkQQwOCCFEAEIIBGgIBgAEEjEwkAI+W4XgNilEEBQoghBmQjSDPAEbUwQEDQ4iDFEAEgAAwEAAAIhKAAAAAAAAAPbfR1RoiAgAgQAAAAAAAEAAAQAAAAAAAgAGCAAAAAAAAAAAAAAAAACAAAAAQAAAAAAAAABAEAAAAAAAAP/v/fd///7///v////9/7////8AwhIgBAYMCAckFhABAAAAAAAAAAAAAAAAAAAA4P7//////3l/3yj5ADIMEoAIADrVWNjC7BidqC8glhDgDNYiJpcPBgJAslWQooARUACYBAQAQAAAAAAAAAAAAAAAAAAAAAAAAMD7///+7/vfCAtDYrZBO/t0b4kjf67X7EfgYFmWoI8JLGEwoA0JqipO1HtPssSLOMapEGEUAABCDIACAkj+hWQ+1vfjoDoHDAzkMASA9gIQAAAAAAAAAAAAAAAAAAAAAAAAEAAAQAAAAEAAAAABAAAAAAAAAAAAAAAAAEAAAAAAAAQAAACAAAAAAAAAAARAAAAAAAAAAAAAAAAAQAAAAAAACAAA4P+9/v////9/f+f7v///9////+9+//ff9/bf+/6/T4AAAAAAAAAAAAAAAAAA7/9/f//3tgZEfrj1OzGIlhf0AGCpkROAAEly8/IkAAGHyELT40hQACQFQwAATEonAlgQICgWAQmoFAAAAAAAwD5oAAAAAAAAAAAAAAAAAAAA4P//t9v99wAAAABALseAAQAAACABAABAAAAAADAAqP/3tPOt/wMgAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8Pv/953P/b8BwxUnGAqBQqgACgiBCIAIgAQYvqMSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkOZpN9z/a/89+Pz58wQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIBvv+7n/t+iXdg/C8CECQygQAAQaRDiErmlhgBaAGiJAgWQgGoQAAMAAAAAgPkfAI4BAAAAAAAAAAAAAAD/////////////////////////////////////////////////PwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wP7/3/+/v////////////9//v////////8AAAAAAAAAAH8A'
    };


    let _cjkBits = null;
    function cjkBits(file) {
        if (!_cjkBits) _cjkBits = {};
        if (_cjkBits[file]) return _cjkBits[file];
        const b64 = CJK_COVERAGE[file];
        if (!b64) return null;
        let bin;
        if (typeof atob === 'function') bin = atob(b64);
        else bin = Buffer.from(b64, 'base64').toString('binary');
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        _cjkBits[file] = out;
        return out;
    }

    /**
     * Bit position of `cp` in the packed coverage bitmap, or -1 when the code
     * point is outside every covered block.
     *
     * -1 is NOT "not covered" in the sense of a zero bit — it is "this table has
     * nothing to say", and every caller must treat it the same way: as a failure
     * to prove. Both meanings select the safe answer, so they are collapsed here.
     */
    function cjkBitIndex(cp) {
        let base = 0;
        for (let r = 0; r < CJK_COVERAGE_RANGES.length; r++) {
            const lo = CJK_COVERAGE_RANGES[r][0], hi = CJK_COVERAGE_RANGES[r][1];
            if (cp >= lo && cp < hi) return base + (cp - lo);
            base += hi - lo;
        }
        return -1;
    }

    /**
     * The CJK coverage of one shipped font file, as a Set-like `{has(cp)}`.
     *
     * Shaped as a Set so it can be handed straight to FontResolver's
     * scriptsStillNeeded(), which already takes exactly this contract for the
     * coverage of fonts a DOCUMENT EMBEDS (NTH-07). Feeding it the coverage of a
     * font we are about to DOWNLOAD is the whole of NTH-12, and reusing the
     * proven predicate is the point.
     *
     * @param {string} file registry file name, e.g. 'NotoSerifSC-GB2312.ttf'
     * @returns {{has:(cp:number)=>boolean}|null} null when the font has no
     *   measured table — which callers must read as "can prove nothing".
     */
    function cjkCoverageOf(file) {
        const bits = cjkBits(file);
        if (!bits) return null;
        return {
            has: (cp) => {
                if (typeof cp !== 'number' || !Number.isFinite(cp)) return false;
                const i = cjkBitIndex(cp);
                return i >= 0 && !!(bits[i >> 3] & (1 << (i & 7)));
            }
        };
    }

    /**
     * Does the shipped font `file` cover every one of `codePoints`?
     *
     * Returns FALSE for an unmeasured font, an empty/absent code-point list, or
     * any code point outside the covered blocks — all of which mean "cannot
     * prove it fits". There is deliberately no way to get a true out of missing
     * information: the callers spend that false on the full font, or on keeping
     * a script font they might not have needed, and both are recoverable. A
     * wrong true is silent tofu or a silently demoted typeface.
     *
     * @param {number[]} codePoints CJK code points actually seen in the document
     * @param {string} file registry file name
     * @returns {boolean} true only when every code point is provably covered
     */
    function fontCoversAllCJK(codePoints, file) {
        const cov = cjkCoverageOf(file);
        if (!cov) return false;
        if (!Array.isArray(codePoints) || codePoints.length === 0) return false;
        for (const cp of codePoints) {
            if (!cov.has(cp)) return false;
        }
        return true;
    }

    /**
     * Every distinct code point of `text` that falls inside the CJK coverage
     * blocks, sorted.
     *
     * This is DELIBERATELY WIDER than scriptCodePoints(text, ['han']). The han
     * script PATTERN exists to decide whether to ADD a font; this set exists to
     * decide whether one may be REMOVED, and the second question has to account
     * for every character the removed font was the only loaded one able to draw.
     * U+3002 。 and U+FF0C ，— which no Latin fallback we ship covers — are not in
     * the han pattern but are in almost every Chinese sentence.
     *
     * @param {string} text decoded document text
     * @returns {number[]}
     */

    // =====================================================================
    // FG-186: LIST LABELS THE LAYOUT GENERATES.
    //
    // A list numbered 甲 乙 丙 … (or 一 二 三, ア イ ウ, 가 나 다, ０１２ …) has
    // those characters nowhere in the document's text: LibreOffice generates
    // them from the numbering format at layout time. Script detection reads the
    // text, saw no CJK, mounted no CJK face, and the labels drew as boxes
    // (cjklist30.docx). These tables say which characters each format can
    // generate, so the caller can add them to the text sample: han detection,
    // the CJK census and the coverage proofs then see them like any other text.
    //
    // Each set is the format's whole repertoire, taken from LibreOffice
    // (i18npool/inc/bullet.h tables; nativenumber/data/numberchar.h digits and
    // multipliers for the NatNum mode each type uses, defaultnumberingprovider
    // .cxx; the Korean legal words). A superset is safe: it can only make a
    // coverage proof harder, never drop a face a label needs.
    // =====================================================================
    const LIST_LABEL_CHARS = {
        tianGan: '甲乙丙丁戊己庚辛壬癸',
        diZi: '子丑寅卯辰巳午未申酉戌亥',
        aiuFull: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
        aiuHalf: 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ',
        irohaFull: 'イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセスン',
        irohaHalf: 'ｲﾛﾊﾆﾎﾍﾄﾁﾘﾇﾙｦﾜｶﾖﾀﾚｿﾂﾈﾅﾗﾑｳヰﾉｵｸﾔﾏｹﾌｺｴﾃｱｻｷﾕﾒﾐｼヱﾋﾓｾｽﾝ',
        circled: '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿',
        hangulJamo: 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ',
        hangulSyllable: '가나다라마바사아자차카타파하',
        fullwidthDigits: '０１２３４５６７８９',
        // NatNum digit rows and the multipliers used with them.
        zhLower: '零〇一二三四五六七八九京兆亿万千百十',          // NUMBER_LOWER_ZH (NatNum12, zh; libnumbertext zh.sor emits 零)
        zhUpper: '零壹贰叁肆伍陆柒捌玖京兆亿万仟佰拾',            // NUMBER_UPPER_ZH (NatNum5, zh)
        zhTwUpper: '零壹貳參肆伍陸柒捌玖京兆億萬仟佰拾',          // NUMBER_UPPER_ZH_TW (NatNum5, zh-TW)
        jaTraditional: '零壱弐参四伍六七八九〇一二三京兆億萬万阡佰拾千百十', // NUMBER_TRADITIONAL_JA (NatNum8, ja)
        koHanja: '零一二三四五六七八九壹貳參伍京兆億萬千百十阡拾', // NUMBER_DIGITAL2_KO, NUMBER_UPPER_KO
        koHangul: '영일이삼사오육칠팔구조억만천백십',              // NUMBER_HANGUL_KO, NUMBER_DIGITAL_KO (NatNum11/9)
        // NUMBER_LEGAL_KO: the words for 1-99, and NatNum11 Hangul numerals from 100.
        koLegalWords: '곱나넷다덟둘든른마물서섯셋순쉰스아여열예일하홉흔영일이삼사오육칠팔구조억만천백십'
    };

    // DOCX w:numFmt -> the sets it can generate (writerfilter ConversionHelper
    // ::ConvertNumberingType). Formats LibreOffice maps to a Latin type are absent.
    const DOCX_NUMFMT_LABELS = {
        ideographTraditional: ['tianGan'],
        ideographZodiac: ['diZi'],
        aiueo: ['aiuHalf'], aiueoFullWidth: ['aiuFull'],
        iroha: ['irohaHalf'], irohaFullWidth: ['irohaFull'],
        decimalEnclosedCircle: ['circled'], decimalEnclosedCircleChinese: ['circled'],
        ideographEnclosedCircle: ['circled'],
        ganada: ['hangulSyllable'], chosung: ['hangulJamo'],
        koreanLegal: ['koLegalWords'],
        koreanDigital: ['koHangul'], koreanCounting: ['koHangul'], koreanDigital2: ['koHanja'],
        ideographLegalTraditional: ['zhTwUpper'],
        japaneseLegal: ['jaTraditional'],
        chineseCounting: ['zhLower'], japaneseCounting: ['zhLower'], taiwaneseCounting: ['zhLower'],
        taiwaneseCountingThousand: ['zhLower'], ideographDigital: ['zhLower'],
        chineseCountingThousand: ['zhLower'],
        chineseLegalSimplified: ['zhUpper'],
        decimalFullWidth: ['fullwidthDigits'], decimalFullWidth2: ['fullwidthDigits']
    };

    // RTF \levelnfcN -> the DOCX format name it imports as (writerfilter
    // rtfdispatchvalue.cxx getNumberFormat, by index).
    const RTF_LEVELNFC_NUMFMT = [
        'decimal', 'upperRoman', 'lowerRoman', 'upperLetter', 'lowerLetter', 'ordinal',
        'cardinalText', 'ordinalText', 'none', 'none', 'ideographDigital', 'japaneseCounting',
        'aiueo', 'iroha', 'decimalFullWidth', 'decimalHalfWidth', 'japaneseLegal',
        'japaneseDigitalTenThousand', 'decimalEnclosedCircleChinese', 'decimalFullWidth2',
        'aiueoFullWidth', 'irohaFullWidth', 'decimalZero', 'bullet', 'ganada', 'chosung',
        'decimalEnclosedFullstop', 'decimalEnclosedParen', 'decimalEnclosedCircleChinese',
        'ideographEnclosedCircle', 'ideographTraditional', 'ideographZodiac',
        'ideographZodiacTraditional', 'taiwaneseCounting', 'ideographLegalTraditional',
        'taiwaneseCountingThousand', 'taiwaneseDigital', 'chineseCounting',
        'chineseLegalSimplified', 'chineseCountingThousand', 'decimal', 'koreanDigital',
        'koreanCounting', 'koreanLegal', 'koreanDigital2', 'hebrew1', 'arabicAlpha', 'hebrew2',
        'arabicAbjad', 'none'
    ];

    // Own properties only: the names come from the document, and a plain-object
    // lookup of "toString" or "constructor" returned a function, the loop threw,
    // and the caller's catch dropped every label in the document (WAF review).
    const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

    /** The characters a set of DOCX numFmt names can generate ('' for Latin formats). */
    function listLabelCharsForNumFmts(numFmts) {
        const seen = new Set();
        for (const f of numFmts || []) {
            const name = String(f).trim();
            if (!hasOwn(DOCX_NUMFMT_LABELS, name)) continue;
            for (const set of DOCX_NUMFMT_LABELS[name]) {
                if (!hasOwn(LIST_LABEL_CHARS, set)) continue;
                for (const ch of LIST_LABEL_CHARS[set]) seen.add(ch);
            }
        }
        return Array.from(seen).join('');
    }

    /**
     * The characters ODF `style:num-format` values can generate. ODF names a
     * non-Latin format by its first label ("甲, 乙, 丙, ...", "一, 二, 三, ...", "가,
     * 나, 다, ..."), so every set containing that first character is taken.
     */
    function listLabelCharsForOdfNumFormats(values) {
        const seen = new Set();
        for (const v of values || []) {
            const first = Array.from(String(v || '').trim())[0];
            if (!first || first.charCodeAt(0) < 0x80) continue;
            for (const set of Object.values(LIST_LABEL_CHARS)) {
                if (set.includes(first)) for (const ch of set) seen.add(ch);
            }
        }
        return Array.from(seen).join('');
    }

    /** The characters an RTF's `\levelnfcN` / `\levelnfcnN` list levels can generate. */
    function listLabelCharsForRtf(rtfText) {
        const names = new Set();
        const s = String(rtfText || '');
        const re = /\\levelnfcn?(\d{1,3})(?![0-9])/g;
        let m;
        while ((m = re.exec(s)) !== null) {
            const idx = Number(m[1]);
            const name = idx < RTF_LEVELNFC_NUMFMT.length ? RTF_LEVELNFC_NUMFMT[idx] : null;
            if (typeof name === 'string') names.add(name);
        }
        return listLabelCharsForNumFmts(Array.from(names));
    }

    function cjkCoveragePoints(text) {
        const seen = new Set();
        const s = String(text || '');
        for (const ch of s) {
            const cp = ch.codePointAt(0);
            if (cjkBitIndex(cp) >= 0) seen.add(cp);
        }
        return Array.from(seen).sort((a, b) => a - b);
    }

    /**
     * The Latin fonts every conversion loads regardless of what the document asks
     * for — the substitution targets for Arial/Times/Courier/Calibri and the
     * generic sans/serif/mono fallbacks. Without these you get tofu boxes, which
     * is a silent rendering failure: the PDF is produced, downloaded, and wrong.
     *
     * ONE list, two readers. font_resolver.js (main thread, the normal path) and
     * conversion_worker.js (the fallback path, used when the resolver was
     * unavailable or threw) each used to carry their own copy — font_resolver.js's
     * even carried the comment "mirrors ESSENTIAL_FONT_FAMILIES in
     * conversion_worker.js", which is an admission that nothing enforced the
     * mirroring. The fallback path is exactly where drift would go unnoticed: it
     * only runs when the primary path has already failed. BUG-21 is the precedent —
     * the two font paths disagreed and the user got tofu.
     *
     * Order is meaningful: it is the load order, most-substituted first.
     * @type {ReadonlyArray<string>}
     */
    const ESSENTIAL_FONT_FAMILIES = Object.freeze([
        'Liberation Sans',        // Arial, Calibri, Helvetica substitute
        'Liberation Sans Narrow', // Narrow variants
        'Liberation Serif',       // Times New Roman, Cambria substitute
        'Liberation Mono',        // Courier New, Consolas substitute
        'DejaVu Sans',            // General sans-serif fallback
        'DejaVu Serif',           // General serif fallback
        'DejaVu Sans Mono'        // Monospace fallback
    ]);

    const SCRIPTS = [
        {
            id: 'han',
            label: 'Chinese/Japanese',
            // Kana, CJK Unified (+ Ext A), compatibility ideographs, halfwidth kana.
            pattern: /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g,
            files: ['DroidSansFallbackFull.ttf']
        },
        // ---------------------------------------------------------------
        // SCRIPTS DejaVu COVERS BUT THAT ARE NOT ALWAYS MOUNTED.
        //
        // These four had no entry on purpose. The reasoning, recorded in
        // tests/unit/test_protocol_helpers.js, was: "DejaVuSans.ttf is in the
        // ALWAYS-LOADED essential set and already draws Hebrew, Arabic,
        // Georgian, Armenian and Lao. Adding entries for them would download a
        // second font per document to render text that already renders."
        //
        // The coverage half is true. The "always-loaded" half is not.
        // ESSENTIAL_FONT_FAMILIES holds DejaVu Sans and is used "when nothing
        // better is known" — but a ZIP format (DOCX/XLSX/PPTX) is not that case.
        // It names its own fonts and takes the extractable path, which unions
        // FALLBACK_CORE_FAMILIES: Liberation only, with DejaVu deliberately
        // excluded there as ~742 KB those documents "do not need".
        //
        // MEASURED 2026-08-29 on a PPTX carrying all five scripts, one line
        // each, against the same text as .txt:
        //
        //   .txt  (essential path, DejaVu mounted)   all five render
        //   .pptx (extractable path, no DejaVu)      Hebrew renders;
        //                                            Arabic, Georgian, Armenian
        //                                            and Lao are ROWS OF BOXES
        //
        // Hebrew keeps its exemption because it genuinely still renders — Carlito
        // and Liberation cover it — so an entry for it really would be the wasted
        // download the original note describes. The other four get one.
        // ---------------------------------------------------------------
        {
            id: 'arabic',
            label: 'Arabic',
            // + Arabic Extended-A (U+08A0-08FF, FG-168): DejaVu Sans has 0/96 of it and
            // NotoSansArabic 75/96 (measured 2026-10-04). Presentation Forms-B
            // (U+FE70-FEFF) needs no entry: DejaVu Sans covers 141/144.
            pattern: /[\u0600-\u06FF\u08A0-\u08FF]/g,
            files: ['NotoSansArabic-Regular.ttf']
        },
        {
            id: 'georgian',
            label: 'Georgian',
            pattern: /[\u10A0-\u10FF]/g,
            files: ['NotoSansGeorgian-Regular.ttf']
        },
        {
            id: 'armenian',
            label: 'Armenian',
            pattern: /[\u0530-\u058F]/g,
            files: ['NotoSansArmenian-Regular.ttf']
        },
        {
            id: 'lao',
            label: 'Lao',
            pattern: /[\u0E80-\u0EFF]/g,
            files: ['NotoSansLao-Regular.ttf']
        },
        {
            id: 'thai',
            label: 'Thai',
            pattern: /[฀-๿]/g,
            files: ['NotoSansThai-Regular.ttf']
        },
        {
            id: 'devanagari',
            label: 'Devanagari (Hindi/Marathi/Nepali)',
            pattern: /[ऀ-ॿ]/g,
            files: ['NotoSansDevanagari-Regular.ttf']
        },

        // --------------------------------------------------------------
        // Indic (beyond Devanagari). Each is ONE Unicode block with no
        // Extended/Supplement companion that the chosen font covers, so each
        // pattern is exactly that block. The blocks are ~60-77% assigned --
        // the holes are Unicode's own reserved slots, not font gaps, and a
        // reserved code point cannot appear in real text, so matching the
        // whole block costs nothing and keeps the range readable.
        // --------------------------------------------------------------
        {
            id: 'bengali',
            label: 'Bengali/Assamese',
            // Bengali U+0980-09FF (Assamese shares the block).
            pattern: /[ঀ-৿]/g,
            files: ['NotoSansBengali-Regular.ttf']
        },
        {
            id: 'gurmukhi',
            label: 'Punjabi (Gurmukhi)',
            // Gurmukhi U+0A00-0A7F.
            pattern: /[਀-੿]/g,
            files: ['NotoSerifGurmukhi-Regular.ttf']
        },
        {
            id: 'gujarati',
            label: 'Gujarati',
            // Gujarati U+0A80-0AFF.
            pattern: /[઀-૿]/g,
            files: ['NotoSerifGujarati-Regular.ttf']
        },
        {
            id: 'tamil',
            label: 'Tamil',
            // Tamil U+0B80-0BFF ONLY. Tamil Supplement (U+11FC0-11FFF) is
            // deliberately excluded: measured coverage in this font is 0/64,
            // so including it would promise glyphs that are not there.
            pattern: /[஀-௿]/g,
            files: ['NotoSansTamil-Regular.ttf']
        },
        {
            id: 'telugu',
            label: 'Telugu',
            // Telugu U+0C00-0C7F.
            pattern: /[ఀ-౿]/g,
            files: ['NotoSansTelugu-Regular.ttf']
        },
        {
            id: 'kannada',
            label: 'Kannada',
            // Kannada U+0C80-0CFF.
            pattern: /[ಀ-೿]/g,
            files: ['NotoSansKannada-Regular.ttf']
        },
        {
            id: 'sinhala',
            label: 'Sinhala',
            // Sinhala U+0D80-0DFF + Sinhala Archaic Numbers U+111E0-111FF.
            // The archaic-numbers block IS included because every assigned code
            // point in it (U+111E1-111F4) was measured present in this font;
            // the unmatched remainder of the block is unassigned in Unicode.
            // Astral range => /u is required (see detectScripts on flags).
            pattern: /[඀-෿\u{111E0}-\u{111FF}]/gu,
            files: ['NotoSansSinhala-Regular.ttf']
        },

        // --------------------------------------------------------------
        // South-East Asian
        // --------------------------------------------------------------
        {
            id: 'myanmar',
            label: 'Burmese (Myanmar)',
            // Myanmar U+1000-109F (160/160), Ext-B U+A9E0-A9FF, Ext-A
            // U+AA60-AA7F (32/32). All three measured fully covered, so all
            // three are in. Ext-B's single miss (U+A9FF) is unassigned.
            // NB U+A9E0-A9FF sits just above Hangul Jamo Ext-A (U+A960-A97F);
            // the ranges are adjacent but disjoint.
            pattern: /[က-႟ꧠ-꧿ꩠ-ꩿ]/g,
            files: ['NotoSansMyanmar-Regular.ttf']
        },
        {
            id: 'khmer',
            label: 'Khmer',
            // Khmer U+1780-17FF + Khmer Symbols U+19E0-19FF (32/32 covered).
            pattern: /[ក-៿᧠-᧿]/g,
            files: ['NotoSansKhmer-Regular.ttf']
        },

        // --------------------------------------------------------------
        // Other
        // --------------------------------------------------------------
        {
            id: 'ethiopic',
            label: 'Ethiopic (Amharic/Tigrinya)',
            // Ethiopic U+1200-137F, Supplement U+1380-139F, Extended
            // U+2D80-2DDF, Extended-A U+AB00-AB2F -- all measured covered for
            // their assigned code points. Extended-B (U+1E7E0-1E7FF) is
            // EXCLUDED: 0/32 in this font.
            pattern: /[ሀ-᎟ⶀ-⷟꬀-꬯]/g,
            files: ['NotoSerifEthiopic-Regular.ttf']
        },
        {
            id: 'cherokee',
            label: 'Cherokee',
            // Cherokee U+13A0-13FF + Cherokee Supplement U+AB70-ABBF (80/80).
            // The four unmatched points in the main block are unassigned.
            pattern: /[Ꭰ-᏿ꭰ-ꮿ]/g,
            files: ['NotoSansCherokee-Regular.ttf']
        },

        // ==================================================================
        // THE SCRIPTS WE SHIPPED A FONT FOR AND NEVER ROUTED TO.
        //
        // web/fonts/ carries 336 files covering ~195 Noto families. Until this
        // block, SCRIPTS reached 17 of them. Every other family was DEAD
        // WEIGHT IN THE TREE: present, registered in fonts.json, downloadable
        // — and unreachable, because nothing detected the script that would
        // ask for it. Documents in those scripts converted to a PDF whose text
        // layer was perfect and whose every glyph was an empty box.
        //
        // Confirmed by conversion, not by reading code: a plain UTF-8 .txt
        // rendered to PNG showed boxes for Tibetan, Mongolian, Syriac, Thaana
        // and Vai while we shipped Noto Serif Tibetan, Noto Sans Mongolian,
        // Noto Sans Syriac, Noto Sans Thaana and Noto Sans Vai.
        //
        // HOW THIS SET WAS CHOSEN, since "wire all 182" would be wrong. Every
        // Unicode block was measured three ways — what the always-loaded
        // essential set draws, what this table already reached, and the best
        // single shipped font — and a block earns an entry only when all of:
        //   1. the essential set does NOT already draw it (Armenian, Georgian,
        //      Lao, Arabic, Hebrew, Greek, Cyrillic, Ogham, Lisu, Braille and
        //      the Latin/Greek extensions are covered by DejaVu Sans and are
        //      deliberately absent from this table — they render today);
        //   2. a shipped font draws essentially all of it, READ FROM ITS CMAP
        //      (BUG-17: DroidSansFallbackFull.ttf covers 3 of 11172 Hangul
        //      syllables. A filename is not evidence.);
        //   3. the script has a real, living user population — an official
        //      language, a state-mandated orthography, a community that writes
        //      in it now.
        // Rule 3 is why the historic and scholarly scripts are NOT here even
        // though we ship perfectly good fonts for them: Linear A and B,
        // Cuneiform, Egyptian and Anatolian Hieroglyphs, Gothic, Ugaritic,
        // Phoenician, Old Persian/Turkic/Hungarian/Permic/Sogdian, the
        // Inscriptional and Meroitic families, Avestan, Kharoshthi, Brahmi,
        // Tangut, Nushu, Duployan, Sutton SignWriting, the musical-notation
        // blocks, Deseret, Shavian, Phags-pa. See the deliberate-omission list
        // in tests/gates/test_script_coverage.js, which pins the decision so a
        // later reader can see it was a decision.
        //
        // WHAT AN ENTRY COSTS. Nothing for a document that does not contain
        // the script: fonts are fetched per-document, so this adds ZERO bytes
        // to an English conversion. The cost is one character-class scan of
        // the text sample. Measured on a 256 KB Latin sample: 0.2 ms for the
        // whole table at 17 entries, 0.6 ms at 75. That asymmetry is why the
        // list is generous.
        //
        // WHY THE RANGES ARE \u{...} ESCAPES rather than the literal
        // characters used above. Every one of them was GENERATED from the
        // named font's cmap and then re-derived and re-checked by
        // tests/gates/test_script_coverage.js, which fails if the table and
        // the font disagree in either direction. Where a range has a hole, the
        // comment says which code point and why. Unassigned Unicode positions
        // are left inside a range on purpose — they cannot occur in real text.
        // ==================================================================
        {
            id: 'malayalam',
            label: 'Malayalam',
            // Malayalam U+0D00-0D7F. ~38 M speakers; the official language of Kerala.
            // One of the two largest populations left unreachable by this table.
            pattern: new RegExp('[' + '\u{D00}-\u{D7F}' + ']', 'gu'),
            files: ['NotoSansMalayalam-Regular.ttf']
        },
        {
            id: 'odia',
            label: 'Odia (Oriya)',
            // Oriya U+0B00-0B7F. ~35 M speakers; the official language of Odisha and one
            // of India's 22 scheduled languages.
            // MEASURED EXCLUSION: NotoSansOriya-Regular.ttf cannot draw U+B55 — left out
            // of the pattern rather than
            // promised and then not delivered. No shipped font draws it.
            pattern: new RegExp('[' + '\u{B00}-\u{B54}\u{B56}-\u{B7F}' + ']', 'gu'),
            files: ['NotoSansOriya-Regular.ttf']
        },
        {
            id: 'tibetan',
            label: 'Tibetan',
            // Tibetan U+0F00-0FFF. Tibetan, Dzongkha (official in Bhutan), Ladakhi.
            // Measured as boxes on a plain UTF-8 .txt before this entry existed.
            pattern: new RegExp('[' + '\u{F00}-\u{FFF}' + ']', 'gu'),
            files: ['NotoSerifTibetan-Regular.ttf']
        },
        {
            id: 'mongolian',
            label: 'Mongolian (traditional)',
            // Mongolian U+1800-18AF + Mongolian Supplement U+11660-1167F. The traditional
            // vertical script: the sole official script of Inner Mongolia and co-official
            // in Mongolia since 2025. Measured as boxes before this entry existed.
            // MEASURED EXCLUSION: NotoSansMongolian-Regular.ttf cannot draw U+180F —
            // left out of the pattern rather than
            // promised and then not delivered. No shipped font draws it.
            pattern: new RegExp('[' + '\u{1800}-\u{180E}\u{1810}-\u{18AF}\u{11660}-\u{1167F}' + ']', 'gu'),
            files: ['NotoSansMongolian-Regular.ttf']
        },
        {
            id: 'syriac',
            label: 'Syriac',
            // Syriac U+0700-074F. Liturgical across the Syriac churches and the everyday
            // script of Neo-Aramaic communities. Measured as boxes before this entry.
            // Syriac Supplement U+0860-086F (Garshuni, 11 code points) is NOT included:
            // no font in web/fonts/ draws a single one of them.
            pattern: new RegExp('[' + '\u{700}-\u{74F}' + ']', 'gu'),
            files: ['NotoSansSyriac-Regular.ttf']
        },
        {
            id: 'thaana',
            label: 'Thaana (Dhivehi)',
            // Thaana U+0780-07BF. The sole script of Dhivehi, official in the Maldives.
            // Measured as boxes before this entry existed.
            pattern: new RegExp('[' + '\u{780}-\u{7BF}' + ']', 'gu'),
            files: ['NotoSansThaana-Regular.ttf']
        },
        {
            id: 'nko',
            label: "N'Ko",
            // NKo U+07C0-07FF. Manding languages across West Africa, in active daily use.
            // PARTIAL, NOT ABSENT, before this entry: DejaVuSans draws 54 of the 62
            // assigned points, so N'Ko text mostly rendered and then dropped 8 characters
            // into boxes (U+07E8-07EA, U+07F6-07F7, U+07FD-07FF) with no warning.
            // 0.04 MB buys the whole script in one consistent face.
            pattern: new RegExp('[' + '\u{7C0}-\u{7FF}' + ']', 'gu'),
            files: ['NotoSansNKo-Regular.ttf']
        },
        {
            id: 'samaritan',
            label: 'Samaritan',
            // Samaritan U+0800-083F. Small but living liturgical and community use.
            pattern: new RegExp('[' + '\u{800}-\u{83F}' + ']', 'gu'),
            files: ['NotoSansSamaritan-Regular.ttf']
        },
        {
            id: 'mandaic',
            label: 'Mandaic',
            // Mandaic U+0840-085F. Mandaean liturgy and Neo-Mandaic.
            pattern: new RegExp('[' + '\u{840}-\u{85F}' + ']', 'gu'),
            files: ['NotoSansMandaic-Regular.ttf']
        },
        {
            id: 'arabic-extended',
            label: 'extended Arabic',
            // Arabic Supplement U+0750-077F + Arabic Presentation Forms-A U+FB50-FDFF.
            // NOT the main Arabic block: DejaVuSans covers that (measured 165/256) and
            // ordinary Arabic renders today, so it stays as it is.
            // 
            // These two do NOT render. Arabic Supplement is 0/48 in the essential set --
            // it holds the extra letters for Arabic-script African and Asian languages
            // (Fula, Hausa, Kanuri, Khowar, Torwali). Presentation Forms-A is 108/631,
            // the ligature forms legacy Arabic documents are full of, and it contains
            // U+FDFA and U+FDFD, which appear in more or less every Islamic text.
            // MEASURED EXCLUSION: NotoNaskhArabic-Regular.ttf cannot draw U+FBC2,
            // U+FD40, U+FD41, U+FD42, U+FD43, U+FD44, U+FD45, U+FD46, U+FD47, U+FD48,
            // U+FD49, U+FD4A, U+FD4B, U+FD4C, U+FD4D, U+FD4E, U+FD4F, U+FDCF, U+FDFE,
            // U+FDFF — left out of the pattern rather than
            // promised and then not delivered. No shipped font draws them.
            pattern: new RegExp('[' + '\u{750}-\u{77F}\u{FB50}-\u{FBC1}\u{FBC3}-\u{FD3F}\u{FD50}-\u{FDCE}\u{FDD0}-\u{FDFD}' + ']', 'gu'),
            files: ['NotoNaskhArabic-Regular.ttf']
        },
        {
            id: 'georgian-mtavruli',
            label: 'Georgian Mtavruli (capitals)',
            // Georgian Extended U+1C90-1CBF = MTAVRULI, the capital forms modern Georgian
            // uses for headings, emphasis and all-caps. 0/46 in the essential set while
            // the main Georgian block is 83/88, so plain Georgian rendered and every
            // all-caps heading in the same document came out as boxes. That asymmetry is
            // exactly the kind of gap a block-blind table hides.
            pattern: new RegExp('[' + '\u{1C90}-\u{1CBF}' + ']', 'gu'),
            files: ['NotoSansGeorgian-Regular.ttf']
        },
        {
            id: 'canadian-aboriginal',
            label: 'Canadian Aboriginal Syllabics (Inuktitut/Cree)',
            // UCAS U+1400-167F + Extended U+18B0-18FF. Inuktitut (co-official in Nunavut
            // and the NWT), Cree, Ojibwe, Naskapi.
            // PARTIAL, NOT ABSENT, before this entry: DejaVuSans draws 404 of the 640
            // assigned points in the main block, so syllabics text rendered with 236
            // scattered boxes in it. Extended is 0/70.
            // Extended-A U+11AB0-11ABF is NOT included: 0/16 in this font and in every
            // other font we ship.
            pattern: new RegExp('[' + '\u{1400}-\u{167F}\u{18B0}-\u{18FF}' + ']', 'gu'),
            files: ['NotoSansCanadianAboriginal-Regular.ttf']
        },
        {
            id: 'limbu',
            label: 'Limbu',
            // Limbu U+1900-194F. Nepal and Sikkim; taught in schools.
            pattern: new RegExp('[' + '\u{1900}-\u{194F}' + ']', 'gu'),
            files: ['NotoSansLimbu-Regular.ttf']
        },
        {
            id: 'tai-le',
            label: 'Tai Le',
            // Tai Le U+1950-197F. Dehong Dai, Yunnan.
            pattern: new RegExp('[' + '\u{1950}-\u{197F}' + ']', 'gu'),
            files: ['NotoSansTaiLe-Regular.ttf']
        },
        {
            id: 'new-tai-lue',
            label: 'New Tai Lue',
            // New Tai Lue U+1980-19DF. Tai Lue, Yunnan; the official modern form.
            pattern: new RegExp('[' + '\u{1980}-\u{19DF}' + ']', 'gu'),
            files: ['NotoSansNewTaiLue-Regular.ttf']
        },
        {
            id: 'buginese',
            label: 'Buginese (Lontara)',
            // Buginese U+1A00-1A1F. Lontara, South Sulawesi.
            pattern: new RegExp('[' + '\u{1A00}-\u{1A1F}' + ']', 'gu'),
            files: ['NotoSansBuginese-Regular.ttf']
        },
        {
            id: 'tai-tham',
            label: 'Tai Tham (Lanna)',
            // Tai Tham U+1A20-1AAF. Northern Thai, Tai Lue, Khun; liturgical and
            // increasingly signage across northern Thailand.
            pattern: new RegExp('[' + '\u{1A20}-\u{1AAF}' + ']', 'gu'),
            files: ['NotoSansTaiTham-Regular.ttf']
        },
        {
            id: 'balinese',
            label: 'Balinese',
            // Balinese U+1B00-1B7F. Taught in Bali's schools and mandated on signage.
            // MEASURED EXCLUSION: NotoSansBalinese-Regular.ttf cannot draw U+1B4C,
            // U+1B7D, U+1B7E — left out of the pattern rather than
            // promised and then not delivered. No shipped font draws them.
            pattern: new RegExp('[' + '\u{1B00}-\u{1B4B}\u{1B4D}-\u{1B7C}\u{1B7F}' + ']', 'gu'),
            files: ['NotoSansBalinese-Regular.ttf']
        },
        {
            id: 'sundanese',
            label: 'Sundanese',
            // Sundanese U+1B80-1BBF + Supplement U+1CC0-1CCF. ~32 M speakers; the script
            // is taught in West Java.
            pattern: new RegExp('[' + '\u{1B80}-\u{1BBF}\u{1CC0}-\u{1CCF}' + ']', 'gu'),
            files: ['NotoSansSundanese-Regular.ttf']
        },
        {
            id: 'batak',
            label: 'Batak',
            // Batak U+1BC0-1BFF. North Sumatra.
            pattern: new RegExp('[' + '\u{1BC0}-\u{1BFF}' + ']', 'gu'),
            files: ['NotoSansBatak-Regular.ttf']
        },
        {
            id: 'lepcha',
            label: 'Lepcha',
            // Lepcha U+1C00-1C4F. Sikkim and Darjeeling; an official language of Sikkim.
            pattern: new RegExp('[' + '\u{1C00}-\u{1C4F}' + ']', 'gu'),
            files: ['NotoSansLepcha-Regular.ttf']
        },
        {
            id: 'ol-chiki',
            label: 'Santali (Ol Chiki)',
            // Ol Chiki U+1C50-1C7F. Santali, ~7.6 M speakers, one of India's 22 scheduled
            // languages and written in this script by law in Jharkhand and West Bengal.
            pattern: new RegExp('[' + '\u{1C50}-\u{1C7F}' + ']', 'gu'),
            files: ['NotoSansOlChiki-Regular.ttf']
        },
        {
            id: 'tagalog',
            label: 'Baybayin (Tagalog)',
            // Tagalog U+1700-171F. Baybayin: taught in Philippine schools and used on
            // currency and government signage.
            // MEASURED EXCLUSION: NotoSansTagalog-Regular.ttf cannot draw U+170D,
            // U+1715, U+171F — left out of the pattern rather than
            // promised and then not delivered. No shipped font draws them.
            pattern: new RegExp('[' + '\u{1700}-\u{170C}\u{170E}-\u{1714}\u{1716}-\u{171E}' + ']', 'gu'),
            files: ['NotoSansTagalog-Regular.ttf']
        },
        {
            id: 'hanunoo',
            label: 'Hanunoo',
            // Hanunoo U+1720-173F. Mindoro; still written by hand today.
            pattern: new RegExp('[' + '\u{1720}-\u{173F}' + ']', 'gu'),
            files: ['NotoSansHanunoo-Regular.ttf']
        },
        {
            id: 'buhid',
            label: 'Buhid',
            // Buhid U+1740-175F. Mindoro.
            pattern: new RegExp('[' + '\u{1740}-\u{175F}' + ']', 'gu'),
            files: ['NotoSansBuhid-Regular.ttf']
        },
        {
            id: 'tagbanwa',
            label: 'Tagbanwa',
            // Tagbanwa U+1760-177F. Palawan.
            pattern: new RegExp('[' + '\u{1760}-\u{177F}' + ']', 'gu'),
            files: ['NotoSansTagbanwa-Regular.ttf']
        },
        {
            id: 'tifinagh',
            label: 'Tifinagh (Tamazight)',
            // Tifinagh U+2D30-2D7F. Neo-Tifinagh is the official script of Tamazight in
            // Morocco (road signs, schoolbooks, the constitution).
            // PARTIAL, NOT ABSENT, before this entry: DejaVuSans draws 55 of 59, missing
            // U+2D66, U+2D67, U+2D70 and U+2D7F -- and U+2D70 is the Tifinagh separator
            // mark, i.e. punctuation, so it turns up in ordinary running text.
            pattern: new RegExp('[' + '\u{2D30}-\u{2D7F}' + ']', 'gu'),
            files: ['NotoSansTifinagh-Regular.ttf']
        },
        {
            id: 'coptic',
            label: 'Coptic',
            // Coptic U+2C80-2CFF + Coptic Epact Numbers U+102E0-102FF. The liturgical
            // language of the Coptic Orthodox Church; service books are printed in it now.
            pattern: new RegExp('[' + '\u{2C80}-\u{2CFF}\u{102E0}-\u{102FF}' + ']', 'gu'),
            files: ['NotoSansCoptic-Regular.ttf']
        },
        {
            id: 'yi',
            label: 'Yi (Nuosu)',
            // Yi Syllables U+A000-A48F + Yi Radicals U+A490-A4CF. ~2 M speakers; the
            // standardised syllabary is co-official in Liangshan, Sichuan.
            // 1220 assigned code points for 0.17 MB.
            pattern: new RegExp('[' + '\u{A000}-\u{A4CF}' + ']', 'gu'),
            files: ['NotoSansYi-Regular.ttf']
        },
        {
            id: 'vai',
            label: 'Vai',
            // Vai U+A500-A63F. Liberia and Sierra Leone; an indigenous syllabary in
            // continuous everyday use since the 1830s.
            // Measured as boxes before this entry existed.
            pattern: new RegExp('[' + '\u{A500}-\u{A63F}' + ']', 'gu'),
            files: ['NotoSansVai-Regular.ttf']
        },
        {
            id: 'bamum',
            label: 'Bamum',
            // Bamum U+A6A0-A6FF + Bamum Supplement U+16800-16A3F. Cameroon; taught by the
            // Bamum Scripts and Archives Project.
            pattern: new RegExp('[' + '\u{A6A0}-\u{A6FF}\u{16800}-\u{16A3F}' + ']', 'gu'),
            files: ['NotoSansBamum-Regular.ttf']
        },
        {
            id: 'syloti-nagri',
            label: 'Syloti Nagri',
            // Syloti Nagri U+A800-A82F. Sylheti, Bangladesh and the UK diaspora.
            pattern: new RegExp('[' + '\u{A800}-\u{A82F}' + ']', 'gu'),
            files: ['NotoSansSylotiNagri-Regular.ttf']
        },
        {
            id: 'saurashtra',
            label: 'Saurashtra',
            // Saurashtra U+A880-A8DF. Tamil Nadu.
            pattern: new RegExp('[' + '\u{A880}-\u{A8DF}' + ']', 'gu'),
            files: ['NotoSansSaurashtra-Regular.ttf']
        },
        {
            id: 'kayah-li',
            label: 'Kayah Li',
            // Kayah Li U+A900-A92F. Karenni, Myanmar and Thailand.
            pattern: new RegExp('[' + '\u{A900}-\u{A92F}' + ']', 'gu'),
            files: ['NotoSansKayahLi-Regular.ttf']
        },
        {
            id: 'rejang',
            label: 'Rejang',
            // Rejang U+A930-A95F. Sumatra.
            pattern: new RegExp('[' + '\u{A930}-\u{A95F}' + ']', 'gu'),
            files: ['NotoSansRejang-Regular.ttf']
        },
        {
            id: 'javanese',
            label: 'Javanese',
            // Javanese U+A980-A9DF. Aksara Jawa: taught in Central and East Java and
            // mandated on street signage in Yogyakarta.
            pattern: new RegExp('[' + '\u{A980}-\u{A9DF}' + ']', 'gu'),
            files: ['NotoSansJavanese-Regular.ttf']
        },
        {
            id: 'cham',
            label: 'Cham',
            // Cham U+AA00-AA5F. Vietnam and Cambodia; taught in Ninh Thuan.
            pattern: new RegExp('[' + '\u{AA00}-\u{AA5F}' + ']', 'gu'),
            files: ['NotoSansCham-Regular.ttf']
        },
        {
            id: 'tai-viet',
            label: 'Tai Viet',
            // Tai Viet U+AA80-AADF. Tai Dam / Tai Don, northwestern Vietnam and Laos.
            pattern: new RegExp('[' + '\u{AA80}-\u{AADF}' + ']', 'gu'),
            files: ['NotoSansTaiViet-Regular.ttf']
        },
        {
            id: 'meetei-mayek',
            label: 'Meitei (Meetei Mayek)',
            // Meetei Mayek U+ABC0-ABFF + Extensions U+AAE0-AAFF. Manipuri, one of India's
            // 22 scheduled languages; Manipur made this script mandatory in schools.
            pattern: new RegExp('[' + '\u{AAE0}-\u{AAFF}\u{ABC0}-\u{ABFF}' + ']', 'gu'),
            files: ['NotoSansMeeteiMayek-Regular.ttf']
        },
        {
            id: 'osage',
            label: 'Osage',
            // Osage U+104B0-104FF. Devised 2006-2014 and now the Osage Nation's official
            // orthography -- a script that exists only because people write in it.
            pattern: new RegExp('[' + '\u{104B0}-\u{104FF}' + ']', 'gu'),
            files: ['NotoSansOsage-Regular.ttf']
        },
        {
            id: 'adlam',
            label: 'Adlam (Fulani)',
            // Adlam U+1E900-1E95F. Invented in the 1980s for Fulani and one of the
            // fastest-growing scripts in real digital use across West Africa.
            pattern: new RegExp('[' + '\u{1E900}-\u{1E95F}' + ']', 'gu'),
            files: ['NotoSansAdlam-Regular.ttf']
        },
        {
            id: 'hanifi-rohingya',
            label: 'Hanifi Rohingya',
            // Hanifi Rohingya U+10D00-10D3F. The modern script for Rohingya.
            pattern: new RegExp('[' + '\u{10D00}-\u{10D3F}' + ']', 'gu'),
            files: ['NotoSansHanifiRohingya-Regular.ttf']
        },
        {
            id: 'chakma',
            label: 'Chakma',
            // Chakma U+11100-1114F. Chittagong Hill Tracts, Bangladesh and India.
            // MEASURED EXCLUSION: NotoSansChakma-Regular.ttf cannot draw U+11147 — left
            // out of the pattern rather than
            // promised and then not delivered. No shipped font draws it.
            pattern: new RegExp('[' + '\u{11100}-\u{11146}\u{11148}-\u{1114F}' + ']', 'gu'),
            files: ['NotoSansChakma-Regular.ttf']
        },
        {
            id: 'medefaidrin',
            label: 'Medefaidrin',
            // Medefaidrin U+16E40-16E9F. Oberi Okaime, Nigeria; in liturgical use.
            pattern: new RegExp('[' + '\u{16E40}-\u{16E9F}' + ']', 'gu'),
            files: ['NotoSansMedefaidrin-Regular.ttf']
        },
        {
            id: 'miao',
            label: 'Miao (Pollard)',
            // Miao U+16F00-16F9F. The Pollard script for A-Hmao, Yunnan and Guizhou;
            // actively used in publishing and church literature.
            pattern: new RegExp('[' + '\u{16F00}-\u{16F9F}' + ']', 'gu'),
            files: ['NotoSansMiao-Regular.ttf']
        },
        {
            id: 'pahawh-hmong',
            label: 'Pahawh Hmong',
            // Pahawh Hmong U+16B00-16B8F. Hmong, in Laos and the diaspora.
            pattern: new RegExp('[' + '\u{16B00}-\u{16B8F}' + ']', 'gu'),
            files: ['NotoSansPahawhHmong-Regular.ttf']
        },
        {
            id: 'nyiakeng-puachue-hmong',
            label: 'Nyiakeng Puachue Hmong',
            // Nyiakeng Puachue Hmong U+1E100-1E14F. Devised in the 1980s, in use by Hmong
            // communities in the US and Australia.
            pattern: new RegExp('[' + '\u{1E100}-\u{1E14F}' + ']', 'gu'),
            files: ['NotoSerifNyiakengPuachueHmong-Regular.ttf']
        },
        {
            id: 'warang-citi',
            label: 'Warang Citi (Ho)',
            // Warang Citi U+118A0-118FF. Ho, ~1.4 M speakers, Jharkhand and Odisha.
            pattern: new RegExp('[' + '\u{118A0}-\u{118FF}' + ']', 'gu'),
            files: ['NotoSansWarangCiti-Regular.ttf']
        },
        {
            id: 'sora-sompeng',
            label: 'Sora Sompeng',
            // Sora Sompeng U+110D0-110FF. Sora, Odisha and Andhra Pradesh.
            pattern: new RegExp('[' + '\u{110D0}-\u{110FF}' + ']', 'gu'),
            files: ['NotoSansSoraSompeng-Regular.ttf']
        },
        {
            id: 'masaram-gondi',
            label: 'Masaram Gondi',
            // Masaram Gondi U+11D00-11D5F. Gondi, central India.
            pattern: new RegExp('[' + '\u{11D00}-\u{11D5F}' + ']', 'gu'),
            files: ['NotoSansMasaramGondi-Regular.ttf']
        },
        {
            id: 'gunjala-gondi',
            label: 'Gunjala Gondi',
            // Gunjala Gondi U+11D60-11DAF. Gondi, Adilabad; revived and taught since 2014.
            pattern: new RegExp('[' + '\u{11D60}-\u{11DAF}' + ']', 'gu'),
            files: ['NotoSansGunjalaGondi-Regular.ttf']
        },
        {
            id: 'mro',
            label: 'Mro',
            // Mro U+16A40-16A6F. Mru, Chittagong Hill Tracts.
            pattern: new RegExp('[' + '\u{16A40}-\u{16A6F}' + ']', 'gu'),
            files: ['NotoSansMro-Regular.ttf']
        },
        {
            id: 'bassa-vah',
            label: 'Bassa Vah',
            // Bassa Vah U+16AD0-16AFF. Bassa, Liberia; under active revival.
            pattern: new RegExp('[' + '\u{16AD0}-\u{16AFF}' + ']', 'gu'),
            files: ['NotoSansBassaVah-Regular.ttf']
        },
        {
            id: 'mende-kikakui',
            label: 'Mende Kikakui',
            // Mende Kikakui U+1E800-1E8DF. Mende, Sierra Leone.
            pattern: new RegExp('[' + '\u{1E800}-\u{1E8DF}' + ']', 'gu'),
            files: ['NotoSansMendeKikakui-Regular.ttf']
        },
        {
            id: 'wancho',
            label: 'Wancho',
            // Wancho U+1E2C0-1E2FF. Wancho Naga, Arunachal Pradesh; devised 2001 and now
            // taught in local schools.
            pattern: new RegExp('[' + '\u{1E2C0}-\u{1E2FF}' + ']', 'gu'),
            files: ['NotoSansWancho-Regular.ttf']
        },
        {
            id: 'enclosed-alphanumerics',
            label: 'enclosed numbers and letters',
            // Enclosed Alphanumerics U+2460-24FF. NOT a script -- ordinary document
            // furniture. CJK documents number their lists with these, and Western ones
            // use (a)/(1) forms all the time.
            // The essential set draws EXACTLY ten of the 160: U+2460-2469, the circled
            // digits 1-9 and 10. Everything past 10 -- and every circled or parenthesised
            // LETTER -- was a box. That is a numbered list that renders correctly for
            // ten items and then stops.
            pattern: new RegExp('[' + '\u{2460}-\u{24FF}' + ']', 'gu'),
            files: ['NotoSansSymbols-Regular.ttf']
        },
        {
            id: 'math-symbols',
            label: 'mathematical symbols',
            // The four math blocks the essential set does NOT cover. Deliberately not
            // U+2200-22FF (Mathematical Operators): DejaVuSans draws that one 256/256, so
            // the everyday symbols an ordinary document uses stay free of charge.
            // These four are specialist notation -- 102/432 and 481/996 in the essential
            // set -- so a document containing any of them is a technical document that
            // wants one consistent math face anyway.
            // PLUS the 34 arrow forms U+2B0E-2B11, U+2B30-2B4C and U+2BFE. Those belong
            // to the `symbols` block below by Unicode, but NotoSansSymbols2 is the one
            // shipped font that cannot draw them and this is the one that can. The two
            // entries therefore PARTITION U+2B00-2BFF: nothing in it is dropped (silent
            // tofu) and nothing is claimed twice (two fonts fetched for one character).
            pattern: new RegExp('[' + '\u{27C0}-\u{27EF}\u{2980}-\u{2AFF}\u{2B0E}-\u{2B11}\u{2B30}-\u{2B4C}\u{2BFE}\u{1D400}-\u{1D7FF}' + ']', 'gu'),
            files: ['NotoSansMath-Regular.ttf']
        },
        {
            id: 'symbols',
            label: 'symbols and arrows',
            // Control Pictures U+2400-243F, OCR U+2440-245F, Misc Symbols and Arrows
            // U+2B00-2BFF. The last one is the one that matters: it holds the heavy
            // block arrows and stars (U+2B05 <-, U+2B50 *) that modern documents and
            // slide decks are full of, and the essential set draws 35 of its 253.
            // MEASURED EXCLUSION: NotoSansSymbols2-Regular.ttf cannot draw U+2B0E,
            // U+2B0F, U+2B10, U+2B11, U+2B30, U+2B31, U+2B32, U+2B33, U+2B34, U+2B35,
            // U+2B36, U+2B37, U+2B38, U+2B39, U+2B3A, U+2B3B, U+2B3C, U+2B3D, U+2B3E,
            // U+2B3F, U+2B40, U+2B41, U+2B42, U+2B43, U+2B44, U+2B45, U+2B46, U+2B47,
            // U+2B48, U+2B49, U+2B4A, U+2B4B, U+2B4C, U+2BFE — left out of the pattern
            // rather than
            // promised and then not delivered. No shipped font draws them.
            pattern: new RegExp('[' + '\u{2400}-\u{245F}\u{2B00}-\u{2B0D}\u{2B12}-\u{2B2F}\u{2B4D}-\u{2BFD}\u{2BFF}' + ']', 'gu'),
            files: ['NotoSansSymbols2-Regular.ttf']
        },

        {
            id: 'hangul',
            label: 'Korean (Hangul)',
            // Compatibility Jamo U+3130-318F and the 11172 precomposed syllables
            // U+AC00-D7A3 — everything NanumGothic provably draws.
            //
            // NARROWED 2026-07-29, and the reason is worth keeping. This pattern
            // used to also claim CONJOINING JAMO: U+1100-11FF, Jamo Ext-A
            // U+A960-A97F and Ext-B U+D7B0-D7FF. Measured against the cmap of the
            // file it names, NanumGothic-Regular.ttf draws 0 of 256, 0 of 32 and
            // 0 of 80 of them. The table was promising a glyph the font does not
            // have — the same shape as BUG-17, one level up: not a lying
            // filename this time but a lying RANGE. It also made the
            // font-embedding gate demand a face that cannot render the text, and
            // it made every conjoining-jamo document pay 1.96 MB for a font that
            // could not draw a single one of its characters.
            // The excluded U+3164 HANGUL FILLER is the one assigned code point
            // inside U+3130-318F that NanumGothic has no glyph for; it is an
            // invisible filler, so that is correct rather than a gap.
            // Where the conjoining jamo went: the `hangul-jamo` entry below.
            pattern: new RegExp('[' +
                '\u{3130}-\u{3163}\u{3165}-\u{318F}' +   // Compatibility Jamo, minus the filler
                '\u{AC00}-\u{D7A3}' +                    // the 11172 syllables
            ']', 'gu'),
            // NanumGothic (OFL 1.1, NHN Corporation, RFN "Nanum"; shipped
            // unmodified) draws all 11172 Hangul syllables -- measured from its
            // own cmap, not assumed from its name.
            //
            // BUG-16 GUESSED WRONG AND THE GUESS IS WORTH RECORDING. It
            // hypothesised that the shipped DroidSansFallbackFull.ttf was a
            // mislabeled *cut-down* of the AOSP font and that the "genuine"
            // AOSP file would add full Hangul for +0.6-0.9 MB. Measured
            // 2026-07-27 against the real AOSP android10 DroidSansFallbackFull
            // (4,033,576 B, decoded from android.googlesource.com): it covers
            // 3/11172 Hangul syllables too. The shipped file is NOT a fake; the
            // AOSP font simply has no Hangul (Android has carried Korean in a
            // separate face since 4.x). There was never a cheap swap.
            //
            // Deliberately a KOREAN-SPECIFIC file rather than one more script
            // hung off DroidSansFallbackFull: that font was the single point of
            // failure for Han + Kana + Hangul, and one asset serving three
            // scripts is how a coverage hole in one of them stays invisible.
            // Korean now fails or passes on its own font. Costs 2.05 MB, and
            // only for documents that actually contain Hangul.
            files: ['NanumGothic-Regular.ttf']
        },
        {
            id: 'hangul-jamo',
            label: 'Korean conjoining Jamo',
            // Conjoining Jamo U+1100-11FF, Jamo Extended-A U+A960-A97C and
            // Extended-B U+D7B0-D7C6 / U+D7CB-D7FB: the ASSIGNED code points only.
            // FG-140: the whole Ext-B block (to U+D7FF) used to be matched, so the
            // unassigned U+D7FF in UTF-8-test.txt (a decoder boundary test, not
            // Korean) raised a false "no font for Korean conjoining Jamo" warning.
            //
            // A DECLARED GAP (files: []), which means the user is TOLD rather
            // than handed boxes. Every one of the 336 files in web/fonts/ was
            // read for this, and the best coverage in the tree is
            // DroidSansFallbackFull.ttf at 99/256 of the main block — and its 99
            // are the leading and trailing consonants with the MEDIAL VOWELS
            // U+1161-1175 missing, so it cannot draw a single complete syllable.
            // Ext-A and Ext-B are 0/32 and 0/80 in every shipped font.
            //
            // This is not an exotic corner. macOS writes Korean filenames and
            // text in NFD, which is exactly this range, so a Korean document
            // round-tripped through a Mac arrives here decomposed and renders as
            // boxes with — until this entry existed — no warning at all, because
            // the `hangul` pattern claimed the range and the resolver duly
            // fetched a 1.96 MB font that draws none of it.
            //
            // Closing it needs a font that covers conjoining jamo (Noto Sans KR
            // and the upstream Nanum Gothic Coding both do); until one is
            // shipped, saying so is the honest behaviour.
            pattern: new RegExp('[' +
                '\u{1100}-\u{11FF}\u{A960}-\u{A97C}\u{D7B0}-\u{D7C6}\u{D7CB}-\u{D7FB}' +
            ']', 'gu'),
            files: []
        },
        // --------------------------------------------------------------
        // EMOJI, in two halves.
        //
        // The old single `emoji` entry had files: [] and therefore warned "no
        // font available" for EVERY emoji. That warning was FALSE for the most
        // common ones: DejaVuSans.ttf is in the always-loaded essential set and
        // measurably draws U+1F600 (real glyph 5857, not .notdef), 80% of the
        // Emoticons block, 91% of Dingbats and 74% of Misc Symbols. Warning
        // about text that renders perfectly costs more than the tofu it was
        // meant to prevent -- the warning channel has to stay trustworthy.
        //
        // But DejaVu's coverage is genuinely partial (Transport U+1F680-16FF
        // 0/128, Misc Symbols & Pictographs U+1F300-1F5FF 12/768, Suppl.
        // Symbols & Pictographs and Symbols Ext-A both 0), and the gaps do not
        // follow block boundaries -- they are "whatever Unicode version DejaVu
        // froze at, minus everything with an emoji presentation". U+2728 is
        // missing from the middle of an otherwise 91%-covered Dingbats block.
        // So a block-granular range would necessarily lie in one direction or
        // the other, and the two range sets below are instead derived directly
        // from DejaVuSans.ttf's cmap. They PARTITION the old emoji domain: no
        // code point is in both (which would produce a phantom warning for text
        // that renders), and none was dropped (which would be silent tofu).
        // tests/unit/test_font_coverage.js re-derives both sets from the font
        // and fails if either drifts, and prints the corrected ranges.
        // --------------------------------------------------------------
        {
            id: 'emoji',
            label: 'emoji',
            // The emoji/symbol code points DejaVuSans.ttf actually draws.
            // Zero extra download: this font is already loaded for every
            // document. Derived from its cmap -- see the note above.
            pattern: new RegExp('[' +
                // Misc Symbols U+2600-26FF and Dingbats U+2700-27BF, minus the
                // emoji-presentation code points DejaVu has no glyph for.
                '\\u{2600}-\\u{269C}\\u{269E}-\\u{26B8}\\u{26C0}-\\u{26C3}\\u{26E2}' +
                '\\u{2701}-\\u{2704}\\u{2706}-\\u{2709}\\u{270C}-\\u{2727}\\u{2729}-\\u{274B}' +
                '\\u{274D}\\u{274F}-\\u{2752}\\u{2756}\\u{2758}-\\u{275E}\\u{2761}-\\u{2794}' +
                '\\u{2798}-\\u{27AF}\\u{27B1}-\\u{27BE}' +
                // Mahjong / Domino / Playing Cards U+1F000-1F0FF.
                '\\u{1F030}-\\u{1F093}\\u{1F0A0}-\\u{1F0AE}\\u{1F0B1}-\\u{1F0BE}' +
                '\\u{1F0C1}-\\u{1F0CF}\\u{1F0D1}-\\u{1F0DF}' +
                // The dozen pictographs DejaVu happens to have (moon phases, a
                // few animals) out of U+1F300-1F5FF.
                '\\u{1F311}-\\u{1F318}\\u{1F42D}-\\u{1F42E}\\u{1F431}\\u{1F435}' +
                // Emoticons U+1F600-1F64F, minus four later-Unicode additions.
                '\\u{1F600}-\\u{1F623}\\u{1F625}-\\u{1F62B}\\u{1F62D}-\\u{1F640}\\u{1F643}' +
            ']', 'gu'),
            files: ['DejaVuSans.ttf']
        },
        {
            id: 'emoji-pictographic',
            label: 'pictographic emoji',
            // The exact complement of the entry above within the same domain:
            // the emoji DejaVuSans cannot draw. The split is still worth having
            // even now that both halves have a font, because the two fonts are
            // NOT interchangeable: `emoji` costs zero extra bytes (DejaVuSans is
            // always loaded) and this one costs 1.98 MB, so a document with only
            // ☀ and ✂ must not pay for Noto Emoji.
            //
            // MONOCHROME ON PURPOSE — and as of 2026-07-28 that is a COST
            // decision, not an uncertainty. The old note here said the colour
            // path was "unproven". It has now been MEASURED, and it works:
            //
            //   CBDT COLOUR EMOJI DO SURVIVE PDF EXPORT. Forcing this entry to
            //   NotoColorEmoji.ttf embeds it as a **Type 3** font (pdffonts:
            //   "CAAAAA+NotoColorEmoji  Type 3  Custom  emb/sub/uni yes") whose
            //   /CharProcs draw image XObjects — 136x128, 8-bit /DeviceRGB,
            //   /FlateDecode, each with an 8-bit /DeviceGray /SMask. The CBDT
            //   strikes with alpha. Extracted and rendered: real colour glyphs.
            //   Same fixture, same driver, mono vs forced-colour:
            //     mono   23,256 B   CAAAAA+NotoEmoji-Regular  TrueType   0 saturated px
            //     colour 64,738 B   CAAAAA+NotoColorEmoji     Type 3  3,718 saturated px
            //   tofu_check clean in both. Two colour runs were byte-identical.
            //   NOTE `pdfimages -list` prints NOTHING for either PDF, even with
            //   -all: it enumerates page-level resources and these bitmaps live
            //   inside the Type 3 font's own resource dict. It is not the CBDT
            //   test and must not be used as one.
            //
            // So why is this still monochrome? BYTES, and a specific cliff:
            //   - 10.29 MB vs 1.89 MB on the wire (conditional — only documents
            //     containing pictographic emoji fetch either).
            //   - MAX_FONT_BYTES is 24 MB (font_resolver.js). Measured against
            //     the real registry: a Chinese document with emoji comes to
            //     23.41 MB in colour (0.59 MB of headroom) versus 15.01 MB in
            //     mono; add Korean and it is 25.37 MB, i.e. OVER, at which point
            //     applyFontBudget starts SHEDDING fonts. That has already been
            //     seen to strip every Latin face off a document silently.
            //   - Colour is not additive: when offered, VCL prefers it for the
            //     WHOLE emoji domain, including the half DejaVuSans draws for
            //     free today, and DejaVuSans then stops being embedded at all.
            //   - The bitmaps are fixed at 136x128 whatever the point size, so a
            //     large emoji in a print-resolution PDF is upsampling.
            //
            // Switching to colour is therefore a live, evidenced OWNER decision
            // about bandwidth and the budget cliff — not a technical unknown.
            // See docs/backlog/features.md. Do not flip this entry without it.
            //
            // Noto Emoji ships as its upstream VARIABLE file (NotoEmoji[wght].ttf,
            // byte-identical to google/fonts ofl/notoemoji). Its default instance
            // is Regular (fvar default wght=400, usWeightClass 400) and the glyf
            // outlines ARE that instance, so it renders correctly even where the
            // variation tables are ignored. Kept under the upstream name rather
            // than renamed to a static-looking "NotoEmoji-Regular.ttf" precisely
            // because of BUG-17: a filename must not imply a static face.
            pattern: new RegExp('[' +
                '\\u{269D}\\u{26B9}-\\u{26BF}\\u{26C4}-\\u{26E1}\\u{26E3}-\\u{2700}' +
                '\\u{2705}\\u{270A}-\\u{270B}\\u{2728}\\u{274C}\\u{274E}\\u{2753}-\\u{2755}' +
                '\\u{2757}\\u{275F}-\\u{2760}\\u{2795}-\\u{2797}\\u{27B0}\\u{27BF}' +
                '\\u{1F000}-\\u{1F02F}\\u{1F094}-\\u{1F09F}\\u{1F0AF}-\\u{1F0B0}' +
                '\\u{1F0BF}-\\u{1F0C0}\\u{1F0D0}\\u{1F0E0}-\\u{1F2FF}' +
                '\\u{1F300}-\\u{1F310}\\u{1F319}-\\u{1F42C}\\u{1F42F}-\\u{1F430}' +
                '\\u{1F432}-\\u{1F434}\\u{1F436}-\\u{1F5FF}' +
                '\\u{1F624}\\u{1F62C}\\u{1F641}-\\u{1F642}\\u{1F644}-\\u{1FAFF}' +
            ']', 'gu'),
            files: ['NotoEmoji[wght].ttf']
        }
    ];

    /**
     * Detect which non-Latin scripts a text sample contains.
     * @param {string} text - decoded sample of the document's text
     * @param {number} [minHits=1] - occurrences required before a script counts.
     *   Use >1 for untrusted samples (binary heuristics decoded as UTF-16LE can
     *   produce stray code points from non-text bytes).
     * @returns {string[]} script ids, in SCRIPTS order
     */
    function detectScripts(text, minHits) {
        if (!text) return [];
        const need = minHits > 0 ? minHits : 1;
        const found = [];
        for (const s of SCRIPTS) {
            let hits = 0;
            // Fresh regex per call: /g lastIndex must not leak between calls.
            // PRESERVE the pattern's own flags -- this used to hardcode 'g' and
            // silently drop everything else. Any script needing /u (astral-plane
            // \u{...} escapes, i.e. emoji and the CJK extension planes) then threw
            // "Range out of order", and because the throw is caught upstream it
            // disabled detection for EVERY script, not just the new one. Adding a
            // script must not be able to break the others.
            const flags = s.pattern.flags.includes('g') ? s.pattern.flags : s.pattern.flags + 'g';
            const re = new RegExp(s.pattern.source, flags);
            while (re.exec(text) !== null) {
                if (++hits >= need) break;
            }
            if (hits >= need) found.push(s.id);
        }
        return found;
    }

    /**
     * The actual code points of each given script that a text contains.
     *
     * detectScripts() answers "is this script here at all", which is all that is
     * needed to ADD a font. Deciding NOT to fetch a script font needs more: the
     * exact code points, so they can be checked one by one against the cmap of a
     * font the document supplies itself (font_resolver.js, NTH-07). Partial
     * coverage must never suppress, and that comparison is impossible without
     * this list.
     *
     * Uses the same SCRIPTS patterns as detectScripts, so the set checked for
     * coverage can never be narrower than the set that triggered the download.
     *
     * @param {string} text
     * @param {string[]} scriptIds - ids to collect for (others are ignored)
     * @returns {Object<string, number[]>} id -> distinct code points, in the
     *   order first seen. Absent id => none found.
     */
    function scriptCodePoints(text, scriptIds) {
        const out = {};
        if (!text || !scriptIds || !scriptIds.length) return out;
        for (const s of SCRIPTS) {
            if (!scriptIds.includes(s.id)) continue;
            const flags = s.pattern.flags.includes('g') ? s.pattern.flags : s.pattern.flags + 'g';
            const re = new RegExp(s.pattern.source, flags);
            const seen = new Set();
            let m;
            while ((m = re.exec(text)) !== null) seen.add(m[0].codePointAt(0));
            if (seen.size) out[s.id] = Array.from(seen);
        }
        return out;
    }

    /**
     * Font FILE basenames needed to render the given scripts (deduped).
     * @param {string[]} scriptIds
     * @returns {string[]}
     */
    function scriptFontFiles(scriptIds) {
        const ids = scriptIds || [];
        const out = [];
        for (const s of SCRIPTS) {
            if (!ids.includes(s.id)) continue;
            for (const f of s.files) if (!out.includes(f)) out.push(f);
        }
        return out;
    }

    // ------------------------------------------------------------------
    // OOXML THEME FONT COLLECTION: ISO 15924 script tag -> the SCRIPTS id that
    // can answer "does this document contain that script?".
    //
    // WHAT THIS IS FOR. An Office theme's <a:fontScheme> holds two font sets,
    // <a:majorFont> (headings) and <a:minorFont> (body). Each begins with the
    // theme's OWN typefaces -- <a:latin>, <a:ea>, <a:cs> -- and is then followed
    // by a PER-SCRIPT FALLBACK LIST: ~48 <a:font script="Jpan" typeface="游明朝"/>
    // entries, one for every script Windows ships a font for. That list is
    // boilerplate. Word writes all 48 into every theme it saves, whether the
    // document is a Japanese report or an English invoice, and no run can
    // reference an entry by name -- it is consulted only when the text itself
    // contains a character of that script. Harvesting those typefaces as
    // "fonts this document uses" made a pure-English test page download 10.3 MB
    // of Japanese faces (measured on DOCX_TestPage.docx, 2026-07-27).
    //
    // A tag appears below ONLY when detectScripts() can positively see that
    // script in the document's text. An UNLISTED tag is never treated as
    // unused -- we have no detector for it, so absence cannot be proven, and
    // under-fetching a font is tofu. Deliberately unlisted:
    //   * Arab, Hebr, Geor, Armn, Laoo -- no SCRIPTS entry on purpose (DejaVuSans
    //     draws them), so there is nothing to detect them with.
    //   * Viet -- Latin script; its typeface may genuinely render body text.
    //   * Bopo -- Bopomofo is U+3100-312F, which the `han` pattern does NOT
    //     cover. Mapping it to `han` would make "no han detected" look like
    //     evidence about Bopomofo when it is not.
    //   * Uigh (Old Uyghur), Lisu, Osma (Osmanya), Phag (Phags-pa) -- still no
    //     detector: Lisu is drawn by DejaVuSans so it has no SCRIPTS entry, and
    //     the other three are scripts this table deliberately does not carry.
    // Every one of those keeps today's behaviour exactly.
    //
    // GREW 2026-07-29 from 17 tags to 33, as a side effect of the SCRIPTS
    // extension: Tibt, Mong, Yiii, Thaa, Orya, Mlym, the four Syriac tags,
    // Cans, Java, Nkoo, Olck, Sora, Tale, Talu, Tfng and Bugi were on the
    // "cannot detect" list purely because nothing routed to the fonts we
    // already shipped. Each one now lets a theme's boilerplate fallback for
    // that script be pruned from an English document, which is bytes saved,
    // never bytes lost -- the rule is unchanged, only the evidence is better.
    // ------------------------------------------------------------------
    //
    // A value may be a LIST of ids: the tag is unused only when the document
    // contains NONE of them. `hang` needs that -- Korean can arrive precomposed
    // (`hangul`) or NFD-decomposed (`hangul-jamo`, which is what macOS writes),
    // and pruning the Korean theme face on an NFD document because only the
    // other id fired would be exactly the under-fetch this guard exists to stop.
    const THEME_SCRIPT_TAGS = {
        // CJK ideographs + kana. All three tags are covered by the `han` pattern
        // (kana, CJK Unified + Ext A, compatibility ideographs, halfwidth kana).
        jpan: 'han',
        hans: 'han',
        hant: 'han',
        hang: ['hangul', 'hangul-jamo'],
        thai: 'thai',
        deva: 'devanagari',
        beng: 'bengali',
        guru: 'gurmukhi',
        gujr: 'gujarati',
        taml: 'tamil',
        telu: 'telugu',
        knda: 'kannada',
        sinh: 'sinhala',
        mymr: 'myanmar',
        khmr: 'khmer',
        ethi: 'ethiopic',
        cher: 'cherokee',
        // Newly detectable (2026-07-29).
        tibt: 'tibetan',
        mong: 'mongolian',
        yiii: 'yi',
        thaa: 'thaana',
        orya: 'odia',
        mlym: 'malayalam',
        // Syriac has four theme tags for its three writing styles plus the
        // generic one; all four are answered by the same detector.
        syrc: 'syriac',
        syrn: 'syriac',
        syrj: 'syriac',
        syre: 'syriac',
        cans: 'canadian-aboriginal',
        java: 'javanese',
        nkoo: 'nko',
        olck: 'ol-chiki',
        sora: 'sora-sompeng',
        tale: 'tai-le',
        talu: 'new-tai-lue',
        tfng: 'tifinagh',
        bugi: 'buginese'
    };

    /**
     * Is a theme's per-script fallback entry PROVABLY unused by this document?
     *
     * Answers true only on positive evidence of absence: the tag maps to a
     * script we can detect, and the (trusted, non-empty) detection did not find
     * it. Everything else -- an unknown tag, a missing/!array detection, a tag
     * we have no detector for -- answers false, i.e. "keep harvesting it".
     *
     * @param {string} tag - the ISO 15924 value of <a:font script="...">
     * @param {string[]} detectedScriptIds - ids detectScripts() actually found
     * @returns {boolean}
     */
    function themeScriptFallbackUnused(tag, detectedScriptIds) {
        if (!tag || !Array.isArray(detectedScriptIds)) return false;
        const mapped = THEME_SCRIPT_TAGS[String(tag).trim().toLowerCase()];
        if (!mapped) return false;
        // A list means "unused only if NONE of these fired" -- see the note on
        // `hang` above. Absence has to be proven against every id that could
        // have carried the evidence.
        if (Array.isArray(mapped)) return !mapped.some(i => detectedScriptIds.includes(i));
        const id = mapped;
        return !detectedScriptIds.includes(id);
    }

    /**
     * Human-readable labels for detected scripts we have NO font for.
     * @param {string[]} scriptIds
     * @returns {string[]}
     */
    function unsupportedScriptLabels(scriptIds) {
        const ids = scriptIds || [];
        return SCRIPTS.filter(s => ids.includes(s.id) && s.files.length === 0)
                      .map(s => s.label);
    }

    /**
     * Decode a byte sample of a text-ish document (txt/rtf/html) into a string
     * for script detection. Honours a UTF-16 BOM, defaults to UTF-8 (a Latin-1
     * file decodes to replacement chars, which never false-positive a script),
     * and un-escapes the two ways non-ASCII hides in plain-text formats:
     *   RTF   backslash-u26085 followed by an optional space (signed decimal UTF-16 code unit)
     *   HTML  &#26085;  /  &#x65E5;
     * Pure + node-testable. Never throws.
     * @param {ArrayBuffer|Uint8Array} buffer
     * @param {string} [ext] - lowercase file extension (drives un-escaping)
     * @returns {string}
     */
    /**
     * Guess UTF-16 for a buffer that carries NO byte-order mark.
     *
     * Item 10: `UTF16BEWITHOUTBOM.txt` rendered as a page of boxes. The engine
     * decodes it correctly (its text layer is right), but THIS sniff — the one
     * that decides which script fonts to load — saw mojibake, detected no
     * scripts, and so no CJK font was ever requested. The glyphs then had no
     * covering face. Measured: `detectScripts` returned [] on the mojibake and
     * ["han"] on the correct decode.
     *
     * The signal is NUL parity. In UTF-16, ASCII and most Latin text yields one
     * NUL per code unit, always on the same side: `XX 00` little-endian,
     * `00 XX` big-endian. So NULs clustering on odd offsets means LE, on even
     * offsets means BE.
     *
     * Conservative by construction, because guessing wrong here would corrupt
     * the sniff for every other document:
     *   - needs a real population of NULs (a UTF-8 file has none, and returns
     *     null immediately);
     *   - needs a decisive parity split, not a marginal one;
     *   - looks at an even-length prefix so the parity count cannot be skewed by
     *     a trailing byte.
     *
     * @returns {'utf-16le'|'utf-16be'|null} null means "no opinion" — callers
     *          must keep their existing default.
     */
    /**
     * FG-155: is this non-UTF-8 text confidently Simplified Chinese in GB18030/GBK?
     * LibreOffice's own text detection maps an ICU "GB18030" verdict and reads such
     * a file correctly (measured on our WASM build), but the windows-1252 fallback
     * below runs first and turns it into Latin mojibake. Decide it here, and only
     * when the evidence is strong, because other legacy encodings overlap:
     *   1. the bytes decode as gb18030 with {fatal: true};
     *   2. at least 8 double-byte pairs, and >= 95% of them in the GB2312 block
     *      (lead 0xA1-0xF7, trail 0xA1-0xFE). Big5 (trail 0x40-0x7E for about
     *      half its characters), Shift-JIS (lead 0x81-0x9F) and Western text,
     *      where a lone accented byte pairs with an ASCII letter, fail this;
     *   3. >= 5% of all pairs have a lead byte of 0xD0 or above. GB2312's common
     *      hanzi are pinyin-ordered B0-D7, so Chinese reaches past D0 constantly
     *      (中 D6, 在 D4, 这 D5, 一 D2; measured 6-23% on sample texts). EUC-JP
     *      shares the whole A1-FE block, but JIS level-1 kanji end at CF and
     *      EUC-KR Hangul at C8, so Japanese and Korean measured 0%;
     *   4. < 2% of pairs in rows A4/A5, which hold hiragana/katakana in both
     *      GB2312 and EUC-JP. Chinese text practically never uses them, while
     *      Japanese prose is 30-60% kana.
     * Anything that fails keeps today's windows-1252 fallback and its notice.
     * @param {Uint8Array} bytes
     * @returns {boolean}
     */
    function sniffGb18030(bytes, opts) {
        // opts.partial: `bytes` is a PREFIX of the file (the font sniff's sample),
        // so a character cut at the end is not evidence against GB18030.
        const partial = !!(opts && opts.partial);
        let pairs = 0, gb2312 = 0, rowD0 = 0, kana = 0;
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            if (b < 0x80) continue;
            const t = bytes[i + 1];
            if (t === undefined) {
                if (partial) break;   // lead byte cut off by the sample end
                return false;
            }
            if (b >= 0x81 && b <= 0xFE && t >= 0x30 && t <= 0x39) {   // 4-byte GB18030
                i += 3;
                continue;
            }
            pairs++;
            if (b >= 0xA1 && b <= 0xF7 && t >= 0xA1 && t <= 0xFE) {
                gb2312++;
                if (b >= 0xD0) rowD0++;
                if (b === 0xA4 || b === 0xA5) kana++;
            }
            i++;
        }
        if (pairs < 8 || gb2312 < pairs * 0.95 || rowD0 < pairs * 0.05 || kana >= pairs * 0.02) {
            return false;
        }
        try {
            new TextDecoder('gb18030', { fatal: true }).decode(bytes, { stream: partial });
        } catch (e) {
            return false;   // invalid sequence, or no gb18030 decoder in this browser
        }
        return true;
    }

    // FG-056: most frequent characters per language, used to tell a correct
    // decode from a mis-decode. Real text hits these constantly; the CJK
    // characters a wrong double-byte decode produces almost never do.
    const COMMON_ZH_HANT = new Set('的一是不了人我在有他這中大來上國個到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡後小麼心多天而能好都然沒日於起還發成事只作當想看文無開手十用主行方又如前所本見經頭面公同三已老從動兩長知民樣現分將外但身些與高意進把法此實回二理美點月明其種聲全工己話兒者向情部正名定女問力機給等幾很業最間新什打便位因重被走電四第門相次東政海口使教西再平真聽世氣信北少關并內加化由卻代軍產入先山五太水萬市眼體別處總才場師書比住員九笑性通目華報立馬命張活難神數件安表原車白應路期叫死常提感金何更反合放做系計或司利受光王果親界及今京務制解各任至清物台象記邊共風戰干接它許八特覺望直服毛林題建南度統色字請交愛讓認算論百吃義科怎元社術結六功指思非流每青管夫連遠資隊跟帶花快條院變聯言權往展該領傳近留紅治決周保達辦運武半候七必城父強步完革深區即求品士轉量空甚眾技輕程告江語英基派滿式李息寫呢識極令黃德收臉錢黨倒未持取設始版雙歷越史商千片容研像找友孩站廣改議形委早房音火際則首單據導影失拿網香似斯專石若兵弟誰校讀志飛觀爭究包組造落視濟喜離雖壞興急');
    const COMMON_KO = new Set('이다는의에하고가을지리기사서한대로자어나도정일시수인적해게구주보내상부전들아장위제성으소원국경회라생식비우무문동공화히연방중미여그니면선계실오신마관거것할있년금개했요세만저분용과와를은요며습니까던때다면입니');
    const COMMON_RU = 'оеаинтсрвлкмдпуяыьгзбчйхжшюцщэфъё';
    const COMMON_RU_TOP10 = new Set(COMMON_RU.slice(0, 10));
    // Russian letter frequencies (%), in COMMON_RU order. Only the all-caps
    // branch below uses them: see sniffLegacyCharset.
    const RU_FREQ = [10.97, 8.45, 8.01, 7.35, 6.70, 6.26, 5.47, 4.73, 4.54, 4.40, 3.49,
        3.21, 2.98, 2.81, 2.62, 2.01, 1.90, 1.74, 1.70, 1.65, 1.59, 1.44, 1.21, 0.97, 0.94,
        0.73, 0.64, 0.48, 0.36, 0.32, 0.26, 0.04, 0.04];
    const RU_INDEX = new Map(Array.from(COMMON_RU, (ch, i) => [ch, i]));

    /** FG-056: user-facing names for the legacy encodings we identify. */
    const LEGACY_CHARSET_NAMES = {
        'gb18030': 'Simplified Chinese (GB18030/GBK)',
        'big5': 'Traditional Chinese (Big5)',
        'shift_jis': 'Japanese (Shift_JIS)',
        'euc-jp': 'Japanese (EUC-JP)',
        'euc-kr': 'Korean (EUC-KR)',
        'windows-1251': 'Cyrillic (Windows-1251)',
        'koi8-r': 'Russian (KOI8-R)',
    };

    /**
     * FG-056: how much of the input sniffLegacyCharset looks at. A verdict on
     * 256 KiB of text is as good as one on 60 MB, and the full-input version
     * measured 16-23 s on a 60 MB CSV, synchronously on the main thread. The
     * caller checks the REST of the file with decodeLegacyOrNull.
     */
    const LEGACY_SNIFF_PREFIX_BYTES = 256 * 1024;

    /**
     * FG-056: identify a legacy East-Asian or Cyrillic encoding confidently, or
     * return null so the caller keeps its windows-1252 fallback. GB18030 is
     * handled first by sniffGb18030 (FG-155). Only the first
     * LEGACY_SNIFF_PREFIX_BYTES are examined. The cut may fall inside a
     * multi-byte character, so a truncated prefix is decoded with {stream: true}:
     * the decoder holds back a trailing partial sequence instead of failing on
     * it, while any invalid sequence before it still throws. (Cutting after the
     * last byte below 0x80 would also be safe, but a prefix whose only ASCII is
     * near its start would shrink to almost nothing.) The verdict covers the
     * prefix only, so callers must decode the whole input with
     * decodeLegacyOrNull.
     *
     * Each candidate must decode with {fatal: true} (double-byte) and then look
     * like real text in its language:
     *   shift_jis / euc-jp  >= 15% kana and >= 90% Japanese characters overall;
     *   euc-kr              >= 60% Hangul syllables, >= 25% of them common ones;
     *   big5                >= 85% CJK, no kana, >= 20% common Traditional chars;
     *   windows-1251/koi8-r >= 50% of letters in high bytes (Cyrillic text, not
     *                       accented Western text), >= 85% Cyrillic after decode,
     *                       a consistent case (>= 65% lower OR >= 65% upper, so an
     *                       all-caps CSV qualifies), >= 45% of letters among the
     *                       10 most frequent Russian ones, and that share at least
     *                       0.1 above the other Cyrillic decode's. A wrong
     *                       1251/KOI8-R decode swaps case and scrambles letter
     *                       frequencies (measured ~0.3-0.4 vs ~0.6-0.8).
     *                       All-caps output is ALSO what lowercase Greek
     *                       (windows-1253) and Hebrew (windows-1255) become under
     *                       KOI8-R, and Greek maps almost letter-for-letter onto
     *                       Russian (alpha->A, epsilon->E, omicron->O ...), so the
     *                       upper-case branch further needs the letter distribution
     *                       to match Russian's: cosine >= 0.85 (measured 0.90-0.94
     *                       on Russian/Ukrainian/Bulgarian prose, 0.80 Greek, 0.68
     *                       Hebrew). Short all-caps text (a lone header row) cannot
     *                       reach that and is refused.
     * Candidates that qualify are then ranked by their OWN language's evidence,
     * not by a shared "looks like CJK" share that a wrong decode also earns:
     * kana share (Japanese), Hangul share (Korean), common-Traditional share
     * (Big5), top-10-letter share (Cyrillic). Top two within 0.05: null.
     * Needs at least 8 non-ASCII bytes.
     * @param {Uint8Array} bytes
     * @returns {'shift_jis'|'euc-jp'|'euc-kr'|'big5'|'windows-1251'|'koi8-r'|null}
     */
    function sniffLegacyCharset(bytes, opts) {
        // opts.partial: the caller's `bytes` is itself a prefix (the font sniff's
        // 256 KiB sample, exactly LEGACY_SNIFF_PREFIX_BYTES long), so a trailing
        // cut character must be held back even when no further cut happens here.
        const partial = !!(opts && opts.partial) || bytes.length > LEGACY_SNIFF_PREFIX_BYTES;
        const sample = partial ? bytes.subarray(0, LEGACY_SNIFF_PREFIX_BYTES) : bytes;

        let high = 0, asciiLetters = 0;
        for (let i = 0; i < sample.length; i++) {
            const b = sample[i];
            if (b >= 0x80) high++;
            else if ((b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)) asciiLetters++;
        }
        if (high < 8) return null;
        const decode = (enc) => {
            try { return new TextDecoder(enc, { fatal: true }).decode(sample, { stream: partial }); }
            catch (e) { return null; }
        };
        const best = [];

        // Double-byte East-Asian candidates.
        for (const enc of ['shift_jis', 'euc-jp', 'euc-kr', 'big5']) {
            const text = decode(enc);
            if (text === null) continue;
            let n = 0, kana = 0, cjk = 0, hangul = 0, punct = 0, commonZh = 0, commonKo = 0;
            for (const ch of text) {
                const c = ch.codePointAt(0);
                if (c < 0x80) continue;
                n++;
                if (c >= 0x3040 && c <= 0x30FF) kana++;
                else if (c >= 0x4E00 && c <= 0x9FFF) { cjk++; if (COMMON_ZH_HANT.has(ch)) commonZh++; }
                else if (c >= 0xAC00 && c <= 0xD7A3) { hangul++; if (COMMON_KO.has(ch)) commonKo++; }
                else if ((c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF)) punct++;
            }
            if (n < 4) continue;
            if ((enc === 'shift_jis' || enc === 'euc-jp')
                && kana >= 0.15 * n && (kana + cjk + punct) >= 0.9 * n) {
                best.push([enc, kana / n]);
            } else if (enc === 'euc-kr' && hangul >= 0.6 * n && commonKo >= 0.25 * hangul) {
                best.push([enc, hangul / n]);
            } else if (enc === 'big5' && kana === 0 && (cjk + punct) >= 0.85 * n
                       && commonZh >= 0.2 * cjk) {
                best.push([enc, commonZh / n]);
            }
        }

        // Single-byte Cyrillic: only when most letters are high bytes.
        if (high >= 0.5 * (high + asciiLetters)) {
            const cyrillic = [];
            for (const enc of ['windows-1251', 'koi8-r']) {
                const text = decode(enc);   // single-byte: cannot fail
                if (text === null) continue;
                let n = 0, cyr = 0, lower = 0, upper = 0, common = 0;
                const counts = new Array(RU_FREQ.length).fill(0);
                for (const ch of text) {
                    const c = ch.codePointAt(0);
                    if (c < 0x80) continue;
                    n++;
                    if (c >= 0x0400 && c <= 0x04FF) {
                        cyr++;
                        const lc = ch.toLowerCase();
                        if (lc !== ch) upper++;
                        else if (ch.toUpperCase() !== ch) lower++;
                        if (COMMON_RU_TOP10.has(lc)) common++;
                        const k = RU_INDEX.get(lc);
                        if (k !== undefined) counts[k]++;
                    }
                }
                let ok = cyr > 0 && cyr >= 0.85 * n && common >= 0.45 * cyr;
                if (ok && lower < 0.65 * cyr) {
                    let dot = 0, oo = 0, ff = 0;
                    for (let k = 0; k < counts.length; k++) {
                        dot += counts[k] * RU_FREQ[k];
                        oo += counts[k] * counts[k];
                        ff += RU_FREQ[k] * RU_FREQ[k];
                    }
                    ok = upper >= 0.65 * cyr && oo > 0 && dot / Math.sqrt(oo * ff) >= 0.85;
                }
                cyrillic.push([enc, cyr > 0 ? common / cyr : 0, ok]);
            }
            for (const [enc, score, ok] of cyrillic) {
                const other = cyrillic.find(o => o[0] !== enc);
                if (ok && (!other || score - other[1] >= 0.1)) best.push([enc, score]);
            }
        }

        if (best.length === 0) return null;
        best.sort((a, b) => b[1] - a[1]);
        // Two candidates whose own evidence is alike: do not guess.
        if (best.length > 1 && best[0][1] - best[1][1] < 0.05) return null;
        return best[0][0];
    }

    /**
     * FG-056: decode the WHOLE input in the encoding sniffLegacyCharset chose
     * from a prefix, or return null if any byte anywhere is invalid in it. The
     * caller then takes its windows-1252 path (with its notice) exactly as if
     * the sniff had found nothing; a non-fatal decode here would hand the user
     * U+FFFD for whatever lay past the sniffed prefix, without a word.
     * @param {Uint8Array} bytes
     * @param {string} enc
     * @returns {string|null}
     */
    function decodeLegacyOrNull(bytes, enc) {
        try { return new TextDecoder(enc, { fatal: true }).decode(bytes); }
        catch (e) { return null; }
    }

    function sniffUtf16WithoutBom(bytes, opts) {
        if (!bytes || bytes.length < 16) return null;
        // GATE 1: never reinterpret something that is already valid UTF-8. This
        // is what makes the heuristic safe for every other document — a UTF-8
        // file, ASCII or not, leaves here immediately.
        // CB-003: delimited text (CSV/TSV) may skip it with { allowValidUtf8: true }.
        // ASCII-only UTF-16 IS valid UTF-8 (NUL is a legal byte), and a NUL never
        // occurs in a genuine CSV, so gates 2 and 3 alone decide there.
        if (!(opts && opts.allowValidUtf8) && isValidUtf8(bytes)) return null;
        const limit = Math.min(bytes.length, 4096) & ~1;   // even-length prefix
        let even = 0, odd = 0;
        for (let i = 0; i < limit; i++) {
            if (bytes[i] === 0x00) { if (i % 2 === 0) even++; else odd++; }
        }
        // GATE 2: enough NULs to mean something. Measured on the real fixtures:
        // CJK-heavy UTF-16 carries NULs only for its ASCII runs, so the SHARE is
        // tiny (0.9% on UTF16BEWITHOUTBOM.txt) while the SPLIT is absolute
        // (11 even, 0 odd). Thresholding on share would have missed exactly the
        // documents this exists for — the first version of this function did.
        if (even + odd < 4) return null;
        // GATE 3: the split must be decisive. Interleaved single-byte text does
        // not produce an 8:1 parity ratio in its NULs.
        if (odd === 0 || even > odd * 8) return 'utf-16be';
        if (even === 0 || odd > even * 8) return 'utf-16le';
        return null;
    }

    function decodeTextSample(buffer, ext) {
        try {
            const bytes = buffer instanceof Uint8Array
                ? buffer
                : new Uint8Array(buffer || new ArrayBuffer(0));
            let encoding = 'utf-8';
            if (bytes.length >= 2) {
                if (bytes[0] === 0xFF && bytes[1] === 0xFE) encoding = 'utf-16le';
                else if (bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = 'utf-16be';
                else {
                    // No BOM. UTF-16 without one is a real, supported input
                    // (documents/libreoffice_tests/UTF16*WITHOUTBOM.txt), and
                    // reading it as UTF-8 yields mojibake in which no script can
                    // be detected — which is how CJK text ended up with no font
                    // and rendered as boxes. Only overrides when decisive.
                    const guess = sniffUtf16WithoutBom(bytes);
                    if (guess) encoding = guess;
                }
            }
            // FG-056: a legacy-encoded .txt/.csv is decoded for conversion by
            // transcodeLegacyTextInput / the CSV fast path. The script sniff must
            // read it the SAME way, or it picks fonts for text that is not there:
            // Shift-JIS read as UTF-8 detected Yi, so the PDF shipped Noto Sans Yi
            // and every Japanese character was lost although the transcode was
            // right. The sample is a prefix, so UTF-8 validity is tested in stream
            // mode (a character cut at the end is not an error), and the legacy
            // decode is non-fatal (detection only; the conversion decodes strictly).
            const e0 = (ext || '').toLowerCase();
            if (encoding === 'utf-8' && (e0 === 'txt' || e0 === 'csv' || e0 === 'tsv')) {
                let validUtf8 = true;
                try { new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }); }
                catch (err) { validUtf8 = false; }
                if (!validUtf8 && bytes.indexOf(0) === -1) {
                    // { partial: true }: the sample is a prefix (Fable review): a
                    // multi-byte character cut by the sample end must not fail the
                    // fatal decodes, or ~half of all legacy CJK files over 256 KiB
                    // would sniff as windows-1252 and load no CJK font.
                    encoding = sniffGb18030(bytes, { partial: true }) ? 'gb18030'
                        : (sniffLegacyCharset(bytes, { partial: true }) || 'windows-1252');
                }
            }
            let text = new TextDecoder(encoding, { fatal: false }).decode(bytes);

            const e = (ext || '').toLowerCase();
            // FG-140: transcodeLegacyTextInput composes conjoining Jamo in UTF-8
            // .txt; the sniff must see the same syllables, or it picks the Jamo
            // entry (no font) and the composed text is drawn without NanumGothic.
            if (e === 'txt' && encoding === 'utf-8') text = composeConjoiningJamo(text);
            if (e === 'rtf') {
                text = text.replace(/\\u(-?\d+)\s?/g, (m, n) => {
                    let cu = parseInt(n, 10);
                    if (Number.isNaN(cu)) return m;
                    if (cu < 0) cu += 65536;           // RTF writes >32767 as negative
                    if (cu < 0 || cu > 0xFFFF) return m;
                    return String.fromCharCode(cu);
                });
            } else if (e === 'html' || e === 'htm') {
                text = text.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (m, n) => {
                    const cp = n[0] === 'x' || n[0] === 'X'
                        ? parseInt(n.slice(1), 16)
                        : parseInt(n, 10);
                    if (Number.isNaN(cp) || cp < 0 || cp > 0x10FFFF) return m;
                    return String.fromCodePoint(cp);
                });
            }
            return text;
        } catch (err) {
            return '';
        }
    }

    // ------------------------------------------------------------------
    // BUG-12 (encoding half) — legacy single-byte plain text
    //
    // This build reads plain text as UTF-8 unconditionally. Under Emscripten,
    // `osl_getThreadTextEncoding()` is always UTF-8 (musl), and LibreOffice's
    // ICU charset detector (`iodetect.cxx`) only maps UTF-8 / UTF-16 / GB18030 —
    // an ISO-8859-1 / Windows-1252 verdict is discarded as DONTKNOW. So a
    // legacy-encoded .txt has every non-ASCII byte turned into U+FFFD: the
    // characters are destroyed before any font is ever consulted.
    //
    // The fix is on this side of the bridge: decode the bytes ourselves and hand
    // the worker UTF-8 with a BOM. The BOM takes the deterministic branch in
    // `iodetect.cxx` (no detection runs at all) and is stripped before rendering
    // by RTL_TEXTTOUNICODE_FLAGS_GLOBAL_SIGNATURE in `parasc.cxx`, so no stray
    // glyph reaches the user.
    //
    // The BOM sniff and the strict-UTF-8 probe are shared with csv_fast_path.js
    // (which needed exactly the same decision for its own decodeBuffer) so there
    // is one definition of "is this UTF-8, and if not what do we assume".
    // ------------------------------------------------------------------

    /**
     * Extensions this transcode may touch. Deliberately just `txt`:
     *   - rtf declares its own codepage in-band (`\ansicpg`) and starts with the
     *     `{\rtf1` signature a BOM would break;
     *   - html declares its own charset (`<meta charset>`);
     *   - csv on the WASM path is handed an explicit charset by the bridge, and
     *     a BOM would land in the first cell;
     *   - every other input is ZIP (docx/xlsx/pptx/od*), OLE2 (doc/xls/ppt) or
     *     PDF — binary containers that transcoding would corrupt outright.
     * Adding an entry here means proving the format tolerates a UTF-8 BOM AND
     * has no in-band encoding declaration of its own.
     */
    /**
     * BUG-31: count HTML form controls that CARRY A VALUE. NO LONGER DRIVES ANY NOTICE: since
     * FG-040 the worker draws the controls as text (flattenHtmlFormControls), so there is no loss
     * to report. Kept exported, unchanged, because ConversionProtocol is the MCP host's
     * contract (add rather than remove); nothing in this repository calls it. Pure and bounded:
     * a regex scan of the markup, no DOM. Counts what a reader would miss:
     *   <input> with a non-empty value= or `checked` (not hidden/submit/button/reset/image),
     *   <textarea> with non-blank content, <select> with an <option selected>.
     * @param {string} html
     * @returns {{count: number, kinds: string[]}}
     */
    function countHtmlFormValues(html) {
        const text = String(html || '');
        let count = 0;
        const kinds = new Set();
        const inputRe = /<input\b([^>]*)>/gi;
        let m;
        while ((m = inputRe.exec(text)) !== null) {
            const attrs = m[1];
            const type = (/\btype\s*=\s*["']?([a-z-]+)/i.exec(attrs) || [])[1];
            if (type && /^(hidden|submit|button|reset|image)$/i.test(type)) continue;
            const value = /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
            const hasValue = value && (value[1] || value[2] || value[3] || '').trim() !== '';
            const checked = /\bchecked\b/i.test(attrs);
            if (hasValue || checked) { count++; kinds.add('input'); }
        }
        const taRe = /<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi;
        while ((m = taRe.exec(text)) !== null) {
            if (m[1].trim() !== '') { count++; kinds.add('textarea'); }
        }
        const selRe = /<select\b[^>]*>([\s\S]*?)<\/select>/gi;
        while ((m = selRe.exec(text)) !== null) {
            if (/<option\b[^>]*\bselected\b/i.test(m[1])) { count++; kinds.add('select'); }
        }
        return { count, kinds: Array.from(kinds) };
    }

    // ------------------------------------------------------------------
    // FG-040: HTML form controls drawn as text.
    //
    // The engine drops every control of an HTML <form>: its form object cannot be
    // created in WebAssembly (18 builds, 2026-08, never found why the attempt then trapped), so
    // `<input value="John Doe">` was lost and a <select> listed all its options. Rather than
    // patch the engine, the worker flattens the controls to plain text BEFORE the engine reads
    // the page (FG-040 record, "What would close it", option 3). The look is ours, not
    // LibreOffice's widgets: a bordered box for fields and selects, ☑/☐ and ◉/○ for check boxes
    // and radio buttons (numeric character references, so the inserted bytes are ASCII and any
    // ASCII-compatible charset is safe).
    //
    // BYTE-LEVEL, NOT A DOM. Every byte outside a rewritten control is returned unchanged
    // (the same buffer when nothing is rewritten): the scan never decodes the document, so a
    // charset the page declares is irrelevant, and a tag it cannot parse is left exactly as it
    // was. UTF-16/32 pages (a BOM, or NUL bytes up front) are not touched. ISO-2022-JP and HZ
    // are the only charsets whose double-byte text can contain a 0x3C byte; a false match
    // needs the exact bytes "<input" or "<select" inside such text.
    //
    // BOUNDED. A work budget (8 x the input) ends the scan on pathological markup (a million
    // unterminated tags would otherwise be quadratic); the rest is copied verbatim.
    // ------------------------------------------------------------------
    const FLATTEN_MAX_BYTES = 50 * 1024 * 1024;
    const FLATTEN_BOX_STYLE = 'border:1px solid #808080;padding:1px 6px';
    const FLATTEN_EMPTY_FILL = '&nbsp;'.repeat(12);
    // Inputs left exactly as they are: no value to draw, or the control is a button whose
    // caption the engine already prints.
    const FLATTEN_SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color']);
    // Elements whose content is text, not markup: nothing inside them is a control.
    const FLATTEN_RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

    function flatIsWs(c) { return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D || c === 0x0C; }
    function flatAlnum(c) { return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A); }
    function flatEscape(v) { return v.replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    // HTML whitespace is ASCII only: [\t\n\f\r ]. NEVER JS `\s` or String.trim() on these strings: the string is the page's
    // BYTES (one char per byte), and `\s`/trim() count U+00A0, i.e. the byte 0xA0, which is a UTF-8 CONTINUATION byte
    // ("à" is C3 A0, "Р" is D0 A0, many CJK characters end in A0): stripping it corrupts the text (WAF review of #712).
    function flatTrim(v) {
        let a = 0, b = v.length;
        while (a < b && flatIsWs(v.charCodeAt(a))) a++;
        while (b > a && flatIsWs(v.charCodeAt(b - 1))) b--;
        return v.slice(a, b);
    }
    function flatCollapse(v) { return flatTrim(v.replace(/[\t\n\f\r ]+/g, ' ')); }

    /** Cheap pre-scan: is there any "<input" or "<select" at all (any case)? */
    function flatHasControl(bytes) {
        const n = bytes.length - 6;
        for (let i = 0; i < n; i++) {
            if (bytes[i] !== 0x3C) continue;
            const c = bytes[i + 1] | 0x20;
            if (c === 0x69 && (bytes[i + 2] | 0x20) === 0x6E && (bytes[i + 3] | 0x20) === 0x70
                && (bytes[i + 4] | 0x20) === 0x75 && (bytes[i + 5] | 0x20) === 0x74) return true;
            if (c === 0x73 && (bytes[i + 2] | 0x20) === 0x65 && (bytes[i + 3] | 0x20) === 0x6C
                && (bytes[i + 4] | 0x20) === 0x65 && (bytes[i + 5] | 0x20) === 0x63 && (bytes[i + 6] | 0x20) === 0x74) return true;
        }
        return false;
    }

    /**
     * Parse the attributes of the start tag whose name ended at `k`.
     * @returns {{attrs: Map<string,string>, end: number}|null} `end` is just past '>'; null when
     *   the tag is not terminated (an unclosed quote, or no '>').
     */
    function flatScanTag(s, k, budget) {
        const attrs = new Map();
        const n = s.length;
        while (k < n) {
            if (budget.work++ > budget.limit) return null;
            let c = s.charCodeAt(k);
            if (c === 0x3E) return { attrs, end: k + 1 };
            if (flatIsWs(c) || c === 0x2F) { k++; continue; }
            const ns = k;
            while (k < n) {
                c = s.charCodeAt(k);
                if (flatIsWs(c) || c === 0x2F || c === 0x3E || c === 0x3D) break;
                k++;
            }
            if (k === ns) { k++; continue; }                       // a stray '='
            const name = s.slice(ns, k).toLowerCase();
            let p = k;
            while (p < n && flatIsWs(s.charCodeAt(p))) p++;
            let value = '';
            if (p < n && s.charCodeAt(p) === 0x3D) {
                p++;
                while (p < n && flatIsWs(s.charCodeAt(p))) p++;
                const q = s.charCodeAt(p);
                if (q === 0x22 || q === 0x27) {
                    const e = s.indexOf(q === 0x22 ? '"' : "'", p + 1);
                    if (e < 0) return null;                        // unclosed quote: not a tag we can read
                    budget.work += e - p;
                    value = s.slice(p + 1, e);
                    k = e + 1;
                } else {
                    let e = p;
                    while (e < n) { const cc = s.charCodeAt(e); if (flatIsWs(cc) || cc === 0x3E) break; e++; }
                    value = s.slice(p, e);
                    k = e;
                }
            }
            if (!attrs.has(name)) attrs.set(name, value);
        }
        return null;
    }

    function flatBox(text) {
        return '<span style="' + FLATTEN_BOX_STYLE + '">' + (text === '' ? FLATTEN_EMPTY_FILL : text) + '</span>';
    }

    /** The replacement for one <input>, or null to leave it alone. */
    function flatRenderInput(attrs) {
        const type = flatTrim(attrs.get('type') || 'text').toLowerCase();
        if (FLATTEN_SKIP_TYPES.has(type)) return null;
        if (type === 'checkbox') return attrs.has('checked') ? '&#9745;' : '&#9744;';
        if (type === 'radio') return attrs.has('checked') ? '&#9673;' : '&#9675;';
        const v = attrs.get('value') || '';
        if (type === 'password') return flatBox('&#8226;'.repeat(Math.min(v.length, 32)));   // never the secret
        return flatBox(flatTrim(v) === '' ? '' : flatEscape(v));
    }

    /** The text a <select> shows: its selected option(s), or the first option. */
    function flatSelectText(inner, selectAttrs, budget) {
        const options = [];
        let i = 0;
        while (i < inner.length) {
            const lt = inner.indexOf('<', i);
            if (lt < 0) break;
            if (inner.startsWith('<!--', lt)) { const e = inner.indexOf('-->', lt + 4); i = e < 0 ? inner.length : e + 3; continue; }
            let j = lt + 1;
            while (j < inner.length && flatAlnum(inner.charCodeAt(j))) j++;
            const name = inner.slice(lt + 1, j).toLowerCase();
            if (name !== 'option') { i = j > lt + 1 ? j : lt + 1; continue; }
            const t = flatScanTag(inner, j, budget);
            if (!t) { i = j; continue; }
            const nextLt = inner.indexOf('<', t.end);
            const raw = inner.slice(t.end, nextLt < 0 ? inner.length : nextLt);
            let text = flatCollapse(raw);
            if (text === '') text = flatTrim(t.attrs.get('label') || '');
            options.push({ text: flatEscape(text), selected: t.attrs.has('selected'), disabled: t.attrs.has('disabled') });
            i = t.end;
        }
        if (selectAttrs.has('multiple')) return options.filter((o) => o.selected).map((o) => o.text).join(', ');
        const chosen = options.filter((o) => o.selected);
        if (chosen.length) return chosen[chosen.length - 1].text;           // the last `selected` wins
        const first = options.find((o) => !o.disabled) || options[0];
        return first ? first.text : '';
    }

    /**
     * FG-040: replace the <input> and <select> controls of an HTML page with text that shows
     * their value and state. Pure; byte-preserving outside the replaced controls.
     * @param {Uint8Array|ArrayBuffer} input the HTML bytes
     * @returns {{bytes: Uint8Array, changed: boolean, count: number,
     *            spans: Array<[number, number, string]>, reason: (string|null), budgetExhausted: boolean}}
     *   `bytes` is `input` itself when nothing changed; `spans` lists [start, end, replacement]
     *   in input coordinates (for tests); `reason` says why a page was left untouched.
     */
    function flattenHtmlFormControls(input) {
        const bytes = input instanceof Uint8Array ? input : (input instanceof ArrayBuffer ? new Uint8Array(input) : null);
        const none = (reason, extra) => Object.assign({ bytes: input, changed: false, count: 0, spans: [], reason: reason || null, budgetExhausted: false }, extra);
        if (!bytes || bytes.length === 0) return none(null);
        if (bytes.length > FLATTEN_MAX_BYTES) return none('too-large');
        if ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF)) return none('utf16');
        for (let i = 0, m = Math.min(bytes.length, 64); i < m; i++) if (bytes[i] === 0) return none('utf16');
        if (!flatHasControl(bytes)) return none(null);

        let s = '';
        for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        const ls = s.toLowerCase();                       // same length: every code unit is <= 0xFF
        const budget = { work: 0, limit: 8 * s.length + 1024 };
        const out = [];
        const spans = [];
        let copied = 0;                                   // everything before this offset is in `out`
        const replace = (start, end, text) => {
            out.push(s.slice(copied, start), text);
            spans.push([start, end, text]);
            copied = end;
        };

        let i = 0;
        while (i < s.length && budget.work < budget.limit) {
            const lt = s.indexOf('<', i);
            if (lt < 0) break;
            budget.work += lt - i + 1;
            if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? s.length : e + 3; continue; }
            const c1 = s.charCodeAt(lt + 1);
            if (c1 === 0x21 || c1 === 0x3F) { const e = s.indexOf('>', lt + 2); i = e < 0 ? s.length : e + 1; continue; }
            if (c1 === 0x2F) { i = lt + 2; continue; }
            let j = lt + 1;
            while (j < s.length && flatAlnum(s.charCodeAt(j))) j++;
            const name = ls.slice(lt + 1, j);
            const d = s.charCodeAt(j);
            if (!name || !(j >= s.length || flatIsWs(d) || d === 0x2F || d === 0x3E)) { i = j > lt + 1 ? j : lt + 1; continue; }

            if (name === 'plaintext') break;               // the rest of the page is text
            if (FLATTEN_RAW_TEXT.has(name)) {
                const t = flatScanTag(s, j, budget);
                if (!t) { i = j; continue; }
                const e = ls.indexOf('</' + name, t.end);
                i = e < 0 ? s.length : e;
                continue;
            }
            const t = flatScanTag(s, j, budget);
            if (!t) { i = j; continue; }
            if (name === 'input') {
                const rep = flatRenderInput(t.attrs);
                if (rep !== null) replace(lt, t.end, rep);
                i = t.end;
            } else if (name === 'select') {
                // The search is charged to the work budget, so many selects with a distant or missing
                // close cannot make the scan quadratic: past the budget the rest is copied verbatim.
                const ce = ls.indexOf('</select', t.end);
                budget.work += (ce < 0 ? s.length : ce) - t.end;
                const gt = ce < 0 ? -1 : s.indexOf('>', ce);
                const inner = ce < 0 ? '' : s.slice(t.end, ce);
                if (ce < 0 || gt < 0 || ls.indexOf('<select', t.end) !== -1 && ls.indexOf('<select', t.end) < ce) { i = t.end; continue; }
                replace(lt, gt + 1, flatBox(flatSelectText(inner, t.attrs, budget)));
                i = gt + 1;
            } else {
                i = t.end;
            }
        }
        const budgetExhausted = i < s.length && budget.work >= budget.limit;   // the scan stopped early: the rest is verbatim
        if (spans.length === 0) return none(budgetExhausted ? 'budget' : null, { budgetExhausted });
        out.push(s.slice(copied));
        const joined = out.join('');
        const res = new Uint8Array(joined.length);
        for (let k = 0; k < joined.length; k++) res[k] = joined.charCodeAt(k);
        return { bytes: res, changed: true, count: spans.length, spans, reason: budgetExhausted ? 'budget' : null, budgetExhausted };
    }

    // ------------------------------------------------------------------
    // Font rights: ONE implementation (moved here from font_extractor.js for NTH-13; the page, the conversion
    // worker and the MCP host all call it, and the worker does not load font_extractor.js).
    // The rule is docs/fonts/embedded-font-rights.md; the engine applies the same one to the fonts embedded in an
    // Office/ODF/PDF file (engine/patches/*embedded-fonts-pdf-only-viewing-rights-wasm.patch).
    // ------------------------------------------------------------------
    const FSTYPE_EDITABLE_BIT = 0x08;

    /**
     * Read OS/2 fsType from sfnt bytes. Returns null when the font cannot be read.
     * A readable font with NO rights information (no OS/2 table, or one shorter than the
     * 42 bytes the engine requires) returns 0: the engine reads it as Installable
     * (GetTTGlobalFontInfo leaves typeFlags 0), and so does the owner's rule
     * (docs/fonts/embedded-font-rights.md: the user supplied the file).
     */
    function readSfntFsType(bytes) {
        try {
            if (!bytes || bytes.length < 12) return null;
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const tag0 = dv.getUint32(0);
            // 0x00010000 (TrueType), 'true', 'OTTO'. Reject anything else.
            if (tag0 !== 0x00010000 && tag0 !== 0x74727565 && tag0 !== 0x4F54544F) return null;
            const numTables = dv.getUint16(4);
            for (let i = 0; i < numTables; i++) {
                const rec = 12 + i * 16;
                if (rec + 16 > bytes.length) return null;
                const tag = String.fromCharCode(
                    bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
                if (tag === 'OS/2') {
                    const off = dv.getUint32(rec + 8);
                    // The engine clamps a table that runs past the end of the file to what
                    // is there (sft.cxx, "Check the table offsets"), and ignores an OS/2
                    // table under 42 bytes (GetTTGlobalFontInfo): fsType then reads 0.
                    const len = off >= bytes.length ? 0 : Math.min(dv.getUint32(rec + 12), bytes.length - off);
                    if (len < 42) return 0;
                    return dv.getUint16(off + 8);   // fsType is at +8 within OS/2
                }
            }
            return 0;                               // no OS/2 table: no rights information
        } catch (e) {
            return null;
        }
    }

    /**
     * The engine's rights rule, mirrored exactly:
     *  - usage permission (bits 0-3): when several are set, the LEAST restrictive wins
     *    (OpenType OS/2 spec, fsType, "Version differences"), so 0x0A and 0x0E are
     *    Editable; only Restricted on its own (0x02) is "not used";
     *  - every output: Installable, Editable or Preview & Print (owner, 2026-10-22);
     *  - 0x100 (no subsetting) refuses only where the font is subsetted: PDF output;
     *  - 0x200 (bitmap embedding only) refuses for every output.
     * A font with no rights information arrives as 0 (readSfntFsType). Unknown (null) is refused: fail safe.
     */
    const FSTYPE_RESTRICTED_BIT = 0x0002;
    const FSTYPE_PREVIEW_PRINT_BIT = 0x0004;
    const FSTYPE_NO_SUBSETTING_BIT = 0x0100;
    const FSTYPE_BITMAP_ONLY_BIT = 0x0200;
    function engineWillAcceptEmbedded(fsType, pdfOnly) {
        if (!Number.isInteger(fsType) || fsType < 0 || fsType > 0xFFFF) return false;   // unknown: fail safe
        if (fsType & FSTYPE_BITMAP_ONLY_BIT) return false;
        if (pdfOnly && (fsType & FSTYPE_NO_SUBSETTING_BIT)) return false;
        if (fsType & FSTYPE_EDITABLE_BIT) return true;            // least restrictive wins
        if (fsType & FSTYPE_PREVIEW_PRINT_BIT) return true;       // every output (owner, 2026-10-22)
        if (fsType & FSTYPE_RESTRICTED_BIT) return false;          // Restricted alone
        return true;                                               // Installable
    }

    // ------------------------------------------------------------------
    // NTH-13: web fonts carried in an HTML page's own CSS (@font-face with a data: URL).
    //
    // Writer's CSS parser skips every at-rule but @import and @page, and external URLs are never fetched (FG-022), so
    // a page's own typeface was drawn with a category fallback. This reads the data: fonts out of the page (TTF, OTF,
    // WOFF1) so the worker can mount them before the engine starts; every use goes through engineWillAcceptEmbedded on
    // the DECODED font's own OS/2 (never the WOFF wrapper). WOFF2 is not decoded: it is skipped with a notice.
    //
    // THE PAGE IS BYTES. The CSS is held one character per byte, so `\s`, String.trim() and toLowerCase() on it are
    // wrong (U+00A0 is the UTF-8 continuation byte 0xA0; WAF review of #712): only ASCII whitespace [\t\n\f\r ] and
    // ASCII case folding are used here, and names are decoded as UTF-8 only at the end.
    // ------------------------------------------------------------------
    const DATAFONT_MAX_FONT_BYTES = 8 * 1024 * 1024;       // one decoded font
    const DATAFONT_MAX_TOTAL_BYTES = 24 * 1024 * 1024;     // all of a page's decoded fonts
    const DATAFONT_MAX_PAYLOAD_CHARS = 12 * 1024 * 1024;   // one data: URL, as written
    const DATAFONT_MAX_FONTS = 16;
    const DATAFONT_MAX_RULES = 64;
    const DATAFONT_MAX_PAGE_BYTES = 50 * 1024 * 1024;

    function dfIsWs(c) { return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D || c === 0x0C; }
    function dfTrim(v) {
        let a = 0, b = v.length;
        while (a < b && dfIsWs(v.charCodeAt(a))) a++;
        while (b > a && dfIsWs(v.charCodeAt(b - 1))) b--;
        return v.slice(a, b);
    }
    /** ASCII-only lower case (A-Z); every other code unit, i.e. every non-ASCII byte, is kept as it is. */
    function dfLower(v) { return v.replace(/[A-Z]+/g, (m) => m.toLowerCase()); }
    function dfBinaryString(bytes) {
        let s = '';
        for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        return s;
    }
    function dfBytesOf(str) { const o = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) o[i] = str.charCodeAt(i) & 0xFF; return o; }
    /** A name read from the page's bytes, decoded as UTF-8 (a lone bad byte becomes U+FFFD, which never matches a family). */
    function dfUtf8(str) { return new TextDecoder('utf-8').decode(dfBytesOf(str)); }
    /**
     * A family name that is safe to put in fontconfig's XML: only XML 1.0 Chars (no C0/C1 controls, no lone surrogate, no
     * U+FFFE/FFFF), runs of ASCII whitespace collapsed to one space, at most 128 code points. May return ''.
     */
    function dfCleanName(n) {
        let t = String(n == null ? '' : n).replace(/[^\u0020-\u007E\u00A0-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}\t\n\f\r]/gu, '');
        t = dfTrim(t.replace(/[\t\n\f\r ]+/g, ' '));
        const cps = Array.from(t);
        return cps.length > 128 ? cps.slice(0, 128).join('') : t;
    }
    /** A name safe to show a user and to put in a notice: no control characters or markup, at most 60 characters. */
    function dfSafeName(n) {
        const t = String(n).replace(/[\u0000-\u001f\u007f<>&"]/g, '');
        return t.length > 60 ? t.slice(0, 60) : t;
    }

    function dfSkipString(s, i) {                           // s[i] is a quote; returns the index after the closing quote
        const q = s.charCodeAt(i);
        for (let k = i + 1; k < s.length; k++) {
            const c = s.charCodeAt(k);
            if (c === 0x5C) { k++; continue; }
            if (c === q) return k + 1;
            if (c === 0x0A) return k;                       // an unterminated string ends at the line end, as in CSS
        }
        return s.length;
    }
    function dfSkipUrl(s, i) {                              // s[i..] is "url(": returns the index after its ")"
        let k = i + 4;
        while (k < s.length && dfIsWs(s.charCodeAt(k))) k++;
        const q = s.charCodeAt(k);
        if (q === 0x22 || q === 0x27) {
            k = dfSkipString(s, k);
            while (k < s.length && s.charCodeAt(k) !== 0x29) k++;
            return Math.min(k + 1, s.length);
        }
        const e = s.indexOf(')', k);
        return e < 0 ? s.length : e + 1;
    }
    function dfIsUrlAt(s, i) { return (s.charCodeAt(i) | 0x20) === 0x75 && (s.charCodeAt(i + 1) | 0x20) === 0x72 && (s.charCodeAt(i + 2) | 0x20) === 0x6C && s.charCodeAt(i + 3) === 0x28; }

    /** The end of the {...} block that starts at s[i] === '{' (index of its '}'), or -1. */
    function dfBlockEnd(s, i) {
        let depth = 0;
        for (let k = i; k < s.length; k++) {
            const c = s.charCodeAt(k);
            if (c === 0x5C) { k++; continue; }
            if (c === 0x2F && s.charCodeAt(k + 1) === 0x2A) { const e = s.indexOf('*/', k + 2); if (e < 0) return -1; k = e + 1; continue; }
            if (c === 0x22 || c === 0x27) { k = dfSkipString(s, k) - 1; continue; }
            if (dfIsUrlAt(s, k)) { k = dfSkipUrl(s, k) - 1; continue; }
            if (c === 0x7B) depth++;
            else if (c === 0x7D) { depth--; if (depth === 0) return k; }
        }
        return -1;
    }
    /** Split at top-level `sep` characters (outside strings, url(), parentheses and comments). */
    function dfSplitTop(s, sep) {
        const out = []; let start = 0, paren = 0;
        for (let k = 0; k < s.length; k++) {
            const c = s.charCodeAt(k);
            if (c === 0x5C) { k++; continue; }
            if (c === 0x2F && s.charCodeAt(k + 1) === 0x2A) { const e = s.indexOf('*/', k + 2); k = e < 0 ? s.length : e + 1; continue; }
            if (c === 0x22 || c === 0x27) { k = dfSkipString(s, k) - 1; continue; }
            if (dfIsUrlAt(s, k)) { k = dfSkipUrl(s, k) - 1; continue; }
            if (c === 0x28) paren++; else if (c === 0x29 && paren > 0) paren--;
            else if (c === sep && paren === 0) { out.push(s.slice(start, k)); start = k + 1; }
        }
        out.push(s.slice(start));
        return out;
    }
    function dfUnquote(v) {
        v = dfTrim(v);
        const q = v.charCodeAt(0);
        if ((q === 0x22 || q === 0x27) && v.length >= 2 && v.charCodeAt(v.length - 1) === q) return v.slice(1, -1).replace(/\\(.)/g, '$1');
        return v.replace(/\\(.)/g, '$1');                      // an unquoted name: Plain\ Name
    }

    /** The data: payload of a CSS url() value as bytes, or {error}. */
    function dfDecodeDataUrl(raw) {
        const u = dfTrim(raw);
        if (dfLower(u.slice(0, 5)) !== 'data:') return { notData: true };
        const comma = u.indexOf(',');
        if (comma < 0) return { error: 'malformed' };
        const meta = u.slice(5, comma).split(';');
        const isB64 = meta.slice(1).some((m) => dfLower(dfTrim(m)) === 'base64');
        const payload = u.slice(comma + 1);
        if (payload.length > DATAFONT_MAX_PAYLOAD_CHARS) return { error: 'too-large' };
        try {
            if (isB64) {
                const bin = atob(payload.replace(/[\t\n\f\r ]+/g, ''));
                return { bytes: dfBytesOf(bin), mime: dfLower(dfTrim(meta[0])) };
            }
            const out = [];
            for (let k = 0; k < payload.length; k++) {
                const c = payload.charCodeAt(k);
                if (c === 0x25) {
                    const h = payload.slice(k + 1, k + 3);
                    if (!/^[0-9A-Fa-f]{2}$/.test(h)) return { error: 'malformed' };
                    out.push(parseInt(h, 16)); k += 2;
                } else out.push(c & 0xFF);
            }
            return { bytes: Uint8Array.from(out), mime: dfLower(dfTrim(meta[0])) };
        } catch (e) { return { error: 'malformed' }; }
    }

    /**
     * Read the @font-face rules of an HTML page's <style> elements.
     * @param {Uint8Array} bytes the page
     * @returns {{faces: Array<{family: string, sources: Array<{kind: ('data'|'other'), bytes?: Uint8Array, error?: string, format?: string}>}>, truncated: boolean}}
     *   External url() sources are listed as 'other' and are never fetched.
     */
    function parseHtmlFontFaces(bytes) {
        const faces = [];
        const s = dfBinaryString(bytes);
        const ls = dfLower(s);
        // Linear by construction: every step advances the position, a rule that fails to close ends the scan, and the number of
        // rules is capped, so there is no work budget to exhaust (unlike the form flattener).
        let truncated = false;
        let pos = 0;
        while (pos < s.length) {
            const st = ls.indexOf('<style', pos);
            if (st < 0) break;
            const d = s.charCodeAt(st + 6);
            if (!(dfIsWs(d) || d === 0x3E || d === 0x2F || Number.isNaN(d))) { pos = st + 6; continue; }
            // the start tag ends at the first '>' outside a quoted attribute value
            let k = st + 6, q = 0;
            for (; k < s.length; k++) {
                const c = s.charCodeAt(k);
                if (q) { if (c === q) q = 0; } else if (c === 0x22 || c === 0x27) q = c; else if (c === 0x3E) break;
            }
            if (k >= s.length) break;
            const cssStart = k + 1;
            const close = ls.indexOf('</style', cssStart);
            const css = s.slice(cssStart, close < 0 ? s.length : close);
            pos = close < 0 ? s.length : close + 7;
            // the rules of this block
            for (let i = 0; i < css.length; i++) {
                const c = css.charCodeAt(i);
                if (c === 0x5C) { i++; continue; }                          // a backslash escapes the next character, also outside strings
                if (c === 0x2F && css.charCodeAt(i + 1) === 0x2A) { const e = css.indexOf('*/', i + 2); if (e < 0) break; i = e + 1; continue; }
                if (c === 0x22 || c === 0x27) { i = dfSkipString(css, i) - 1; continue; }
                if (c !== 0x40 || dfLower(css.slice(i + 1, i + 10)) !== 'font-face') continue;
                let j = i + 10;
                while (j < css.length && dfIsWs(css.charCodeAt(j))) j++;
                if (css.charCodeAt(j) !== 0x7B) continue;
                const end = dfBlockEnd(css, j);
                if (end < 0) { truncated = true; break; }
                if (faces.length >= DATAFONT_MAX_RULES) { truncated = true; break; }
                const face = { family: '', sources: [] };
                for (const decl of dfSplitTop(css.slice(j + 1, end), 0x3B)) {
                    const colon = decl.indexOf(':');
                    if (colon < 0) continue;
                    const name = dfLower(dfTrim(decl.slice(0, colon)));
                    const value = dfTrim(decl.slice(colon + 1));
                    if (name === 'font-family' && !face.family) {
                        const first = dfSplitTop(value, 0x2C)[0];
                        face.family = dfUtf8(dfUnquote(first).replace(/[\t\n\f\r ]+/g, ' '));
                    } else if (name === 'src') {
                        for (const entry of dfSplitTop(value, 0x2C).slice(0, 8)) {
                            const e = dfTrim(entry);
                            const ui = dfLower(e).indexOf('url(');
                            if (ui < 0) continue;                         // local(): not a file
                            const uEnd = dfSkipUrl(e, ui);
                            const raw = dfUnquote(e.slice(ui + 4, uEnd - 1));
                            const fm = /format\([\t\n\f\r ]*["']?([^"')\t\n\f\r ]+)/i.exec(e.slice(uEnd));
                            const dec = dfDecodeDataUrl(raw);
                            if (dec.notData) face.sources.push({ kind: 'other' });
                            else if (dec.error) face.sources.push({ kind: 'data', error: dec.error });
                            else face.sources.push({ kind: 'data', bytes: dec.bytes, format: fm ? dfLower(fm[1]) : '' });
                        }
                    }
                }
                faces.push(face);
                i = end;
            }
        }
        return { faces, truncated };
    }

    // ---- sfnt and WOFF1 ------------------------------------------------------------------------------------------
    /** 'woff' | 'woff2' | 'sfnt' | 'ttc' | 'unknown', from the first four bytes (never the declared MIME type). */
    function dfKind(b) {
        if (!b || b.length < 4) return 'unknown';
        const t = String.fromCharCode(b[0], b[1], b[2], b[3]);
        if (t === 'wOFF') return 'woff';
        if (t === 'wOF2') return 'woff2';
        if (t === 'ttcf') return 'ttc';
        if ((b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || t === 'true' || t === 'OTTO') return 'sfnt';
        return 'unknown';
    }

    /** Inflate a zlib stream to exactly `origLen` bytes; throws when it inflates past or short of that. */
    async function dfInflate(comp, origLen) {
        const ds = new DecompressionStream('deflate');
        const w = ds.writable.getWriter();
        const writing = (async () => { await w.write(comp); await w.close(); })();
        writing.catch(() => { /* a bad stream surfaces on the read side */ });
        const reader = ds.readable.getReader();
        const chunks = []; let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > origLen) { try { await reader.cancel(); } catch (e) { /* done */ } throw new Error('a table inflates past its declared size'); }
            chunks.push(value);
        }
        if (total !== origLen) throw new Error('a table inflates to less than its declared size');
        const out = new Uint8Array(origLen); let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out;
    }

    /**
     * WOFF 1.0 to sfnt (TTF/OTF). Bounded by the declared sizes; throws on anything malformed.
     * @param {Uint8Array} b
     * @returns {Promise<Uint8Array>}
     */
    async function decodeWoff1(b) {
        if (!b || b.length < 44 || dfKind(b) !== 'woff') throw new Error('not a WOFF file');
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const flavor = dv.getUint32(4), length = dv.getUint32(8), n = dv.getUint16(12), total = dv.getUint32(16);
        if (length !== b.length) throw new Error('WOFF length mismatch');
        if (n < 1 || n > 64) throw new Error('WOFF table count');
        if (total > DATAFONT_MAX_FONT_BYTES) throw new Error('WOFF too large');
        const dirEnd = 44 + 20 * n;
        if (dirEnd > b.length) throw new Error('WOFF directory');
        const tables = []; let sum = 0;
        for (let i = 0; i < n; i++) {
            const r = 44 + i * 20;
            const t = { tag: dv.getUint32(r), off: dv.getUint32(r + 4), comp: dv.getUint32(r + 8), orig: dv.getUint32(r + 12), sum: dv.getUint32(r + 16) };
            if (t.off < dirEnd || t.off + t.comp > b.length || t.comp > t.orig) throw new Error('WOFF table bounds');
            sum += (t.orig + 3) & ~3;
            if (sum > DATAFONT_MAX_FONT_BYTES) throw new Error('WOFF too large');
            tables.push(t);
        }
        tables.sort((x, y) => x.tag - y.tag);
        for (let i = 1; i < tables.length; i++) if (tables[i].tag === tables[i - 1].tag) throw new Error('WOFF duplicate table');
        const datas = [];
        for (const t of tables) {
            const raw = b.subarray(t.off, t.off + t.comp);
            datas.push(t.comp === t.orig ? raw : await dfInflate(raw, t.orig));
        }
        const headLen = 12 + 16 * n;
        let off = headLen;
        const offs = tables.map((t) => { const o = off; off += (t.orig + 3) & ~3; return o; });
        const out = new Uint8Array(off);
        const ov = new DataView(out.buffer);
        let es = 0; while ((1 << (es + 1)) <= n) es++;
        ov.setUint32(0, flavor); ov.setUint16(4, n); ov.setUint16(6, 16 * (1 << es)); ov.setUint16(8, es); ov.setUint16(10, 16 * n - 16 * (1 << es));
        tables.forEach((t, i) => {
            const r = 12 + i * 16;
            ov.setUint32(r, t.tag); ov.setUint32(r + 4, t.sum); ov.setUint32(r + 8, offs[i]); ov.setUint32(r + 12, t.orig);
            out.set(datas[i], offs[i]);
        });
        return out;
    }

    /**
     * What a decoded sfnt is, checked cheaply and in bounds: its container, the tables a font needs, the OS/2 rights
     * field, and the family name FreeType/fontconfig will see.
     * @returns {{ok: boolean, reason?: string, kind?: ('ttf'|'otf'), fsType?: number, family?: (string|null)}}
     */
    function sfntFacts(b) {
        try {
            if (!b || b.length < 12 || dfKind(b) !== 'sfnt') return { ok: false, reason: 'not an sfnt font' };
            const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
            const n = dv.getUint16(4);
            if (n < 1 || n > 64 || 12 + n * 16 > b.length) return { ok: false, reason: 'table directory' };
            const T = new Map();
            for (let i = 0; i < n; i++) {
                const r = 12 + i * 16;
                const tag = String.fromCharCode(b[r], b[r + 1], b[r + 2], b[r + 3]);
                const off = dv.getUint32(r + 8), len = dv.getUint32(r + 12);
                if (off < 12 + n * 16 || off + len > b.length) return { ok: false, reason: 'table bounds: ' + tag };
                T.set(tag, { off, len });
            }
            const head = T.get('head');
            if (!head || head.len < 54 || dv.getUint32(head.off + 12) !== 0x5F0F3CF5) return { ok: false, reason: 'head table' };
            if (!T.has('cmap')) return { ok: false, reason: 'no cmap' };
            const otf = dfKind(b) === 'sfnt' && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'OTTO';
            if (otf ? !T.has('CFF ') : !(T.has('glyf') && T.has('loca'))) return { ok: false, reason: 'no outlines' };
            const fsType = readSfntFsType(b);
            if (fsType === null) return { ok: false, reason: 'unreadable OS/2' };
            let family = null;
            const nm = T.get('name');
            if (nm && nm.len >= 6) {
                const cnt = dv.getUint16(nm.off + 2), so = dv.getUint16(nm.off + 4);
                let best = null;
                for (let i = 0; i < cnt && 6 + (i + 1) * 12 <= nm.len; i++) {
                    const r = nm.off + 6 + i * 12;
                    const plat = dv.getUint16(r), id = dv.getUint16(r + 6), len = dv.getUint16(r + 8), o = dv.getUint16(r + 10);
                    if (id !== 1 || nm.off + so + o + len > b.length || o + len > nm.len) continue;
                    const str = b.subarray(nm.off + so + o, nm.off + so + o + len);
                    let text = null;
                    if (plat === 3 && len % 2 === 0) { text = ''; for (let k = 0; k < len; k += 2) text += String.fromCharCode((str[k] << 8) | str[k + 1]); }
                    else if (plat === 1) text = String.fromCharCode.apply(null, str);
                    if (text && (!best || (plat === 3 && best.plat !== 3))) best = { plat, text };
                }
                if (best) family = best.text;
            }
            return { ok: true, kind: otf ? 'otf' : 'ttf', fsType, family };
        } catch (e) { return { ok: false, reason: 'unreadable' }; }
    }

    /** Is there an "@font-face" anywhere (any case)? A cheap byte pass so most pages cost nothing more. */
    function dfHasFontFace(b) {
        const n = b.length - 10;
        for (let i = 0; i < n; i++) {
            if (b[i] !== 0x40) continue;
            if ((b[i + 1] | 0x20) === 0x66 && (b[i + 2] | 0x20) === 0x6F && (b[i + 3] | 0x20) === 0x6E && (b[i + 4] | 0x20) === 0x74
                && b[i + 5] === 0x2D && (b[i + 6] | 0x20) === 0x66 && (b[i + 7] | 0x20) === 0x61 && (b[i + 8] | 0x20) === 0x63 && (b[i + 9] | 0x20) === 0x65) return true;
        }
        return false;
    }

    /**
     * The fonts an HTML page carries in data: URLs, decoded, validated and cleared by the rights rule for this output.
     * Never throws. @returns {Promise<{fonts: Array<{cssFamily: string, family: string, bytes: Uint8Array, kind: string, fsType: number, hash: string}>,
     *   skipped: Array<{family: string, reason: string}>, notices: string[]}>}
     * Skip reasons: 'woff2' | 'unsupported' | 'malformed' | 'too-large' | 'limit' | 'rights'.
     */
    async function prepareHtmlDataFonts(input, opts) {
        const out = { fonts: [], skipped: [], notices: [] };
        try {
            const pdfOnly = !!(opts && opts.pdfOnly);
            const bytes = input instanceof Uint8Array ? input : (input instanceof ArrayBuffer ? new Uint8Array(input) : null);
            if (!bytes || bytes.length === 0 || bytes.length > DATAFONT_MAX_PAGE_BYTES) return out;
            if ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF)) return out;
            for (let i = 0, m = Math.min(bytes.length, 64); i < m; i++) if (bytes[i] === 0) return out;
            if (!dfHasFontFace(bytes)) return out;
            const { faces } = parseHtmlFontFaces(bytes);
            let total = 0;
            const seen = new Set();
            const skip = (family, reason) => { out.skipped.push({ family, reason }); };
            for (const face of faces) {
                const data = face.sources.filter((s) => s.kind === 'data');
                if (data.length === 0) continue;                              // only external or local() sources: nothing carried in the page
                const family = dfCleanName(face.family);          // fontconfig writes it into XML: clean and capped here too
                if (!family) { skip('', 'malformed'); continue; }
                let chosen = null, firstReason = null;
                for (const src of data) {
                    if (src.error) { firstReason = firstReason || src.error; continue; }
                    const kind = dfKind(src.bytes);
                    if (kind === 'sfnt' || kind === 'woff') { chosen = { src, kind }; break; }
                    firstReason = firstReason || (kind === 'woff2' ? 'woff2' : 'unsupported');
                }
                if (!chosen) { skip(family, firstReason || 'unsupported'); continue; }
                if (out.fonts.length >= DATAFONT_MAX_FONTS) { skip(family, 'limit'); continue; }
                let sfnt;
                try { sfnt = chosen.kind === 'woff' ? await decodeWoff1(chosen.src.bytes) : chosen.src.bytes; }
                catch (e) { skip(family, 'malformed'); continue; }
                if (sfnt.length > DATAFONT_MAX_FONT_BYTES) { skip(family, 'too-large'); continue; }
                const facts = sfntFacts(sfnt);
                if (!facts.ok) { skip(family, 'malformed'); continue; }
                // THE RIGHTS DECISION: one function, the decoded font's own OS/2.
                if (!engineWillAcceptEmbedded(facts.fsType, pdfOnly)) { skip(family, 'rights'); continue; }
                if (total + sfnt.length > DATAFONT_MAX_TOTAL_BYTES) { skip(family, 'limit'); continue; }
                const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', sfnt));
                const hash = Array.from(digest.subarray(0, 8), (x) => x.toString(16).padStart(2, '0')).join('');
                if (seen.has(hash + '|' + family)) continue;
                seen.add(hash + '|' + family);
                total += sfnt.length;
                out.fonts.push({ cssFamily: family, family: dfCleanName(facts.family) || family, bytes: sfnt, kind: facts.kind, fsType: facts.fsType, hash });
            }
            const said = new Set();
            for (const sk of out.skipped) {
                const name = dfSafeName(sk.family) || 'a web font';
                const key = name + '|' + (sk.reason === 'rights' ? 'rights' : 'other');
                if (said.has(key)) continue;
                said.add(key);
                out.notices.push(sk.reason === 'rights'
                    ? `This document's web font ${name} can't be used in this conversion because its font file doesn't allow embedding; a similar font was used.`
                    : `This document's web font ${name} isn't included in this conversion; a similar font was used.`);
            }
        } catch (e) { /* a font problem never fails a conversion */ }
        return out;
    }

    const LEGACY_TEXT_FORMATS = ['txt'];

    /**
     * Delimited text, eligible ONLY when the caller passes `{ delimited: true }`
     * (FG-057 / BUG-32). On the engine path the bridge imports CSV with an
     * explicit charset (UTF-8 unless the user chose one), so a legacy file the user
     * left at the default was read as UTF-8 and every accented byte became U+FFFD.
     * Transcoding it to UTF-8 first fixes that; the two objections above are met
     * by (a) emitting NO BOM for delimited text, so nothing lands in the first cell,
     * and (b) the caller not opting in when the user explicitly chose a legacy
     * encoding, which the bridge then honours itself (CB-001, #418).
     */
    const LEGACY_DELIMITED_FORMATS = ['csv', 'tsv'];

    /** The three bytes of a UTF-8 byte-order mark. */
    const UTF8_BOM = [0xEF, 0xBB, 0xBF];

    /**
     * Byte-order-mark sniff.
     * @param {Uint8Array} bytes
     * @returns {'utf-8'|'utf-16le'|'utf-16be'|null}
     */
    function sniffBOM(bytes) {
        if (!bytes || bytes.length < 2) return null;
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le';
        if (bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be';
        if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8';
        return null;
    }

    /**
     * FG-140: does this UTF-8 contain a conjoining Hangul Jamo (U+1100-11FF)?
     * Byte scan, no decode: those code points encode as E1 84 80 .. E1 87 BF.
     */
    function hasConjoiningJamoUtf8(bytes) {
        for (let i = 0, n = bytes.length - 1; i < n; i++) {
            if (bytes[i] === 0xE1 && bytes[i + 1] >= 0x84 && bytes[i + 1] <= 0x87) return true;
        }
        return false;
    }

    // A run of conjoining Jamo, optionally after a precomposed syllable (a
    // trailing final consonant composes onto it).
    const JAMO_RUN_RE = /[\uAC00-\uD7A3]?[\u1100-\u11FF]+/g;

    /**
     * FG-140: compose conjoining Hangul Jamo runs into precomposed syllables.
     * Modern Korean saved decomposed (NFD, as macOS writes it) has no font in the
     * converter, but its composed syllables do (NanumGothic). Only Jamo runs are
     * normalized: NFC composition spans a starter and what follows it, so per-run
     * NFC equals whole-text NFC there and leaves every other code point as the
     * author wrote it: every Jamo and syllable is a starter, the only
     * compositions involving them are L+V and LV+T, and the run's boundaries
     * are characters nothing composes across. Old Hangul with no precomposed
     * form is left unchanged.
     * @param {string} text
     * @returns {string}
     */
    function composeConjoiningJamo(text) {
        return text.replace(JAMO_RUN_RE, (m) => m.normalize('NFC'));
    }

    /** True when `bytes` decode as strict (fatal) UTF-8. Never throws. */
    function isValidUtf8(bytes) {
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * FEAT-14 Q6 (owner-approved 2026-10-31): THE CSV/TSV encoding detector, one for every
     * surface. The website's in-page CSV path (csv_fast_path.js decodeBuffer), its engine
     * path (transcodeLegacyTextInput, delimited) and the MCP (from the first release that
     * carries this; feature-detect with typeof ConversionProtocol.detectCsvEncoding ===
     * 'function') read a CSV's bytes the same way. Additive export: CONTRACT_VERSION is
     * unchanged.
     *
     * The order is the union of the two earlier detectors:
     *   1. a byte-order mark (UTF-8, UTF-16LE, UTF-16BE): declared, not a guess;
     *   2. UTF-16 without a BOM, from the parity of its NUL bytes (sniffUtf16WithoutBom;
     *      a NUL never occurs in a genuine CSV, so this runs even on valid UTF-8);
     *   3. valid UTF-8 (including plain ASCII): not a guess;
     *   4. not UTF-8 but containing NUL bytes that are not decisively UTF-16: no answer
     *      (encoding null). Each caller keeps its own rule for that: the in-page path reads
     *      Windows-1252 with a warning, the engine path converts the bytes as they are with
     *      a notice;
     *   5. Simplified Chinese (GB18030/GBK), FG-155;
     *   6. another legacy charset identified with confidence (FG-056), only if the WHOLE
     *      input decodes cleanly in it;
     *   7. Windows-1252, which cannot fail.
     * Steps 2 and 5-7 are guesses: `guessed` is true and the caller reports them.
     *
     * Pure, node-testable, never throws.
     *
     * @param {ArrayBuffer|Uint8Array} buffer
     * @returns {{encoding: (string|null), reason: string, guessed: boolean, bomLength: number,
     *            text: (string|undefined)}}
     *   encoding  - a WHATWG TextDecoder label, or null (step 4)
     *   reason    - 'empty' | 'bom' | 'utf16-without-bom' | 'valid-utf-8' |
     *               'not-utf8-with-nul' | 'gb18030' | 'legacy' | 'windows-1252'
     *   bomLength - bytes of BOM at the start (0, 2 or 3)
     *   text      - the decoded text when the check already had to decode it (steps 5-6)
     */
    function detectCsvEncoding(buffer) {
        let bytes;
        try {
            bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || new ArrayBuffer(0));
        } catch (e) {
            bytes = new Uint8Array(0);
        }
        const out = (encoding, reason, guessed, extra) =>
            Object.assign({ encoding, reason, guessed, bomLength: 0 }, extra || {});
        if (bytes.length === 0) return out('utf-8', 'empty', false);
        const bom = sniffBOM(bytes);
        if (bom) return out(bom, 'bom', false, { bomLength: bom === 'utf-8' ? 3 : 2 });
        const hasNul = bytes.indexOf(0) !== -1;
        if (hasNul) {
            const guess = sniffUtf16WithoutBom(bytes, { allowValidUtf8: true });
            if (guess) return out(guess, 'utf16-without-bom', true);
        }
        if (isValidUtf8(bytes)) return out('utf-8', 'valid-utf-8', false);
        if (hasNul) return out(null, 'not-utf8-with-nul', false);
        if (sniffGb18030(bytes)) {
            return out('gb18030', 'gb18030', true, { text: new TextDecoder('gb18030').decode(bytes) });
        }
        const legacy = sniffLegacyCharset(bytes);
        const legacyText = legacy ? decodeLegacyOrNull(bytes, legacy) : null;
        if (legacyText !== null) return out(legacy, 'legacy', true, { text: legacyText });
        return out('windows-1252', 'windows-1252', true);
    }

    /**
     * Decide whether a text input needs transcoding to UTF-8, and do it.
     *
     * Guarantees, in order of how expensive being wrong would be:
     *   1. A format not in LEGACY_TEXT_FORMATS is returned untouched — the same
     *      bytes over the same ArrayBuffer, never a copy, never a re-encode.
     *   2. Valid UTF-8 (which includes all pure ASCII) is returned untouched,
     *      except that a .txt containing conjoining Hangul Jamo has its Jamo
     *      runs composed (FG-140; canonically equivalent, so `message` is null).
     *   3. A UTF-8 or UTF-16 BOM is honoured: the file has declared itself, so
     *      it is returned untouched (the same FG-140 exception applies after a
     *      UTF-8 BOM, which is kept) and LOK's deterministic BOM branch handles it.
     *   4. Bytes that are neither valid UTF-8 nor BOM-marked but DO contain NUL
     *      are returned untouched with a warning: that is BOM-less UTF-16/UTF-32
     *      (or something binary), and decoding it as a single-byte charset would
     *      turn real text into guaranteed mojibake. We say so instead of guessing.
     *   5. Only what is left — invalid UTF-8, no BOM, no NUL, i.e. single-byte
     *      legacy text — is decoded as windows-1252 and re-encoded as UTF-8 with
     *      a BOM. windows-1252 rather than ISO-8859-1 because it is a strict
     *      superset in practice (it fills 0x80-0x9F, the C1 control block, with
     *      the €, curly-quote and dash characters real files actually contain),
     *      and because WHATWG already resolves the label "iso-8859-1" to it.
     *      No statistical guessing between legacy charsets: a Shift-JIS, Big5 or
     *      KOI8-R file is NOT recovered by this, which is why `message` is
     *      always set when this fallback transcodes. (An exact rewrite -- a
     *      BOM-marked UTF-16 delimited file, or FG-140's Jamo composition --
     *      carries no message.)
     *
     * Pure + node-testable. Never throws.
     *
     * @param {ArrayBuffer|Uint8Array} buffer
     * @param {string} ext - extension ('txt', '.txt') or a whole file name
     * @returns {{bytes: Uint8Array, transcoded: boolean, encoding: string|null,
     *            reason: string, message: string|null}}
     *   bytes   — what to send to the worker. When `transcoded` is false this is
     *             a view over the caller's own buffer (no copy). When true it is
     *             a fresh, exactly-sized array (byteOffset 0, byteLength ===
     *             buffer.byteLength) so `.buffer` can be handed on directly.
     *   message — user-facing text, non-null exactly when the user needs telling.
     */
    function transcodeLegacyTextInput(buffer, ext, opts) {
        const delimited = !!(opts && opts.delimited);
        let bytes;
        try {
            bytes = buffer instanceof Uint8Array
                ? buffer
                : new Uint8Array(buffer || new ArrayBuffer(0));
        } catch (e) {
            return { bytes: new Uint8Array(0), transcoded: false, encoding: null,
                     reason: 'unreadable', message: null };
        }
        const result = (reason, encoding, message) => ({
            bytes, transcoded: false, encoding: encoding || null, reason,
            message: message || null
        });

        // NB: not sanitizeExtension() — that one expects a *file name* and maps a
        // bare 'txt' (no dot) to 'bin'. Callers here pass analysis.extension.
        const raw = String(ext == null ? '' : ext).toLowerCase();
        const e = raw.slice(raw.lastIndexOf('.') + 1).replace(/[^a-z0-9]/g, '');
        const isDelimited = delimited && LEGACY_DELIMITED_FORMATS.indexOf(e) !== -1;
        if (LEGACY_TEXT_FORMATS.indexOf(e) === -1 && !isDelimited) return result('format-not-eligible');
        if (bytes.length === 0) return result('empty');

        const bom = sniffBOM(bytes);
        // FG-140: plain-text Korean saved as conjoining Jamo is composed into
        // syllables (canonically equivalent; BOM kept as authored). Text with no
        // Jamo, and every non-.txt format, is never decoded or copied here.
        const composeJamo = (skip) => {
            if (isDelimited || !hasConjoiningJamoUtf8(bytes)) return null;
            let text;
            try {
                text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(skip));
            } catch (err) { return null; }
            const composed = composeConjoiningJamo(text);
            if (composed === text) return null;
            const body = new TextEncoder().encode(composed);
            const out = new Uint8Array(skip + body.length);
            out.set(bytes.subarray(0, skip), 0);
            out.set(body, skip);
            return { bytes: out, transcoded: true, encoding: 'utf-8',
                     reason: 'utf-8-jamo-composed', message: null };
        };
        if (bom === 'utf-8') return composeJamo(3) || result('bom-utf-8', 'utf-8');

        // CB-003: delimited text reaches an importer that is TOLD the charset
        // (UTF-8 unless the user chose one), so UTF-16 must be decoded here. .txt
        // is left alone: LibreOffice's text import reads a UTF-16 BOM itself.
        const utf16ToUtf8 = (enc, skip) => {
            const text = new TextDecoder(enc).decode(bytes.subarray(skip));
            return new TextEncoder().encode(text);   // no BOM for delimited text
        };
        if (isDelimited) {
            // FEAT-14 Q6: delimited text is read by THE shared CSV detector (detectCsvEncoding).
            const d = detectCsvEncoding(bytes);
            if (d.reason === 'bom' && d.encoding !== 'utf-8') {
                try {
                    return { bytes: utf16ToUtf8(d.encoding, 2), transcoded: true, encoding: d.encoding,
                             reason: 'bom-utf-16-transcoded', message: null };   // exact: no guess
                } catch (err) { return result('bom-utf-16', d.encoding); }
            }
            if (d.reason === 'utf16-without-bom') {
                try {
                    return { bytes: utf16ToUtf8(d.encoding, 0), transcoded: true, encoding: d.encoding,
                             reason: 'utf16-without-bom',
                             message: 'This file has no byte-order mark but its bytes are UTF-16 ' +
                                 '(' + (d.encoding === 'utf-16le' ? 'little' : 'big') + '-endian), so it ' +
                                 'was read as UTF-16. If any characters look wrong, re-saving it as ' +
                                 'UTF-8 will convert exactly.' };
                } catch (err) { /* fall through to the NUL notice below */ }
            }
            if (d.reason === 'valid-utf-8') return result('valid-utf-8', 'utf-8');
            if (d.reason === 'gb18030' || d.reason === 'legacy') return legacyResult(d.encoding, d.text);
            if (d.reason === 'windows-1252') return windows1252Result();
            // 'not-utf8-with-nul' (or a UTF-16 decode that failed): the NUL notice below.
        } else if (bom) {
            return result('bom-utf-16', bom);
        }

        if (isValidUtf8(bytes)) return composeJamo(0) || result('valid-utf-8', 'utf-8');

        if (bytes.indexOf(0) !== -1) {
            return result('not-utf8-with-nul', null,
                'This text file is not valid UTF-8 and contains NUL bytes, so it looks like ' +
                'UTF-16 saved without a byte-order mark. It was converted as-is rather than ' +
                'guessed at, so some characters may be wrong. Re-saving it as UTF-8 (or with ' +
                'a byte-order mark) will convert exactly.');
        }

        // FG-155 / FG-056: a confidently identified legacy encoding is decoded as
        // such (UTF-8 out, BOM for .txt only), with a notice naming it. Anything
        // ambiguous keeps the windows-1252 fallback below. sniffLegacyCharset
        // judges a prefix, so the whole input must also decode cleanly in its
        // verdict; one invalid sequence past the prefix sends it to the fallback.
        let legacy = null, legacyText = null;
        if (sniffGb18030(bytes)) {
            legacy = 'gb18030';
            legacyText = new TextDecoder('gb18030').decode(bytes);   // sniffGb18030 decoded it fatally
        } else {
            const guess = sniffLegacyCharset(bytes);
            legacyText = guess ? decodeLegacyOrNull(bytes, guess) : null;
            if (legacyText !== null) legacy = guess;
        }
        if (legacy) return legacyResult(legacy, legacyText);
        return windows1252Result();

        function legacyResult(enc, text) {
            const encoded = new TextEncoder().encode(text);
            const lead = isDelimited ? [] : UTF8_BOM;
            const legacyOut = new Uint8Array(lead.length + encoded.length);
            legacyOut.set(lead, 0);
            legacyOut.set(encoded, lead.length);
            return {
                bytes: legacyOut,
                transcoded: true,
                encoding: enc,
                reason: 'legacy-' + enc,
                message:
                    'This text file is not UTF-8; its bytes are ' + LEGACY_CHARSET_NAMES[enc] +
                    ', so it was read that way. If any characters look wrong, re-saving it as ' +
                    'UTF-8 will convert exactly.'
            };
        }

        function windows1252Result() {
            let out;
            try {
                const text = new TextDecoder('windows-1252').decode(bytes);  // cannot fail
                const encoded = new TextEncoder().encode(text);
                // Delimited text gets no BOM: the bridge already tells the CSV importer
                // the charset, and a BOM would become part of the first cell.
                const lead = isDelimited ? [] : UTF8_BOM;
                out = new Uint8Array(lead.length + encoded.length);
                out.set(lead, 0);
                out.set(encoded, lead.length);
            } catch (err) {
                // No windows-1252 in this TextDecoder build: leave the bytes alone
                // rather than ship something half-decoded, and say why.
                return result('transcode-unavailable', null,
                    'This text file is not valid UTF-8 and this browser could not decode it as ' +
                    'Windows-1252, so accented characters may be wrong in the output. Re-saving ' +
                    'the file as UTF-8 will convert exactly.');
            }
            return {
                bytes: out,
                transcoded: true,
                encoding: 'windows-1252',
                reason: 'legacy-fallback',
                message:
                    'This text file is not valid UTF-8; it was read as Windows-1252 (Western ' +
                    'European) so accented characters are preserved. If any characters still look ' +
                    'wrong the file may use a different legacy encoding (for example Shift-JIS or ' +
                    'KOI8-R) — re-saving it as UTF-8 will convert exactly.'
            };
        }
    }

    // ==================================================================
    // BUG-11 — default paper size for documents that declare none.
    //
    // SCOPE, measured not assumed: a document that DECLARES a page size
    // already converts at that size (a DOCX declaring A4 at 11906x16838 twips
    // comes out 595.3 x 841.9 pt). Nothing below touches that path. This is
    // only about the inputs that carry no page concept at all — txt, csv,
    // html, and the ODS fixtures whose styles.xml has no `page-layout` — where
    // there is nothing in the file to preserve and the converter must pick.
    //
    // What it picked, and why: LibreOffice asks
    // PaperInfo::getSystemDefaultPaper(), and in THIS build every signal that
    // function consults is unavailable —
    //   1. officecfg Setup/L10N/ooSetupSystemLocale — empty (never set)
    //   2. `paperconf` (libpaper) — compiled out, the call site is guarded by
    //      `#if ! defined(MACOSX) && ! defined(EMSCRIPTEN)`
    //   3. LC_PAPER / nl_langinfo_l(_NL_PAPER_WIDTH) — compiled out, needs
    //      glibc + _GNU_SOURCE; musl/Emscripten defines neither LC_PAPER nor
    //      _NL_PAPER_WIDTH
    //   4. officecfg System/L10N/Locale — empty, because the value is bound to
    //      the platform LocaleBackend and there is no desktop to read
    // — so it reaches its last line of defence,
    //     `if (aLocaleStr.isEmpty()) aLocaleStr = EN_US;`
    // and every user on earth gets US Letter. That is an upstream default that
    // assumes en-US when it knows nothing, not a misconfiguration on our side.
    //
    // The decision now lives HERE, in one pure function,
    // `resolveConversionSettings` below, together with the format locale
    // (docs/design/conversion-settings.md): a setting the user chose, else the
    // browser's (or, in the MCP, the OS's) own locale, else en-GB + A4. All of
    // it is client-side: nothing is sent anywhere, and there is no edge or
    // country lookup.
    // ==================================================================

    /**
     * Countries whose default paper is US Letter.
     *
     * MIRRORED, not invented: this is exactly the list in
     * `libreoffice/i18nutil/source/utility/paper.cxx`,
     * `PaperInfo::getDefaultPaperForLocale()`. Keeping our own copy is what
     * lets the choice be made in one place on the client
     * instead of being scattered through the engine — but a private copy of
     * someone else's table drifts silently, so
     * `tests/gates/test_paper_size.js` re-parses that .cxx and fails if the
     * two ever disagree.
     *
     * Every one was confirmed against native LibreOffice 25.2 in the `lo-ref`
     * image. Note the near-misses that are A4: pt-BR, es-ES, es-AR, es-PE,
     * en-GB, and all of CJK.
     */
    const LETTER_COUNTRIES = [
        'US', // United States
        'PR', // Puerto Rico
        'CA', // Canada
        'VE', // Venezuela
        'CL', // Chile
        'MX', // Mexico
        'CO', // Colombia
        'PH', // Philippines
        'BZ', // Belize
        'CR', // Costa Rica
        'GT', // Guatemala
        'NI', // Nicaragua
        'PA', // Panama
        'SV'  // El Salvador
    ];

    /** The only two paper sizes a conversion can use. */
    const PAPER_SIZES = ['a4', 'letter'];

    /**
     * The paper used whenever we cannot work out anything better.
     *
     * A4, NOT Letter — deliberately, and this is the whole point of the fix.
     * `en-US`/Letter is the upstream fallback that causes this bug and it is
     * wrong for the large majority of the world: A4 is standard everywhere
     * except the US, Canada and the short list above, and A4 is what the
     * dockerized LibreOffice reference emits with no configuration at all
     * (measured). When we do not know where the user is, "United States" is
     * the one guess that is wrong most often.
     */
    const FALLBACK_PAPER = 'a4';

    /**
     * Extract the ISO 3166 alpha-2 region from one BCP-47-ish tag, or null.
     *
     * Handles what browsers actually emit: `en-US`, `en_US`, `zh-Hans-CN`
     * (script subtag skipped), `de-DE-u-ca-buddhist` (extension stopped at).
     * Returns null for a bare language (`de`) and for UN M.49 numeric regions
     * (`es-419`) — LibreOffice compares against alpha-2 country codes, so a
     * numeric region can never match and is not evidence of a country.
     *
     * @param {string} tag
     * @returns {string|null} uppercase 2-letter region
     */
    function regionOfLocale(tag) {
        if (typeof tag !== 'string') return null;
        const parts = tag.trim().replace(/_/g, '-').split('-').filter(Boolean);
        if (parts.length < 2) return null;
        if (!/^[A-Za-z]{2,3}$/.test(parts[0])) return null;
        for (let i = 1; i < parts.length; i++) {
            const p = parts[i];
            if (p.length === 1) return null;             // extension singleton
            if (/^[A-Za-z]{2}$/.test(p)) return p.toUpperCase();
            if (/^[0-9]{3}$/.test(p)) return null;       // M.49 macroregion
        }
        return null;
    }

    /**
     * The worker interface's contract version (the MCP runs this release's
     * worker; root CLAUDE.md, "The worker interface is the MCP's contract").
     * Bumped ONLY for a breaking change to that contract; additive changes keep
     * it. 2 = INIT requires `formatLocale` and `paperSize` (conversion settings,
     * docs/design/conversion-settings.md). 3 = CONVERT requires `conversionTime`
     * and CONVERT_DONE reports `conversionTime`, `conversionTimeFallback` and
     * `conversionTimeOffsetChanged` (docs/design/conversion-time.md §6, N4);
     * INIT is unchanged. The MCP accepts exactly this value.
     */
    const CONTRACT_VERSION = 3;

    /**
     * FG-054: does the WEBSITE ask its engine to decode embedded EOT fonts (a PPTX's
     * ppt/fonts/*.fntdata)? The presentations module is built with libeot, but decodes only when
     * the host asks: INIT.allowEmbeddedEot === true makes the worker set LO_WASM_ALLOW_EOT=1 in the
     * engine's environment (engine patch embedded-fonts-eot-runtime-switch). The browser driver
     * sends it, and tells FontResolver the same (options.acceptEot) so a PPTX's embedded faces stop
     * downloading substitutes the engine will not need. A host that sends nothing (the MCP) gets an
     * engine that refuses EOT and a resolver that keeps every substitute. One constant drives all
     * of it; gate embedded_font_import fails if it and the real engine disagree. Additive:
     * CONTRACT_VERSION is unchanged.
     */
    const WEBSITE_ACCEPTS_EMBEDDED_EOT = true;

    /**
     * FG-021: does the WEBSITE let its engine ask for, and be given, a document password?
     * INIT.allowDocumentPasswords === true makes the worker set LO_WASM_ALLOW_DOCUMENT_PASSWORDS=1 in the
     * engine's environment, and the bridge then enables LibreOfficeKit's password callback. A host that
     * sends nothing (the MCP) gets an engine that refuses encrypted inputs, as before, and refuses a
     * password it is handed as unsupported. Additive: CONTRACT_VERSION is unchanged.
     * FALSE UNTIL the worker passes the user's password through (options.inputPassword, the web
     * agent's step 3): with no password ever supplied there is nothing for the engine to use.
     */
    const WEBSITE_ALLOWS_DOCUMENT_PASSWORDS = false;

    /**
     * FG-054: did the engine accept every embedded face we skipped a substitute
     * for? Compares the resolver's prediction with the worker's listing of the
     * engine's embedded-font directory before and after the conversion.
     *
     * Named faces (DOCX, PPTX) must be present afterwards; a file that was
     * already there counts, because LibreOffice reuses an existing file
     * ("assume it's already been added"). Faces the engine names with a
     * process-wide counter -- <family><N>.ttf for ODF, font<N>.ttf for a name that
     * is not a valid file name -- are checked by count: at least `count` NEW files
     * matching <stem><digits>.ttf.
     *
     * @param {{files:string[], numbered:{stem:string,count:number}[]}|null} expected
     * @param {string[]|null} before
     * @param {string[]|null} after
     * @returns {{missing:string[], missingCounted:number}|{unverifiable:true}|null}
     *   missingCounted: how many counter-named faces did not appear.
     *   null = nothing missing, or nothing to check. {unverifiable:true} = faces
     *   were expected but the after-listing is absent or unreadable (the engine
     *   keeps its embedded fonts elsewhere): the caller must say so loudly and
     *   must NOT retry, since a retry cannot be verified either.
     */
    function embeddedFontMismatch(expected, before, after) {
        if (!expected) return null;
        const files = Array.isArray(expected.files) ? expected.files : [];
        const numbered = (Array.isArray(expected.numbered) ? expected.numbered : [])
            .filter(e => e && typeof e.stem === 'string' && Number(e.count) > 0);
        if (!files.length && !numbered.length) return null;
        if (!Array.isArray(after)) return { unverifiable: true };   // never retry on that
        const now = new Set(after);
        const was = new Set(Array.isArray(before) ? before : []);
        const missing = files.filter(f => !now.has(f));
        const fresh = after.filter(f => !was.has(f));
        let missingCounted = 0;
        for (const { stem, count } of numbered) {
            const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp('^' + esc + '\\d+\\.ttf$');
            missingCounted += Math.max(0, Number(count) - fresh.filter(f => re.test(f)).length);
        }
        return (missing.length || missingCounted) ? { missing, missingCounted } : null;
    }

    /**
     * FM-3: the (requested family -> family we ship) substitution pairs for one
     * document, from FontResolver's matches. The worker turns each pair into a
     * fontconfig rule (buildSubstitutionRules), in order.
     *
     * A match whose family equals the requested name needs no rule: the engine
     * finds it by name. Every other match does. Without one the requested family
     * is unknown to the engine and resolves through glyph fallback, which is
     * per-DOCUMENT rather than per-family and so collapses every unmatched run
     * onto a single arbitrary face.
     *
     * Shared with the MCP host (FG-055): the website driver and the MCP both call
     * this, so a change here reaches both. The MCP kept its own copy while it was
     * private to conversion_driver.js, and that copy missed the CJK pin below.
     * Feature-detect it with `typeof ConversionProtocol.buildFontSubstitutions`.
     * Additive: CONTRACT_VERSION is unchanged.
     *
     * @param {Array<{family:string, cjkFamily?:string, requestedFont?:string,
     *                requestedFonts?:string[]}>|null} matches
     * @returns {Array<{requested:string, family:string}>|null}
     */
    function buildFontSubstitutions(matches) {
        if (!Array.isArray(matches)) return null;
        const pairs = [];
        const seen = new Set();
        const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '');
        for (const match of matches) {
            if (!match || !match.family) continue;
            for (const requested of (match.requestedFonts || [match.requestedFont])) {
                if (!requested || norm(requested) === norm(match.family)) continue;
                const key = norm(requested);
                if (seen.has(key)) continue;
                seen.add(key);
                pairs.push({ requested, family: match.family });
                // FG-055: a CJK fallback face behind the Latin family
                // (FontMatcher withCjkFallback). Each rule inserts its family
                // immediately BEFORE the requested name (fontconfig `prepend`,
                // not `prepend_first`), so this second rule gives
                // [Liberation Sans, Droid Sans Fallback, <requested>]: the Latin
                // face is the run's face and sets the line's metrics, as before
                // these names were mapped; characters it lacks fall to the CJK
                // face, which is in the list ahead of any other mounted CJK
                // face. Emitted the other way round, Droid led and a Latin-only
                // 等线 line sat 8.7 pt lower (measured).
                if (match.cjkFamily && norm(match.cjkFamily) !== norm(match.family)) {
                    pairs.push({ requested, family: match.cjkFamily });
                }
            }
        }
        return pairs.length ? pairs : null;
    }


    /**
     * Every locale the engine has format data for, keyed by its tag in the
     * ENGINE's spelling (`_` -> `-`, never Intl-canonicalised: `sr-CS` and
     * `kmr-Latn-TR` stay as they are), with the script LibreOffice uses for it.
     * The script is what derivation matches on, and it is not always Intl's:
     * `sr-ME` takes its calendar from `sr-RS` and is Cyrillic, while
     * `Intl.Locale('sr-ME').maximize()` says Latin.
     */
    // BEGIN GENERATED FORMAT_LOCALES — engine/tools/gen_format_locales.js, LibreOffice 30742500f2d3. Do not edit by hand.
    const FORMAT_LOCALE_SCRIPTS = Object.freeze({
        'af-NA': 'Latn',
        'af-ZA': 'Latn',
        'ak-GH': 'Latn',
        'am-ET': 'Ethi',
        'an-ES': 'Latn',
        'ar-AE': 'Arab',
        'ar-BH': 'Arab',
        'ar-DZ': 'Arab',
        'ar-EG': 'Arab',
        'ar-IQ': 'Arab',
        'ar-JO': 'Arab',
        'ar-KW': 'Arab',
        'ar-LB': 'Arab',
        'ar-LY': 'Arab',
        'ar-MA': 'Arab',
        'ar-OM': 'Arab',
        'ar-QA': 'Arab',
        'ar-SA': 'Arab',
        'ar-SY': 'Arab',
        'ar-TN': 'Arab',
        'ar-YE': 'Arab',
        'ast-ES': 'Latn',
        'axk-CG': 'Latn',
        'az-AZ': 'Latn',
        'be-BY': 'Cyrl',
        'beq-CG': 'Latn',
        'bg-BG': 'Cyrl',
        'bkw-CG': 'Latn',
        'bm-ML': 'Latn',
        'bn-BD': 'Beng',
        'bn-IN': 'Beng',
        'bo-CN': 'Tibt',
        'bo-IN': 'Tibt',
        'br-FR': 'Latn',
        'bs-BA': 'Latn',
        'bvx-CG': 'Latn',
        'ca-ES': 'Latn',
        'ca-ES-valencia': 'Latn',
        'cs-CZ': 'Latn',
        'cu-RU': 'Cyrl',
        'cv-RU': 'Cyrl',
        'cy-GB': 'Latn',
        'da-DK': 'Latn',
        'dde-CG': 'Latn',
        'de-AT': 'Latn',
        'de-CH': 'Latn',
        'de-DE': 'Latn',
        'de-LI': 'Latn',
        'de-LU': 'Latn',
        'dsb-DE': 'Latn',
        'dv-MV': 'Thaa',
        'dz-BT': 'Tibt',
        'ebo-CG': 'Latn',
        'ee-GH': 'Latn',
        'el-GR': 'Grek',
        'en-AU': 'Latn',
        'en-BW': 'Latn',
        'en-BZ': 'Latn',
        'en-CA': 'Latn',
        'en-DK': 'Latn',
        'en-GB': 'Latn',
        'en-GH': 'Latn',
        'en-GM': 'Latn',
        'en-GY': 'Latn',
        'en-HK': 'Latn',
        'en-IE': 'Latn',
        'en-IL': 'Latn',
        'en-IN': 'Latn',
        'en-JM': 'Latn',
        'en-KE': 'Latn',
        'en-LK': 'Latn',
        'en-MU': 'Latn',
        'en-MW': 'Latn',
        'en-MY': 'Latn',
        'en-NA': 'Latn',
        'en-NG': 'Latn',
        'en-NZ': 'Latn',
        'en-PH': 'Latn',
        'en-TT': 'Latn',
        'en-US': 'Latn',
        'en-ZA': 'Latn',
        'en-ZM': 'Latn',
        'en-ZW': 'Latn',
        'eo': 'Latn',
        'es-AR': 'Latn',
        'es-BO': 'Latn',
        'es-CL': 'Latn',
        'es-CO': 'Latn',
        'es-CR': 'Latn',
        'es-DO': 'Latn',
        'es-EC': 'Latn',
        'es-ES': 'Latn',
        'es-GT': 'Latn',
        'es-HN': 'Latn',
        'es-MX': 'Latn',
        'es-NI': 'Latn',
        'es-PA': 'Latn',
        'es-PE': 'Latn',
        'es-PR': 'Latn',
        'es-PY': 'Latn',
        'es-SV': 'Latn',
        'es-UY': 'Latn',
        'es-VE': 'Latn',
        'et-EE': 'Latn',
        'eu-ES': 'Latn',
        'ext-ES': 'Latn',
        'fa-IR': 'Arab',
        'fi-FI': 'Latn',
        'fo-FO': 'Latn',
        'fr-BE': 'Latn',
        'fr-BF': 'Latn',
        'fr-BJ': 'Latn',
        'fr-CA': 'Latn',
        'fr-CH': 'Latn',
        'fr-CI': 'Latn',
        'fr-FR': 'Latn',
        'fr-GN': 'Latn',
        'fr-LU': 'Latn',
        'fr-MC': 'Latn',
        'fr-ML': 'Latn',
        'fr-NE': 'Latn',
        'fr-SN': 'Latn',
        'fr-TG': 'Latn',
        'fur-IT': 'Latn',
        'fy-NL': 'Latn',
        'ga-IE': 'Latn',
        'gd-GB': 'Latn',
        'gl-ES': 'Latn',
        'gos-NL': 'Latn',
        'gsc-FR': 'Latn',
        'gu-IN': 'Gujr',
        'gug-PY': 'Latn',
        'ha-Latn-GH': 'Latn',
        'ha-Latn-NG': 'Latn',
        'haw-US': 'Latn',
        'he-IL': 'Hebr',
        'hi-IN': 'Deva',
        'hil-PH': 'Latn',
        'hr-HR': 'Latn',
        'hsb-DE': 'Latn',
        'ht-HT': 'Latn',
        'hu-HU': 'Latn',
        'hy-AM': 'Armn',
        'ia': 'Latn',
        'id-ID': 'Latn',
        'ilo-PH': 'Latn',
        'is-IS': 'Latn',
        'it-CH': 'Latn',
        'it-IT': 'Latn',
        'iyx-CG': 'Latn',
        'ja-JP': 'Jpan',
        'jbo': 'Latn',
        'ka-GE': 'Geor',
        'kab-DZ': 'Latn',
        'kk-KZ': 'Cyrl',
        'kkw-CG': 'Latn',
        'kl-GL': 'Latn',
        'km-KH': 'Khmr',
        'kmr-Latn-TR': 'Latn',
        'kn-IN': 'Knda',
        'kng-CG': 'Latn',
        'ko-KR': 'Kore',
        'ky-KG': 'Cyrl',
        'la-VA': 'Latn',
        'lb-LU': 'Latn',
        'ldi-CG': 'Latn',
        'lg-UG': 'Latn',
        'lgr-SB': 'Latn',
        'lif-NP': 'Deva',
        'lij-IT': 'Latn',
        'lld-IT': 'Latn',
        'ln-CD': 'Latn',
        'lo-LA': 'Laoo',
        'lt-LT': 'Latn',
        'ltg-LV': 'Latn',
        'lv-LV': 'Latn',
        'mai-IN': 'Deva',
        'mdw-CG': 'Latn',
        'mfe-MU': 'Latn',
        'min-ID': 'Latn',
        'mk-MK': 'Cyrl',
        'mkw-CG': 'Latn',
        'ml-IN': 'Mlym',
        'mn-Cyrl-MN': 'Cyrl',
        'mn-Mong-MN': 'Mong',
        'mos-BF': 'Latn',
        'mr-IN': 'Deva',
        'ms-MY': 'Latn',
        'mt-MT': 'Latn',
        'my-MM': 'Mymr',
        'myv-RU': 'Cyrl',
        'nb-NO': 'Latn',
        'nds-DE': 'Latn',
        'ne-NP': 'Deva',
        'ngz-CG': 'Latn',
        'njx-CG': 'Latn',
        'njy-CG': 'Latn',
        'nl-BE': 'Latn',
        'nl-NL': 'Latn',
        'nn-NO': 'Latn',
        'no-NO': 'Latn',
        'nr-ZA': 'Latn',
        'nso-ZA': 'Latn',
        'ny-MW': 'Latn',
        'oc-ES-aranes': 'Latn',
        'oc-FR-lengadoc': 'Latn',
        'om-ET': 'Latn',
        'or-IN': 'Orya',
        'pa-IN': 'Guru',
        'pap-BQ': 'Latn',
        'pap-CW': 'Latn',
        'pdc-US': 'Latn',
        'pjt-AU': 'Latn',
        'pl-PL': 'Latn',
        'plt-MG': 'Latn',
        'pt-AO': 'Latn',
        'pt-BR': 'Latn',
        'pt-MZ': 'Latn',
        'pt-PT': 'Latn',
        'pui-CO': 'Latn',
        'puu-CG': 'Latn',
        'ro-MD': 'Latn',
        'ro-RO': 'Latn',
        'ru-RU': 'Cyrl',
        'rue-SK': 'Cyrl',
        'rw-RW': 'Latn',
        'sat-IN': 'Olck',
        'sat-Olck-IN': 'Olck',
        'sc-IT': 'Latn',
        'sdj-CG': 'Latn',
        'sg-CF': 'Latn',
        'shs-CA': 'Latn',
        'sid-ET': 'Latn',
        'sk-SK': 'Latn',
        'sl-SI': 'Latn',
        'so-SO': 'Latn',
        'sq-AL': 'Latn',
        'sr-CS': 'Cyrl',
        'sr-Latn-CS': 'Latn',
        'sr-Latn-ME': 'Latn',
        'sr-Latn-RS': 'Latn',
        'sr-ME': 'Cyrl',
        'sr-RS': 'Cyrl',
        'ss-ZA': 'Latn',
        'st-ZA': 'Latn',
        'sun-ID': 'Latn',
        'sv-FI': 'Latn',
        'sv-SE': 'Latn',
        'sw-TZ': 'Latn',
        'szl-PL': 'Latn',
        'ta-IN': 'Taml',
        'te-IN': 'Telu',
        'tek-CG': 'Latn',
        'tg-TJ': 'Cyrl',
        'th-TH': 'Thai',
        'ti-ER': 'Ethi',
        'tk-TM': 'Latn',
        'tn-ZA': 'Latn',
        'tpi-PG': 'Latn',
        'tr-TR': 'Latn',
        'ts-ZA': 'Latn',
        'tsa-CG': 'Latn',
        'tt-RU': 'Cyrl',
        'tyx-CG': 'Latn',
        'ug-CN': 'Arab',
        'uk-UA': 'Cyrl',
        'ur-PK': 'Arab',
        'uz-UZ': 'Latn',
        've-ZA': 'Latn',
        'vec-IT': 'Latn',
        'vi-VN': 'Latn',
        'vif-CG': 'Latn',
        'vro-EE': 'Latn',
        'wa-BE': 'Latn',
        'xh-ZA': 'Latn',
        'xku-CG': 'Latn',
        'yi-US': 'Hebr',
        'yom-CG': 'Latn',
        'zh-CN': 'Hans',
        'zh-HK': 'Hant',
        'zh-MO': 'Hant',
        'zh-SG': 'Hans',
        'zh-TW': 'Hant',
        'zu-ZA': 'Latn',
    });
    // END GENERATED FORMAT_LOCALES

    /** The locales a user or the MCP may set, in the engine's spelling. */
    const FORMAT_LOCALES = Object.freeze(Object.keys(FORMAT_LOCALE_SCRIPTS));

    /** Format locale used when nothing says anything (with A4: a coherent pair). */
    const FALLBACK_FORMAT_LOCALE = 'en-GB';

    /** Language, script, region and variants of an engine tag. */
    function splitEngineTag(tag) {
        const parts = tag.split('-');
        const out = { language: parts[0], script: null, region: null, variants: [] };
        for (let i = 1; i < parts.length; i++) {
            const p = parts[i];
            if (i === 1 && /^[A-Z][a-z]{3}$/.test(p)) out.script = p;
            else if (!out.region && out.variants.length === 0 && /^([A-Z]{2}|[0-9]{3})$/.test(p)) out.region = p;
            else out.variants.push(p);
        }
        return out;
    }

    // language-script-region -> engine tag, for the entries a locale can be
    // DERIVED to: a language and a country, no variant. Bare-language (`eo`) and
    // variant (`ca-ES-valencia`) entries are reachable by an explicit setting only.
    const DERIVABLE_FORMAT_LOCALES = (() => {
        const map = new Map();
        for (const tag of FORMAT_LOCALES) {
            const p = splitEngineTag(tag);
            if (!p.region || p.variants.length) continue;
            const key = p.language + '-' + FORMAT_LOCALE_SCRIPTS[tag] + '-' + p.region;
            if (!map.has(key)) map.set(key, tag);
        }
        return map;
    })();

    /**
     * The engine's `LANG` value for a format locale, or null if it is not one.
     * A language-region tag uses the POSIX form (`de-DE` -> `de_DE.UTF-8`).
     * A tag with a script or variant is passed as the BCP 47 tag itself
     * (`sr-Latn-RS.UTF-8`): LibreOffice's LocaleBackend turns a LANG it cannot
     * read as POSIX into a LanguageTag, and that is the only spelling that
     * reaches these locales. Measured 2026-10-10 (month names of an XLSX date):
     * `sr_RS.UTF-8@latin` still gives Cyrillic `децембар` and `mn_MN.UTF-8`
     * Cyrillic Mongolian, while `sr-Latn-RS.UTF-8` gives `decembar` and
     * `mn-Mong-MN.UTF-8` Mongolian script. Gate `format_locale_engine`.
     * @param {string} tag a FORMAT_LOCALES entry
     * @returns {string|null}
     */
    function toPosixLocale(tag) {
        if (typeof tag !== 'string' || !Object.prototype.hasOwnProperty.call(FORMAT_LOCALE_SCRIPTS, tag)) return null;
        const p = splitEngineTag(tag);
        if (!p.script && !p.variants.length) {
            return (p.region ? p.language + '_' + p.region : p.language) + '.UTF-8';
        }
        return tag + '.UTF-8';
    }

    /**
     * One locale string as a browser or an OS reports it -> Intl.Locale, or null
     * when it carries no information. Accepts POSIX spellings (`en_US.UTF-8`,
     * `sr_RS@latin`); a macro-region (`es-419`) is dropped so the language's own
     * default country applies; `C`, `POSIX` (with any codeset) and `und` are not
     * information. Of the glibc modifiers only `@latin` and `@cyrillic` carry
     * information (the script); others (`@euro`, `@valencia`) are ignored —
     * variant entries are reachable by an explicit setting only. Never throws.
     */
    function parseLocaleInput(raw) {
        if (typeof raw !== 'string') return null;
        let s = raw.trim();
        let modifier = '';
        const at = s.indexOf('@');
        if (at >= 0) { modifier = s.slice(at + 1).toLowerCase(); s = s.slice(0, at); }
        const dot = s.indexOf('.');
        if (dot >= 0) s = s.slice(0, dot);
        if (!s || /^(c|posix)$/i.test(s)) return null;
        s = s.replace(/_/g, '-');
        let loc;
        try {
            loc = new Intl.Locale(s);
            if (modifier === 'latin') loc = new Intl.Locale(loc.language, { script: 'Latn', region: loc.region });
            else if (modifier === 'cyrillic') loc = new Intl.Locale(loc.language, { script: 'Cyrl', region: loc.region });
            // A macro-region (UN M.49 area: 419 Latin America, 150 Europe, 001
            // World …) names no country. Owner decision 2026-10-10 (design §11,
            // "macro-region tags"): drop it and let maximize() choose the
            // language's own default — es-419 -> es-ES, pt-419 -> pt-BR,
            // en-001 and en-150 -> en-US — rather than counting the entry as
            // unsupported and falling back to en-GB.
            if (loc.region && /^[0-9]{3}$/.test(loc.region)) {
                loc = new Intl.Locale(loc.language, loc.script ? { script: loc.script } : {});
            }
        } catch (_) {
            return null;
        }
        if (!loc.language || loc.language === 'und') return null;
        return loc;
    }

    /**
     * What one informative locale says: the format locale it derives to (null
     * if the engine has none — unsupported) and the paper of its country (null
     * without a country, and null when unsupported: A-1, an entry the engine
     * cannot use is information for neither setting).
     */
    function deriveFromLocale(loc) {
        let max;
        try { max = loc.maximize(); } catch (_) { return { formatLocale: null, paperSize: null }; }
        const key = max.language + '-' + max.script + '-' + max.region;
        const formatLocale = DERIVABLE_FORMAT_LOCALES.get(key) || null;
        if (!formatLocale) return { formatLocale: null, paperSize: null };
        return { formatLocale, paperSize: paperForRegion(max.region) };
    }

    function paperForRegion(region) {
        if (typeof region !== 'string' || !/^[A-Z]{2}$/.test(region)) return null;
        return LETTER_COUNTRIES.indexOf(region) >= 0 ? 'letter' : 'a4';
    }

    /** The first entry of a chain that carries information, or null. */
    function firstInformative(list) {
        const arr = Array.isArray(list) ? list : (typeof list === 'string' ? [list] : []);
        for (const raw of arr) {
            const loc = parseLocaleInput(raw);
            if (loc) return loc;
        }
        return null;
    }

    function warnIgnored(field, value) {
        if (typeof console !== 'undefined' && console.warn) {
            console.warn(`[ConversionSettings] ignoring invalid ${field} ${JSON.stringify(value)}; resolving from the locale instead`);
        }
    }

    /**
     * THE decision: the format locale and paper size a conversion uses.
     * docs/design/conversion-settings.md; plans/conversion-settings-implementation.md §3.
     *
     *   format locale: input.formatLocale > derived from `languages` > en-GB
     *   paper size:    input.paperSize > derived from `paperLanguages ?? languages`
     *                  > derived from the RESOLVED format locale > A4
     *
     * A chain is read at its first informative entry only (`C`, `POSIX`, `und`
     * and junk are skipped). An entry the engine has no locale for counts as no
     * information for both settings (A-1), so `en-GB` + A4 is used together
     * exactly when nothing says anything. An invalid explicit value is logged
     * and ignored, never thrown. `source` is for logs and tests only: it is
     * never shown to users nor put in MCP results.
     *
     * @param {{formatLocale?: string, paperSize?: string, languages?: string[],
     *          paperLanguages?: string[]}} input
     * @returns {{formatLocale: string, paperSize: 'a4'|'letter',
     *            source: {formatLocale: string, paperSize: string}}}
     */
    function resolveConversionSettings(input) {
        const inp = (input && typeof input === 'object') ? input : {};
        const source = {};

        let formatLocale = null;
        if (inp.formatLocale !== undefined && inp.formatLocale !== null) {
            if (typeof inp.formatLocale === 'string' &&
                    Object.prototype.hasOwnProperty.call(FORMAT_LOCALE_SCRIPTS, inp.formatLocale)) {
                formatLocale = inp.formatLocale;
                source.formatLocale = 'setting';
            } else {
                warnIgnored('formatLocale', inp.formatLocale);
            }
        }
        const langLoc = firstInformative(inp.languages);
        const fromLanguages = langLoc ? deriveFromLocale(langLoc) : null;
        if (!formatLocale && fromLanguages && fromLanguages.formatLocale) {
            formatLocale = fromLanguages.formatLocale;
            source.formatLocale = 'locale';
        }
        if (!formatLocale) {
            formatLocale = FALLBACK_FORMAT_LOCALE;
            source.formatLocale = 'fallback';
        }

        let paperSize = null;
        if (inp.paperSize !== undefined && inp.paperSize !== null) {
            if (inp.paperSize === 'a4' || inp.paperSize === 'letter') {
                paperSize = inp.paperSize;
                source.paperSize = 'setting';
            } else {
                warnIgnored('paperSize', inp.paperSize);
            }
        }
        if (!paperSize) {
            const own = inp.paperLanguages !== undefined && inp.paperLanguages !== null
                ? firstInformative(inp.paperLanguages) : langLoc;
            const fromOwn = own ? deriveFromLocale(own).paperSize : null;
            if (fromOwn) {
                paperSize = fromOwn;
                source.paperSize = 'locale';
            }
        }
        if (!paperSize) {
            const fromFormat = paperForRegion(splitEngineTag(formatLocale).region);
            if (fromFormat && source.formatLocale !== 'fallback') {
                paperSize = fromFormat;
                source.paperSize = 'locale';
            }
        }
        if (!paperSize) {
            paperSize = FALLBACK_PAPER;
            source.paperSize = 'fallback';
        }
        return { formatLocale, paperSize, source };
    }

    /**
     * localStorage key of the website's override (plan §4):
     * {"v":1,"formatLocale"?,"paperSize"?,"conversionTime"?}. The same key in
     * sessionStorage holds {"v":1,"conversionTime":"<explicit date-time>"}: an
     * explicit "now" lives only in the open tab (conversion-time design N6).
     */
    const SETTINGS_STORAGE_KEY = 'conversion-settings';

    // ---- FEAT-11: the time limit (owner-approved brief, 2026-10-31) ----------------------
    //
    // One flat limit per conversion, whatever the file's size or type: a conversion that takes
    // longer stops. Default 10 minutes, 0.1 to 120, decimals allowed (0.1 = 6 s). The MCP has
    // the same option (time_limit_minutes / timeLimitMinutes) with the SAME values and wording
    // (process rule 6): change both together. The website stores it with the other settings,
    // {"v":1, ..., "timeLimitMinutes": N}, behind the release-only flag timeLimitSetting.
    const TIME_LIMIT_DEFAULT_MINUTES = 10;
    const TIME_LIMIT_MIN_MINUTES = 0.1;
    const TIME_LIMIT_MAX_MINUTES = 120;
    const TIME_LIMIT_TEXT = Object.freeze({
        invalid: 'Enter a time limit between 0.1 and 120 minutes.',
    });
    /** The number of minutes as people write it: 10, 0.5, 2.5 (no trailing zeros). */
    function formatMinutes(minutes) {
        return String(Math.round(Number(minutes) * 1000) / 1000);
    }
    /** "1 minute" for exactly 1, otherwise "N minutes" (0.1 minutes, 1.5 minutes, 10 minutes). */
    function minutesText(minutes) {
        const n = formatMinutes(minutes);
        return n === '1' ? '1 minute' : `${n} minutes`;
    }
    /** "Stopped after the time limit (N minutes). You can change the time limit in Settings." */
    function timeLimitReachedMessage(minutes) {
        return `Stopped after the time limit (${minutesText(minutes)}). You can change the time limit in Settings.`;
    }
    /**
     * A typed or stored time limit, checked: a finite number of minutes from 0.1 to 120
     * inclusive (a numeric string is accepted, as an <input type=number> gives one).
     * @returns {{ok: true, minutes: number} | {ok: false, message: string}}
     */
    function parseTimeLimitMinutes(value) {
        const n = typeof value === 'number' ? value
            : (typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN);
        if (!Number.isFinite(n) || n < TIME_LIMIT_MIN_MINUTES || n > TIME_LIMIT_MAX_MINUTES) {
            return { ok: false, message: TIME_LIMIT_TEXT.invalid };
        }
        return { ok: true, minutes: n };
    }
    /** The error a conversion settles with when the time limit is reached. Never retried. */
    function timeLimitReachedError(minutes) {
        const err = new Error(timeLimitReachedMessage(minutes));
        err.code = 'TIME_LIMIT_REACHED';
        err.timeLimitMinutes = Number(minutes);
        return err;
    }

    /**
     * The website's stored override, as resolver input fields. Each field is
     * optional (overriding one keeps the other automatic). Anything unreadable —
     * no storage (private window), bad JSON, another version — is no override,
     * never an error: the resolver then validates the values themselves.
     * `conversionTime` is passed through as stored (validated, and the N6
     * storage rule applied, by resolveConversionTimeSetting) — also so that a
     * settings panel merging into the stored object keeps it.
     * @param {string|null|undefined} raw the stored string
     * @returns {{formatLocale?: string, paperSize?: string, conversionTime?: string}}
     */
    function parseStoredSettings(raw) {
        if (typeof raw !== 'string' || !raw) return {};
        let obj;
        try { obj = JSON.parse(raw); } catch (_) { return {}; }
        if (!obj || typeof obj !== 'object' || obj.v !== 1) return {};
        const out = {};
        if (obj.formatLocale !== undefined) out.formatLocale = obj.formatLocale;
        if (obj.paperSize !== undefined) out.paperSize = obj.paperSize;
        if (obj.conversionTime !== undefined) out.conversionTime = obj.conversionTime;
        // FEAT-11: a stored time limit that is not valid is ignored (the default applies).
        if (obj.timeLimitMinutes !== undefined && parseTimeLimitMinutes(obj.timeLimitMinutes).ok) {
            out.timeLimitMinutes = Number(obj.timeLimitMinutes);
        }
        return out;
    }

    /**
     * The settings for a conversion in THIS browser: the stored override, then
     * navigator.languages (website precedence, plan §0). Main thread only — a
     * Worker has no localStorage. Never throws.
     *
     * Also `conversionTime` (docs/design/conversion-time.md §8, N6): an
     * explicit date-time from this tab's sessionStorage, else `document` or
     * `system` from localStorage, else 'document'. It is sent per CONVERT, not
     * in INIT, so it is not part of the driver's settingsKey (§6, N4).
     */
    // FEAT-12 (queue model, owner-approved 2026-10-31): settings are SNAPSHOT when a file is
    // queued. While a queued conversion runs, the page pins its snapshot here, so every reader
    // (the driver, the CSV fast path) converts with the settings the file was queued with, even
    // if the user changes them meanwhile. `{ live: true }` reads the real current settings (the
    // settings panel, and the snapshot for the next file). Page-only: the worker never sees it.
    let pinnedBrowserSettings = null;
    function pinBrowserConversionSettings(snapshot) {
        pinnedBrowserSettings = snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
        return function unpin() { pinnedBrowserSettings = null; };
    }

    function resolveBrowserConversionSettings(opts) {
        if (pinnedBrowserSettings && !(opts && opts.live)) return JSON.parse(JSON.stringify(pinnedBrowserSettings));
        let stored = {};
        try {
            if (typeof localStorage !== 'undefined' && localStorage) {
                stored = parseStoredSettings(localStorage.getItem(SETTINGS_STORAGE_KEY));
            }
        } catch (_) { /* storage blocked: no override */ }
        let session = {};
        try {
            if (typeof sessionStorage !== 'undefined' && sessionStorage) {
                session = parseStoredSettings(sessionStorage.getItem(SETTINGS_STORAGE_KEY));
            }
        } catch (_) { /* storage blocked: no explicit time */ }
        let languages = [];
        try {
            if (typeof navigator !== 'undefined' && navigator) {
                languages = (navigator.languages && navigator.languages.length) ? navigator.languages
                    : (navigator.language ? [navigator.language] : []);
            }
        } catch (_) { /* no navigator */ }
        const resolved = resolveConversionSettings({ ...stored, languages: Array.from(languages || []) });
        resolved.conversionTime = resolveConversionTimeSetting(stored.conversionTime, session.conversionTime);
        // FEAT-11: the stored time limit, else the default. Whether it is USED is the driver's
        // call (release-only flag timeLimitSetting).
        resolved.timeLimitMinutes = stored.timeLimitMinutes !== undefined ? stored.timeLimitMinutes : TIME_LIMIT_DEFAULT_MINUTES;
        return resolved;
    }

    /**
     * What LibreOffice would choose for these browser languages ON ITS OWN,
     * with no help from us.
     *
     * This is not hypothetical, and it is the single most important fact about
     * this whole area — MEASURED on the shipped build with nothing patched and
     * nothing overridden, varying only Chrome's `--lang`:
     *
     *     simple.txt  en-US -> 612 x 792 (Letter)    de-DE -> 595.3 x 841.9 (A4)
     *                 en-CA -> 612 x 792 (Letter)    ja-JP -> 595.3 x 841.9 (A4)
     *
     * The engine ALREADY follows the user's browser locale. The chain is:
     * Emscripten synthesises `LANG` from `navigator.languages[0]` in
     * `getEnvStrings()` (visible in the generated soffice.js:
     * `((navigator.languages && navigator.languages[0]) || "C").replace("-","_") + ".UTF-8"`),
     * LibreOffice's LocaleBackend (shell/source/backends/localebe, confirmed
     * compiled into soffice.wasm) reads it, that populates
     * `officecfg System/L10N/Locale`, and `PaperInfo::getSystemDefaultPaper()`
     * consults exactly that before giving up and defaulting to en-US.
     *
     * So BUG-11's "every conversion is Letter" is an artefact of the harness
     * that observed it: headless Chrome in Docker reports en-US, and en-US
     * genuinely IS Letter. The one thing the engine gets wrong is the case it
     * cannot resolve — a browser reporting no usable region falls through to
     * LibreOffice's hardcoded `EN_US`, i.e. Letter, which is the wrong guess
     * for most of the world. Re-measured 2026-10-05 (FG-164): bare `en`, `de`,
     * `fr`, `ja` all give Letter unaided.
     *
     * @param {string|string[]|null|undefined} languages
     * @returns {'a4'|'letter'} what the engine does unaided
     */
    function enginePaperForLocales(languages) {
        const list = Array.isArray(languages) ? languages : (languages ? [languages] : []);
        for (const tag of list) {
            const region = regionOfLocale(tag);
            if (!region) continue;
            return LETTER_COUNTRIES.indexOf(region) >= 0 ? 'letter' : 'a4';
        }
        // No usable region anywhere: LibreOffice reaches
        // `if (aLocaleStr.isEmpty()) aLocaleStr = EN_US;` and returns Letter.
        return 'letter';
    }

    // ------------------------------------------------------------------
    // Conversion time ("now") — docs/design/conversion-time.md.
    //
    // The engine's real-time clock is `Date.now` (§2, measured): the worker
    // pins it for the duration of one CONVERT (§3), so NOW()/TODAY(), DATE
    // fields and the PDF CreationDate all read the conversion time. Everything
    // below is pure apart from documentTimeOf's use of DecompressionStream, so
    // the website worker, the MCP's Node host and the unit tests run one
    // implementation (§4.1).
    // ------------------------------------------------------------------

    /** The default everywhere (§1: "the default takes the date time from the source input document"). */
    const CONVERSION_TIME_DEFAULT = 'document';

    // N8: the accepted range, as wall-time tuples [y, mo, d, h, mi, s]. Excel's
    // date system starts at 1900; PDF dates have four-digit years. The whole of
    // the last second is inside (milliseconds are not compared): the reply
    // reports seconds anyway.
    const CONVERSION_TIME_MIN = [1900, 1, 1, 0, 0, 0];
    const CONVERSION_TIME_MAX = [9999, 12, 31, 23, 59, 59];

    // §6: the RFC 3339 profile, nothing else. Week dates (2026-W05-6), ordinal
    // dates (2026-031), the basic format (20260131T233000), durations, a space
    // for `T`, lowercase `t`/`z` and more than three fractional digits all fail
    // here, by construction rather than by a list of exclusions. An offset needs
    // a time: `2026-01-31Z` is not in the profile.
    const CONVERSION_TIME_RE =
        /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

    function daysInMonth(y, mo) {
        return new Date(Date.UTC(y, mo, 0)).getUTCDate();
    }

    /** Compare a wall time with a [y, mo, d, h, mi, s] tuple: -1, 0 or 1. */
    function compareWall(w, t) {
        const a = [w.y, w.mo, w.d, w.h, w.mi, w.s];
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== t[i]) return a[i] < t[i] ? -1 : 1;
        }
        return 0;
    }

    /** A calendar-valid wall time (no 2026-02-30, no hour 24, no leap second). */
    function isValidWall(w) {
        return !!w && Number.isInteger(w.y) && w.mo >= 1 && w.mo <= 12 &&
            w.d >= 1 && w.d <= daysInMonth(w.y, w.mo) &&
            w.h >= 0 && w.h <= 23 && w.mi >= 0 && w.mi <= 59 && w.s >= 0 && w.s <= 59 &&
            w.ms >= 0 && w.ms <= 999;
    }

    function wallInRange(w) {
        return compareWall(w, CONVERSION_TIME_MIN) >= 0 && compareWall(w, CONVERSION_TIME_MAX) <= 0;
    }

    /**
     * Validate a `conversionTime` value (the worker contract, §6; the worker
     * refuses with it, the website and the MCP pre-check with it).
     *
     *   'document' | 'auto' (N9 alias)  -> mode 'document'
     *   'system'                        -> mode 'system'
     *   YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM] or YYYY-MM-DD -> mode 'explicit'
     *
     * An explicit value must be a real calendar date and time inside N8's range
     * (1900-01-01T00:00 to 9999-12-31T23:59:59, compared on the wall time as
     * typed). A date alone is 00:00 on that date (§5). Exact strings only: no
     * trimming, no case folding — this is a contract field, not user input.
     *
     * @param {*} value
     * @returns {{ok: true, mode: 'document'|'system'|'explicit',
     *            wall: {y,mo,d,h,mi,s,ms}|null, offsetMinutes: number|null, dateOnly: boolean}
     *          | {ok: false, reason: string}}
     */
    function parseConversionTime(value) {
        if (value === 'document' || value === 'auto') {
            return { ok: true, mode: 'document', wall: null, offsetMinutes: null, dateOnly: false };
        }
        if (value === 'system') {
            return { ok: true, mode: 'system', wall: null, offsetMinutes: null, dateOnly: false };
        }
        if (typeof value !== 'string') {
            return { ok: false, reason: 'missing or not a string (expected "document", "system" or an RFC 3339 date-time)' };
        }
        const m = CONVERSION_TIME_RE.exec(value);
        if (!m) {
            return { ok: false, reason: 'not "document", "system", YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM]' };
        }
        const wall = {
            y: +m[1], mo: +m[2], d: +m[3],
            h: m[4] !== undefined ? +m[4] : 0,
            mi: m[5] !== undefined ? +m[5] : 0,
            s: m[6] !== undefined ? +m[6] : 0,
            ms: m[7] !== undefined ? +(m[7] + '00').slice(0, 3) : 0,
        };
        if (!isValidWall(wall)) return { ok: false, reason: 'not a real date and time' };
        let offsetMinutes = null;
        if (m[8] === 'Z') {
            offsetMinutes = 0;
        } else if (m[8] !== undefined) {
            const oh = +m[8].slice(1, 3), om = +m[8].slice(4, 6);
            if (oh > 23 || om > 59) return { ok: false, reason: 'not a valid UTC offset' };
            offsetMinutes = (m[8][0] === '-' ? -1 : 1) * (oh * 60 + om);
        }
        if (!wallInRange(wall)) return { ok: false, reason: 'outside 1900-01-01T00:00 to 9999-12-31T23:59:59' };
        return { ok: true, mode: 'explicit', wall, offsetMinutes, dateOnly: m[4] === undefined };
    }

    /**
     * The instant whose wall time in THIS realm's time zone is `wall` (§5,
     * N3/T5: "what you type is what the document shows"). One implementation
     * for the worker and the CSV fast path. The local-time Date constructor is
     * exactly what the engine's `localtime` inverts (§2, measured).
     *
     * A wall time that does not exist (a daylight-saving gap) moves forward by
     * the gap, and an ambiguous one takes the earlier instant — the Date
     * constructor's rule; the reported conversionTime shows what was used.
     */
    function localInstantOfWall(wall) {
        return new Date(wall.y, wall.mo - 1, wall.d, wall.h || 0, wall.mi || 0, wall.s || 0, wall.ms || 0).getTime();
    }

    /** This realm's UTC offset at `instant`, in whole minutes (east positive). */
    function localOffsetMinutesAt(instant) {
        // Historic local mean time can be a fraction of a minute; RFC 3339 cannot say that.
        return Math.round(-new Date(instant).getTimezoneOffset()) || 0;
    }

    /**
     * `instant` as RFC 3339 in this realm's zone, seconds precision, with the
     * offset actually used: CONVERT_DONE.conversionTime (§6), e.g.
     * 2026-01-31T23:30:00-08:00. A zero offset is written +00:00.
     */
    function formatConversionTime(instant) {
        const t = new Date(instant);
        const pad = (n, w) => String(n).padStart(w || 2, '0');
        const off = localOffsetMinutesAt(instant);
        const abs = Math.abs(off);
        return `${pad(t.getFullYear(), 4)}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` +
            `T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}` +
            `${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    }

    /**
     * THE decision: which instant a conversion's "now" is, and what the reply
     * says about it (§3-§5). Shared by the worker and the CSV fast path so the
     * two cannot disagree.
     *
     *   system   -> no pin; the real clock (never a fallback, §8)
     *   explicit -> the typed wall time in this zone; offsetChanged when the
     *               value carried an offset this zone does not have then (N3).
     *               An offset this zone DOES have at that wall time is honoured
     *               exactly, which also picks the right one of the two instants
     *               a daylight-saving overlap gives one wall time (Berlin
     *               2026-10-25T02:30+01:00 is the second 02:30, not the first)
     *   document -> the document's date: a value with an offset is that
     *               instant (shown in this zone, §5); a zone-less value is a
     *               wall time. No date -> the real clock, fallback (§4.2)
     *
     * @param {object} parsed   an ok parseConversionTime() result
     * @param {object|null} docTime  documentTimeOf() result (document mode only)
     * @param {number} nowMs    the real clock
     * @returns {{pin: boolean, instant: number, conversionTime: string,
     *            fallback: boolean, offsetChanged: boolean}}
     */
    function conversionClockOf(parsed, docTime, nowMs) {
        const clock = (pin, instant, fallback, offsetChanged) =>
            ({ pin, instant, conversionTime: formatConversionTime(instant), fallback, offsetChanged });
        if (!parsed || !parsed.ok) throw new Error('conversionClockOf: needs a valid parseConversionTime() result');
        if (parsed.mode === 'system') return clock(false, nowMs, false, false);
        if (parsed.mode === 'explicit') {
            if (parsed.offsetMinutes !== null) {
                // The typed instant, if this zone shows exactly the typed wall
                // time at it: then wall time AND instant are what was typed, no
                // flag. The Date constructor alone always takes the earlier
                // instant of an overlap, and would report the other offset.
                const w = parsed.wall;
                const exact = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s, w.ms) - parsed.offsetMinutes * 60000;
                const t = new Date(exact);
                if (t.getFullYear() === w.y && t.getMonth() === w.mo - 1 && t.getDate() === w.d &&
                        t.getHours() === w.h && t.getMinutes() === w.mi && t.getSeconds() === w.s) {
                    return clock(true, exact, false, false);
                }
            }
            const instant = localInstantOfWall(parsed.wall);
            const offsetChanged = parsed.offsetMinutes !== null &&
                parsed.offsetMinutes !== localOffsetMinutesAt(instant);
            return clock(true, instant, false, offsetChanged);
        }
        if (docTime && docTime.ok) {
            const w = docTime.wall;
            const instant = docTime.offsetMinutes === null
                ? localInstantOfWall(w)
                : Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s, w.ms) - docTime.offsetMinutes * 60000;
            return clock(true, instant, false, false);
        }
        return clock(false, nowMs, true, false);
    }

    /**
     * The website's `conversionTime` setting from what is stored (N6):
     * `document`/`system` persist in localStorage['conversion-settings'];
     * an explicit date-time counts ONLY from sessionStorage (the open tab), so
     * a back-dated "now" set once cannot silently back-date every document
     * converted months later. An explicit value found in localStorage is
     * ignored for exactly that reason; anything invalid is no setting.
     * Default: 'document'. Never throws.
     *
     * @param {*} persisted the `conversionTime` field of the localStorage object
     * @param {*} session   the `conversionTime` field of the sessionStorage object
     * @returns {string} a value parseConversionTime accepts ('auto' -> 'document')
     */
    function resolveConversionTimeSetting(persisted, session) {
        if (session !== undefined && session !== null) {
            const s = parseConversionTime(session);
            if (s.ok && s.mode === 'explicit') return session;
            if (typeof console !== 'undefined' && console.warn) {
                console.warn(`[ConversionSettings] ignoring session conversionTime ${JSON.stringify(session)}: ` +
                             (s.ok ? 'only an explicit date-time is kept per tab' : s.reason));
            }
        }
        if (persisted !== undefined && persisted !== null) {
            const p = parseConversionTime(persisted);
            if (p.ok && p.mode !== 'explicit') return p.mode;
            if (typeof console !== 'undefined' && console.warn) {
                console.warn(`[ConversionSettings] ignoring stored conversionTime ${JSON.stringify(persisted)}: ` +
                             (p.ok ? 'an explicit date-time is kept only in the open tab (N6)' : p.reason));
            }
        }
        return CONVERSION_TIME_DEFAULT;
    }

    // ---- documentTimeOf: the document's own date (§4, N1, N10, N11) ------

    // §4 table: formats that carry no date.
    const NO_DATE_FORMATS = new Set(['txt', 'csv', 'tsv']);
    const HTML_FORMATS = new Set(['html', 'htm', 'xhtml']);
    // Reads stay bounded whatever the input: §4.1's "first 64 KB" for RTF and
    // HTML; a flat ODF's office:meta comes first in the file (LibreOffice
    // writes it before settings, styles and body), so 1 MB is generous; an
    // inflated metadata part is a few KB, so 4 MB stops a zip bomb early.
    const TEXT_SCAN_BYTES = 64 * 1024;
    const FLAT_ODF_SCAN_BYTES = 1024 * 1024;
    const MAX_PART_BYTES = 4 * 1024 * 1024;

    const NS_DCTERMS = 'http://purl.org/dc/terms/';
    const NS_DC = 'http://purl.org/dc/elements/1.1/';
    const NS_ODF_META = 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0';
    const NS_ODF_OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
    const NS_XMP = 'http://ns.adobe.com/xap/1.0/';

    function u16le(u8, o) { return u8[o] | (u8[o + 1] << 8); }
    function u32le(u8, o) { return (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0; }
    function u64le(u8, o) { return u32le(u8, o) + u32le(u8, o + 4) * 4294967296; }

    /** Bytes as one char per byte. Only ever used on bounded windows. */
    function latin1(u8) {
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + 0x8000)));
        }
        return s;
    }

    function asciiBytes(str) {
        const out = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
        return out;
    }

    function matchesAt(u8, pat, at) {
        if (at < 0 || at + pat.length > u8.length) return false;
        for (let j = 0; j < pat.length; j++) if (u8[at + j] !== pat[j]) return false;
        return true;
    }

    /** Last index of `pat` in u8[0, before), or -1. Native lastIndexOf on the first byte keeps it fast on big PDFs. */
    function lastIndexOfBytes(u8, pat, before) {
        let i = Math.min(before === undefined ? u8.length : before, u8.length) - pat.length;
        while (i >= 0) {
            i = u8.lastIndexOf(pat[0], i);
            if (i < 0) return -1;
            if (matchesAt(u8, pat, i)) return i;
            i--;
        }
        return -1;
    }

    function indexOfBytes(u8, pat, from, to) {
        const end = Math.min(to === undefined ? u8.length : to, u8.length) - pat.length;
        let i = Math.max(0, from || 0);
        while (i <= end) {
            i = u8.indexOf(pat[0], i);
            if (i < 0 || i > end) return -1;
            if (matchesAt(u8, pat, i)) return i;
            i++;
        }
        return -1;
    }

    /** A document date as stored: {wall, offsetMinutes} (null offset = a wall time), or null. */
    function storedDate(wall, offsetMinutes) {
        return isValidWall(wall) ? { wall, offsetMinutes } : null;
    }

    /**
     * ISO 8601 / W3CDTF / xsd:dateTime as documents store it — deliberately
     * more lenient than the contract profile (documents write `.123456789`,
     * `+0100` and zone-less times). A date alone is 00:00. Year-only and
     * year-month W3CDTF values are not a "now" and count as no date.
     */
    function parseIsoDocumentDate(str) {
        if (typeof str !== 'string') return null;
        const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?\s*$/i.exec(str);
        if (!m) return null;
        const wall = {
            y: +m[1], mo: +m[2], d: +m[3],
            h: m[4] !== undefined ? +m[4] : 0, mi: m[5] !== undefined ? +m[5] : 0,
            s: m[6] !== undefined ? +m[6] : 0, ms: m[7] !== undefined ? +(m[7] + '00').slice(0, 3) : 0,
        };
        let off = null;
        if (m[8] !== undefined) {
            if (/^z$/i.test(m[8])) off = 0;
            else {
                const digits = m[8].slice(1).replace(':', '');
                const oh = +digits.slice(0, 2), om = digits.length > 2 ? +digits.slice(2, 4) : 0;
                if (oh > 23 || om > 59) return null;
                off = (m[8][0] === '-' ? -1 : 1) * (oh * 60 + om);
            }
        }
        return storedDate(wall, off);
    }

    /** A PDF date string, D:YYYY[MM[DD[HH[mm[SS]]]]][Z|±HH'mm'] (ISO 32000-1 §7.9.4). No O part = a wall time. */
    function parsePdfDate(str) {
        if (typeof str !== 'string') return null;
        const m = /^\s*(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz+-])(?:(\d{2})'?(?:(\d{2})'?)?)?)?/.exec(str);
        if (!m) return null;
        const wall = { y: +m[1], mo: m[2] ? +m[2] : 1, d: m[3] ? +m[3] : 1, h: m[4] ? +m[4] : 0,
                       mi: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0, ms: 0 };
        let off = null;
        if (m[7] === 'Z' || m[7] === 'z') off = 0;
        else if (m[7]) {
            const oh = m[8] ? +m[8] : 0, om = m[9] ? +m[9] : 0;
            if (oh > 23 || om > 59) return null;
            off = (m[7] === '-' ? -1 : 1) * (oh * 60 + om);
        }
        return storedDate(wall, off);
    }

    /** OLE FILETIME (100 ns since 1601-01-01 UTC) -> a UTC stored date. */
    function filetimeDate(low, high) {
        // As a double: 2026 is ~1.3e17 ticks, past 2^53, so the last few
        // 100 ns ticks round away; milliseconds are exact.
        const ms = Math.floor((high * 4294967296 + low) / 10000) - 11644473600000;
        const t = new Date(ms);
        if (Number.isNaN(t.getTime())) return null;
        return storedDate({ y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(),
                            mi: t.getUTCMinutes(), s: t.getUTCSeconds(), ms: t.getUTCMilliseconds() }, 0);
    }

    function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function decodeXmlText(s) {
        return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (all, e) => {
            if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'amp') return '&';
            if (e === 'quot') return '"'; if (e === 'apos') return "'";
            const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
        });
    }

    /** Every prefix `nsXml` binds to `nsUri` (prefixes are the document's choice, not fixed names). */
    function xmlPrefixesFor(nsXml, nsUri) {
        const out = [];
        const re = /xmlns:([A-Za-z_][\w.-]*)\s*=\s*(["'])(.*?)\2/g;
        let m;
        while ((m = re.exec(nsXml))) if (m[3] === nsUri && out.indexOf(m[1]) < 0) out.push(m[1]);
        return out;
    }

    /**
     * Text of the first element {nsUri}localName in `scope`, prefixes taken
     * from `nsXml`; also an element that declares nsUri as its own default
     * namespace. No DOMParser: a Worker has none, and neither has Node.
     */
    function xmlElementText(nsXml, scope, nsUri, localName) {
        const ln = escapeRe(localName);
        for (const p of xmlPrefixesFor(nsXml, nsUri)) {
            const q = escapeRe(p) + ':' + ln;
            const m = new RegExp('<' + q + '(?:\\s[^>]*)?>([^<]*)</' + q + '\\s*>').exec(scope);
            if (m) return decodeXmlText(m[1]).trim();
        }
        const d = new RegExp('<' + ln + '\\s[^>]*xmlns\\s*=\\s*(["\'])' + escapeRe(nsUri) + '\\1[^>]*>([^<]*)</' + ln + '\\s*>').exec(scope);
        return d ? decodeXmlText(d[2]).trim() : null;
    }

    /** Inner text of the first {nsUri}localName element in `xml`, or null. */
    function xmlElementInner(xml, nsUri, localName) {
        for (const p of xmlPrefixesFor(xml, nsUri)) {
            const q = escapeRe(p) + ':' + escapeRe(localName);
            const m = new RegExp('<' + q + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + q + '\\s*>').exec(xml);
            if (m) return m[1];
        }
        return null;
    }

    /** An XMP property in element (<xmp:ModifyDate>v</…>) or attribute (xmp:ModifyDate="v") form. */
    function xmpProperty(xml, localName) {
        const el = xmlElementText(xml, xml, NS_XMP, localName);
        if (el) return el;
        for (const p of xmlPrefixesFor(xml, NS_XMP)) {
            const m = new RegExp('\\s' + escapeRe(p) + ':' + escapeRe(localName) + '\\s*=\\s*(["\'])(.*?)\\1').exec(xml);
            if (m) return decodeXmlText(m[2]).trim();
        }
        return null;
    }

    // ---- ZIP (OOXML, ODF) --------------------------------------------------

    /** The central directory: name (lowercased) -> entry. Never reads the entries themselves. */
    function zipDirectory(u8) {
        const EOCD = 0x06054b50;
        let eocd = -1;
        for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 0xffff); i--) {
            if (u32le(u8, i) === EOCD) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('ZIP: no end of central directory');
        let count = u16le(u8, eocd + 10);
        let cdSize = u32le(u8, eocd + 12);
        let cdOffset = u32le(u8, eocd + 16);
        if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
            const loc = eocd - 20;
            if (loc < 0 || u32le(u8, loc) !== 0x07064b50) throw new Error('ZIP64: no locator');
            const rec = u64le(u8, loc + 8);
            if (rec + 56 > u8.length || u32le(u8, rec) !== 0x06064b50) throw new Error('ZIP64: no end record');
            count = u64le(u8, rec + 32);
            cdSize = u64le(u8, rec + 40);
            cdOffset = u64le(u8, rec + 48);
        }
        if (cdOffset + cdSize > u8.length) throw new Error('ZIP: central directory outside the file');
        const entries = new Map();
        let p = cdOffset;
        for (let n = 0; n < count && p + 46 <= u8.length && u32le(u8, p) === 0x02014b50; n++) {
            const nameLen = u16le(u8, p + 28), extraLen = u16le(u8, p + 30), commentLen = u16le(u8, p + 32);
            const e = {
                flags: u16le(u8, p + 8), method: u16le(u8, p + 10),
                compSize: u32le(u8, p + 20), size: u32le(u8, p + 24), localOffset: u32le(u8, p + 42),
            };
            const name = latin1(u8.subarray(p + 46, p + 46 + nameLen));
            // ZIP64 extended information: only the fields that overflowed, in this order.
            let x = p + 46 + nameLen;
            const xEnd = x + extraLen;
            while (x + 4 <= xEnd) {
                const id = u16le(u8, x), len = u16le(u8, x + 2);
                if (id === 0x0001) {
                    let q = x + 4;
                    if (e.size === 0xffffffff) { e.size = u64le(u8, q); q += 8; }
                    if (e.compSize === 0xffffffff) { e.compSize = u64le(u8, q); q += 8; }
                    if (e.localOffset === 0xffffffff) { e.localOffset = u64le(u8, q); }
                }
                x += 4 + len;
            }
            const key = name.toLowerCase();   // OPC part names compare case-insensitively
            if (!entries.has(key)) entries.set(key, e);
            p += 46 + nameLen + extraLen + commentLen;
        }
        return entries;
    }

    /**
     * Inflate raw DEFLATE with the platform's DecompressionStream
     * ('deflate-raw': browsers and workers; Node >= 20.12 / 21.2, the MCP
     * requires >= 22.21). The one non-pure dependency, and the reason
     * documentTimeOf is async. Stops reading past `maxOut`.
     */
    async function inflateRaw(data, maxOut) {
        if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream unavailable');
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(data).then(() => writer.close()).catch(() => { /* surfaces through read() */ });
        const chunks = [];
        let total = 0;
        for (;;) {
            let step;
            try {
                step = await reader.read();
            } catch (e) {
                // The platform's message is often just the error's name.
                throw new Error('ZIP: corrupt DEFLATE data (' + ((e && (e.message || e.name)) || e) + ')');
            }
            const { done, value } = step;
            if (done) break;
            total += value.length;
            if (total > maxOut) {
                reader.cancel().catch(() => {});
                throw new Error('ZIP: metadata part larger than ' + maxOut + ' bytes');
            }
            chunks.push(value);
        }
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out;
    }

    async function zipEntryText(u8, entry) {
        if (entry.flags & 1) { const e = new Error('ZIP: encrypted entry'); e.encrypted = true; throw e; }
        if (entry.size > MAX_PART_BYTES) throw new Error('ZIP: metadata part too large');
        const lh = entry.localOffset;
        if (lh + 30 > u8.length || u32le(u8, lh) !== 0x04034b50) throw new Error('ZIP: bad local header');
        const start = lh + 30 + u16le(u8, lh + 26) + u16le(u8, lh + 28);
        if (start + entry.compSize > u8.length) throw new Error('ZIP: entry outside the file');
        const raw = u8.subarray(start, start + entry.compSize);
        let bytes;
        if (entry.method === 0) bytes = raw;
        else if (entry.method === 8) bytes = await inflateRaw(raw.slice(), MAX_PART_BYTES);
        else throw new Error('ZIP: compression method ' + entry.method);
        return new TextDecoder('utf-8').decode(bytes);
    }

    /** OOXML docProps/core.xml (or wherever _rels/.rels points), else ODF meta.xml. */
    async function zipDocumentDates(u8) {
        const dir = zipDirectory(u8);
        let core = dir.get('docprops/core.xml');
        if (!core && dir.has('_rels/.rels')) {
            // OPC: the core-properties part is found through the package relationship.
            const rels = await zipEntryText(u8, dir.get('_rels/.rels'));
            const re = /<Relationship\b[^>]*>/g;
            let m;
            while (!core && (m = re.exec(rels))) {
                if (!/\bType\s*=\s*["'][^"']*\/metadata\/core-properties["']/.test(m[0])) continue;
                const t = /\bTarget\s*=\s*["']([^"']+)["']/.exec(m[0]);
                if (t) core = dir.get(t[1].replace(/^\/+/, '').toLowerCase());
            }
        }
        if (core) {
            const xml = await zipEntryText(u8, core);
            return [
                { source: 'modified', field: 'dcterms:modified', date: parseIsoDocumentDate(xmlElementText(xml, xml, NS_DCTERMS, 'modified')) },
                { source: 'created', field: 'dcterms:created', date: parseIsoDocumentDate(xmlElementText(xml, xml, NS_DCTERMS, 'created')) },
            ];
        }
        const meta = dir.get('meta.xml');
        if (meta) return odfMetaDates(await zipEntryText(u8, meta));
        return [];
    }

    /** ODF: dc:date, else meta:creation-date — inside office:meta only (annotations carry dc:date too). */
    function odfMetaDates(xml) {
        const scope = xmlElementInner(xml, NS_ODF_OFFICE, 'meta');
        if (scope === null) return [];
        return [
            { source: 'modified', field: 'dc:date', date: parseIsoDocumentDate(xmlElementText(xml, scope, NS_DC, 'date')) },
            { source: 'created', field: 'meta:creation-date', date: parseIsoDocumentDate(xmlElementText(xml, scope, NS_ODF_META, 'creation-date')) },
        ];
    }

    // ---- CFB / OLE (DOC, XLS, PPT) -------------------------------------------

    const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    const CFB_END = 0xfffffffe;
    const CFB_NONE = 0xffffffff;
    // FMTID_SummaryInformation {F29F85E0-4FF9-1068-AB91-08002B27B3D9}, as stored (little-endian GUID).
    const FMTID_SUMMARY = [0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3, 0xd9];

    /**
     * Open a CFB container ([MS-CFB]: header, DIFAT -> FAT, directory). Every
     * read is bounded by the file's own sector count, so a crafted header or a
     * cyclic chain throws instead of looping. Returns the helpers the readers
     * below share.
     */
    function cfbOpen(u8) {
        if (u8.length < 512) throw new Error('CFB: truncated header');
        const shift = u16le(u8, 0x1e);
        if (shift !== 9 && shift !== 12) throw new Error('CFB: unsupported sector size');
        const ss = 1 << shift;
        const miniSize = 1 << u16le(u8, 0x20);
        const firstDir = u32le(u8, 0x30), cutoff = u32le(u8, 0x38);
        const firstMiniFat = u32le(u8, 0x3c), firstDifat = u32le(u8, 0x44);
        const maxSectors = Math.ceil(u8.length / ss);
        // The header's FAT sector count is untrusted: a file can need no more
        // FAT sectors than it has sectors to describe. Capped BEFORE anything is
        // sized from it, so a crafted count (with a DIFAT chain that loops back
        // on itself) cannot make the FAT below a multi-hundred-MB allocation.
        const nFat = Math.min(u32le(u8, 0x2c), Math.ceil(maxSectors / (ss / 4)) + 1);
        const sector = (s) => {
            const off = (s + 1) * ss;
            if (s >= maxSectors || off >= u8.length) throw new Error('CFB: sector outside the file');
            return u8.subarray(off, Math.min(u8.length, off + ss));
        };

        const fatSectors = [];
        for (let i = 0; i < 109 && fatSectors.length < nFat; i++) fatSectors.push(u32le(u8, 0x4c + 4 * i));
        for (let d = firstDifat, guard = 0; fatSectors.length < nFat && d < 0xfffffffa; guard++) {
            if (guard > maxSectors) throw new Error('CFB: DIFAT loop');
            const s = sector(d), per = ss / 4 - 1;
            for (let i = 0; i < per && fatSectors.length < nFat; i++) fatSectors.push(u32le(s, 4 * i));
            d = u32le(s, 4 * per);
        }
        const fat = new Uint32Array(fatSectors.length * (ss / 4));
        fatSectors.forEach((fs, k) => {
            const s = sector(fs);
            for (let i = 0; i < ss / 4 && 4 * i + 4 <= s.length; i++) fat[k * (ss / 4) + i] = u32le(s, 4 * i);
        });
        const chain = (start, table, limit) => {
            const out = [];
            for (let s = start; s !== CFB_END; s = table[s]) {
                if (s >= table.length || out.length > limit) throw new Error('CFB: broken chain');
                out.push(s);
            }
            return out;
        };
        const readStream = (start, size) => {
            const out = new Uint8Array(size);
            let o = 0;
            for (const s of chain(start, fat, maxSectors)) {
                if (o >= size) break;
                const b = sector(s);
                const n = Math.min(b.length, size - o);
                out.set(b.subarray(0, n), o);
                o += n;
            }
            if (o < size) throw new Error('CFB: stream shorter than its size');
            return out;
        };

        const dirBytes = (() => {
            const ids = chain(firstDir, fat, maxSectors);
            const out = new Uint8Array(ids.length * ss);
            ids.forEach((s, i) => out.set(sector(s), i * ss));
            return out;
        })();
        const nEntries = Math.floor(dirBytes.length / 128);
        const entry = (id) => {
            if (id >= nEntries) throw new Error('CFB: directory entry outside the directory');
            const b = id * 128;
            const nameLen = Math.min(64, u16le(dirBytes, b + 0x40));
            let name = '';
            for (let i = 0; i + 1 < nameLen - 1; i += 2) name += String.fromCharCode(u16le(dirBytes, b + i));
            return {
                name, type: dirBytes[b + 0x42], left: u32le(dirBytes, b + 0x44), right: u32le(dirBytes, b + 0x48),
                child: u32le(dirBytes, b + 0x4c), start: u32le(dirBytes, b + 0x74), size: u32le(dirBytes, b + 0x78),
            };
        };
        const root = entry(0);
        if (root.type !== 5) throw new Error('CFB: no root entry');
        return { ss, miniSize, cutoff, firstMiniFat, maxSectors, fat, sector, chain, readStream, entry, root };
    }

    /**
     * The root storage's direct children. They form one red-black tree of
     * siblings (left/right); each entry is visited once, so a cyclic tree ends.
     */
    function cfbRootEntries(cfb) {
        const out = [];
        const seen = new Set();
        const stack = [cfb.root.child];
        while (stack.length) {
            const id = stack.pop();
            if (id === CFB_NONE || seen.has(id)) continue;
            seen.add(id);
            const e = cfb.entry(id);
            out.push(e);
            stack.push(e.left, e.right);
        }
        return out;
    }

    /**
     * The root storage's `\005SummaryInformation` stream (the mini stream for
     * streams under the cutoff). Only root-level: an embedded object's own
     * summary stream is not the document's. Returns null when there is none.
     */
    function cfbSummaryStream(u8) {
        const cfb = cfbOpen(u8);
        const found = cfbRootEntries(cfb).find((e) => e.type === 2 && e.name === '\u0005SummaryInformation') || null;
        if (!found) return null;
        if (found.size > MAX_PART_BYTES) throw new Error('CFB: summary stream too large');
        return cfbStreamPrefix(cfb, found, found.size, true);
    }

    /**
     * The first min(size, limit) bytes of a stream entry, from regular sectors or, under
     * the cutoff, from the mini stream (the root entry's own stream). Never allocates
     * more than `limit`, whatever size the entry declares. `whole`: the stream must hold
     * all of its declared size (else only what exists is returned).
     */
    function cfbStreamPrefix(cfb, entry, limit, whole = false) {
        const { ss, miniSize, cutoff, firstMiniFat, maxSectors, fat, sector, chain, readStream, root } = cfb;
        const want = Math.min(entry.size, limit);
        if (entry.size >= cutoff) {
            const out = new Uint8Array(want);
            let o = 0;
            for (const s of chain(entry.start, fat, maxSectors)) {
                if (o >= want) break;
                const b = sector(s);
                const n = Math.min(b.length, want - o);
                out.set(b.subarray(0, n), o);
                o += n;
            }
            if (whole && o < want) throw new Error('CFB: stream shorter than its size');
            return out.subarray(0, o);
        }
        const found = { start: entry.start, size: want };
        if (root.size > MAX_PART_BYTES) throw new Error('CFB: mini stream too large');
        const miniStream = readStream(root.start, root.size);
        const miniFatBytes = (() => {
            const ids = chain(firstMiniFat, fat, maxSectors);
            const out = new Uint8Array(ids.length * ss);
            ids.forEach((s, i) => out.set(sector(s), i * ss));
            return out;
        })();
        const miniFat = new Uint32Array(miniFatBytes.length / 4);
        for (let i = 0; i < miniFat.length; i++) miniFat[i] = u32le(miniFatBytes, 4 * i);
        const out = new Uint8Array(found.size);
        let o = 0;
        for (const s of chain(found.start, miniFat, miniFat.length)) {
            if (o >= found.size) break;
            const off = s * miniSize;
            if (off + miniSize > miniStream.length) throw new Error('CFB: mini sector outside the mini stream');
            const n = Math.min(miniSize, found.size - o);
            out.set(miniStream.subarray(off, off + n), o);
            o += n;
        }
        if (whole && o < found.size) throw new Error('CFB: mini stream shorter than its size');
        return out.subarray(0, o);
    }

    /** PIDSI_LASTSAVE_DTM (0x0D), else PIDSI_CREATE_DTM (0x0C), from a SummaryInformation property set. */
    function cfbDocumentDates(u8) {
        const s = cfbSummaryStream(u8);
        if (!s) return [];
        if (s.length < 48 || u16le(s, 0) !== 0xfffe) throw new Error('SummaryInformation: bad header');
        let set = -1;
        const nSets = Math.min(u32le(s, 24), 8);
        for (let k = 0; k < nSets && set < 0; k++) {
            const at = 28 + 20 * k;
            if (at + 20 > s.length) break;
            if (FMTID_SUMMARY.every((b, i) => s[at + i] === b)) set = u32le(s, at + 16);
        }
        if (set < 0 || set + 8 > s.length) throw new Error('SummaryInformation: no summary property set');
        const n = Math.min(u32le(s, set + 4), 4096);
        const props = new Map();
        for (let i = 0; i < n && set + 16 + 8 * i <= s.length; i++) {
            props.set(u32le(s, set + 8 + 8 * i), set + u32le(s, set + 12 + 8 * i));
        }
        const filetimeProp = (pid) => {
            const p = props.get(pid);
            if (p === undefined || p + 12 > s.length) return null;
            if ((u32le(s, p) & 0xffff) !== 0x0040) return null;    // VT_FILETIME
            return filetimeDate(u32le(s, p + 4), u32le(s, p + 8));
        };
        return [
            { source: 'modified', field: 'PIDSI_LASTSAVE_DTM', date: filetimeProp(0x0d) },
            { source: 'created', field: 'PIDSI_CREATE_DTM', date: filetimeProp(0x0c) },
        ];
    }

    // ---- RTF, HTML, flat ODF ---------------------------------------------------

    /** {\info{\revtim\yr\mo\dy\hr\min[\sec]}} else \creatim, in the first 64 KB; a wall time. */
    function rtfDocumentDates(u8) {
        const text = latin1(u8.subarray(0, TEXT_SCAN_BYTES));
        const read = (kw) => {
            const m = new RegExp('\\\\' + kw + '(?![a-z])((?:\\s*\\\\(?:yr|mo|dy|hr|min|sec)-?\\d+)+)').exec(text);
            if (!m) return null;
            const v = {};
            const re = /\\(yr|mo|dy|hr|min|sec)(-?\d+)/g;
            let k;
            while ((k = re.exec(m[1]))) if (v[k[1]] === undefined) v[k[1]] = +k[2];
            if (v.yr === undefined || v.mo === undefined || v.dy === undefined) return null;
            return storedDate({ y: v.yr, mo: v.mo, d: v.dy, h: v.hr || 0, mi: v.min || 0, s: v.sec || 0, ms: 0 }, null);
        };
        return [
            { source: 'modified', field: 'revtim', date: read('revtim') },
            { source: 'created', field: 'creatim', date: read('creatim') },
        ];
    }

    /**
     * An HTML meta date: ISO 8601 (what LibreOffice writes, zone-less), or
     * the older StarOffice form `YYYYMMDD;HHMMSSCC` that LibreOffice still reads.
     */
    function parseHtmlMetaDate(content) {
        const iso = parseIsoDocumentDate(content);
        if (iso) return iso;
        const m = /^\s*(\d{4})(\d{2})(\d{2});(\d{2})(\d{2})(\d{2})\d{0,2}\s*$/.exec(content || '');
        return m ? storedDate({ y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], ms: 0 }, null) : null;
    }

    /** <meta name="changed"> else <meta name="created">, in the first 64 KB. */
    function htmlDocumentDates(u8) {
        const text = latin1(u8.subarray(0, TEXT_SCAN_BYTES));
        const found = {};
        const tagRe = /<meta\b([^>]*)>/gi;
        let t;
        while ((t = tagRe.exec(text))) {
            const attrs = {};
            const aRe = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
            let a;
            while ((a = aRe.exec(t[1]))) attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4];
            const name = (attrs.name || '').toLowerCase();
            if ((name === 'changed' || name === 'created') && found[name] === undefined && attrs.content !== undefined) {
                found[name] = decodeXmlText(attrs.content);
            }
        }
        return [
            { source: 'modified', field: 'meta changed', date: parseHtmlMetaDate(found.changed) },
            { source: 'created', field: 'meta created', date: parseHtmlMetaDate(found.created) },
        ];
    }

    /** Flat ODF (.fodt/.fods/.fodp): the same elements under office:document/office:meta. */
    function flatOdfDocumentDates(u8) {
        const xml = new TextDecoder('utf-8').decode(u8.subarray(0, FLAT_ODF_SCAN_BYTES));
        if (xml.indexOf(NS_ODF_OFFICE) < 0) return [];
        return odfMetaDates(xml);
    }

    // ---- PDF (input to pdf-docx / pdf-pptx; N10) -------------------------------

    /** The bytes of a PDF string object starting at text[i] ('(' literal or '<' hex), as a JS string. */
    function pdfStringAt(text, i) {
        let bytes = [];
        if (text[i] === '<') {
            const end = text.indexOf('>', i);
            if (end < 0) return null;
            const hex = text.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, '');
            for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt((hex[k] + (hex[k + 1] || '0')), 16));
        } else if (text[i] === '(') {
            let depth = 0;
            for (let k = i; k < text.length; k++) {
                const c = text[k];
                if (c === '\\') {
                    const n = text[k + 1];
                    const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
                    if (esc[n] !== undefined) { bytes.push(esc[n]); k++; }
                    else if (/[0-7]/.test(n)) {
                        const o = /^[0-7]{1,3}/.exec(text.slice(k + 1, k + 4))[0];
                        bytes.push(parseInt(o, 8) & 0xff);
                        k += o.length;
                    } else if (n === '\r' || n === '\n') { k += (n === '\r' && text[k + 2] === '\n') ? 2 : 1; }
                    else { k++; }
                    continue;
                }
                if (c === '(') { if (depth++ > 0) bytes.push(40); continue; }
                if (c === ')') { if (--depth === 0) break; bytes.push(41); continue; }
                bytes.push(c.charCodeAt(0) & 0xff);
            }
        } else {
            return null;
        }
        if (bytes[0] === 0xfe && bytes[1] === 0xff) {          // UTF-16BE text string
            let s = '';
            for (let k = 2; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
            return s;
        }
        return String.fromCharCode.apply(null, bytes);
    }

    /** The text after `num gen obj` (last definition wins: incremental updates), up to endobj, or null. */
    function pdfObjectText(u8, num, gen) {
        const pat = asciiBytes(num + ' ' + gen + ' obj');
        for (let at = lastIndexOfBytes(u8, pat); at >= 0; at = lastIndexOfBytes(u8, pat, at)) {
            const prev = at > 0 ? u8[at - 1] : 0x0a;
            if (prev >= 0x30 && prev <= 0x39) continue;       // "11 0 obj" is not "1 0 obj"
            const start = at + pat.length;
            const text = latin1(u8.subarray(start, Math.min(u8.length, start + 65536)));
            const end = text.search(/\bendobj\b/);
            return end >= 0 ? text.slice(0, end) : text;
        }
        return null;
    }

    function pdfDictDate(dictText, key) {
        // A string value: '(' literal or '<' hex — never '<<', a dictionary.
        const m = new RegExp('/' + key + '\\s*(\\(|<(?!<))').exec(dictText || '');
        return m ? parsePdfDate(pdfStringAt(dictText, m.index + m[0].length - 1)) : null;
    }

    /**
     * Trailer /Info /ModDate, else XMP xmp:ModifyDate; then /CreationDate,
     * else xmp:CreateDate. Only an Info object written as a plain `n g obj`
     * can be read (one inside a compressed object stream cannot, §4.1); the
     * XMP must be the catalog's own /Metadata and unfiltered (N10). An
     * encrypted PDF has no readable date.
     */
    function pdfDocumentDates(u8) {
        const textAt = (from, to) => latin1(u8.subarray(Math.max(0, from), Math.min(u8.length, to)));
        // The last trailer (or cross-reference stream dictionary) is near the
        // end; a linearised file also repeats it in the first-page trailer.
        const infoPat = asciiBytes('/Info');
        const regions = [[Math.max(0, u8.length - FLAT_ODF_SCAN_BYTES), u8.length], [0, Math.min(u8.length, FLAT_ODF_SCAN_BYTES)]];
        let trailer = null;
        for (const [from, to] of regions) {
            for (let at = lastIndexOfBytes(u8, infoPat, to); at >= from; at = lastIndexOfBytes(u8, infoPat, at)) {
                const near = textAt(at - 2048, at + 2048);
                if (/^\/Info\s+\d+\s+\d+\s+R/.test(near.slice(Math.min(2048, at)))) { trailer = near; break; }
            }
            if (trailer) break;
        }
        if (!trailer) {
            // No /Info at all: the catalog may still be found through /Root for the XMP.
            const rootPat = asciiBytes('/Root');
            const at = lastIndexOfBytes(u8, rootPat);
            if (at >= 0) trailer = textAt(at - 2048, at + 2048);
        }
        if (!trailer) return [];
        if (/\/Encrypt\b/.test(trailer)) { const e = new Error('PDF: encrypted'); e.encrypted = true; throw e; }

        const ref = (key) => {
            const m = new RegExp('/' + key + '\\s+(\\d+)\\s+(\\d+)\\s+R').exec(trailer);
            return m ? [m[1], m[2]] : null;
        };
        const infoRef = ref('Info');
        const info = infoRef ? pdfObjectText(u8, infoRef[0], infoRef[1]) : null;
        let xmpCache;
        const xmp = () => {
            if (xmpCache !== undefined) return xmpCache;
            xmpCache = null;
            const rootRef = ref('Root');
            const cat = rootRef && pdfObjectText(u8, rootRef[0], rootRef[1]);
            const mref = cat && /\/Metadata\s+(\d+)\s+(\d+)\s+R/.exec(cat);
            const md = mref && pdfObjectText(u8, mref[1], mref[2]);
            if (!md) return null;
            const s = md.search(/\bstream(\r\n|\n|\r)/);
            if (s < 0 || /\/Filter\b/.test(md.slice(0, s))) return null;    // compressed XMP: not read (N10)
            const body = md.slice(s).replace(/^stream(\r\n|\n|\r)/, '');
            const e = body.indexOf('endstream');
            const bytes = asciiBytes(e >= 0 ? body.slice(0, e) : body);
            xmpCache = new TextDecoder('utf-8').decode(bytes);
            return xmpCache;
        };
        const fromXmp = (name) => () => { const x = xmp(); return x ? parseIsoDocumentDate(xmpProperty(x, name)) : null; };
        return [
            { source: 'modified', field: '/ModDate', date: pdfDictDate(info, 'ModDate') },
            { source: 'modified', field: 'xmp:ModifyDate', date: fromXmp('ModifyDate') },
            { source: 'created', field: '/CreationDate', date: pdfDictDate(info, 'CreationDate') },
            { source: 'created', field: 'xmp:CreateDate', date: fromXmp('CreateDate') },
        ];
    }

    // ---- the entry point -------------------------------------------------------

    /** N11: a sentinel some generators write when they have no date. */
    function isSentinelWall(w) {
        return w.y === 1900 && w.mo === 1 && w.d === 1 && w.h === 0 && w.mi === 0 && w.s === 0 && w.ms === 0;
    }

    /**
     * The document's own date for `document` mode (§4): its last-saved date,
     * else its creation date (N1), read without the engine and BEFORE the
     * document is loaded (XLSX recalculates NOW() on load, §4.1).
     *
     *   OOXML  docProps/core.xml dcterms:modified, else dcterms:created
     *   ODF    meta.xml dc:date, else meta:creation-date (flat ODF: office:meta)
     *   OLE    \005SummaryInformation PIDSI_LASTSAVE_DTM, else PIDSI_CREATE_DTM
     *   RTF    \info \revtim, else \creatim (first 64 KB)
     *   HTML   <meta name="changed">, else <meta name="created"> (first 64 KB)
     *   PDF    /Info /ModDate, else xmp:ModifyDate; /CreationDate, else xmp:CreateDate
     *   TXT, CSV, TSV  none
     *
     * The container is recognised by its bytes (a .doc that is really RTF is
     * read as RTF, as the engine would load it); the extension decides only
     * the formats that have no magic (TXT/CSV/TSV, HTML).
     *
     * N11: a date outside N8's range or a sentinel (FILETIME 0 = 1601-01-01,
     * 0001-01-01, 1900-01-01T00:00:00) is no date, and the next field is
     * tried. A future date is used as found. A value with a zone (UTC, an
     * offset) carries offsetMinutes; a zone-less value carries null (a wall
     * time). Encrypted, malformed or unreadable input has no date. Never
     * rejects: every failure is {ok: false, reason}.
     *
     * @param {Uint8Array|ArrayBuffer} bytes the document as the engine will get it
     * @param {string} ext its extension ('docx', '.docx' or a file name)
     * @returns {Promise<{ok: true, wall: {y,mo,d,h,mi,s,ms}, offsetMinutes: number|null,
     *                    source: 'modified'|'created', field: string} | {ok: false, reason: string}>}
     */
    async function documentTimeOf(bytes, ext) {
        try {
            // Realm-agnostic: the MCP host and the unit tests hand over Buffers
            // and arrays from another realm than the one this file runs in.
            const u8 = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                : Object.prototype.toString.call(bytes) === '[object ArrayBuffer]' ? new Uint8Array(bytes) : null;
            if (!u8 || !u8.length) return { ok: false, reason: 'no document bytes' };
            const e = String(ext == null ? '' : ext).toLowerCase().replace(/^.*\./, '');
            if (NO_DATE_FORMATS.has(e)) return { ok: false, reason: `a .${e} file stores no date` };

            let candidates;
            let lead = 0;
            if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) lead = 3;
            while (lead < u8.length && lead < 1024 && (u8[lead] === 0x20 || u8[lead] === 0x09 || u8[lead] === 0x0a || u8[lead] === 0x0d)) lead++;
            if (u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5) && (u8[3] === 4 || u8[3] === 6)) {
                candidates = await zipDocumentDates(u8);
            } else if (CFB_MAGIC.every((b, i) => u8[i] === b)) {
                candidates = cfbDocumentDates(u8);
            } else if (matchesAt(u8, asciiBytes('{\\rtf'), lead)) {
                candidates = rtfDocumentDates(u8);
            } else if (indexOfBytes(u8, asciiBytes('%PDF-'), 0, 1024) >= 0) {
                candidates = pdfDocumentDates(u8);
            } else if (HTML_FORMATS.has(e)) {
                candidates = htmlDocumentDates(u8);
            } else if (u8[lead] === 0x3c) {   // '<': flat ODF is XML
                candidates = flatOdfDocumentDates(u8);
            } else {
                return { ok: false, reason: 'not a format that stores a document date' };
            }

            let rejected = null;
            for (const c of candidates) {
                const d = typeof c.date === 'function' ? c.date() : c.date;
                if (!d) continue;
                if (!wallInRange(d.wall) || isSentinelWall(d.wall)) {
                    rejected = rejected || `${c.field} ${d.wall.y}-${String(d.wall.mo).padStart(2, '0')}-${String(d.wall.d).padStart(2, '0')} is outside the range or a placeholder`;
                    continue;
                }
                return { ok: true, wall: d.wall, offsetMinutes: d.offsetMinutes, source: c.source, field: c.field };
            }
            return { ok: false, reason: rejected || 'the document stores no last-saved or creation date' };
        } catch (err) {
            return { ok: false, reason: (err && err.encrypted ? 'encrypted: ' : 'unreadable: ') + ((err && err.message) || String(err)) };
        }
    }

    // ---- FG-021: legacy binary Office files (phase 2 of §3.1) -------------------------
    //
    // DOC, XLS and PPT keep their encryption flag inside their own streams, so a CFB file
    // is not evidence by itself (phase 1 said "unknown" for all of them):
    //   DOC  WordDocument stream, FIB base: wIdent 0xA5EC, fEncrypted = bit 0x0100 of the
    //        flags word at offset 0x0A ([MS-DOC] 2.5.2)
    //   XLS  Workbook (BIFF8) or Book (BIFF5) stream: a FilePass record (0x002F) in the
    //        globals substream, after BOF ([MS-XLS] 2.4.117)
    //   PPT  an EncryptedSummary stream at the root ([MS-PPT] 2.3.7)
    // Each read is a bounded PREFIX of its stream (cfbStreamPrefix), whatever size the
    // stream declares.
    //
    // VelvetSweatshop: Excel encrypts a workbook that has only a write password with the
    // built-in password "VelvetSweatshop", and Excel and the engine open it without asking.
    // Such a file must NEVER be refused, so FilePass is checked against that password
    // ([MS-OFFCRYPTO] 2.3.6 RC4 and 2.3.5 RC4 CryptoAPI, as msoffcrypto-tool does): if it
    // opens, the file is "maybe open", like a permissions-only PDF. XOR obfuscation
    // (FilePass type 0) is not checked, and so stays "unknown" rather than risk refusing a
    // file that opens.

    const LEGACY_PREFIX_BYTES = 64 * 1024;
    const XLS_DEFAULT_PASSWORD = 'VelvetSweatshop';

    /** MD5 (RFC 1321). Bytes in, 16 bytes out. */
    function md5(msg) {
        const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
        const K = new Uint32Array(64);
        for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
        const len = msg.length;
        const total = ((len + 8) >>> 6) + 1;
        const buf = new Uint8Array(total * 64);
        buf.set(msg); buf[len] = 0x80;
        const bits = len * 8;
        for (let i = 0; i < 4; i++) buf[total * 64 - 8 + i] = (bits >>> (8 * i)) & 0xff;
        buf[total * 64 - 4] = Math.floor(len / 0x20000000) & 0xff;
        let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
        const M = new Uint32Array(16);
        for (let blk = 0; blk < total; blk++) {
            for (let i = 0; i < 16; i++) M[i] = u32le(buf, blk * 64 + 4 * i);
            let A = a0, B = b0, C = c0, D = d0;
            for (let i = 0; i < 64; i++) {
                let F, g;
                if (i < 16) { F = (B & C) | (~B & D); g = i; }
                else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
                else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
                else { F = C ^ (B | ~D); g = (7 * i) % 16; }
                const sh = S[(i >>> 4) * 4 + (i & 3)];
                const x = (A + F + K[i] + M[g]) >>> 0;
                A = D; D = C; C = B;
                B = (B + ((x << sh) | (x >>> (32 - sh)))) >>> 0;
            }
            a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
        }
        const out = new Uint8Array(16);
        [a0, b0, c0, d0].forEach((v, k) => { for (let i = 0; i < 4; i++) out[4 * k + i] = (v >>> (8 * i)) & 0xff; });
        return out;
    }

    /** RC4: the keystream XORed over `data`. */
    function rc4(key, data) {
        const S = new Uint8Array(256);
        for (let i = 0; i < 256; i++) S[i] = i;
        for (let i = 0, j = 0; i < 256; i++) {
            j = (j + S[i] + key[i % key.length]) & 0xff;
            const t = S[i]; S[i] = S[j]; S[j] = t;
        }
        const out = new Uint8Array(data.length);
        for (let n = 0, i = 0, j = 0; n < data.length; n++) {
            i = (i + 1) & 0xff; j = (j + S[i]) & 0xff;
            const t = S[i]; S[i] = S[j]; S[j] = t;
            out[n] = data[n] ^ S[(S[i] + S[j]) & 0xff];
        }
        return out;
    }

    const utf16le = (str) => {
        const out = new Uint8Array(str.length * 2);
        for (let i = 0; i < str.length; i++) { out[2 * i] = str.charCodeAt(i) & 0xff; out[2 * i + 1] = str.charCodeAt(i) >> 8; }
        return out;
    };
    const joinBytes = (...parts) => {
        const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
        let o = 0;
        for (const x of parts) { out.set(x, o); o += x.length; }
        return out;
    };
    const equalBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const le32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

    /**
     * Does `password` open this FilePass record's RC4 encryption? true / false, or null
     * when the record is not RC4 (XOR obfuscation, or an unknown version).
     * @param {Uint8Array} fp the FilePass record's data (after its 4-byte header)
     */
    async function xlsFilePassOpens(fp, password) {
        if (fp.length < 6 || u16le(fp, 0) !== 1) return null;            // 0 = XOR obfuscation
        const vMajor = u16le(fp, 2), vMinor = u16le(fp, 4);
        const pw = utf16le(password);
        if (vMajor === 1 && vMinor === 1) {                              // RC4, Office 97/2000
            if (fp.length < 6 + 48) return null;
            const salt = fp.subarray(6, 22), ev = fp.subarray(22, 38), evh = fp.subarray(38, 54);
            const h1 = md5(new Uint8Array(Array.from({ length: 16 }, () => [...md5(pw).subarray(0, 5), ...salt]).flat()));
            const key = md5(joinBytes(h1.subarray(0, 5), le32(0)));
            const dec = rc4(key, joinBytes(ev, evh));
            return equalBytes(md5(dec.subarray(0, 16)), dec.subarray(16, 32));
        }
        if ((vMajor === 2 || vMajor === 3 || vMajor === 4) && vMinor === 2) { // RC4 CryptoAPI
            const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;
            if (!subtle || fp.length < 14) return null;
            const headerSize = u32le(fp, 10);
            const h = 14;                                                // EncryptionHeader
            if (headerSize < 20 || h + headerSize + 4 > fp.length) return null;
            let keyBits = u32le(fp, h + 16);
            if (keyBits === 0) keyBits = 40;
            const v = h + headerSize;                                    // EncryptionVerifier
            const saltSize = u32le(fp, v);
            if (saltSize !== 16 || v + 4 + 16 + 16 + 4 + 20 > fp.length) return null;
            const salt = fp.subarray(v + 4, v + 20), ev = fp.subarray(v + 20, v + 36);
            const evh = fp.subarray(v + 40, v + 40 + 20);
            const sha1 = async (b) => new Uint8Array(await subtle.digest('SHA-1', b));
            const hfinal = await sha1(joinBytes(await sha1(joinBytes(salt, pw)), le32(0)));
            const key = keyBits === 40 ? joinBytes(hfinal.subarray(0, 5), new Uint8Array(11)) : hfinal.subarray(0, keyBits / 8);
            const dec = rc4(key, joinBytes(ev, evh));
            return equalBytes(await sha1(dec.subarray(0, 16)), dec.subarray(16, 36));
        }
        return null;
    }

    /** The FilePass record of a BIFF workbook stream prefix, or null when there is none. */
    function xlsFilePass(wb) {
        if (wb.length < 4 || u16le(wb, 0) !== 0x0809) return undefined;  // not BIFF8 BOF: undecided
        for (let p = 0, n = 0; p + 4 <= wb.length && n < 4096; n++) {
            const type = u16le(wb, p), len = u16le(wb, p + 2);
            if (type === 0x002f) return wb.subarray(p + 4, Math.min(wb.length, p + 4 + len));
            if (type === 0x000a) return null;                            // EOF of the globals substream
            p += 4 + len;
        }
        return undefined;                                                // ran out of the prefix: undecided
    }

    /**
     * A legacy CFB document's protection: {encrypted, kind}. Unknown containers (not
     * DOC/XLS/PPT) and anything undecidable stay {encrypted: null, kind: 'cfb'}.
     */
    async function legacyEncryption(cfb) {
        const entries = cfbRootEntries(cfb).filter((e) => e.type === 2);
        const byName = new Map(entries.map((e) => [e.name, e]));
        if (byName.has('PowerPoint Document')) {
            return byName.has('EncryptedSummary') ? { encrypted: true, kind: 'ppt' } : { encrypted: false, kind: 'ppt' };
        }
        const wd = byName.get('WordDocument');
        if (wd) {
            const fib = cfbStreamPrefix(cfb, wd, 32);
            if (fib.length < 12 || u16le(fib, 0) !== 0xa5ec) return { encrypted: null, kind: 'cfb' };
            return (u16le(fib, 0x0a) & 0x0100) ? { encrypted: true, kind: 'doc' } : { encrypted: false, kind: 'doc' };
        }
        const wbEntry = byName.get('Workbook') || byName.get('Book');
        if (wbEntry) {
            const fp = xlsFilePass(cfbStreamPrefix(cfb, wbEntry, LEGACY_PREFIX_BYTES));
            if (fp === undefined) return { encrypted: null, kind: 'cfb' };
            if (fp === null) return { encrypted: false, kind: 'xls' };
            const opens = await xlsFilePassOpens(fp, XLS_DEFAULT_PASSWORD);
            if (opens === true) return { encrypted: true, kind: 'xls-velvetsweatshop' };
            if (opens === false) return { encrypted: true, kind: 'xls' };
            return { encrypted: null, kind: 'cfb' };                     // XOR, or an unknown version
        }
        return { encrypted: null, kind: 'cfb' };
    }

    /** Kinds that are encrypted yet open without a password: never refused (§3.1). */
    const MAYBE_OPEN_KINDS = Object.freeze(['pdf-maybe-open', 'xls-velvetsweatshop']);

    /** True when a detectEncryption result means "refuse: it needs a password". */
    function encryptionBlocks(r) {
        return !!(r && r.encrypted === true && !MAYBE_OPEN_KINDS.includes(r.kind));
    }

    // ---- FG-021 §4.4: prove a protected output IS protected (fail closed) ------------
    //
    // The bridge does not verify its output. Before CONVERT_DONE the worker checks the
    // PROPERTY, not the container (WAF 1): any failure is OUTPUT_PROTECTION_FAILED and the
    // output is never offered.
    //   PDF    /Filter /Standard with /V 5 /R 6 (AES-256; RC4 and /V < 5 refused); the EMPTY
    //          user password does not open it and the given one does (ISO 32000-2 2.A/2.B,
    //          crypto.subtle); with permissions asked, /P carries them.
    //   OOXML  a CFB with EncryptionInfo version 4.4 (Agile) and an EncryptedPackage stream.
    // ODF output is never protectable (no NSS: OUTPUT_PROTECTABLE), so it has no check.
    // The PDF security-handler code was designed and checked against the owner's fixtures
    // on design/pdf-empty-user-password (MD5/RC4 are #631's, above).

    const PDF_PASSWORD_PAD = new Uint8Array([
        0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
        0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);

    const concatBytes = (...parts) => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    };
    const sameBytes = (a, b, n) => a.length >= n && b.length >= n && a.subarray(0, n).every((x, i) => x === b[i]);

    /** A PDF string object's bytes: a literal (...) with its escapes, or a hex <...>. */
    function pdfStringBytes(text, at) {
        if (text[at] === '<') {
            const end = text.indexOf('>', at);
            if (end < 0) return null;
            const hex = text.slice(at + 1, end).replace(/\s+/g, '');
            const h = hex.length % 2 ? hex + '0' : hex;
            if (!/^[0-9a-fA-F]*$/.test(h)) return null;
            const out = new Uint8Array(h.length / 2);
            for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(2 * i, 2), 16);
            return out;
        }
        if (text[at] !== '(') return null;
        const out = [];
        let depth = 1;
        for (let i = at + 1; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c === 0x5c) {                                   // backslash
                const n = text[++i];
                const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
                if (n in map) out.push(map[n]);
                else if (n >= '0' && n <= '7') {
                    let oct = n;
                    while (oct.length < 3 && text[i + 1] >= '0' && text[i + 1] <= '7') oct += text[++i];
                    out.push(parseInt(oct, 8) & 0xff);
                } else if (n === '\r') { if (text[i + 1] === '\n') i++; }  // line continuation
                else if (n !== '\n') out.push(n.charCodeAt(0) & 0xff);
                continue;
            }
            if (c === 0x28) depth++;
            if (c === 0x29 && --depth === 0) return new Uint8Array(out);
            out.push(c & 0xff);
        }
        return null;
    }

    /** The text of the << ... >> dictionary starting at `at` (nested dictionaries kept), or null. */
    function pdfDictAt(text, at, limit = 64 * 1024) {
        if (text.substr(at, 2) !== '<<') return null;
        let depth = 0;
        for (let i = at; i < Math.min(text.length, at + limit); i++) {
            if (text[i] === '(') {                              // skip a string: it may hold << or >>
                let d = 0;
                for (; i < text.length; i++) {
                    if (text[i] === '\\') { i++; continue; }
                    if (text[i] === '(') d++;
                    else if (text[i] === ')' && --d === 0) break;
                }
                continue;
            }
            if (text.substr(i, 2) === '<<') { depth++; i++; continue; }
            if (text.substr(i, 2) === '>>') { if (--depth === 0) return text.slice(at, i + 2); i++; }
        }
        return null;
    }

    /**
     * The standard security handler's parameters: /Encrypt (direct, or an indirect
     * object that is not in an object stream) and the first /ID string. Null when
     * they cannot be read, or the handler is not /Standard.
     */
    function pdfEncryption(u8) {
        const text = latin1(u8.length <= 4 * PDF_ENCRYPT_SCAN_BYTES ? u8
            : concatBytes(u8.subarray(0, 2 * PDF_ENCRYPT_SCAN_BYTES), u8.subarray(u8.length - 2 * PDF_ENCRYPT_SCAN_BYTES)));
        const refRe = /\/Encrypt\s*(?:(\d+)\s+(\d+)\s+R|(<<))/g;
        let m, last = null;
        while ((m = refRe.exec(text))) last = m;
        if (!last) return null;
        let dict;
        if (last[3]) dict = pdfDictAt(text, last.index + last[0].length - 2);
        else {
            const objRe = new RegExp('(?:^|[\\s>])' + last[1] + '\\s+' + last[2] + '\\s+obj\\s*', 'g');
            let o, at = -1;
            while ((o = objRe.exec(text))) at = o.index + o[0].length;
            if (at < 0) return null;
            dict = pdfDictAt(text, at);
        }
        if (!dict || !/\/Filter\s*\/Standard\b/.test(dict)) return null;
        const num = (k) => { const x = new RegExp('/' + k + '\\s+(-?\\d+)').exec(dict); return x ? parseInt(x[1], 10) : null; };
        const str = (k) => { const x = new RegExp('/' + k + '\\s*([(<])').exec(dict); return x ? pdfStringBytes(dict, x.index + x[0].length - 1) : null; };
        const idm = /\/ID\s*\[\s*([(<])/.exec(text.slice(Math.max(0, last.index - 4096), last.index + 4096));
        const idText = text.slice(Math.max(0, last.index - 4096), last.index + 4096);
        const id0 = idm ? pdfStringBytes(idText, idm.index + idm[0].length - 1) : new Uint8Array(0);
        // The top level only: nested dictionaries (the /CF crypt filters) blanked out.
        let dictTop = '', depth = 0;
        for (let i = 0; i < dict.length; i++) {
            if (dict.substr(i, 2) === '<<') { depth++; i++; if (depth === 1) dictTop += '<<'; continue; }
            if (dict.substr(i, 2) === '>>') { if (depth === 1) dictTop += '>>'; depth--; i++; continue; }
            if (depth === 1) dictTop += dict[i];
        }
        return {
            dictTop,
            V: num('V'), R: num('R'), P: num('P'), O: str('O'), U: str('U'),
            encryptMetadata: !/\/EncryptMetadata\s+false\b/.test(dict), id0: id0 || new Uint8Array(0),
        };
    }

    /** R5/R6: algorithm 2.B (R6) or one SHA-256 (R5), via crypto.subtle. */
    async function pdfHashR6(password, salt, udata, R) {
        const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;
        if (!subtle) return null;
        const sha = async (alg, b) => new Uint8Array(await subtle.digest(alg, b));
        let K = await sha('SHA-256', concatBytes(password, salt, udata));
        if (R === 5) return K;
        for (let round = 0; ; round++) {
            const one = concatBytes(password, K, udata);
            const K1 = new Uint8Array(one.length * 64);
            for (let i = 0; i < 64; i++) K1.set(one, i * one.length);
            const key = await subtle.importKey('raw', K.subarray(0, 16), { name: 'AES-CBC' }, false, ['encrypt']);
            // subtle always pads; K1 is a multiple of 16 bytes, so the extra block is dropped.
            const E = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: K.subarray(16, 32) }, key, K1))
                .subarray(0, K1.length);
            let sum = 0;
            for (let i = 0; i < 16; i++) sum += E[i];
            K = await sha(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], E);
            if (round >= 63 && E[E.length - 1] <= round - 31) break;
        }
        return K.subarray(0, 32);
    }

    /**
     * Does `password` (a JS string; '' = none) open this PDF as its USER? true / false,
     * or null when the PDF is not standard-encrypted or this cannot be decided.
     * R6 passwords are UTF-8, truncated to 127 bytes (SASLprep is not applied: a
     * password that needs it may be reported wrongly; the empty password never does).
     * R2-R4 passwords are taken as Latin-1 bytes, truncated to 32.
     */
    async function pdfUserPasswordOpens(bytes, password = '') {
        try {
            const u8 = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
            const e = pdfEncryption(u8);
            if (!e || !e.U || e.R === null) return null;
            if (e.R === 5 || e.R === 6) {
                if (e.V !== 5 || e.U.length < 48) return null;
                const pw = new TextEncoder().encode(password).subarray(0, 127);
                const h = await pdfHashR6(pw, e.U.subarray(32, 40), new Uint8Array(0), e.R);
                return h ? sameBytes(h, e.U, 32) : null;
            }
            // Only the handler revisions and V values this was tested against (the owner's
            // fixtures: R2/V1, R3/V2, R4/V4, R6/V5). Anything else is undecided, never
            // "needs a password": a wrong derivation must not block a file that opens.
            const KNOWN = { 2: [1], 3: [2], 4: [4] };
            if (!KNOWN[e.R] || !KNOWN[e.R].includes(e.V) || !e.O || e.O.length < 32 || e.P === null) return null;
            const pw = new Uint8Array(32);
            const raw = Uint8Array.from(String(password), (c) => c.charCodeAt(0) & 0xff).subarray(0, 32);
            pw.set(raw); pw.set(PDF_PASSWORD_PAD.subarray(0, 32 - raw.length), raw.length);
            // Key length: 40 bits for R2; V2's top-level /Length (bits); 128 bits for V4,
            // whose /Length is usually only the crypt filter's, in BYTES (CF/StdCF /Length 16).
            const topLength = (() => {
                const x = /\/Length\s+(\d+)/.exec(e.dictTop || '');
                return x ? parseInt(x[1], 10) : 40;
            })();
            const n = e.R === 2 ? 5 : e.V === 4 ? 16 : Math.max(5, Math.min(16, Math.floor(topLength / 8)));
            const P = new Uint8Array(4);
            for (let i = 0; i < 4; i++) P[i] = (e.P >>> (8 * i)) & 0xff;
            let key = md5(concatBytes(pw, e.O.subarray(0, 32), P, e.id0,
                e.R >= 4 && !e.encryptMetadata ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array(0)));
            if (e.R >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
            key = key.subarray(0, n);
            if (e.R === 2) return sameBytes(rc4(key, PDF_PASSWORD_PAD), e.U, 32);
            let x = rc4(key, md5(concatBytes(PDF_PASSWORD_PAD, e.id0)));
            for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
            return sameBytes(x, e.U, 16);
        } catch (err) {
            return null;
        }
    }


    /**
     * /P bits for the requested permissions, and which bits to compare ([ISO 32000-2]
     * Table 22): 3 print, 4 modify, 5 copy/extract, 12 high-quality print. Only those
     * the request decides are checked; the filter sets the rest itself.
     */
    function pdfExpectedPermissionBits(pm) {
        const bit = (n) => 1 << (n - 1);
        const want = {};
        const printing = pm.printing === undefined ? 'high' : pm.printing;
        want[3] = printing !== 'none';
        want[12] = printing === 'high';
        want[4] = (pm.changes === undefined ? 'any' : pm.changes) !== 'none';
        want[5] = pm.copying === undefined ? true : !!pm.copying;
        return Object.entries(want).map(([n, on]) => ({ n: Number(n), mask: bit(Number(n)), on }));
    }

    /**
     * §4.4: is `bytes` really protected as `outputProtection` asked? Never throws.
     * @returns {Promise<{ok: true} | {ok: false, reason: string}>} the reason names no secret
     */
    async function verifyOutputProtection(bytes, targetFormat, outputProtection) {
        try {
            const u8 = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
            const t = String(targetFormat || '').toLowerCase();
            const op = outputProtection || {};
            if (t === 'pdf') {
                const e = pdfEncryption(u8);
                if (!e) return { ok: false, reason: 'the PDF has no standard /Encrypt dictionary' };
                if (e.V !== 5 || e.R !== 6) return { ok: false, reason: `PDF encryption is /V ${e.V} /R ${e.R}, not AES-256 (/V 5 /R 6)` };
                const withoutPassword = await pdfUserPasswordOpens(u8, '');
                if (withoutPassword === null) return { ok: false, reason: 'whether the PDF opens without a password could not be decided' };
                if (withoutPassword) return { ok: false, reason: 'the PDF opens WITHOUT a password' };
                if ((await pdfUserPasswordOpens(u8, op.openPassword || '')) !== true) return { ok: false, reason: 'the PDF does not open with the requested password' };
                if (op.permissions) {
                    if (e.P === null) return { ok: false, reason: 'the PDF has no /P' };
                    for (const b of pdfExpectedPermissionBits(op.permissions)) {
                        if (((e.P & b.mask) !== 0) !== b.on) return { ok: false, reason: `PDF permission bit ${b.n} is ${(e.P & b.mask) ? 'set' : 'clear'}, the request says otherwise` };
                    }
                }
                return { ok: true };
            }
            if (t === 'docx' || t === 'xlsx' || t === 'pptx') {
                if (!(u8.length >= 8 && CFB_MAGIC.every((b, i) => u8[i] === b))) return { ok: false, reason: 'the output is not an encrypted OOXML container' };
                const cfb = cfbOpen(u8);
                const byName = new Map(cfbRootEntries(cfb).filter((x) => x.type === 2).map((x) => [x.name, x]));
                if (!byName.has('EncryptedPackage') || !byName.has('EncryptionInfo')) return { ok: false, reason: 'EncryptionInfo or EncryptedPackage is missing' };
                const info = cfbStreamPrefix(cfb, byName.get('EncryptionInfo'), 8);
                if (info.length < 4 || u16le(info, 0) !== 4 || u16le(info, 2) !== 4) {
                    return { ok: false, reason: `EncryptionInfo is version ${u16le(info, 0)}.${u16le(info, 2)}, not Agile (4.4)` };
                }
                return { ok: true };
            }
            return { ok: false, reason: `.${t} output cannot be password-protected` };
        } catch (err) {
            return { ok: false, reason: 'the output could not be read: ' + ((err && err.message) || String(err)) };
        }
    }

    /**
     * The CONVERT_ERROR `code` for a bridge error text (get_last_error, "TAG: message"):
     * the password tags map to their codes; anything else has none. ENCRYPTION_REFUSED (#655:
     * the file's own encryption settings are refused, e.g. an ODF key-derivation iteration count
     * outside 1..10,000,000) is final like PASSWORD_UNSUPPORTED: no password can help, so a
     * caller must not ask again (plans/fg-021-bug-36-password-and-calc-notes.md §2).
     */
    function bridgeErrorCode(detail) {
        const m = /^(PASSWORD_REQUIRED|PASSWORD_WRONG|PASSWORD_UNSUPPORTED|ENCRYPTION_REFUSED):/.exec(String(detail || ''));
        return m ? m[1] : null;
    }

    // ---- FG-021 §3.1: is the input password-protected? --------------------------
    //
    // Decided BEFORE the module download: a protected file the engine cannot open
    // yet should cost the user neither ~25 MB nor a vague "may be corrupted"
    // (plans/fg-021-bug-36-password-and-calc-notes.md §3.1). Runs on the main
    // thread on untrusted bytes, so every read is bounded: the CFB reader is
    // cfbOpen's (FAT capped by the file's sector count, chains limited, each
    // directory entry visited once), the ZIP reader is zipDirectory/zipEntryText
    // (one part, inflated to at most MAX_PART_BYTES), and a PDF is searched in
    // its first and last PDF_ENCRYPT_SCAN_BYTES only.

    const PDF_ENCRYPT_SCAN_BYTES = 1024 * 1024;

    /**
     * The parts whose encryption makes an ODF password-protected: the document
     * itself. A password on the whole document is written in one of two ways:
     *
     *   - LibreOffice 25.8's DEFAULT (ODF 1.4, AES-256-GCM, Argon2id): the whole
     *     package is one `encrypted-package` entry, the only one the manifest
     *     lists. content.xml and styles.xml do not appear at all.
     *   - the older per-file scheme (AES-256-CBC/PBKDF2, or Blowfish): every XML
     *     stream is encrypted, content.xml and styles.xml included (LibreOffice's
     *     own sc/qa/unit/data/ods/password.ods: content, styles, meta, settings).
     *
     * Missing the first scheme was a regression in BUG-45's own fix (#625), found
     * against the owner's encrypted fixtures; both are now pinned by tests.
     * Encryption-data on OTHER entries alone is not a protected document: a
     * password-protected Basic library (Basic/<lib>/*.xml, e.g. tdf57113.ods)
     * encrypts only the macros, which load lazily, and the engine opens the
     * document without any password (BUG-45, a regression from #622 that
     * refused FG-165's fixture). styles.xml counts as well as content.xml because
     * the engine cannot load a document without its styles.
     *
     * Adding a part can only cause MORE refusals, so a part joins this list only
     * with evidence: a fixture with only that part encrypted that the real engine
     * cannot open without the password (WAF, on #625). meta.xml and settings.xml
     * are not in it for that reason; missing one costs a generic error instead of
     * the password message, the less harmful side. `encrypted-package` meets the
     * rule: LibreOffice refuses every one of the owner's whole-package fixtures
     * without the password (their MANIFEST.json verification records).
     */
    const ODF_DOCUMENT_PARTS = Object.freeze(['encrypted-package', 'content.xml', 'styles.xml']);

    /**
     * The full-paths of the manifest's file entries that carry encryption-data.
     * LINEAR in the manifest's size, whatever it contains (main thread, untrusted
     * input; the #580 class): the manifest is cut at each file-entry opener, and
     * EVERY search for an entry (its tag end, its closer, encryption-data) runs
     * inside that entry's own segment, never past the next opener. An unbounded
     * xml.indexOf('>', start) was still quadratic on openers with no '>' at all
     * (WAF, #625: 3.4 s at the 4 MB part cap).
     */
    function odfEncryptedParts(manifestXml) {
        const out = new Map();                                        // full-path -> algorithm-name ('' if none)
        const xml = String(manifestXml);
        const openers = [];
        const openRe = /<(?:[\w.-]+:)?file-entry\b/g;
        let m;
        while ((m = openRe.exec(xml))) openers.push(m.index);
        const pathRe = /(?:^|\s)(?:[\w.-]+:)?full-path\s*=\s*["']/;
        const closeRe = /<\/(?:[\w.-]+:)?file-entry\s*>/;
        const encRe = /<(?:[\w.-]+:)?encryption-data\b/;
        const algRe = /(?:^|\s)(?:[\w.-]+:)?algorithm-name\s*=\s*["']/;
        // An attribute's value: the regex finds where it starts, indexOf where it ends
        // (no lazy match that could rescan an unterminated quote).
        const valueAt = (text, re) => {
            const a = re.exec(text);
            if (!a) return null;
            const from = a.index + a[0].length;
            const to = text.indexOf(text[from - 1], from);
            return to < 0 ? null : text.slice(from, to);
        };
        for (let k = 0; k < openers.length; k++) {
            const segEnd = k + 1 < openers.length ? openers[k + 1] : xml.length;
            const seg = xml.slice(openers[k], segEnd);                // this entry, and nothing past it
            const tagEnd = seg.indexOf('>');
            if (tagEnd < 0) continue;                                 // an opener never closed: no entry
            if (seg[tagEnd - 1] === '/') continue;                    // <file-entry .../>: no children
            const after = seg.slice(tagEnd + 1);
            const close = after.search(closeRe);
            const body = close >= 0 ? after.slice(0, close) : after;
            if (!encRe.test(body)) continue;
            const fullPath = valueAt(seg.slice(0, tagEnd), pathRe);
            if (fullPath === null) continue;
            out.set(fullPath.replace(/^(?:\.\/|\/)+/, ''), valueAt(body, algRe) || '');
        }
        return out;
    }
    const PASSWORD_PROTECTED = 'INPUT_PASSWORD_PROTECTED';

    /**
     * Whether a document is password-protected, from its bytes. The container
     * is recognised by its magic, as documentTimeOf does; the extension is not
     * consulted (an encrypted .docx IS a CFB file, whatever it is named).
     *
     *   CFB with EncryptionInfo + EncryptedPackage  -> true,  'ooxml'
     *   DOC with the FIB's fEncrypted bit           -> true,  'doc'   (else false)
     *   XLS with a FilePass record                  -> true,  'xls'   (else false)
     *       ...whose password is VelvetSweatshop    -> true,  'xls-velvetsweatshop' (opens: never refused)
     *   PPT with an EncryptedSummary stream         -> true,  'ppt'   (else false)
     *   any other or undecidable CFB                -> null,  'cfb'
     *   ZIP whose manifest has encryption-data on   -> true,  'odf' (Blowfish), 'odf-aes' (AES: unsupported)
     *       content.xml or styles.xml (the document itself; see odfEncryptedParts)
     *   other ZIP                                   -> false
     *   PDF with no trailer and no startxref        -> null,  'pdf-unreadable' (truncated)
     *   PDF with /Encrypt in its trailer            -> true,  'pdf-maybe-open'
     *       (may be permissions-only, with an empty user password the engine
     *        opens: never a reason to refuse, only to explain a failure)
     *   anything else                               -> false
     *
     * Never rejects: input it cannot read is {encrypted: null, kind: 'unreadable'},
     * which callers treat as "not known to be protected".
     *
     * @param {Uint8Array|ArrayBuffer} bytes
     * @returns {Promise<{encrypted: boolean|null, kind: string|null}>}
     */
    async function detectEncryption(bytes) {
        try {
            const u8 = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                : Object.prototype.toString.call(bytes) === '[object ArrayBuffer]' ? new Uint8Array(bytes) : null;
            if (!u8 || u8.length < 8) return { encrypted: false, kind: null };
            if (CFB_MAGIC.every((b, i) => u8[i] === b)) {
                const cfb = cfbOpen(u8);
                const names = new Set(cfbRootEntries(cfb).filter((e) => e.type === 2).map((e) => e.name));
                if (names.has('EncryptionInfo') && names.has('EncryptedPackage')) return { encrypted: true, kind: 'ooxml' };
                return await legacyEncryption(cfb);
            }
            if (u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5) && (u8[3] === 4 || u8[3] === 6)) {
                const manifest = zipDirectory(u8).get('meta-inf/manifest.xml');
                if (!manifest) return { encrypted: false, kind: 'zip' };
                const encrypted = odfEncryptedParts(await zipEntryText(u8, manifest));
                const parts = ODF_DOCUMENT_PARTS.filter((p) => encrypted.has(p));
                if (!parts.length) return { encrypted: false, kind: 'odf' };
                // AES (CBC or GCM, the modern schemes) cannot be read by this build at all: it
                // has no NSS, so there is nothing a password could do. Blowfish (the legacy
                // OpenOffice scheme) is read, so it is merely "protected" (FG-021 opens it).
                return parts.some((p) => /aes/i.test(encrypted.get(p)))
                    ? { encrypted: true, kind: 'odf-aes' } : { encrypted: true, kind: 'odf' };
            }
            if (indexOfBytes(u8, asciiBytes('%PDF-'), 0, 1024) >= 0) {
                const n = PDF_ENCRYPT_SCAN_BYTES;
                const windows = u8.length <= 2 * n ? [u8] : [u8.subarray(0, n), u8.subarray(u8.length - n)];
                const found = windows.some((w) => /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(latin1(w)));
                if (found) return { encrypted: true, kind: 'pdf-maybe-open' };
                // No trailer and no startxref anywhere it looked: a truncated or damaged PDF,
                // whose /Encrypt (if any) is in the part that is missing. Unknown, not "plain"
                // (the owner's TRN-PDF fixtures). The engine still gets it.
                const tail = latin1(windows[windows.length - 1]);
                if (!/\bstartxref\b/.test(tail) && !/\btrailer\b/.test(tail)) return { encrypted: null, kind: 'pdf-unreadable' };
                return { encrypted: false, kind: 'pdf' };
            }
            return { encrypted: false, kind: null };
        } catch (err) {
            // A ZIP entry flagged encrypted (traditional PKWARE encryption on the manifest itself).
            if (err && err.encrypted) return { encrypted: true, kind: 'zip-encrypted' };
            return { encrypted: null, kind: 'unreadable' };
        }
    }

    /**
     * detectEncryption for a Blob/File without reading more than it needs: a PDF
     * is read as its first and last PDF_ENCRYPT_SCAN_BYTES, ZIP and CFB whole
     * (their directories can be anywhere), anything else not past its magic.
     */
    async function detectEncryptionOfBlob(blob) {
        try {
            const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
            const isCfb = head.length >= 8 && CFB_MAGIC.every((b, i) => head[i] === b);
            const isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b;
            if (isCfb || isZip) return await detectEncryption(new Uint8Array(await blob.arrayBuffer()));
            if (indexOfBytes(head, asciiBytes('%PDF-'), 0, 1024) < 0) return { encrypted: false, kind: null };
            const n = PDF_ENCRYPT_SCAN_BYTES;
            if (blob.size <= 2 * n) return await detectEncryption(new Uint8Array(await blob.arrayBuffer()));
            const first = new Uint8Array(await blob.slice(0, n).arrayBuffer());
            const last = new Uint8Array(await blob.slice(blob.size - n).arrayBuffer());
            const joined = new Uint8Array(2 * n);
            joined.set(first, 0); joined.set(last, n);
            return await detectEncryption(joined);
        } catch (err) {
            return { encrypted: null, kind: 'unreadable' };
        }
    }

    /**
     * The error for a protected input the engine cannot open yet (§3.1). Its
     * message is the approved copy; `code` lets the UI and the MCP tell it from
     * a conversion failure.
     */
    function passwordProtectedError(kind) {
        if (UNSUPPORTED_ENCRYPTION_KINDS.includes(kind)) {
            // §3.2's copy for PASSWORD_UNSUPPORTED: no password can help, now or later.
            const err = new Error("This kind of password-protected file can't be opened here. Open it in the app " +
                'that made it and save a copy without a password, then drop that copy here.');
            err.code = PASSWORD_ERROR_CODES.PASSWORD_UNSUPPORTED;
            return err;
        }
        const err = new Error("This file is password-protected. The converter can't open password-protected files yet. " +
            'Open it in the app that made it, save a copy without a password, and drop that copy here.');
        err.code = PASSWORD_PROTECTED;
        return err;
    }

    /**
     * Encryption this build can never read, password or not: modern ODF (AES-256-CBC and
     * AES-256-GCM). The WASM engine is built without NSS, which LibreOffice's ODF package
     * crypto needs (module, 2026-10-26). Blowfish ODF is read. Reported as
     * PASSWORD_UNSUPPORTED, never as "a password is needed".
     */
    const UNSUPPORTED_ENCRYPTION_KINDS = Object.freeze(['odf-aes']);

    /**
     * FG-021 step 4 (brief approved 2026-10-31, "What opens"): the detected kinds the engine
     * opens with a password, so the website asks for one. Measured on builds #1 and #2:
     * DOCX/XLSX/PPTX (ooxml), XLS RC4 and CryptoAPI 128-bit (xls), Blowfish ODF (odf).
     * NOT here: 'doc' (Word 97 and CryptoAPI DOC fail on every password until build #3; add it
     * only when build #3 measures it), 'ppt' (fails, cause unknown), 'odf-aes' (no NSS),
     * 'zip-encrypted', and PDFs, whose open password the engine never asks for (they are
     * 'pdf-maybe-open' and get pdfNeedsPasswordError() if they fail). A kind not listed keeps
     * the "can't be opened here" message.
     */
    const PASSWORD_PROMPT_KINDS = Object.freeze(['ooxml', 'xls', 'odf']);

    /**
     * The website's text for each password outcome (brief, Messages). The UI shows these;
     * none ever contains a password.
     */
    const PASSWORD_UI_TEXT = Object.freeze({
        prompt: 'This file is password-protected. Enter its password to convert it. The password stays on this device and is forgotten when the conversion ends.',
        wrong: "That password didn't open the file. Check it (passwords are case-sensitive) and try again.",
        unsupported: "This kind of password-protected file can't be opened here. Open it in the app that made it and save a copy without a password, then drop that copy here.",
        // ENCRYPTION_REFUSED (#655): the file's own encryption settings are refused; final, no re-prompt.
        refused: "This file's encryption settings can't be opened here, so no password will open it. Open it in the app that made it and save a copy without a password, then drop that copy here.",
        pdfNeedsPassword: "This PDF needs a password, and password-protected PDFs can't be opened here yet. Open it in the app that made it and save a copy without a password, then drop that copy here.",
        protectionFailed: "The converted file couldn't be protected with your password, so it wasn't saved. Nothing was downloaded.",
        protectedOk: 'Protected with your password.',
        notReusable: "This password can't be reused for the converted file. Choose a new password or no password.",
        noPasswordOutput: 'Convert without a password',
        restrictionsDropped: "This PDF's restrictions on printing or copying weren't carried over to the converted file.",
    });

    /**
     * FG-021 step 4, with the website's password handling ON: the error for a detected
     * protected file and no password. A kind the engine opens asks for the password
     * (PASSWORD_REQUIRED, which the UI answers with the prompt); any other kind is
     * PASSWORD_UNSUPPORTED with the "can't be opened here" copy. `passwordKind` says which.
     */
    function passwordRequiredError(kind) {
        const promptable = PASSWORD_PROMPT_KINDS.includes(kind);
        const err = new Error(promptable ? PASSWORD_UI_TEXT.prompt : PASSWORD_UI_TEXT.unsupported);
        err.code = promptable ? PASSWORD_ERROR_CODES.PASSWORD_REQUIRED : PASSWORD_ERROR_CODES.PASSWORD_UNSUPPORTED;
        err.passwordKind = kind;
        return err;
    }

    /**
     * FG-021 step 4: a PDF with an /Encrypt dictionary that the engine could not open. With
     * password handling on, it is reported as needing a password (never "conversion failed").
     * The engine does not ask for PDF open passwords yet (brief), so it is PASSWORD_UNSUPPORTED.
     */
    /**
     * Whether an error is the engine failing to LOAD the input (the bridge's LOAD_FAILED
     * tag, carried in the worker's CONVERT_ERROR text). FG-021 step 4 (WAF review M2): only
     * this, for a PDF with encryption settings, becomes "This PDF needs a password"; a
     * timeout, stall, memory trap or export failure keeps its own message.
     */
    function isEngineLoadFailure(err) {
        return !!(err && typeof err.message === 'string' && /(^|[\s(])LOAD_FAILED:/.test(err.message));
    }

    function pdfNeedsPasswordError() {
        const err = new Error(PASSWORD_UI_TEXT.pdfNeedsPassword);
        err.code = PASSWORD_ERROR_CODES.PASSWORD_UNSUPPORTED;
        err.passwordKind = 'pdf';
        err.pdfNeedsPassword = true;
        return err;
    }

    // ---- FG-021: passwords (plans/fg-021-bug-36-password-and-calc-notes.md §2, §6) ----
    //
    // Passwords never travel inside `options`: the driver sends them in CONVERT's own
    // `secrets` field, added only at postMessage, so they never reach ConversionState,
    // window events, privacy_stats, the queue summary or a log line. Every addition
    // here is optional and additive; CONTRACT_VERSION stays 3.

    /**
     * What this release's engine can do with passwords. EMPTY until the bridge
     * supports them (set_conversion_secrets): a caller that can meet an older
     * engine must check it before sending `secrets`, because an engine without
     * support refuses them (it never silently converts without them).
     * Values once supported: 'input-password', 'output-protection',
     * 'calc-cell-comments'.
     */
    const FEATURES = Object.freeze(['input-password', 'output-protection', 'calc-cell-comments']);

    /**
     * BUG-46 / BUG-47: this release's engine APPLIES a sheet selection (`options.sheetIndex`) and a
     * page-range print area (`options.printArea` / `options.pageRange`, e.g. "2" or "1-3") when the target
     * is PDF. Releases before the fix accepted both and silently exported the whole workbook; a caller that
     * must not return a wrong answer checks this before offering the options (the property is ABSENT on those
     * releases: `ConversionProtocol.CALC_PDF_SELECTION === true`). `sheetIndex` -1 still means every sheet, and
     * cell-range print areas ("A1:C10") worked before and are unchanged. Kept apart from FEATURES, which stays
     * the password capabilities list. Additive; CONTRACT_VERSION is unchanged.
     */
    const CALC_PDF_SELECTION = true;

    /** CONVERT_ERROR `code` values for password conversions (§2). Never retried. */
    const PASSWORD_ERROR_CODES = Object.freeze({
        PASSWORD_REQUIRED: 'PASSWORD_REQUIRED',
        PASSWORD_WRONG: 'PASSWORD_WRONG',
        PASSWORD_UNSUPPORTED: 'PASSWORD_UNSUPPORTED',
        // The file's own encryption settings are refused (#655); final, never a re-prompt.
        ENCRYPTION_REFUSED: 'ENCRYPTION_REFUSED',
        OUTPUT_PROTECTION_UNSUPPORTED: 'OUTPUT_PROTECTION_UNSUPPORTED',
        OUTPUT_PROTECTION_FAILED: 'OUTPUT_PROTECTION_FAILED',
    });

    /**
     * Targets whose output can be password-protected (§2). RTF/TXT/CSV/HTML have no
     * encryption. ODF (odt/ods/odp) is NOT protectable: this build has no NSS, so it
     * cannot write ODF's AES encryption, and Blowfish is not offered as output (it is
     * obsolete and weak).
     */
    const OUTPUT_PROTECTABLE = Object.freeze(['pdf', 'docx', 'xlsx', 'pptx']);

    /**
     * Substrings doc_saveAs cuts out of the WHOLE options string by indexOf before
     * it decides whether the rest is JSON (init.cxx:3754-3794), so a password
     * containing one would be corrupted, in every format, PDF included (§4.3).
     */
    const RESERVED_PASSWORD_TOKENS = Object.freeze([
        'PASSWORDEND', 'PASSWORDTOMODIFYEND', 'WATERMARKEND', 'FULLSHEETPREVEND', 'PDFVEREND',
        ',Watermark=', ',FullSheetPreview=', ',Password=', ',PasswordToModify=', ',PDFVer=',
    ]);

    /**
     * Output passwords (open, permission): the PDF 2.0 limit after SASLprep, for every
     * format (§2). The INPUT password may be longer, up to the bridge's 1024 bytes, so
     * real files with long passwords open (module, 2026-10-26; flagged for the WAF).
     */
    const MAX_PASSWORD_UTF8_BYTES = 127;
    const MAX_INPUT_PASSWORD_UTF8_BYTES = 1024;

    const PDF_PRINTING = Object.freeze(['none', 'low', 'high']);
    const PDF_CHANGES = Object.freeze(['none', 'any']);

    /** One password field's problem, or null. The message never contains the password. */
    function passwordProblem(pw, { input = false } = {}) {
        if (typeof pw !== 'string' || pw.length === 0) return 'must be a non-empty string';
        if (pw.indexOf('\u0000') >= 0) return 'must not contain NUL';
        const max = input ? MAX_INPUT_PASSWORD_UTF8_BYTES : MAX_PASSWORD_UTF8_BYTES;
        if (new TextEncoder().encode(pw).length > max) {
            return `must be at most ${max} UTF-8 bytes`;
        }
        // The input password never enters the saveAs options string, so the reserved
        // tokens (§4.3) bind the OUTPUT passwords only.
        if (!input && RESERVED_PASSWORD_TOKENS.some((t) => pw.indexOf(t) >= 0)) {
            return 'contains a reserved word (e.g. PASSWORDEND) the engine cannot accept';
        }
        return null;
    }

    /**
     * Check CONVERT's `secrets` field (§2). Absent or null is fine (no password).
     * Shape: { inputPassword?, outputProtection?: { openPassword, permissions?:
     * { permissionPassword, printing?, changes?, copying? } } }. Unknown keys are
     * refused, so a misspelt field is never silently dropped. Messages name the
     * field, never its value.
     *
     * @param {*} secrets
     * @param {string} targetFormat
     * @returns {{ok: true} | {ok: false, code: string, field: string, message: string}}
     */
    function validateConversionSecrets(secrets, targetFormat) {
        const bad = (field, why, code = 'INVALID_SETTINGS') => ({ ok: false, code, field, message: `${field} ${why}` });
        if (secrets === undefined || secrets === null) return { ok: true };
        const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
        const onlyKeys = (o, keys, where) => {
            const extra = Object.keys(o).filter((k) => !keys.includes(k));
            return extra.length ? bad(where, 'has unknown field(s): ' + extra.join(', ')) : null;
        };
        if (!isObj(secrets)) return bad('secrets', 'must be an object');
        let r = onlyKeys(secrets, ['inputPassword', 'outputProtection'], 'secrets');
        if (r) return r;
        if (secrets.inputPassword !== undefined) {
            const why = passwordProblem(secrets.inputPassword, { input: true });
            if (why) return bad('secrets.inputPassword', why);
        }
        const op = secrets.outputProtection;
        if (op !== undefined) {
            if (!isObj(op)) return bad('secrets.outputProtection', 'must be an object');
            r = onlyKeys(op, ['openPassword', 'permissions'], 'secrets.outputProtection');
            if (r) return r;
            const why = passwordProblem(op.openPassword);
            if (why) return bad('secrets.outputProtection.openPassword', why);
            const target = String(targetFormat || '').toLowerCase();
            if (!OUTPUT_PROTECTABLE.includes(target)) {
                return bad('secrets.outputProtection', `is not available for .${target} output (no encryption in that format)`,
                    PASSWORD_ERROR_CODES.OUTPUT_PROTECTION_UNSUPPORTED);
            }
            if (op.permissions !== undefined) {
                const pm = op.permissions;
                const f = 'secrets.outputProtection.permissions';
                if (!isObj(pm)) return bad(f, 'must be an object');
                r = onlyKeys(pm, ['permissionPassword', 'printing', 'changes', 'copying'], f);
                if (r) return r;
                if (target !== 'pdf') {
                    return bad(f, 'are available for PDF output only', PASSWORD_ERROR_CODES.OUTPUT_PROTECTION_UNSUPPORTED);
                }
                const pwhy = passwordProblem(pm.permissionPassword);
                if (pwhy) return bad(f + '.permissionPassword', pwhy);
                if (pm.permissionPassword === op.openPassword) return bad(f + '.permissionPassword', 'must differ from openPassword');
                if (pm.printing !== undefined && !PDF_PRINTING.includes(pm.printing)) return bad(f + '.printing', 'must be one of ' + PDF_PRINTING.join('|'));
                if (pm.changes !== undefined && !PDF_CHANGES.includes(pm.changes)) return bad(f + '.changes', 'must be one of ' + PDF_CHANGES.join('|'));
                if (pm.copying !== undefined && typeof pm.copying !== 'boolean') return bad(f + '.copying', 'must be a boolean');
            }
        }
        return { ok: true };
    }

    /** True when a (valid) `secrets` value carries any password. */
    function hasConversionSecrets(secrets) {
        return !!(secrets && (secrets.inputPassword !== undefined || secrets.outputProtection !== undefined));
    }

    /**
     * A copy of conversion options safe to log (§4.5, WAF 5). Passwords are not
     * supposed to be in `options` at all; this is defence in depth: any key named
     * like a password, or `secrets`, is replaced by "<set>" / "<not set>", at any
     * depth. The input is not modified.
     */
    function redactConversionOptions(options) {
        const SECRET_KEY = /password|passphrase|secret/i;
        const walk = (v, depth) => {
            if (v === null || typeof v !== 'object' || depth > 6) return v;
            if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
            if (ArrayBuffer.isView(v) || Object.prototype.toString.call(v) === '[object ArrayBuffer]') return v;
            const out = {};
            for (const k of Object.keys(v)) {
                out[k] = SECRET_KEY.test(k)
                    ? (v[k] === undefined || v[k] === null || v[k] === '' ? '<not set>' : '<set>')
                    : walk(v[k], depth + 1);
            }
            return out;
        };
        return walk(options, 0);
    }

    // The worker pins both settings before main(): the paper through a file
    // (conversion_worker.js writeDefaultPaperPin, read by the engine in
    // PaperInfo::getSystemDefaultPaper) and the format locale through `LANG`
    // (toPosixLocale). enginePaperForLocales above still records what the
    // engine would do unaided, which is why the paper pin is needed at all.

    // ------------------------------------------------------------------
    // B1 — the CDN answers an over-limit engine/font request with 429 (+
    // Retry-After, seconds), which means "stop asking": every retry is one more
    // request. 403 is deliberately NOT included: with S3 origin access control a
    // file missing from a release is also a 403, and telling the user "busy, come
    // back later" for a broken release would be a silent misdiagnosis. A 403 keeps
    // the ordinary failure path and its ordinary error. One definition, used by the
    // driver (main thread), the worker, the font resolver and the CSV fast path.
    //
    // OWNER RULE: the user-facing text must not describe the mechanism. It never
    // names rate limits, firewalls, blocking, request counts or addresses; it
    // says the download server is busy and when to come back.
    // ------------------------------------------------------------------

    const RATE_LIMITED = 'RATE_LIMITED';
    const RETRY_AFTER_DEFAULT_SEC = 300;
    const RETRY_AFTER_MIN_SEC = 30;
    const RETRY_AFTER_MAX_SEC = 3600;

    /** @returns {boolean} true for the status the CDN uses to say "stop asking" (429 only). */
    function isRateLimitStatus(status) {
        return status === 429;
    }

    function clampRetryAfter(sec) {
        if (typeof sec !== 'number' || !isFinite(sec)) return RETRY_AFTER_DEFAULT_SEC;
        return Math.min(RETRY_AFTER_MAX_SEC, Math.max(RETRY_AFTER_MIN_SEC, Math.ceil(sec)));
    }

    /**
     * Parse a Retry-After header value (RFC 9110 §10.2.3: delta-seconds or an
     * HTTP-date) into whole seconds from `nowMs`, clamped to [30, 3600].
     * Absent or unparseable -> 300.
     *
     * Only a string containing a letter is tried as a date: every HTTP-date form
     * names its month, and `Date.parse('120.5')` would otherwise read a bare
     * number as a year and produce a nonsense wait.
     * @param {string|null|undefined} headerValue
     * @param {number} [nowMs] defaults to Date.now()
     * @returns {number}
     */
    function parseRetryAfter(headerValue, nowMs) {
        if (headerValue == null) return RETRY_AFTER_DEFAULT_SEC;
        const v = String(headerValue).trim();
        if (!v) return RETRY_AFTER_DEFAULT_SEC;
        if (/^\d+$/.test(v)) return clampRetryAfter(parseInt(v, 10));
        if (!/[A-Za-z]/.test(v)) return RETRY_AFTER_DEFAULT_SEC;
        const when = Date.parse(v);
        if (!isFinite(when)) return RETRY_AFTER_DEFAULT_SEC;
        const now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
        return clampRetryAfter((when - now) / 1000);
    }

    /**
     * The one user-facing message. Minutes are rounded up, at least 1.
     * @param {number} retryAfterSec
     * @returns {string}
     */
    function rateLimitedMessage(retryAfterSec) {
        const minutes = Math.max(1, Math.ceil(clampRetryAfter(retryAfterSec) / 60));
        return 'The download server is busy right now. ' +
            `Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    }

    /**
     * @param {number} retryAfterSec
     * @returns {Error} with code 'RATE_LIMITED' and retryAfterSec (clamped)
     */
    function rateLimitedError(retryAfterSec) {
        const sec = clampRetryAfter(retryAfterSec);
        const err = new Error(rateLimitedMessage(sec));
        err.code = RATE_LIMITED;
        err.retryAfterSec = sec;
        return err;
    }

    // ------------------------------------------------------------------
    // BUG-63: the browser baseline. The engine is built with WebAssembly SIMD
    // (-msimd128) and native WebAssembly exceptions (-fwasm-exceptions, the legacy
    // try/catch encoding, Emscripten's default), so a browser without either cannot
    // even compile it: Chrome/Edge 95, Firefox 100, Safari/iOS 16.4 or later. The
    // driver checks this BEFORE any engine or font download, and a browser that fails
    // gets one short message instead of a 20 MB download that cannot run.
    // The CSV fast path is plain JavaScript and keeps working everywhere.
    //
    // The probes are the smallest modules that use each feature, as wasm-feature-detect
    // builds them: SIMD = a function returning a v128 (i8x16.splat), EH = a legacy
    // try/catch_all. Measured: with legacy exceptions switched off in V8, both this
    // probe AND the real documents module fail WebAssembly.validate; with them on,
    // both pass (tests/gates/test_browser_baseline.js).
    // ------------------------------------------------------------------
    const ENGINE_BROWSER_MINIMUM = 'Chrome 95, Firefox 100 or Safari 16.4 or later';
    const BROWSER_TOO_OLD_MESSAGE =
        `This browser is too old to run the converter. Please update it (${ENGINE_BROWSER_MINIMUM}).`;
    const WASM_SIMD_PROBE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];
    const WASM_EXCEPTIONS_PROBE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0,
        10, 8, 1, 6, 0, 6, 64, 25, 11, 11];

    /**
     * Can this browser run the engine? Pure: pass a WebAssembly-like object to test it.
     * @param {{validate: function(Uint8Array): boolean}} [wasm] - default: the global WebAssembly
     * @returns {{ok: boolean, missing: string[]}} missing: 'webassembly' | 'simd' | 'exceptions'
     */
    function engineBrowserSupport(wasm) {
        const W = wasm !== undefined ? wasm : (typeof WebAssembly !== 'undefined' ? WebAssembly : null);
        if (!W || typeof W.validate !== 'function') return { ok: false, missing: ['webassembly'] };
        const missing = [];
        const valid = (bytes) => { try { return W.validate(new Uint8Array(bytes)) === true; } catch (e) { return false; } };
        if (!valid(WASM_SIMD_PROBE)) missing.push('simd');
        if (!valid(WASM_EXCEPTIONS_PROBE)) missing.push('exceptions');
        return { ok: missing.length === 0, missing };
    }

    /** The error a too-old browser gets: never retried, never followed by a download. */
    function browserTooOldError(missing) {
        const e = new Error(BROWSER_TOO_OLD_MESSAGE);
        e.code = 'BROWSER_TOO_OLD';
        e.isBrowserTooOld = true;
        e.retryable = false;
        e.missing = Array.isArray(missing) ? missing.slice() : [];
        return e;
    }

    /** @returns {boolean} true if `err` is (or was rebuilt as) a rate-limited failure. */
    function isRateLimitedError(err) {
        return !!(err && err.code === RATE_LIMITED);
    }

    /**
     * The check every engine/font fetch makes on its Response.
     * @param {{status:number, headers?:{get:function}}} response
     * @param {number} [nowMs]
     * @returns {Error|null} a rateLimitedError, or null if the status is not 429
     */
    function rateLimitErrorFromResponse(response, nowMs) {
        if (!response || !isRateLimitStatus(response.status)) return null;
        let header = null;
        try {
            if (response.headers && typeof response.headers.get === 'function') {
                header = response.headers.get('Retry-After');
            }
        } catch (e) { header = null; }
        return rateLimitedError(parseRetryAfter(header, nowMs));
    }

    // ------------------------------------------------------------------
    // FEAT-16 phase 2: the website's engine gate (WAF design "The website key";
    // brief, engine-gate section). The engine BINARIES on the website copy are
    // served only to requests carrying today's (or yesterday's) website key in a
    // header. The key is the same for every visitor (a per-visitor key would be a
    // tracking identifier), derived daily by a stateless Worker on this origin and
    // fetched from ENGINE_KEY_URL. A 403 on a binary means the key was refused:
    // fetch the key again ONCE (a tab open across midnight), then stop with the
    // brief's message.
    //
    // Only the binaries: soffice.js comes through importScripts(), which cannot
    // send a header, so it stays public (glue code); fonts, modules.json and the
    // pages stay public by the design.
    //
    // D21: the worker and these helpers never REQUIRE a key. The MCP's host serves
    // the release tree from disk, where there is no /engine-key; the INIT field
    // `engineKey` is optional and ignored when absent.
    //
    // The names are kept here, in one place: the design's "friction ladder" changes
    // the endpoint and header names from time to time.
    // ------------------------------------------------------------------

    const ENGINE_KEY_URL = '/engine-key';
    const ENGINE_KEY_HEADER = 'X-Engine-Key';
    const ENGINE_BLOCKED = 'ENGINE_BLOCKED';
    const ENGINE_BLOCKED_MESSAGE = "The converter couldn't download its engine: your network or a browser " +
        'extension blocked the request. Try another network, or allow this site in the extension, ' +
        'then reload the page.';

    /**
     * Is this URL one of the gated engine binaries (modules/<name>/<file>.wasm|.data|.bspatch)
     * on `origin`? Another origin never gets the key.
     * @param {string|URL} url
     * @param {string} base   the page's (or worker's) location, to resolve a relative URL
     * @returns {boolean}
     */
    function isEngineFileUrl(url, base) {
        let u;
        try { u = new URL(String(url), base); } catch (e) { return false; }
        let b;
        try { b = new URL(base); } catch (e) { return false; }
        if (u.origin !== b.origin) return false;
        return /\/modules\/[^/]+\/[^/]+\.(wasm|data|bspatch)$/.test(u.pathname);
    }

    /**
     * The key from the /engine-key response body: JSON {"key": "<22+ base64url>", "day": "YYYY-MM-DD"}
     * (the design's base64url HMAC, truncated, plus the day). The key alone travels in the header.
     * @param {string} text
     * @returns {string|null} the key, or null when the body is not a usable key
     */
    function parseEngineKey(text) {
        let k = null;
        try {
            const j = JSON.parse(String(text));
            if (j && typeof j.key === 'string') k = j.key;
        } catch (e) { return null; }
        return isEngineKey(k) ? k : null;
    }

    /** A usable key: base64url, header-safe, of a sane length. */
    function isEngineKey(k) {
        return typeof k === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(k);
    }

    /** @returns {Error} with code 'ENGINE_BLOCKED' and the brief's message. */
    function engineBlockedError() {
        const err = new Error(ENGINE_BLOCKED_MESSAGE);
        err.code = ENGINE_BLOCKED;
        return err;
    }

    /** @returns {boolean} true if `err` is (or was rebuilt as) an engine-blocked failure. */
    function isEngineBlockedError(err) {
        return !!(err && err.code === ENGINE_BLOCKED);
    }

    return {
        RATE_LIMITED,
        RETRY_AFTER_DEFAULT_SEC,
        isRateLimitStatus,
        parseRetryAfter,
        rateLimitedMessage,
        rateLimitedError,
        isRateLimitedError,
        rateLimitErrorFromResponse,
        // FEAT-16 phase 2: the website's engine gate (additive; the MCP never needs it, D21).
        ENGINE_KEY_URL,
        ENGINE_KEY_HEADER,
        ENGINE_BLOCKED,
        ENGINE_BLOCKED_MESSAGE,
        isEngineFileUrl,
        parseEngineKey,
        isEngineKey,
        engineBlockedError,
        isEngineBlockedError,
        // FG-021 §3.1: password-protected input, detected before any download.
        PASSWORD_PROTECTED,
        detectEncryption,
        detectEncryptionOfBlob,
        encryptionBlocks,
        passwordProtectedError,
        passwordRequiredError,
        passwordProblem,
        pdfNeedsPasswordError,
        isEngineLoadFailure,
        PASSWORD_PROMPT_KINDS,
        PASSWORD_UI_TEXT,
        // FG-021 (§2, §6): passwords travel in CONVERT's `secrets`, never in `options`.
        FEATURES,
        CALC_PDF_SELECTION,
        PASSWORD_ERROR_CODES,
        OUTPUT_PROTECTABLE,
        RESERVED_PASSWORD_TOKENS,
        MAX_PASSWORD_UTF8_BYTES,
        MAX_INPUT_PASSWORD_UTF8_BYTES,
        validateConversionSecrets,
        hasConversionSecrets,
        verifyOutputProtection,
        bridgeErrorCode,
        pdfUserPasswordOpens,
        redactConversionOptions,
        MSG,
        LETTER_COUNTRIES,
        PAPER_SIZES,
        FALLBACK_PAPER,
        regionOfLocale,
        enginePaperForLocales,
        CONTRACT_VERSION,
        WEBSITE_ACCEPTS_EMBEDDED_EOT,
        WEBSITE_ALLOWS_DOCUMENT_PASSWORDS,
        FORMAT_LOCALES,
        FORMAT_LOCALE_SCRIPTS,
        FALLBACK_FORMAT_LOCALE,
        parseLocaleInput,
        toPosixLocale,
        resolveConversionSettings,
        SETTINGS_STORAGE_KEY,
        parseStoredSettings,
        TIME_LIMIT_DEFAULT_MINUTES,
        TIME_LIMIT_MIN_MINUTES,
        TIME_LIMIT_MAX_MINUTES,
        TIME_LIMIT_TEXT,
        formatMinutes,
        minutesText,
        timeLimitReachedMessage,
        parseTimeLimitMinutes,
        timeLimitReachedError,
        resolveBrowserConversionSettings,
        // FG-186: characters a list numbering format generates.
        LIST_LABEL_CHARS,
        listLabelCharsForNumFmts,
        listLabelCharsForOdfNumFormats,
        listLabelCharsForRtf,
        // FM-3 / FG-055: font substitution pairs, shared with the MCP host.
        buildFontSubstitutions,
        // FG-054: post-load check of the document's embedded fonts.
        embeddedFontMismatch,
        // Conversion time (docs/design/conversion-time.md, CONTRACT_VERSION 3)
        CONVERSION_TIME_DEFAULT,
        parseConversionTime,
        localInstantOfWall,
        localOffsetMinutesAt,
        formatConversionTime,
        conversionClockOf,
        resolveConversionTimeSetting,
        documentTimeOf,
        sanitizeExtension,
        sanitizeBaseName,
        shouldResetStallTimer,
        engineProgressKey,
        createDeadlineExtension,
        ENGINE_PHASE_ORDER,
        inputMayCarryDocumentFonts,
        INPUTS_WITHOUT_DOCUMENT_FONTS,
        isWasmMemoryTrap,
        WASM_TRAP_SIGNATURES,
        resolveStagedTargetFormat,
        isNonDefaultPdfOptions,
        isNonDefaultSheetOptions,
        isNonDefaultCsvOptions,
        csvOptionsToBridgeArgs,
        normalizeTargetFormat,
        ENGINE_MAX_ROWS,
        ENGINE_MAX_COLS,
        delimitedExtent,
        engineCsvDelimiter,
        detectCsvDelimiterCode,
        resolveCsvDelimiterOptions,
        scanBytesOf,
        engineTableLimitError,
        inputSanityError,
        userMessageFor,
        ENCRYPTED_PDF_HINT,
        CONVERSION_FAILED_TEXT,
        readBridgeError,
        canonicalEncoding,
        isValidPageRange,
        isValidPrintArea,
        sanitizeHtmlLinks,
        fontCoversAllCJK,
        cjkCoverageOf,
        cjkCoveragePoints,
        CJK_COVERAGE,
        CJK_COVERAGE_RANGES,
        ESSENTIAL_FONT_FAMILIES,
        SCRIPTS,
        detectScripts,
        scriptCodePoints,
        scriptFontFiles,
        THEME_SCRIPT_TAGS,
        themeScriptFallbackUnused,
        unsupportedScriptLabels,
        decodeTextSample,
        sniffUtf16WithoutBom,
        sniffGb18030,
        sniffLegacyCharset,
        decodeLegacyOrNull,
        LEGACY_SNIFF_PREFIX_BYTES,
        LEGACY_CHARSET_NAMES,
        LEGACY_TEXT_FORMATS,
        LEGACY_DELIMITED_FORMATS,
        countHtmlFormValues,
        readSfntFsType,
        engineWillAcceptEmbedded,
        parseHtmlFontFaces,
        decodeWoff1,
        sfntFacts,
        prepareHtmlDataFonts,
        flattenHtmlFormControls,
        sniffBOM,
        isValidUtf8,
        transcodeLegacyTextInput,
        pinBrowserConversionSettings,
        ENGINE_BROWSER_MINIMUM,
        BROWSER_TOO_OLD_MESSAGE,
        WASM_SIMD_PROBE,
        WASM_EXCEPTIONS_PROBE,
        engineBrowserSupport,
        browserTooOldError,
        detectCsvEncoding,
        composeConjoiningJamo
    };
})();

// Browser main thread + worker share `self`; node unit tests use require().
if (typeof self !== 'undefined') self.ConversionProtocol = ConversionProtocol;
if (typeof window !== 'undefined') window.ConversionProtocol = ConversionProtocol;
if (typeof module !== 'undefined' && module.exports) module.exports = ConversionProtocol;
