// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
'use strict';
// Pre-conversion analysis, run INSIDE the engine child (it parses untrusted
// document bytes, so it must be killable). Replicates the website driver's steps
// (conversion_driver.js analyzeFile / _convertFileInner) using the website's own
// verified helper files from the release tree, in the same order:
//
//   route the module (PDF → pdf_analyzer) → size notice → embedded-object check
//   → font resolution → legacy-text transcoding
//
// Every notice the website shows the user becomes a warning here; nothing that
// the website tells its user is dropped. The helpers are loaded with require()
// (module scope) and removed from the global object again by `unload()`, so the
// served worker later sees the same global scope it gets on the website, where
// page and worker are separate.

const path = require('path');
const { isUtf8 } = require('buffer');
const { requestedNames, matchUserFonts, applyUserFonts } = require('./user-fonts');

// conversion_driver.js CONVERSION_CONFIG (desktop thresholds; there is no mobile here).
const SIZE = {
    warning: 10 * 1024 * 1024,
    danger: 25 * 1024 * 1024,
    xlsxWarning: 5 * 1024 * 1024,
    xlsxDanger: 15 * 1024 * 1024,
};
const UNKNOWN_PDF_WARNING =
    "Couldn't detect whether this PDF is a document or slides — converting as a " +
    'document. Choose PPTX/ODP in Advanced Options if it\'s a presentation.';
// The website's text points at its own UI; the MCP names its own parameter.
const UNKNOWN_PDF_WARNING_MCP =
    "Couldn't detect whether this PDF is a document or slides — converted as a document. " +
    "Set pdf_input_kind to 'presentation' if it is slides.";
const GLOBALS = ['FormatRegistry', 'ConversionProtocol', 'JSZip', 'BinaryFontSniff', 'FontMatcher', 'FontExtractor',
    'FontResolver', 'PDFAnalyzer', 'EmbeddedObjectCheck'];

function formatBytes(bytes) {   // conversion_driver.js formatBytes
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** conversion_driver.js buildFontSubstitutions (not exported there). */
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
        }
    }
    return pairs.length ? pairs : null;
}

/** Load the website's helpers from a verified release tree. */
function loadHelpers(tree) {
    const g = globalThis;
    g.self = g;
    if (!path.isAbsolute(String(tree))) throw new Error('the release tree must be an absolute path');   // never the current folder (BUG-75)
    const js = (f) => path.join(tree, 'js', f);
    const h = {};
    h.FormatRegistry = g.FormatRegistry = require(js('format_registry.js'));
    h.ConversionProtocol = g.ConversionProtocol = require(js('conversion_protocol.js'));
    h.JSZip = g.JSZip = require(js('vendor/jszip.min.js'));
    g.BinaryFontSniff = require(js('binary_font_sniff.js'));
    g.FontMatcher = require(js('font_matcher.js'));
    g.FontExtractor = require(js('font_extractor.js'));
    h.FontResolver = require(js('font_resolver.js'));
    h.PDFAnalyzer = require(js('pdf_analyzer.js'));
    h.EmbeddedObjectCheck = require(js('embedded_object_check.js'));
    h.unload = () => { for (const k of GLOBALS) delete g[k]; };
    return h;
}

// FG-021 §3.1 copy, as the converter words it (conversion_protocol.js passwordProtectedError), with the
// website's "drop that copy here" said for a conversion tool. Until the MCP takes passwords, both cases are
// PASSWORD_UNSUPPORTED (owner, 2026-10-31): no tool parameter can help yet, so the caller is not asked for one.
const PASSWORD_PROTECTED_MESSAGE = "This file is password-protected. The converter can't open password-protected files yet. "
    + 'Open it in the app that made it, save a copy without a password, and convert that copy.';
const PASSWORD_UNSUPPORTED_MESSAGE = "This kind of password-protected file can't be opened here. Open it in the app "
    + 'that made it and save a copy without a password, then convert that copy.';
const PDF_MAYBE_ENCRYPTED_HINT = "This PDF is encrypted and may need a password, which the converter can't use yet: "
    + 'if it asks for one when you open it, save a copy without a password and convert that copy.';

/**
 * Whether the input is password-protected, by the release's own detection (bounded reads of untrusted
 * bytes, in this confined process). { refuse } for a file the engine cannot open; pdfMaybeEncrypted for
 * a PDF with an /Encrypt dictionary, which may be permissions-only and is converted. A release without
 * the detection, or a detection that fails, changes nothing (the engine then reports what it finds).
 */
