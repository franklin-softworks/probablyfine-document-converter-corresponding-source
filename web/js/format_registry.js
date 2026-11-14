// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
/**
 * format_registry.js
 * Single source of truth for format facts: categories, MIME types, LibreOffice
 * filter names, input/output capability, font requirements, and font-extraction
 * strategy. Every JS consumer (ConversionAPI, ConversionState, ConversionDriver,
 * FormatSelector, FontResolver, and the conversion worker) derives its
 * format/category/MIME/font tables from this module instead of maintaining its
 * own copy. This eliminates the drift documented in finding M6.
 *
 * Pure data + pure functions. No DOM, no state, no side effects.
 *
 * Routing (extension -> WASM module) stays in web/modules.json, which the build
 * pipeline generates per release; a unit test cross-checks it against this
 * registry so the two cannot drift.
 *
 * Dual environment: attaches to `self` (page + worker), `window` (page), and
 * `module.exports` (node unit tests).
 */

const FormatRegistry = (function() {
    'use strict';

    // ------------------------------------------------------------------
    // Single source of truth.
    //   input:  accepted as an input file (routable/convertible).
    //   output: offered as a target format.
    //   fontsForOutput: false only for plain-text-style outputs that embed no
    //                   fonts (txt, csv, tsv, html). Everything else needs fonts.
    //   fontExtraction: 'zip'  (font names live inside the archive) |
    //                   'text' (font names are readable in the plain-text
    //                           source: HTML font-family / <font face>, RTF
    //                           \fonttbl) |
    //                   'binary' (OLE2/PDF, no font metadata) | 'none'.
    //                   'zip' and 'text' both yield font NAMES and so both feed
    //                   the matcher; they are kept distinct because only 'zip'
    //                   can be sampled for SCRIPT detection by unzipping, and
    //                   conflating them broke that sniff for html/rtf.
    //   csvLike: delimiter-based text tables (csv, tsv).
    //   aliases: alternate extensions that normalize to this format.
    // ------------------------------------------------------------------
    const FORMATS = {
        // --- Documents (blue) ---
        docx: { label: 'DOCX', category: 'documents', input: true, output: true,
                filterName: 'MS Word 2007 XML',
                mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                fontsForOutput: true, fontExtraction: 'zip' },
        doc:  { label: 'DOC', category: 'documents', input: true, output: false,
                mime: 'application/msword',
                fontsForOutput: true, fontExtraction: 'binary' },
        odt:  { label: 'ODT', category: 'documents', input: true, output: true,
                filterName: 'writer8',
                mime: 'application/vnd.oasis.opendocument.text',
                fontsForOutput: true, fontExtraction: 'zip' },
        rtf:  { label: 'RTF', category: 'documents', input: true, output: true,
                filterName: 'Rich Text Format',
                mime: 'application/rtf',
                fontsForOutput: true, fontExtraction: 'text' },
        txt:  { label: 'TXT', category: 'documents', input: true, output: true,
                filterName: 'Text',
                mime: 'text/plain',
                fontsForOutput: false, fontExtraction: 'none' },
        html: { label: 'HTML', category: 'documents', input: true, output: true,
                aliases: ['htm'],
                filterName: 'HTML (StarWriter)',
                mime: 'text/html',
                fontsForOutput: false, fontExtraction: 'text' },
        docm: { label: 'DOCM', category: 'documents', input: true, output: false,
                mime: 'application/vnd.ms-word.document.macroEnabled.12',
                fontsForOutput: true, fontExtraction: 'zip' },
        dotx: { label: 'DOTX', category: 'documents', input: true, output: false,
                mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
                fontsForOutput: true, fontExtraction: 'zip' },

        // --- Spreadsheets (green) ---
        xlsx: { label: 'XLSX', category: 'spreadsheets', input: true, output: true,
                filterName: 'Calc MS Excel 2007 XML',
                mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                fontsForOutput: true, fontExtraction: 'zip' },
        xls:  { label: 'XLS', category: 'spreadsheets', input: true, output: false,
                mime: 'application/vnd.ms-excel',
                fontsForOutput: true, fontExtraction: 'binary' },
        ods:  { label: 'ODS', category: 'spreadsheets', input: true, output: true,
                filterName: 'calc8',
                mime: 'application/vnd.oasis.opendocument.spreadsheet',
                fontsForOutput: true, fontExtraction: 'zip' },
        csv:  { label: 'CSV', category: 'spreadsheets', input: true, output: true,
                filterName: 'Text - txt - csv (StarCalc)',
                mime: 'text/csv',
                fontsForOutput: false, fontExtraction: 'none', csvLike: true },
        tsv:  { label: 'TSV', category: 'spreadsheets', input: true, output: false,
                mime: 'text/tab-separated-values',
                fontsForOutput: false, fontExtraction: 'none', csvLike: true },
        xlsm: { label: 'XLSM', category: 'spreadsheets', input: true, output: false,
                mime: 'application/vnd.ms-excel.sheet.macroEnabled.12',
                fontsForOutput: true, fontExtraction: 'zip' },
        xltx: { label: 'XLTX', category: 'spreadsheets', input: true, output: false,
                mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
                fontsForOutput: true, fontExtraction: 'zip' },

        // FF-6 step C: MS Works DOS/Windows spreadsheet and database files (libwps, in the spreadsheets module's Calc filters). Input only. Routed by
        // extension AND content (ConversionProtocol.inputSanityError checks the file's own magic); the release flag legacyWorksSheets is the kill switch.
        wks:  { label: 'WKS', category: 'spreadsheets', input: true, output: false,
                mime: 'application/vnd.ms-works',
                fontsForOutput: false, fontExtraction: 'none' },
        wdb:  { label: 'WDB', category: 'spreadsheets', input: true, output: false,
                mime: 'application/vnd.ms-works',
                fontsForOutput: false, fontExtraction: 'none' },

        // FF-6 option C: classic word-processor files (WordPerfect, MacWrite, ClarisWorks/AppleWorks, MS Works, WriteNow). Input only, routed to the
        // documents module, where the worker's legacy step (engine/legacy/) turns them into flat ODT first. Never judged by name alone: the bridge says
        // what a file is (ConversionProtocol.isLegacyInput, LEGACY_EXTENSIONS). The release flag legacyFormats is the kill switch.
        wpd:  { label: 'WPD', category: 'documents', input: true, output: false,
                mime: 'application/vnd.wordperfect',
                fontsForOutput: false, fontExtraction: 'none' },
        wp:   { label: 'WP', category: 'documents', input: true, output: false,
                mime: 'application/vnd.wordperfect',
                fontsForOutput: false, fontExtraction: 'none' },
        wp5:  { label: 'WP5', category: 'documents', input: true, output: false,
                mime: 'application/vnd.wordperfect',
                fontsForOutput: false, fontExtraction: 'none' },
        wp6:  { label: 'WP6', category: 'documents', input: true, output: false,
                mime: 'application/vnd.wordperfect',
                fontsForOutput: false, fontExtraction: 'none' },
        mcw:  { label: 'MCW', category: 'documents', input: true, output: false,
                mime: 'application/x-macwrite',
                fontsForOutput: false, fontExtraction: 'none' },
        mw:   { label: 'MW', category: 'documents', input: true, output: false,
                mime: 'application/x-macwrite',
                fontsForOutput: false, fontExtraction: 'none' },
        cwk:  { label: 'CWK', category: 'documents', input: true, output: false,
                mime: 'application/x-clarisworks',
                fontsForOutput: false, fontExtraction: 'none' },
        wps:  { label: 'WPS', category: 'documents', input: true, output: false,
                mime: 'application/vnd.ms-works',
                fontsForOutput: false, fontExtraction: 'none' },
        wn:   { label: 'WN', category: 'documents', input: true, output: false,
                mime: 'application/x-writenow',
                fontsForOutput: false, fontExtraction: 'none' },

        // --- Presentations (yellow) ---
        pptx: { label: 'PPTX', category: 'presentations', input: true, output: true,
                filterName: 'Impress MS PowerPoint 2007 XML',
                mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                fontsForOutput: true, fontExtraction: 'zip' },
        ppt:  { label: 'PPT', category: 'presentations', input: true, output: false,
                mime: 'application/vnd.ms-powerpoint',
                fontsForOutput: true, fontExtraction: 'binary' },
        odp:  { label: 'ODP', category: 'presentations', input: true, output: true,
                filterName: 'impress8',
                mime: 'application/vnd.oasis.opendocument.presentation',
                fontsForOutput: true, fontExtraction: 'zip' },

        // --- PDF (gray) ---
        pdf:  { label: 'PDF', category: 'pdf', input: true, output: true,
                filterName: 'writer_pdf_Export',
                mime: 'application/pdf',
                fontsForOutput: true, fontExtraction: 'binary' }
    };

    // Compatibility matrix: which output formats are valid for each input
    // category. Identical to the matrix previously duplicated in
    // conversion_api.js and format_selector.js.
    const COMPATIBILITY = {
        documents:     ['docx', 'odt', 'rtf', 'txt', 'html', 'pdf'],
        spreadsheets:  ['xlsx', 'ods', 'csv', 'pdf'],
        presentations: ['pptx', 'odp', 'pdf'],
        pdf:           ['docx', 'odt', 'rtf', 'txt', 'pptx', 'odp', 'pdf']
    };

    // ------------------------------------------------------------------
    // Derived-once views
    // ------------------------------------------------------------------

    // alias -> canonical extension, e.g. { htm: 'html' }
    const ALIASES = (function() {
        const map = {};
        for (const [ext, def] of Object.entries(FORMATS)) {
            if (def.aliases) {
                for (const alias of def.aliases) map[alias] = ext;
            }
        }
        return map;
    })();

    function normalizeExtension(ext) {
        const lc = (ext || '').toLowerCase();
        return ALIASES[lc] || lc;
    }

    function getFormat(ext) {
        return FORMATS[normalizeExtension(ext)] || null;
    }

    // CATEGORY_INPUTS: category -> [input extensions incl. aliases]
    const CATEGORY_INPUTS = (function() {
        const inputs = { documents: [], spreadsheets: [], presentations: [], pdf: [] };
        for (const [ext, def] of Object.entries(FORMATS)) {
            if (def.input && inputs[def.category]) {
                inputs[def.category].push(ext);
                if (def.aliases) {
                    for (const alias of def.aliases) inputs[def.category].push(alias);
                }
            }
        }
        return inputs;
    })();

    // FORMAT_CONFIG: output-only formats, shape { label, category, filterName, extension }
    const FORMAT_CONFIG = (function() {
        const cfg = {};
        for (const [ext, def] of Object.entries(FORMATS)) {
            if (def.output) {
                cfg[ext] = {
                    label: def.label,
                    category: def.category,
                    filterName: def.filterName,
                    extension: ext
                };
            }
        }
        return cfg;
    })();

    /**
     * Input category for an extension, or null if not an accepted input.
     */
    function getInputCategory(ext) {
        const def = getFormat(ext);
        return (def && def.input) ? def.category : null;
    }

    /**
     * FF-3: group a list of dropped files by input conversion category, for grouped
     * Advanced mode. Pure — each item only needs a `.name`. Returns groups in a stable
     * order (documents, spreadsheets, presentations, pdf) plus an `unsupported` list for
     * inputs with no accepted category. Files whose extension resolves to the same
     * category are grouped together regardless of exact format (e.g. .csv + .xlsx →
     * spreadsheets), matching the "one options panel per type" model.
     * @param {Array<{name:string}>} files
     * @returns {{ groups: Array<{category:string, files:Array}>, unsupported:Array }}
     */
    function groupInputsByCategory(files) {
        const ORDER = ['documents', 'spreadsheets', 'presentations', 'pdf'];
        const byCat = new Map();
        const unsupported = [];
        for (const f of (files || [])) {
            const ext = (f && f.name ? f.name.split('.').pop() : '').toLowerCase();
            const category = getInputCategory(ext);
            if (!category) { unsupported.push(f); continue; }
            if (!byCat.has(category)) byCat.set(category, []);
            byCat.get(category).push(f);
        }
        const groups = ORDER.filter(c => byCat.has(c)).map(category => ({ category, files: byCat.get(category) }));
        return { groups, unsupported };
    }

    /**
     * Compatible output formats for an input extension (same-format excluded,
     * except PDF->PDF which re-renders through LibreOffice).
     */
    function getCompatibleFormats(ext) {
        const category = getInputCategory(ext);
        if (!category) return [];
        const norm = normalizeExtension(ext);
        return COMPATIBILITY[category].filter(f => f !== norm || category === 'pdf');
    }

    function isCompatible(inputExt, outputFormat) {
        return getCompatibleFormats(inputExt).includes(normalizeExtension(outputFormat));
    }

    /**
     * MIME type for a format; safe fallback for unknown formats.
     */
    function getMimeType(format) {
        const def = getFormat(format);
        return (def && def.mime) || 'application/octet-stream';
    }

    /**
     * Does producing this output format require font loading?
     * Unknown formats default to true (assume fonts needed) so a missing entry
     * can only cause extra font loading, never missing-glyph "tofu".
     */
    function requiresFontsForOutput(format) {
        const def = getFormat(format);
        if (!def) return true;
        return def.fontsForOutput !== false;
    }

    /**
     * Font extraction strategy for an input extension: 'zip' | 'binary' | 'none'.
     */
    function getFontExtraction(ext) {
        const def = getFormat(ext);
        return (def && def.fontExtraction) || 'none';
    }

    function isCsvLike(ext) {
        const def = getFormat(ext);
        return !!(def && def.csvLike);
    }

    /**
     * All accepted input extensions (canonical + aliases).
     */
    function getInputExtensions() {
        const exts = [];
        for (const [ext, def] of Object.entries(FORMATS)) {
            if (def.input) {
                exts.push(ext);
                if (def.aliases) exts.push(...def.aliases);
            }
        }
        return exts;
    }

    /**
     * Extensions whose fonts are extracted from a ZIP archive (docx/odt/...).
     */
    function getExtractableFormats() {
        return Object.keys(FORMATS).filter(ext => FORMATS[ext].fontExtraction === 'zip');
    }

    /**
     * Formats we can read font NAMES from: the archives above plus the
     * plain-text ones. Deliberately a SECOND accessor rather than a widening of
     * getExtractableFormats(), because that list also selects which formats get
     * sampled for script detection by unzipping — html/rtf would fail that and
     * silently lose their script sniff.
     */
    function getFontNameFormats() {
        return Object.keys(FORMATS).filter(
            ext => FORMATS[ext].fontExtraction === 'zip'
                || FORMATS[ext].fontExtraction === 'text');
    }

    /**
     * Binary (OLE2) formats with no font metadata (doc/xls/ppt). PDF is handled
     * as its own special case by FontResolver and is deliberately excluded here.
     */
    function getBinaryFormats() {
        return Object.keys(FORMATS).filter(ext =>
            FORMATS[ext].fontExtraction === 'binary' && FORMATS[ext].category !== 'pdf');
    }

    return {
        // Raw data
        FORMATS,
        COMPATIBILITY,
        ALIASES,
        // Derived views (shapes match the tables consumers previously owned)
        FORMAT_CONFIG,
        CATEGORY_INPUTS,
        // Functions
        normalizeExtension,
        getFormat,
        getInputCategory,
        groupInputsByCategory,
        getCompatibleFormats,
        isCompatible,
        getMimeType,
        requiresFontsForOutput,
        getFontExtraction,
        isCsvLike,
        getInputExtensions,
        getExtractableFormats,
        getFontNameFormats,
        getBinaryFormats
    };
})();

// Dual environment: page main thread, worker, and node.
// In browsers window === self, so the first branch covers page and worker;
// the window assignment is kept explicit for the node mock-window used by tests.
if (typeof self !== 'undefined') self.FormatRegistry = FormatRegistry;
if (typeof window !== 'undefined') window.FormatRegistry = FormatRegistry;
if (typeof module !== 'undefined' && module.exports) module.exports = FormatRegistry;