async function detectEncryption(P, file) {
    if (typeof P.detectEncryptionOfBlob !== 'function' || typeof P.encryptionBlocks !== 'function'
        || typeof P.passwordProtectedError !== 'function') return { refuse: null, pdfMaybeEncrypted: false };
    let r;
    try {
        r = await P.detectEncryptionOfBlob(file);
    } catch {
        return { refuse: null, pdfMaybeEncrypted: false };   // documented never to reject; unknown, as for null
    }
    if (P.encryptionBlocks(r)) {
        const releaseCode = P.passwordProtectedError(r.kind).code;   // which of the converter's two cases
        return { refuse: { code: 'PASSWORD_UNSUPPORTED', kind: r.kind, releaseCode,
            message: releaseCode === 'PASSWORD_UNSUPPORTED' ? PASSWORD_UNSUPPORTED_MESSAGE : PASSWORD_PROTECTED_MESSAGE }, pdfMaybeEncrypted: false };
    }
    return { refuse: null, pdfMaybeEncrypted: !!(r && r.encrypted === true && r.kind === 'pdf-maybe-open') };
}

/**
 * @param {object} h          helpers from loadHelpers
 * @param {object} req
 * @param {Uint8Array} req.bytes
 * @param {string} req.fileName
 * @param {string} req.targetFormat
 * @param {object} req.formatMap      modules.json formatMap
 * @param {'auto'|'document'|'presentation'} [req.pdfInputKind]
 */
async function analyze(h, req) {
    const { FormatRegistry: R, ConversionProtocol: P } = h;
    const warnings = [];
    const warn = (code, level, message, extra) => warnings.push({ code, level, message, ...(extra || {}) });
    const name = req.fileName;
    const ext = name.toLowerCase().split('.').pop();
    const size = req.bytes.length;
    const file = new File([req.bytes], name);

    // 1. Module (driver getModuleForFormat).
    const norm = R.normalizeExtension(ext) || ext;
    let moduleName = req.formatMap[norm] || null;
    const pdf = {};
    // 1b. A WordPerfect file (0xFF 'W' 'P' 'C') goes to the documents module whatever its name (driver analyzeFile, FF-6 option C and BUG-95):
    //     the worker's legacy step turns it into a flat text document, which only that module reads. Under an unknown name (or none) it was
    //     UNSUPPORTED_FORMAT here; under a spreadsheet or slide name (.xls, .wks, .asp, .ppt) the other module failed LOAD_FAILED. Anything
    //     else with an unknown extension stays unsupported (no guessing). The website's kill switch is the release flag legacyFormats; the
    //     worker's legacy step is always on for a host, and so is this routing.
    const wordPerfect = moduleName !== 'documents' && typeof P.isLegacyInput === 'function'
        && Object.values(req.formatMap).includes('documents') && P.isLegacyInput('x', req.bytes);
    if (wordPerfect) moduleName = 'documents';
    if (!moduleName) {
        return { ok: false, error: { code: 'UNSUPPORTED_FORMAT', message: `Unsupported file format: .${ext}` } };
    }

    // 2. PDF routing (driver analyzeFile).
    if (ext === 'pdf' && !wordPerfect) {
        const kind = req.pdfInputKind || 'auto';
        try {
            const info = await h.PDFAnalyzer.analyze(file);
            Object.assign(pdf, { type: info.type, confidence: info.confidence, width: info.width, height: info.height,
                mixedOrientation: info.mixedOrientation === true });
            if (['pptx', 'ppt', 'odp'].includes(req.targetFormat)) {
                moduleName = 'pdf-pptx';
            } else if (req.targetFormat === 'pdf') {
                if (kind === 'presentation') moduleName = 'pdf-pptx';
                else if (kind === 'document') moduleName = 'pdf-docx';
                else if (info.type === 'presentation' && info.confidence >= 0.75) moduleName = 'pdf-pptx';
                else if (info.type === 'unknown') {
                    moduleName = 'pdf-docx';
                    warn('PDF_TYPE_UNKNOWN', 'info', UNKNOWN_PDF_WARNING_MCP);
                } else moduleName = 'pdf-docx';
                if (kind === 'auto' && pdf.mixedOrientation && !warnings.length) {
                    warn('PDF_MIXED_ORIENTATION', 'info', 'This PDF mixes portrait and landscape pages — converted as '
                        + `${moduleName === 'pdf-pptx' ? 'slides' : 'a document'} based on its first page. `
                        + "Set pdf_input_kind to choose differently if that is wrong.");
                }
            } else {
                moduleName = 'pdf-docx';
            }
        } catch (e) {
            moduleName = req.targetFormat === 'pdf' && kind === 'presentation' ? 'pdf-pptx'
                : ['pptx', 'ppt', 'odp'].includes(req.targetFormat) ? 'pdf-pptx' : 'pdf-docx';
            pdf.type = 'unknown';
            if (req.targetFormat === 'pdf' && kind === 'auto') warn('PDF_TYPE_UNKNOWN', 'info', UNKNOWN_PDF_WARNING_MCP);
        }
    }

    // 2b. Password-protected input (FG-021 §3.1; driver convertFile, after analyzeFile): a file the engine
    //     cannot open is refused before the engine starts. Only with a release that has the detection
    //     (converter main beed7f7b, the 11-01 release, and later); with an older one, as before.
    const encryption = await detectEncryption(P, file);
    if (encryption.refuse) return { ok: false, error: encryption.refuse };

    // 3. Size notice (driver analyzeFile; desktop thresholds).
    const sz = formatBytes(size);
    if (['xlsx', 'xls'].includes(ext) && size > SIZE.xlsxDanger) {
        warn('LARGE_FILE', 'warning', `This is a large spreadsheet (${sz}) — conversion may take a few minutes.`);
    } else if (['xlsx', 'xls'].includes(ext) && size > SIZE.xlsxWarning) {
        warn('LARGE_FILE', 'info', `This spreadsheet (${sz}) may take a bit longer to convert.`);
    } else if (size > SIZE.danger) {
        warn('LARGE_FILE', 'warning', `This is a large file (${sz}) — conversion may take a few minutes.`);
    } else if (size > SIZE.warning) {
        warn('LARGE_FILE', 'info', `This file (${sz}) may take a bit longer to convert.`);
    }

    // 4. Embedded objects with no preview image (driver _convertFileInner).
    try {
        const zip = await h.JSZip.loadAsync(req.bytes);
        const manifest = zip.file('META-INF/manifest.xml');
        if (manifest) {
            const contentFile = zip.file('content.xml');
            const objects = h.EmbeddedObjectCheck.inspectEmbeddedObjects(Object.keys(zip.files),
                await manifest.async('string'), contentFile ? await contentFile.async('string') : '');
            const unrenderable = h.EmbeddedObjectCheck.findUnrenderable(objects, moduleName);
            const n = unrenderable.length;
            if (n) {
                warn('EMBEDDED_OBJECT_DROPPED', 'warning',
                    `This file contains ${n} embedded drawing${n === 1 ? '' : 's'} `
                    + 'stored without a preview image, which this converter cannot draw. '
                    + `${n === 1 ? 'It has' : 'They have'} been left out — the rest of the `
                    + 'document converted normally. Re-saving the file in LibreOffice '
                    + 'usually adds the missing preview.',
                    { objects: unrenderable.map((o) => ({ path: o.path, mediaType: o.mediaType })) });
            }
        }
    } catch {
        // Not a ZIP (or not ODF): nothing to inspect, as on the website.
    }

    // 5. Fonts (driver _convertFileInner → FontResolver).
    let requiredFonts = null;
    let fontSubstitutions = null;
    let fontStrategy = 'all';
    let fontMatches = null;
    try {
        const res = await h.FontResolver.resolveFontsForDocument(file, req.targetFormat);
        fontStrategy = res.strategy;
        fontMatches = res.matches;
        fontSubstitutions = buildFontSubstitutions(res.matches);
        if (res.fontsUnavailable) warn('FONTS_UNAVAILABLE', 'warning', res.message);
        else if (res.fontWarning) warn('FONT_COVERAGE', 'warning', res.fontWarning);
        if (res.strategy === 'selective' && res.fontsToLoad) requiredFonts = res.fontsToLoad;
        else if (res.strategy === 'none') requiredFonts = [];
    } catch {
        requiredFonts = null;   // driver: fall back to the worker's own sniff + minimal set
    }

    // 5b. The user's own fonts (fontDirs): a family the document asks for and a configured folder has
    //     is used from there (src/engine/host/user-fonts.js). Only with a font plan to add to: without
    //     one the worker loads its own set, and the user is told their fonts were not used.
    if (Array.isArray(req.userFonts) && req.userFonts.length && fontStrategy !== 'none') {
        const requested = requestedNames(fontMatches);
        if (Array.isArray(requiredFonts)) {
            const u = applyUserFonts({ requiredFonts, fontSubstitutions, requested, faces: req.userFonts });
            if (u) {
                requiredFonts = u.requiredFonts;
                fontSubstitutions = u.fontSubstitutions;
                warnings.push(...u.warnings);
            }
        } else if (matchUserFonts(req.userFonts, requested).length) {
            warn('USER_FONTS_NOT_APPLIED', 'warning', 'This document asks for fonts that your font folders have, but the fonts it needs '
                + 'could not be worked out, so the converter used its own fonts for it.');
        }
    }

    // 6. Legacy single-byte text (driver _convertFileInner → transcodeLegacyTextInput).
    let bytes = req.bytes;
    const t = P.transcodeLegacyTextInput(req.bytes, ext);
    if (t && t.transcoded) bytes = t.bytes;
    if (t && t.message) warn('TEXT_ENCODING', 'info', t.message, { encoding: t.encoding, reason: t.reason });

    // 7. CSV/TSV: the engine is always told UTF-8 (CB-001: it ignores other encodings;
    //    CB-003: nothing checks the bytes), so prepare UTF-8 here and say what was done.
    if (req.csvSourceEncoding) {
        const prepared = prepareCsvBytes(bytes, req.csvSourceEncoding);
        bytes = prepared.bytes;
        for (const w of prepared.warnings) warnings.push(w);
    }

    return {
        ok: true,
        ext, size, moduleName, warnings, pdf,
        // Added to any failure of this conversion (driver convertFile): why an encrypted PDF may have failed.
        failureHint: encryption.pdfMaybeEncrypted ? PDF_MAYBE_ENCRYPTED_HINT : null,
        requiredFonts, fontSubstitutions, fontStrategy,
        bytes: bytes === req.bytes ? null : bytes,   // null = unchanged
    };
}

/**
 * Single-byte encoding → UTF-8. ISO-8859-1 maps every byte to the same code point
 * (Buffer 'latin1'); the WHATWG decoder is not used for it because it treats the
 * label "iso-8859-1" as Windows-1252.
 */
function transcodeToUtf8(bytes, encoding) {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let text;
    if (encoding === 'ISO-8859-1') text = b.toString('latin1');
    else if (encoding === 'Windows-1252') text = new TextDecoder('windows-1252').decode(b);
    else throw new Error('unsupported source encoding ' + encoding);
    return new Uint8Array(Buffer.from(text, 'utf8'));
}

/**
 * UTF-16 without a byte-order mark, decided by where the NUL bytes fall. CSV never
 * contains NUL, so unlike the website's sniffUtf16WithoutBom (conversion_protocol.js,
 * which returns null for anything that is valid UTF-8) this also runs on valid UTF-8:
 * ASCII-only UTF-16 is valid UTF-8 (F-04). Gates 2 and 3 are the website's: at least
 * 4 NULs in an even-length prefix of at most 4096 bytes, split at least 8:1 by parity.
 * @returns {'utf-16le'|'utf-16be'|null}
 */
function sniffCsvUtf16(b) {
    if (b.length < 16) return null;
    const limit = Math.min(b.length, 4096) & ~1;
    let even = 0, odd = 0;
    for (let i = 0; i < limit; i++) {
        if (b[i] === 0x00) { if (i % 2 === 0) even++; else odd++; }
    }
    if (even + odd < 4) return null;
    if (odd === 0 || even > odd * 8) return 'utf-16be';
    if (even === 0 || odd > even * 8) return 'utf-16le';
    return null;
}

/**
 * CSV/TSV bytes → UTF-8 for the engine (CB-001, CB-003; owner request 2026-10-03).
 *
 *   BOM (always wins; reported when it overrides an explicit choice)
 *   → explicit single-byte encoding → NUL bytes (UTF-16 without BOM, else reported)
 *   → valid UTF-8 kept → explicit UTF-8 reported → Windows-1252 fallback reported
 *
 * @param {Uint8Array} bytes
 * @param {'auto'|'UTF-8'|'ISO-8859-1'|'Windows-1252'} encoding  'auto' when the caller chose none
 * @returns {{ bytes: Uint8Array, warnings: object[] }}
 */
function prepareCsvBytes(bytes, encoding) {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = (x, warnings = []) => ({ bytes: x, warnings });
    const utf8 = (text) => new Uint8Array(Buffer.from(text, 'utf8'));
    if (b.length === 0) return out(bytes);

    // A byte-order mark is authoritative, whatever was chosen; the website says so
    // when it overrides the chosen encoding (csv_fast_path.js 'bom-overrode-encoding').
    const overrode = (bom) => (encoding === 'auto' || (bom === 'utf-8' && encoding === 'UTF-8')) ? [] : [{
        code: 'TEXT_ENCODING', level: 'warning', encoding: bom, reason: 'bom-overrode-encoding',
        message: `This CSV file starts with a ${bom.toUpperCase()} byte-order mark, so it was read as ${bom.toUpperCase()} and csv.encoding (${encoding}) was ignored.` }];
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
        const w = overrode('utf-8');
        if (!isUtf8(b.subarray(3))) {
            w.push({ code: 'CSV_INVALID_UTF8', level: 'warning',
                message: 'This CSV file starts with a UTF-8 byte-order mark but is not valid UTF-8, so the invalid bytes appear as "\uFFFD" in the output. '
                    + 'Re-save the file as UTF-8.' });
        }
        return out(bytes, w);
    }
    if (b[0] === 0xFF && b[1] === 0xFE) return out(utf8(new TextDecoder('utf-16le').decode(b.subarray(2))), overrode('utf-16le'));
    if (b[0] === 0xFE && b[1] === 0xFF) return out(utf8(new TextDecoder('utf-16be').decode(b.subarray(2))), overrode('utf-16be'));

    // A named single-byte encoding goes to the engine as it is (CB-001 fixed).
    if (encoding === 'ISO-8859-1' || encoding === 'Windows-1252') return out(bytes);

    if (encoding === 'auto' && b.indexOf(0) !== -1) {
        const guess = sniffCsvUtf16(b);
        if (guess) {
            let text = null;
            try { text = new TextDecoder(guess, { fatal: true }).decode(b); } catch { /* not UTF-16 after all */ }
            if (text !== null) {
                return out(utf8(text), [{ code: 'TEXT_ENCODING', level: 'warning', encoding: guess, reason: 'utf16-without-bom',
                    message: `This CSV file has no byte-order mark but its NUL bytes show it is ${guess.toUpperCase()}, so it was read as ${guess.toUpperCase()}. `
                        + 'If the result looks wrong, re-save the file as UTF-8.' }]);
            }
        }
        return out(bytes, [{ code: 'TEXT_ENCODING', level: 'warning', reason: 'nul-bytes',
            message: 'This CSV file contains NUL bytes, which text files do not; it may be UTF-16 saved without a byte-order mark, or not a text file. '
                + 'It was converted as-is rather than guessed at, so some characters may be wrong or missing. Re-saving it as UTF-8 will convert exactly.' }]);
    }

    if (isUtf8(b)) return out(bytes);

    if (encoding === 'UTF-8') {
        return out(bytes, [{ code: 'CSV_INVALID_UTF8', level: 'warning',
            message: 'This CSV file is not valid UTF-8, but csv.encoding was set to UTF-8, so the invalid bytes appear as "\uFFFD" in the output. '
                + 'Omit csv.encoding to let the converter detect a legacy encoding, or set the encoding the file was saved in.' }]);
    }
    // auto
    return out(transcodeToUtf8(bytes, 'Windows-1252'), [{ code: 'TEXT_ENCODING', level: 'warning', encoding: 'windows-1252', reason: 'legacy-fallback',
        message: 'This CSV file is not valid UTF-8, so it was read as Windows-1252 (Western European). Text in other encodings, '
            + 'such as Cyrillic, Greek or East Asian, may be wrong; set csv.encoding to the encoding the file was saved in, or re-save it as UTF-8.' }]);
}

/** Driver CONVERT_DONE handling for HTML links (sanitiser + its notice). */
function sanitizeHtml(h, outputBytes) {
    const result = h.ConversionProtocol.sanitizeHtmlLinks(new TextDecoder('utf-8').decode(outputBytes));
    const out = new TextEncoder().encode(result.html);
    const removed = result.removed || [];
    const total = removed.reduce((n, r) => n + r.count, 0);
    const breakdown = removed.map((r) => `${r.count} ${r.scheme}:`).join(', ');
    return {
        bytes: out,
        removed,
        message: total ? `Removed ${total} unsafe link${total === 1 ? '' : 's'} (${breakdown}) from the exported HTML for your safety.` : null,
    };
}

module.exports = { loadHelpers, analyze, sanitizeHtml, buildFontSubstitutions, transcodeToUtf8, prepareCsvBytes, UNKNOWN_PDF_WARNING,
    detectEncryption, PASSWORD_PROTECTED_MESSAGE, PASSWORD_UNSUPPORTED_MESSAGE, PDF_MAYBE_ENCRYPTED_HINT };
