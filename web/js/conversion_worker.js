// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2025-2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
/**
 * conversion_worker.js
 * Multi-Module Web Worker for handling LibreOffice Wasm logic off the main thread.
 *
 * VERSION: 2025-12-07-v1 (Dynamic module loading)
 *
 * Note: Pthreads have been removed from the WASM build. This worker runs as
 * a standard Web Worker (not a pthread worker). Emscripten provides stub
 * pthread implementations for SAL layer compatibility.
 */

const isPThread = false;

// Conversion time (docs/design/conversion-time.md §3). The engine's real-time
// clock IS `Date.now` (Emscripten's _emscripten_date_now), and each CONVERT
// replaces it with the conversion's clock for exactly as long as the engine
// works on the document. So the real clock is captured here, before anything can
// replace it, and every piece of the worker's OWN timing (VFS wait, durations,
// the fresh-WASM section name) reads realNow() — under a frozen pin, Date.now()
// would report zero elapsed time forever. nativeDateNow is kept to restore
// Date.now to the very function it was, not a wrapper around it.
const nativeDateNow = Date.now;
const realNow = nativeDateNow.bind(Date);

// NTH-09: every byte of entropy the engine gets comes through crypto.getRandomValues (the
// Emscripten /dev/urandom device). A generator seeded BEFORE the engine snapshot would be
// rewound by every write-back and replay its sequence, so the snapshot is refused if any
// entropy was drawn before it (startEngineForSnapshot). Wrapped here, before soffice.js loads.
let entropyReads = 0;
if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = (a) => { entropyReads++; return getRandomValues(a); };
}

// Parse module name from URL query parameters
const urlParams = new URLSearchParams(self.location.search);
let moduleName = urlParams.get('module') || 'default';
let moduleConfig = null;

console.log('[Worker] Script loaded. isPThread:', isPThread, 'moduleName:', moduleName);

// Load the shared format registry (single source of truth for format/font
// facts). The worker runs from modules/<name>/conversion_worker.js, so
// ../../js/ resolves to <appRoot>/js/ in both the demo server and the packaged
// layout. Non-fatal: format/font helpers below fall back to built-in defaults
// if it is unavailable, which can only cause extra (never missing) font loading.
if (!isPThread) {
    try {
        importScripts('../../js/format_registry.js');   // resolves relative to modules/<name>/
    } catch (e) {
        console.warn('[Worker] format_registry.js unavailable, using built-in defaults:', e);
    }
}

// Load the shared artifact-stem helper (derives the shipped filename stem,
// e.g. 'soffice', from a module's advertised path instead of hardcoding it —
// see web/js/artifact_stem.js). Non-fatal: deriveArtifactStem() below falls
// back to the literal 'soffice' if this is unavailable, which is exactly
// today's hardcoded behaviour, so a missing script degrades rather than breaks
// a conversion.
if (!isPThread) {
    try {
        importScripts('../../js/artifact_stem.js');   // resolves relative to modules/<name>/
    } catch (e) {
        console.warn('[Worker] artifact_stem.js unavailable, defaulting stem to "soffice":', e);
    }
}

/**
 * Safe wrapper around ArtifactStem.deriveStem() for use anywhere in this
 * file — works whether or not the import above succeeded.
 * @param {*} path
 * @returns {string}
 */
function deriveArtifactStem(path) {
    return (typeof ArtifactStem !== 'undefined') ? ArtifactStem.deriveStem(path) : 'soffice';
}

// Load the shared driver<->worker message protocol. Unlike the registry this is
// FATAL if missing: without the message-type constants the worker cannot speak
// the driver's protocol. Post a loud ERROR (which rejects the driver's ready
// promise) and rethrow — never a silent fallback.
// PROTOCOL_BOOTSTRAP_START
try {
    importScripts('../../js/conversion_protocol.js');   // resolves relative to modules/<name>/
} catch (e) {
    // B1: refused (429, from Resource Timing where the browser has it)? Say so with
    // the code the driver maps to the busy message and does not retry. The literal
    // is ConversionProtocol.RATE_LIMITED, which is exactly what did not load.
    const refused = importedScriptStatus('../../js/conversion_protocol.js') === 429;
    postMessage(Object.assign({ type: 'ERROR', error: 'Failed to load conversion_protocol.js: ' + ((e && e.message) || e) },
                              refused ? { code: 'RATE_LIMITED', fatal: true } : {}));
    throw e;
}
// PROTOCOL_BOOTSTRAP_END
const MSG = ConversionProtocol.MSG;

// FG-164 / BUG-11 — the default page size the driver decided ('a4' | 'letter'),
// or null. Written to DEFAULT_PAPER_FILE in preRun, where the engine reads it
// (PaperInfo::getSystemDefaultPaper, engine/patches/*default-paper-from-app-not-locale-wasm.patch).
// A Worker can read neither the page's ?ff_ overrides nor localStorage, so it
// does not decide this itself.
let pinnedPaper = null;
// Conversion settings: the engine's LANG for INIT's formatLocale
// (ConversionProtocol.toPosixLocale), set in preRun so it replaces the value
// Emscripten would derive from navigator.languages. Both INIT fields are
// required (CONTRACT_VERSION 2); a missing or unknown value is refused with
// ERROR code INVALID_SETTINGS rather than guessed at.
let engineLang = null;
// FG-054 (optional, additive; CONTRACT_VERSION unchanged): INIT.allowEmbeddedEot === true lets the
// engine decode embedded EOT fonts. Only exactly `true` counts: absent, false or any other value
// (a string, 1) leaves it off, and so does a host that never sends it (the MCP builds INIT itself and
// sends nothing). The document and CONVERT cannot reach it: it is read from INIT only.
let allowEmbeddedEot = false;
// FEAT-16 phase 2 (optional, additive; CONTRACT_VERSION unchanged, D21): INIT.engineKey, the
// website's engine key. When present (the website, with its engineKeyGate flag on) the fetch and
// XHR hooks below send it as ConversionProtocol.ENGINE_KEY_HEADER on the engine binaries this
// worker requests itself (soffice.data, and the .wasm when the driver did not pre-fetch it), and
// a 403 on one of them latches ENGINE_BLOCKED like B1's 429: the driver fetches a fresh key once
// and starts a new worker. Absent (the MCP's host, or the gate off): no header, and a 403 means
// what it always meant. Never required.
let engineKey = null;
// FG-021 (optional, additive; CONTRACT_VERSION unchanged): INIT.allowDocumentPasswords === true lets the
// engine ask for, and be given, a document password. Same shape as allowEmbeddedEot: only exactly `true`
// counts, absent or any other value leaves it off (a host that sends nothing, the MCP, stays off), and
// the document and CONVERT cannot reach it: it is read from INIT only. Off, an encrypted input fails to
// load as it always did, and a password handed to the engine is refused as unsupported, never as wrong.
let allowDocumentPasswords = false;
// BUG-68 (B): the per-worker memory ceiling (see conversion_protocol.js). 0 = none. `memoryRefusal` is the first growth the guard
// refused during the current conversion (null = none); a conversion that then fails answers MEMORY_LIMIT.
let memoryCeilingBytes = 0;
let memoryRefusal = null;
let memoryGuardInstalled = false;
const DEFAULT_PAPER_FILE = '/tmp/pf-default-paper';
// D4: present while a conversion whose ONLY output is PDF loads its document. The
// engine then also uses Word's small subsets (fewer than 26 glyphs) and refuses
// no-subsetting fonts; Preview & Print is used for every output, Restricted and
// bitmap-only fonts for none (engine/patches/*embedded-fonts-pdf-only-viewing-rights-wasm.patch).
// Written per conversion, removed in the finally block: an editable output never sees it.
const PDF_ONLY_FONT_RIGHTS_FILE = '/tmp/pf-embedded-fonts-pdf-only';

// D4: set once this engine has loaded a document under PDF-only font rights. The
// engine keeps every embedded font it activated for the life of the process, and an
// editable export re-embeds a face by name, including a Word small subset only a PDF
// conversion admits, so such an engine must
// never produce an editable output. The browser driver never asks it to (it starts a
// fresh worker); a CONVERT that would is refused (PDF_ONLY_FONTS_LOADED), whoever sends it.
let pdfOnlyFontRightsUsed = false;

/** D4: write the PDF-only flag for a PDF target, remove it for any other. */
function setPdfOnlyFontRights(FS, targetFormat) {
    const pdfOnly = String(targetFormat || '').toLowerCase() === 'pdf';
    if (pdfOnly) {
        pdfOnlyFontRightsUsed = true;
        try {
            try { FS.mkdirTree('/tmp'); } catch (e) { /* exists */ }
            FS.writeFile(PDF_ONLY_FONT_RIGHTS_FILE, '1');
        } catch (e) {
            // The conversion still succeeds: Word's small subsets are not used (fewer than
            // 26 glyphs) and fall back to their substitutes.
            console.warn('[Worker] D4: could not write the PDF-only font-rights flag; embedded fonts follow the editing rule:', e && e.message);
        }
    } else {
        try { FS.unlink(PDF_ONLY_FONT_RIGHTS_FILE); } catch (e) { /* absent already: the editing rule applies */ }
    }
    return pdfOnly;
}

/**
 * Log WASM memory statistics for debugging large file issues
 * This helps identify if memory exhaustion is the cause of conversion failures
 */
function logMemoryStats(label) {
    // Disabled for production - uncomment for memory debugging
    return;

    if (typeof Module === 'undefined' || !Module.HEAP8) {
        console.log(`[Memory] ${label}: Module not ready`);
        return;
    }

    const heapSize = Module.HEAP8.length;
    const heapSizeMB = (heapSize / (1024 * 1024)).toFixed(2);

    // Try to get more detailed memory info if available
    let details = '';
    if (Module.HEAPU8 && Module.buffer) {
        const bufferSize = Module.buffer.byteLength;
        const bufferSizeMB = (bufferSize / (1024 * 1024)).toFixed(2);
        details = `, buffer: ${bufferSizeMB} MB`;
    }

    console.log(`[Memory] ${label}: HEAP size = ${heapSizeMB} MB${details}`);

    // Also log JS heap if available (Chrome only)
    if (typeof performance !== 'undefined' && performance.memory) {
        const usedMB = (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2);
        const totalMB = (performance.memory.totalJSHeapSize / (1024 * 1024)).toFixed(2);
        console.log(`[Memory] ${label}: JS heap = ${usedMB} MB used / ${totalMB} MB total`);
    }
}

// ---------------------------------------------------------------------------
// B1 — the CDN answers an over-limit engine/font request with 429 (+Retry-After)
// (only 429; a 403 is also a missing release file). It means "stop asking". This worker makes
// such requests in three ways, and each needs its own hook:
//   1. our own fetch() calls (fonts, fonts.json, the fresh-WASM fetch) check the
//      Response and throw ConversionProtocol.rateLimitedError;
//   2. Emscripten's fetch() of the .wasm (used when the driver did not pre-fetch
//      it). Its error text loses the status ("both async and sync fetching of the
//      wasm failed"), so the fetch is OBSERVED via the wrapper below;
//   3. the file packager's XMLHttpRequests for soffice.data and its metadata. A
//      non-2xx on the .data throws `statusText + " : " + url` (statusText is ""
//      over HTTP/2, so no status survives) and a non-200 on the metadata is
//      ignored outright, leaving the load to hang. Also observed below.
// The first rate-limited response latches `rateLimitHit`, is reported to the
// driver ONCE (with code + retryAfterSec), and every later fetch() in this
// worker fails immediately without touching the network. That is what stops
// Emscripten's streaming -> ArrayBuffer fallback from requesting the .wasm twice.
// ---------------------------------------------------------------------------
let rateLimitHit = null;          // the rateLimitedError, once seen
let rateLimitReported = false;    // posted to the driver already?

function noteRateLimit(err) {
    if (!rateLimitHit) rateLimitHit = err;
    return rateLimitHit;
}

/**
 * Tell the driver, once. Pre-ready this rejects the worker's ready promise; with a
 * conversion in flight (activeConvertId) it fails that conversion.
 */
function reportRateLimited() {
    if (!rateLimitHit || rateLimitReported) return;
    rateLimitReported = true;
    console.error('[Worker] Module/font request refused (B1):', rateLimitHit.message);
    postMessage({
        type: MSG.ERROR,
        error: rateLimitHit.message,
        code: rateLimitHit.code,
        retryAfterSec: rateLimitHit.retryAfterSec,
        id: activeConvertId,
        fatal: true
    });
}

/** Throw the latched error if any request in this worker was refused. */
function throwIfRateLimited() {
    if (rateLimitHit) throw rateLimitHit;
}

/** Check a fetch Response at an explicit call site. */
function checkRateLimitedResponse(response) {
    const err = ConversionProtocol.rateLimitErrorFromResponse(response, realNow());
    if (err) throw noteRateLimit(err);
}

/** The worker's error-message fields for an error (code/retryAfterSec only if B1). */
function errorCodeFields(err) {
    if (err && err.fg021Code) return err.fg021Extra ? Object.assign({ code: err.fg021Code }, err.fg021Extra) : { code: err.fg021Code };
    if (ConversionProtocol.isEngineBlockedError && ConversionProtocol.isEngineBlockedError(err)) return { code: err.code };   // FEAT-16
    return ConversionProtocol.isRateLimitedError(err)
        ? { code: err.code, retryAfterSec: err.retryAfterSec }
        : {};
}

/**
 * FEAT-16: is this request one of the engine binaries that carry the key? Only with a key
 * (INIT.engineKey) — without one this is always false, and every hook below behaves as before.
 */
function engineKeyFor(url) {
    if (!engineKey) return false;
    try { return ConversionProtocol.isEngineFileUrl(typeof Request !== 'undefined' && url instanceof Request ? url.url : url, self.location.href); }
    catch (e) { return false; }
}
/** FEAT-16: a refused engine binary (403 with the key). Latched like B1: nothing is asked again. */
function noteEngineBlocked() {
    return noteRateLimit(ConversionProtocol.engineBlockedError());
}

if (!isPThread && typeof self.fetch === 'function') {
    const realFetch = self.fetch.bind(self);
    self.fetch = function rateLimitAwareFetch(input, init) {
        if (rateLimitHit) return Promise.reject(rateLimitHit);
        const keyed = engineKeyFor(input);
        if (keyed) {   // FEAT-16: the key on an engine binary (a plain URL; Emscripten passes a string)
            const headers = new Headers((init && init.headers) || undefined);
            headers.set(ConversionProtocol.ENGINE_KEY_HEADER, engineKey);
            init = Object.assign({}, init, { headers });
        }
        return realFetch(input, init).then((response) => {
            const err = ConversionProtocol.rateLimitErrorFromResponse(response, realNow());
            if (err) noteRateLimit(err);
            else if (keyed && response.status === 403) { noteEngineBlocked(); reportRateLimited(); }
            return response;   // explicit call sites still decide what to throw
        });
    };
}

if (!isPThread && typeof XMLHttpRequest === 'function' && XMLHttpRequest.prototype) {
    const realSend = XMLHttpRequest.prototype.send;
    // FEAT-16: remember each request's URL, so send() can tell an engine binary.
    const realOpen = XMLHttpRequest.prototype.open;
    if (typeof realOpen === 'function') {
        XMLHttpRequest.prototype.open = function(method, url) {
            this.__engineKeyed = engineKeyFor(url);
            return realOpen.apply(this, arguments);
        };
    }
    XMLHttpRequest.prototype.send = function(body) {
        // Same latch as fetch above. This is also what stops Emscripten's LAST
        // .wasm fallback: after streaming and ArrayBuffer instantiation fail,
        // getBinarySync() -> readBinary() asks again with a synchronous XHR
        // (measured: a 404 .wasm is requested three times).
        if (rateLimitHit) throw rateLimitHit;
        // readystatechange(DONE) fires BEFORE load, so this sees the status before
        // the file packager's onload throws its status-less error. A host whose
        // XMLHttpRequest has no addEventListener (the MCP's Node host reads local
        // files, so it is never refused) sends unobserved.
        const keyed = this.__engineKeyed === true && !!engineKey;
        if (keyed && typeof this.setRequestHeader === 'function') this.setRequestHeader(ConversionProtocol.ENGINE_KEY_HEADER, engineKey);
        if (typeof this.addEventListener === 'function') this.addEventListener('readystatechange', () => {
            if (this.readyState !== 4) return;
            if (keyed && this.status === 403) { noteEngineBlocked(); reportRateLimited(); return; }   // FEAT-16
            if (!ConversionProtocol.isRateLimitStatus(this.status)) return;
            let header = null;
            try { header = this.getResponseHeader('Retry-After'); } catch (e) { header = null; }
            noteRateLimit(ConversionProtocol.rateLimitedError(
                ConversionProtocol.parseRetryAfter(header, realNow())));
            reportRateLimited();
        });
        return realSend.call(this, body);
    };
}

// B1: the two non-fatal scripts above were loaded before the latch existed. If either
// was refused, latch now: the module, its data and its fonts are never requested.
if (!isPThread) {
    for (const url of ['../../js/format_registry.js', '../../js/artifact_stem.js']) {
        if (ConversionProtocol.isRateLimitStatus(importedScriptStatus(url))) {
            noteRateLimit(ConversionProtocol.rateLimitedError(ConversionProtocol.RETRY_AFTER_DEFAULT_SEC));
            break;
        }
    }
}

// Add global error handlers for better diagnostics
if (!isPThread) {
    self.addEventListener('error', function(event) {
        if (rateLimitHit) {
            // B1: the cause is already known (e.g. the file packager threw on a
            // refused soffice.data). Report THAT, and cancel the event so it does
            // not also reach the driver as a generic "Worker failed to load".
            reportRateLimited();
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            return;
        }
        console.error('[Worker] Global error:', event.message, 'at', event.filename, ':', event.lineno);
        // fatal: a global error may have corrupted the runtime — tag it so the
        // driver rejects the active conversion (H4) and recycles the worker.
        postMessage({ type: MSG.ERROR, error: 'Global error: ' + event.message, id: activeConvertId, fatal: true });
    });

    self.addEventListener('unhandledrejection', function(event) {
        console.error('[Worker] Unhandled rejection:', event.reason);
        if (rateLimitHit) {   // B1: same reasoning as the error handler above
            reportRateLimited();
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            return;
        }
        postMessage({ type: MSG.ERROR, error: 'Unhandled rejection: ' + String(event.reason), id: activeConvertId, fatal: true });
    });
}

// Define helper functions for main worker BEFORE Module definition
// Paths are updated when INIT message is received with appRoot
let appRoot = '/';
let FONT_REGISTRY_URL = '/fonts/fonts.json';
let FONT_CONFIG_URL = '/fonts/fonts.conf';
// Text of the fetched fonts.conf, kept so it can also be written to the path
// fontconfig ACTUALLY reads (see writeFontConfigWhereItIsRead).
let fontConfigText = null;
// FM-3: [{requested, family}] for THIS conversion, sent by the driver.
let pendingFontSubstitutions = null;
// NTH-13: fonts an HTML page carries in its own CSS (data: URLs), already cleared by the rights rule for this output
// (ConversionProtocol.prepareHtmlDataFonts); mounted by mountPendingDataFonts() just before the engine reads its fonts.
let pendingDataFonts = null;
let dataFontNotices = [];          // visible notices for the page's web fonts that were skipped (reported in CONVERT_DONE)
let dataFontsMounted = [];         // VFS paths written for this conversion

// Track font loading state - fonts are loaded lazily only when needed
let fontsLoaded = false;

// Track LibreOffice initialization state - deferred until first conversion
let lokInitialized = false;

// NTH-09: the engine snapshot, taken only when INIT asks for it (engineSnapshot: the driver
// sets it when worker reuse is on). On the first CONVERT the engine is started with the base
// fontconfig config and NOTHING from the document (no bytes, fonts or substitution rules), and
// its whole linear memory is copied. After every conversion the copy is written back, so the
// next document meets the engine exactly as it was started: fonts, caches, statics and heap
// included. See takeEngineSnapshot() / restoreEngineSnapshot().
let engineSnapshotWanted = false;
let engineSnapshot = null;
// A document has reached the engine since the snapshot was taken or last written back.
let engineDirty = false;
// FG-021: does THIS worker apply passwords? Yes, since it passes them to the engine
// (set_conversion_secrets immediately before convert_*, clear_conversion_secrets in the
// CONVERT finally) AND proves an output password took effect before CONVERT_DONE
// (verifyOutputProtection, design §4.4). Switched on in the same commit as that check
// (WAF review of #624). An engine WITHOUT set_conversion_secrets (an older release) is
// still refused below: a password is never silently ignored. test_conversion_secrets.js
// refuses `true` without the calls and the check.
const WORKER_APPLIES_SECRETS = true;

// FG-021: an error that carries a CONVERT_ERROR `code` (a password tag from the bridge,
// or OUTPUT_PROTECTION_FAILED). Its message names no secret.
/**
 * BUG-66: the document's page count, from a conversion of the same input to PDF without a page
 * range (the other PDF options kept); null when that fails too. Only after an export that failed
 * with a range, so it never costs a successful conversion anything.
 */
function pageCountWithoutRange(inputPath, outputPath, pdfOpts) {
    const checkPath = outputPath + '.pages.pdf';
    try {
        const fn = Module.cwrap('convert_document_with_pdf_options', 'number', ['string', 'string', 'string', 'string', 'number', 'number']);
        if (fn(inputPath, checkPath, 'pdf', '', pdfOpts.maxImageResolution || 0, pdfOpts.quality || 0) !== 1) return null;
        return ConversionProtocol.countPdfPages(Module.FS.readFile(checkPath));
    } catch (e) {
        return null;
    } finally {
        tryUnlink(checkPath);
    }
}

function codedError(message, code, extra) {
    const err = new Error(message);
    err.fg021Code = code;
    if (extra) err.fg021Extra = extra;
    return err;
}

// The write-back failed, or the engine trapped: this engine converts nothing more (the driver
// replaces it). A flag only: the details (paths) go to the console, never into a reply.
let engineRestoreFailed = false;

// BUG-10. Set when the VFS never finished populating. Once set, this worker can
// never convert anything correctly, so every conversion it is handed must fail with
// this message rather than run against a partial filesystem. It is a latch, not a
// retry counter: the population step happens once per worker, and a fresh worker
// gets a fresh module instance and therefore a fresh attempt.
let vfsInitError = null;

// The id of the conversion currently being processed (S3). Set when a CONVERT
// message arrives, cleared after the terminal post. Included on abort/global
// error posts so the driver can reject the correct pending conversion (H4).
let activeConvertId = null;

/**
 * Best-effort VFS unlink (M5). Never throws: ENOENT (file never created / already
 * gone) or a dead runtime after an abort must not mask the real conversion outcome.
 * @param {string|null} path
 */
function tryUnlink(path) {
    if (!path) return;
    try {
        Module.FS.unlink(path);
        console.log('[Worker] VFS cleanup: unlinked', path);
    } catch (e) {
        // Non-fatal: file absent or runtime unusable.
    }
}

// Format/font helpers derived from the shared registry when available. The one
// permitted residual fallback list (assume fonts needed unless known plain-text)
// keeps conversions working if the registry failed to load — a missing registry
// can only cause extra font loading, never missing-glyph "tofu".
function formatRequiresFonts(format) {
    const R = (typeof self !== 'undefined' && self.FormatRegistry) || null;
    if (R && typeof R.requiresFontsForOutput === 'function') {
        return R.requiresFontsForOutput(format);
    }
    return !['txt', 'csv', 'tsv', 'html'].includes((format || '').toLowerCase());
}

function isSpreadsheetExt(ext) {
    const R = (typeof self !== 'undefined' && self.FormatRegistry) || null;
    if (R && typeof R.getInputCategory === 'function') {
        return R.getInputCategory(ext) === 'spreadsheets';
    }
    return ['xlsx', 'xls', 'ods', 'csv', 'xlsm', 'xltx'].includes((ext || '').toLowerCase());
}

function isCsvExt(ext) {
    const R = (typeof self !== 'undefined' && self.FormatRegistry) || null;
    if (R && typeof R.isCsvLike === 'function') {
        return R.isCsvLike(ext);
    }
    return ['csv', 'tsv'].includes((ext || '').toLowerCase());
}

// ---------------------------------------------------------------------------
// The last-resort font set, used when the driver sent no font list at all
// (FontResolver absent, its init failed, or extraction threw -> strategy 'all'
// with fontsToLoad:null). See setupMinimalFont().
//
// BUG-21: this used to be the DejaVu Sans family and nothing else, described as
// "just one fallback". DejaVu Sans is a SANS face, and LibreOffice's own default
// for Writer body text is a SERIF one, so every document that reached this path
// -- which included every document declaring no fonts of its own, because the
// driver drops the resolver's 'fallback' strategy -- was typeset in the wrong
// typeface CLASS. Verified on test_corpus/fixtures/documents/simple.odt: the PDF
// embedded DejaVuSans + OpenSymbol and no serif face at all.
//
// The defaults are not folklore; they are the engine's own table, read from
// officecfg/registry/data/org/openoffice/VCL.xcu (node DefaultFonts/en):
//   LATIN_TEXT ........... Liberation Serif   <- Writer body text
//   LATIN_HEADING ........ Liberation Sans    <- Writer headings
//   LATIN_SPREADSHEET .... Liberation Sans    <- Calc
//   LATIN_PRESENTATION ... Liberation Sans    <- Impress
//   LATIN_FIXED .......... Liberation Mono    <- preformatted/monospace
// All four families are therefore mounted; which one the engine picks is its
// decision, and getting it wrong is exactly the bug. (simple.odt needs two of
// them at once: a Heading 1 -> LATIN_HEADING and body paragraphs -> LATIN_TEXT.)
//
// DejaVu Sans stays, and is NOT redundant: measured from the shipped cmaps, the
// Liberation trio draws 0/96 Armenian, 0/256 Arabic, 0/96 Georgian, 8/112
// Arrows, 18/256 Math Operators, 40/128 Box Drawing and 0/192 Dingbats, all of
// which DejaVu Sans covers. Dropping it would trade one wrong-typeface bug for a
// tofu bug. Both DejaVu faces are kept HERE (unlike the resolver path, which can
// narrow by observed usage) so that this emergency path is a strict SUPERSET of
// what it covered before -- DejaVuSans-Bold is the only shipped source for the
// 120 Mathematical Sans-Serif Bold code points U+1D5D4-1D607, U+1D756-1D78F and
// U+1D7EC-1D7F5, and an emergency path is the wrong place to shave 692 KB.
//
// Named by FILE, not by family, so the three Liberation families contribute
// their Regular face only (their bold/italic faces are synthesised by
// fontconfig) instead of all twelve files / 4.36 MB.
const MINIMAL_FONT_FILES = [
    'LiberationSerif-Regular.ttf',   // LATIN_TEXT        (Writer body)
    'LiberationSans-Regular.ttf',    // LATIN_HEADING / SPREADSHEET / PRESENTATION
    'LiberationMono-Regular.ttf',    // LATIN_FIXED
    'DejaVuSans.ttf',                // broad script/symbol coverage
    'DejaVuSans-Bold.ttf'            // + the Math Sans-Serif Bold block
];

async function setupFontConfig() {
    try {
        const response = await fetch(FONT_CONFIG_URL);
        checkRateLimitedResponse(response);   // B1
        if (!response.ok) throw new Error('Failed to load fonts.conf');
        const configText = await response.text();

        // Create necessary fontconfig directories
        try { Module.FS.mkdirTree('/etc/fonts'); } catch(e) {}
        try { Module.FS.mkdirTree('/var/cache/fontconfig'); } catch(e) {}
        try { Module.FS.mkdirTree('/usr/share/fonts/truetype'); } catch(e) {}

        Module.FS.writeFile('/etc/fonts/fonts.conf', configText);
        console.log('[Worker] Font config loaded');

        // Set environment variable so fontconfig knows where to find config
        if (Module.ENV) {
            Module.ENV['FONTCONFIG_FILE'] = '/etc/fonts/fonts.conf';
            Module.ENV['FONTCONFIG_PATH'] = '/etc/fonts';
            console.log('[Worker] FONTCONFIG environment variables set');
        }
    } catch (e) {
        if (ConversionProtocol.isRateLimitedError(e)) throw e;   // B1: not a soft failure
        console.warn('[Worker] fonts.conf setup failed:', e);
    }
}


// Note: injectDocxComponents() was removed (LOW-combined item 1) — it was defined
// but never called (documents-module services.rdb already carries these OOX/
// WriterFilter/UCB registrations from the build). injectCalcComponents and
// injectImpressComponents below ARE called from onRuntimeInitialized.

/**
 * BUG-11 / FG-164 — tell the engine which default page size to use for
 * documents that declare none (txt, csv, html, an ODS with no page-layout).
 *
 * The engine reads DEFAULT_PAPER_FILE in PaperInfo::getSystemDefaultPaper
 * before its locale logic. Until 2026-10 the only lever was the process LANG
 * (Emscripten builds it from navigator.languages), so getting A4 for a browser
 * that names no country -- or honouring a forced flag -- meant replacing the
 * user's locale with en-GB / en-US. That also changed their date and number
 * formats (OOXML built-in dates became dd/mm/yyyy and overflowed as ###).
 * Pinning the paper directly leaves the locale alone in every case.
 *
 * MUST RUN IN preRun: after the filesystem exists, before main() and before
 * anything asks LibreOffice for a page size.
 *
 * Non-fatal: a conversion with the wrong DEFAULT page size is still a correct
 * conversion of the content, so a failure here is logged loudly, not thrown.
 */
/**
 * Set the engine's locale to INIT's formatLocale. MUST RUN IN preRun: Emscripten
 * builds the process environment once, on the first getenv, from the global
 * ENV (soffice.js `var ENV`) over its navigator.languages default, and nothing
 * reads it before preRun. Measured 2026-10-10: an en-US browser with
 * LANG=de_DE.UTF-8 here gets 31.12.2023 and 1.234,50; a de-DE browser with
 * en_US.UTF-8 gets 12/31/2023. Gate `format_locale_engine`.
 */
function setEngineLocale() {
    if (!engineLang) return;
    if (typeof ENV !== 'object' || ENV === null) {
        // Fatal, not logged-and-continued: the engine would silently convert in
        // the browser's locale instead of the one the user chose. Throwing in
        // preRun aborts the start, and the abort reaches the user as an error.
        throw new Error('Cannot set the format locale (' + engineLang + '): no Emscripten ENV');
    }
    ENV.LANG = engineLang;
    console.log('[Worker] Format locale set: LANG=' + engineLang);
}

/**
 * FG-054: tell the engine it may decode EOT (LO_WASM_ALLOW_EOT=1, read by vcl's embeddedfontshelper).
 * Same place and same reason as setEngineLocale: preRun, before the engine builds its environment.
 * Non-fatal: if the switch cannot be set the engine keeps refusing EOT, the safe direction, and the
 * driver's post-conversion check (#580) converts again with every substitute.
 */
function setEngineEotSwitch() {
    if (!allowEmbeddedEot) return;
    if (typeof ENV !== 'object' || ENV === null) {
        console.error('[Worker] Cannot allow embedded EOT fonts: no Emscripten ENV; the engine will refuse them');
        return;
    }
    ENV.LO_WASM_ALLOW_EOT = '1';
    console.log('[Worker] Embedded EOT fonts allowed (INIT.allowEmbeddedEot)');
}

/**
 * FG-021: switch the engine's document-password handling on, but only when INIT asked for it. The
 * bridge reads LO_WASM_ALLOW_DOCUMENT_PASSWORDS once, in init_office(); anything but exactly "1" is off.
 * Must be set BEFORE init_office(), so it is set in preRun like the EOT switch. Non-fatal: if it cannot
 * be set the engine stays off, the safe direction (an encrypted input then fails, and a password is
 * refused as unsupported).
 */
function setEngineDocumentPasswordSwitch() {
    if (!allowDocumentPasswords) return;
    if (typeof ENV !== 'object' || ENV === null) {
        console.error('[Worker] Cannot allow document passwords: no Emscripten ENV; the engine will refuse them');
        return;
    }
    ENV.LO_WASM_ALLOW_DOCUMENT_PASSWORDS = '1';
    console.log('[Worker] Document passwords allowed (INIT.allowDocumentPasswords)');
}

function writeDefaultPaperPin(FS) {
    if (!pinnedPaper) return;
    try {
        try { FS.mkdirTree('/tmp'); } catch (e) { /* exists */ }
        FS.writeFile(DEFAULT_PAPER_FILE, pinnedPaper);
        console.log('[Worker] Default page size pinned: ' + pinnedPaper);
    } catch (e) {
        console.error('[Worker] Could not pin the default page size:', e);
    }
}

/**
 * Inject Calc (spreadsheet) component registrations into services.rdb
 * These UNO services are needed for XLSX/ODS/CSV import but may be missing from the default services.rdb
 * This must be called BEFORE init_office()
 */
function injectCalcComponents() {
    const SERVICES_RDB_PATH = '/instdir/program/services/services.rdb';

    // Main Calc library - contains SpreadsheetDocument and XML exporters/importers
    const SC_COMPONENT = `<component loader="com.sun.star.loader.SharedLibrary" environment="gcc3" uri="libsclo.a">` +
        `<implementation name="com.sun.star.comp.Calc.FilterOptionsDialog" constructor="Calc_FilterOptionsDialog_get_implementation">` +
        `<service name="com.sun.star.ui.dialogs.FilterOptionsDialog"/></implementation>` +
        `<implementation name="com.sun.star.comp.Calc.SpreadsheetDocument" constructor="Calc_SpreadsheetDocument_get_implementation">` +
        `<service name="com.sun.star.sheet.SpreadsheetDocument"/></implementation>` +
        `<implementation name="com.sun.star.comp.Calc.XMLOasisContentExporter" constructor="Calc_XMLOasisContentExporter_get_implementation">` +
        `<service name="com.sun.star.comp.Calc.XMLOasisContentExporter"/></implementation>` +
        `<implementation name="com.sun.star.comp.Calc.XMLOasisContentImporter" constructor="Calc_XMLOasisContentImporter_get_implementation">` +
        `<service name="com.sun.star.comp.Calc.XMLOasisContentImporter"/></implementation>` +
        `<implementation name="com.sun.star.comp.Calc.XMLOasisExporter" constructor="Calc_XMLOasisExporter_get_implementation">` +
        `<service name="com.sun.star.comp.Calc.XMLOasisExporter"/></implementation>` +
        `<implementation name="com.sun.star.comp.Calc.XMLOasisImporter" constructor="Calc_XMLOasisImporter_get_implementation">` +
        `<service name="com.sun.star.comp.Calc.XMLOasisImporter"/></implementation>` +
        `<implementation name="com.sun.star.comp.Calc.XMLOasisMetaExporter" constructor="Calc_XMLOasisMetaExporter_get_implementation">` +
        `<service name="com.sun.star.comp.Calc.XMLOasisMetaExporter"/></implementation>` +
        `<implementation name="com.sun.star.comp.Calc.XMLOasisMetaImporter" constructor="Calc_XMLOasisMetaImporter_get_implementation">` +
        `<service name="com.sun.star.comp.Calc.XMLOasisMetaImporter"/></implementation>` +
        `<implementation name="com.sun.star.comp.Calc.XMLOasisSettingsExporter" constructor="Calc_XMLOasisSettingsExporter_get_implementation">` +
        `<service name="com.sun.star.comp.Calc.XMLOasisSettingsExporter"/></implementation>` +
        `<implementation name="com.sun.star.comp.Calc.XMLOasisSettingsImporter" constructor="Calc_XMLOasisSettingsImporter_get_implementation">` +
        `<service name="com.sun.star.comp.Calc.XMLOasisSettingsImporter"/></implementation>` +
        `<implementation name="com.sun.star.comp.Calc.XMLOasisStylesExporter" constructor="Calc_XMLOasisStylesExporter_get_implementation">` +
        `<service name="com.sun.star.comp.Calc.XMLOasisStylesExporter"/></implementation>` +
        `<implementation name="com.sun.star.comp.Calc.XMLOasisStylesImporter" constructor="Calc_XMLOasisStylesImporter_get_implementation">` +
        `<service name="com.sun.star.comp.Calc.XMLOasisStylesImporter"/></implementation>` +
        `<implementation name="stardiv.StarCalc.ScAutoFormatsObj" constructor="ScAutoFormatsObj_get_implementation">` +
        `<service name="com.sun.star.sheet.TableAutoFormats"/></implementation>` +
        `<implementation name="stardiv.StarCalc.ScFunctionAccess" constructor="ScFunctionAccess_get_implementation">` +
        `<service name="com.sun.star.sheet.FunctionAccess"/></implementation>` +
        `<implementation name="stardiv.StarCalc.ScFunctionListObj" constructor="ScFunctionListObj_get_implementation">` +
        `<service name="com.sun.star.sheet.FunctionDescriptions"/></implementation>` +
        `<implementation name="stardiv.StarCalc.ScSpreadsheetSettings" constructor="Calc_ScSpreadsheetSettings_get_implementation">` +
        `<service name="com.sun.star.sheet.GlobalSheetSettings"/></implementation>` +
        `</component>`;

    // Calc format detector (scd) - detects Excel formats
    const SCD_COMPONENT = `<component loader="com.sun.star.loader.SharedLibrary" environment="gcc3" uri="libscdlo.a">` +
        `<implementation name="com.sun.star.comp.calc.FormatDetector" constructor="com_sun_star_comp_calc_FormatDetector_get_implementation">` +
        `<service name="com.sun.star.frame.ExtendedTypeDetection"/></implementation>` +
        `<implementation name="com.sun.star.comp.calc.ExcelBiffFormatDetector" constructor="com_sun_star_comp_calc_ExcelBiffFormatDetector_get_implementation">` +
        `<service name="com.sun.star.frame.ExtendedTypeDetection"/></implementation>` +
        `</component>`;

    // Calc filter (scfilt) - XLSX/XLS import/export via oox
    const SCFILT_COMPONENT = `<component loader="com.sun.star.loader.SharedLibrary" environment="gcc3" uri="libscfiltlo.a">` +
        `<implementation name="com.sun.star.comp.oox.xls.ExcelFilter" constructor="com_sun_star_comp_oox_xls_ExcelFilter_get_implementation">` +
        `<service name="com.sun.star.document.ImportFilter"/>` +
        `<service name="com.sun.star.document.ExportFilter"/></implementation>` +
        `<implementation name="com.sun.star.comp.oox.xls.FormulaParser" constructor="com_sun_star_comp_oox_xls_FormulaParser_get_implementation">` +
        `<service name="com.sun.star.sheet.FilterFormulaParser"/></implementation>` +
        `<implementation name="com.sun.star.comp.sc.OrcusFilterDetect" constructor="com_sun_star_comp_sc_OrcusFormatDetect_get_implementation">` +
        `<service name="com.sun.star.frame.ExtendedTypeDetection"/></implementation>` +
        `</component>`;

    try {
        // Read current services.rdb
        const currentContent = Module.FS.readFile(SERVICES_RDB_PATH, { encoding: 'utf8' });

        // Check if Calc components are already present
        if (currentContent.includes('libsclo.a') && currentContent.includes('libscdlo.a') &&
            currentContent.includes('libscfiltlo.a')) {
            console.log('[Worker] Calc components already in services.rdb');
            return;
        }

        // Insert new components before closing </components> tag
        const modifiedContent = currentContent.replace(
            '</components>',
            SC_COMPONENT + SCD_COMPONENT + SCFILT_COMPONENT + '</components>'
        );

        // Write back
        Module.FS.writeFile(SERVICES_RDB_PATH, modifiedContent);
        console.log('[Worker] Injected Calc components into services.rdb');
        console.log('[Worker] services.rdb size:', currentContent.length, '->', modifiedContent.length);
    } catch (e) {
        console.error('[Worker] Failed to inject Calc components into services.rdb:', e);
    }
}

/**
 * Inject Impress (presentations) component registrations into services.rdb
 * The Oasis XML importers for Impress (needed for ODP/OTP loading) are defined in
 * xmloff's xo.component but are missing from the WASM services.rdb.
 *
 * The Impress constructor symbols (com_sun_star_comp_Impress_XMLOasis*) are NOT linked
 * into the WASM binary, but the Draw equivalents (com_sun_star_comp_Draw_XMLOasis*) ARE.
 * Both use the same SdXMLImport class; the bIsDraw flag is auto-detected from the
 * document type at runtime (sdxmlimp.cxx line 328), so using Draw constructors for
 * Impress service names is safe.
 *
 * We inject Impress service names pointing to Draw constructors into the EXISTING
 * libxolo.a component block. This must be called BEFORE init_office().
 */
function injectImpressComponents() {
    const SERVICES_RDB_PATH = '/instdir/program/services/services.rdb';

    // Map Impress service names to Draw constructors (both use SdXMLImport,
    // which auto-detects bIsDraw from the document's PresentationDocument service)
    const IMPRESS_XO_IMPLS =
        // Impress Oasis importers using Draw constructors
        `<implementation name="XMLImpressMetaImportOasis" constructor="com_sun_star_comp_Draw_XMLOasisMetaImporter_get_implementation">` +
        `<service name="com.sun.star.comp.Impress.XMLOasisMetaImporter"/></implementation>` +
        `<implementation name="XMLImpressSettingsImportOasis" constructor="com_sun_star_comp_Draw_XMLOasisSettingsImporter_get_implementation">` +
        `<service name="com.sun.star.comp.Impress.XMLOasisSettingsImporter"/></implementation>` +
        `<implementation name="XMLImpressStylesImportOasis" constructor="com_sun_star_comp_Draw_XMLOasisStylesImporter_get_implementation">` +
        `<service name="com.sun.star.comp.Impress.XMLOasisStylesImporter"/></implementation>` +
        `<implementation name="XMLImpressContentImportOasis" constructor="com_sun_star_comp_Draw_XMLOasisContentImporter_get_implementation">` +
        `<service name="com.sun.star.comp.Impress.XMLOasisContentImporter"/></implementation>` +
        `<implementation name="XMLImpressImportOasis" constructor="com_sun_star_comp_Draw_XMLOasisImporter_get_implementation">` +
        `<service name="com.sun.star.comp.Impress.XMLOasisImporter"/></implementation>` +
        // Impress Oasis exporters using Draw constructors
        `<implementation name="XMLImpressContentExportOasis" constructor="com_sun_star_comp_Draw_XMLOasisContentExporter_get_implementation">` +
        `<service name="com.sun.star.comp.Impress.XMLOasisContentExporter"/></implementation>` +
        `<implementation name="XMLImpressExportOasis" constructor="com_sun_star_comp_Draw_XMLOasisExporter_get_implementation">` +
        `<service name="com.sun.star.comp.Impress.XMLOasisExporter"/></implementation>` +
        `<implementation name="XMLImpressMetaExportOasis" constructor="com_sun_star_comp_Draw_XMLOasisMetaExporter_get_implementation">` +
        `<service name="com.sun.star.comp.Impress.XMLOasisMetaExporter"/></implementation>` +
        `<implementation name="XMLImpressSettingsExportOasis" constructor="com_sun_star_comp_Draw_XMLOasisSettingsExporter_get_implementation">` +
        `<service name="com.sun.star.comp.Impress.XMLOasisSettingsExporter"/></implementation>` +
        `<implementation name="XMLImpressStylesExportOasis" constructor="com_sun_star_comp_Draw_XMLOasisStylesExporter_get_implementation">` +
        `<service name="com.sun.star.comp.Impress.XMLOasisStylesExporter"/></implementation>`;

    try {
        let content = Module.FS.readFile(SERVICES_RDB_PATH, { encoding: 'utf8' });

        // Check if Impress Oasis components are already present
        if (content.includes('Impress.XMLOasisMetaImporter')) {
            console.log('[Worker] Impress Oasis components already in services.rdb');
            return;
        }

        // Insert Impress implementations into the EXISTING libxolo.a component block
        const xoBlockEnd = content.indexOf('</component>', content.indexOf('libxolo.a'));
        if (xoBlockEnd === -1) {
            console.error('[Worker] Could not find libxolo.a component block in services.rdb');
            return;
        }

        content = content.slice(0, xoBlockEnd) + IMPRESS_XO_IMPLS + content.slice(xoBlockEnd);

        Module.FS.writeFile(SERVICES_RDB_PATH, content);
        console.log('[Worker] Injected Impress Oasis XML components (using Draw constructors) into services.rdb');
        console.log('[Worker] services.rdb size after injection:', content.length);
    } catch (e) {
        console.error('[Worker] Failed to inject Impress components into services.rdb:', e);
    }
}

// Track which specific fonts have been loaded (for selective loading)
let loadedFontFiles = new Set();

// BUG-17: several registry entries are byte-identical (e.g. a static
// "Regular" instance and the variable font it was cut from, sharing a
// `hash`). This worker fetches fonts serially (see setupFonts/
// setupSelectiveFonts/setupMinimalFont below), so a simple hash -> bytes
// cache is enough -- no concurrent-fetch race to guard against, unlike
// font_loader.js's batched loader. LibreOffice still needs the bytes written
// at EVERY font's own lazy_path (fontconfig discovers faces by scanning the
// VFS path, not by content), so a cache hit skips the network fetch but never
// skips the FS.writeFile.
let loadedFontPayloads = new Map(); // hash -> Uint8Array

/**
 * Post a per-font liveness PROGRESS message during the font-loading phase (M3).
 * Maps i/n into the 50..69 band (init_office takes over at 70).
 * @param {number} i - Fonts processed so far (1-based)
 * @param {number} n - Total fonts to process
 */
function postFontProgress(i, n) {
    if (isPThread || !n) return;
    const pct = Math.min(69, 50 + Math.round((i / n) * 19));
    postMessage({ type: MSG.PROGRESS, stage: `Loading fonts (${i}/${n})...`, percent: pct });
}

// Essential font families for proper text rendering (EXACT matches only)
//
// The comment that used to sit here read "Loading all 319 fonts causes
// init_office() to hang during fontconfig scan". MEASURED 2026-07-26: that is
// FALSE on the current build. All 319 fonts (81.8 MB) load and convert fine;
// init_office() is CONSTANT at 51-62 ms from 0 to 4,001 font files -- there is no
// knee, no hang, and no pathological file (NotoColorEmoji, SignWriting, Tangut and
// the variable fonts were each isolated and are indistinguishable from baseline).
// A full DOCX->PDF with all 319 forced takes 1.75 s end to end.
//
// The claim originated in commit 0765490 (2026-01-14), in the same change that
// introduced stall detection, against a binary that no longer exists -- so whether
// the original hang was real, or an 82 MB serial font download with no liveness
// signal being READ as a hang, is now undeterminable. Either way it does not
// reproduce.
//
// The scan itself is real but is NOT in init_office(): it happens lazily at first
// document render, costs ~200 ms once per worker for the full registry, and is
// then cached (second conversion: ~10 ms). We still load selectively -- not
// because the engine cannot cope, but because nobody should download 82 MB of
// fonts to convert one document. The binding constraint is BYTES ON THE WIRE
// against the conversion timeout, not font count.
// One list, shared with font_resolver.js (the main-thread path) — see
// ConversionProtocol.ESSENTIAL_FONT_FAMILIES for why it does not live here.
// This is the FALLBACK path, so a divergence here would only ever be exercised
// after the primary path had already failed: the worst place for a silent copy.
const ESSENTIAL_FONT_FAMILIES = new Set(ConversionProtocol.ESSENTIAL_FONT_FAMILIES);

// BUG-12: script-coverage fonts for the FALLBACK path (when the driver sent no
// requiredFonts because FontResolver was unavailable or threw). Without this,
// the worker's own font list would silently undo the resolver's fix. Populated
// per conversion by sniffScriptFontFiles(); empty for Latin-only input, so the
// ASCII path loads exactly what it loaded before and the fontconfig scan (which
// hangs if handed all 319 fonts) stays small.
let pendingScriptFontFiles = new Set();

// Text-ish inputs only. ZIP containers need JSZip to sniff and that lives on
// the main thread (font_resolver.js + font_extractor.js), which is the normal
// path; this is just the safety net.
const SNIFFABLE_TEXT_EXTS = new Set(['txt', 'text', 'rtf', 'html', 'htm', 'csv', 'tsv', 'xml']);
const SCRIPT_SNIFF_BYTES = 256 * 1024;

/**
 * Populate pendingScriptFontFiles from the input bytes (fallback path only).
 * Uses the SAME script table as font_resolver.js (ConversionProtocol.SCRIPTS),
 * so the two paths cannot drift.
 * @param {Uint8Array} fileData
 * @param {string} fileName
 */
function sniffScriptFontFiles(fileData, fileName) {
    pendingScriptFontFiles = new Set();
    try {
        const ext = ConversionProtocol.sanitizeExtension(fileName || '');
        if (!SNIFFABLE_TEXT_EXTS.has(ext) || !fileData) return;
        const bytes = fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData);
        if (!bytes.length) return;
        const sample = bytes.subarray(0, Math.min(bytes.length, SCRIPT_SNIFF_BYTES));
        const text = ConversionProtocol.decodeTextSample(sample, ext);
        const scripts = ConversionProtocol.detectScripts(text, 1);
        if (!scripts.length) return;
        for (const f of ConversionProtocol.scriptFontFiles(scripts)) pendingScriptFontFiles.add(f);
        if (pendingScriptFontFiles.size) {
            console.log('[Worker] Fallback script sniff:', scripts.join(', '),
                        '→', Array.from(pendingScriptFontFiles).join(', '));
        }
    } catch (e) {
        console.warn('[Worker] Script sniff failed (non-fatal):', e.message || String(e));
    }
}

/** @returns {boolean} true if this registry entry is a needed script font. */
function isPendingScriptFont(font) {
    return !!(font && font.file && pendingScriptFontFiles.has(font.file));
}

async function setupFonts() {
    // Skip if already loaded
    if (fontsLoaded) {
        console.log('[Worker] Fonts already loaded, skipping');
        return;
    }

    try {
        console.log('[Worker] Fetching font registry from:', FONT_REGISTRY_URL);
        const response = await fetch(FONT_REGISTRY_URL);
        checkRateLimitedResponse(response);   // B1
        if (!response.ok) throw new Error('Failed to load font registry: ' + response.status);
        const registry = await response.json();
        const allFonts = registry.fonts || registry;

        if (!allFonts || !Array.isArray(allFonts)) {
            throw new Error('Invalid fonts data: expected array, got ' + typeof allFonts);
        }

        // Filter to only essential fonts (exact family match) to avoid fontconfig
        // hanging, plus any script-coverage font the content actually needs (BUG-12).
        const essentialFonts = allFonts.filter(font =>
            (font.family && ESSENTIAL_FONT_FAMILIES.has(font.family)) || isPendingScriptFont(font)
        );

        console.log('[Worker] Loading', essentialFonts.length, 'essential fonts (filtered from', allFonts.length, ')...');

        let loadedCount = 0;
        let failedCount = 0;
        let processed = 0;
        for (const font of essentialFonts) {
            const success = await loadSingleFont(font);
            if (success) loadedCount++;
            else failedCount++;
            postFontProgress(++processed, essentialFonts.length);
        }
        fontsLoaded = true;
        console.log('[Worker] Font loading complete:', loadedCount, 'loaded,', failedCount, 'failed');
    } catch (e) {
        // B1: a refused request fails the conversion; it is not "converted with
        // fewer fonts".
        if (ConversionProtocol.isRateLimitedError(e)) throw e;
        console.error('[Worker] Font setup FAILED:', e.message || String(e));
        console.error('[Worker] Font setup error stack:', e.stack || 'no stack');
    }
}

/**
 * Load a single font to the VFS
 * @param {Object} font - Font object with uri and lazy_path
 * @returns {Promise<boolean>} True if loaded successfully
 */
async function loadSingleFont(font) {
    // Validate font object
    if (!font || typeof font !== 'object') {
        console.warn('[Worker] Invalid font entry:', font);
        return false;
    }

    if (!font.lazy_path) {
        console.warn('[Worker] Font missing lazy_path:', font.family || 'unknown');
        return false;
    }

    if (!font.uri) {
        console.warn('[Worker] Font missing uri:', font.family || 'unknown');
        return false;
    }

    // Skip if already loaded
    if (loadedFontFiles.has(font.file || font.lazy_path)) {
        return true;
    }

    // Check Module.FS availability
    if (typeof Module === 'undefined' || !Module.FS) {
        console.error('[Worker] Module.FS not available - cannot load fonts');
        return false;
    }

    const dir = font.lazy_path.substring(0, font.lazy_path.lastIndexOf('/'));

    try {
        Module.FS.mkdirTree(dir);
    } catch (e) {
        // Ignore - directory may already exist
    }

    // BUG-17: reuse an already-downloaded payload if this font's content hash
    // matches one we already fetched (e.g. Ubuntu Regular and the Ubuntu
    // variable font are byte-identical). LibreOffice still needs the bytes
    // present at THIS font's own lazy_path -- fontconfig finds faces by
    // scanning the VFS, not by content -- so we always write the file, we
    // just skip the network round-trip.
    if (font.hash && loadedFontPayloads.has(font.hash)) {
        try {
            const cached = loadedFontPayloads.get(font.hash);
            Module.FS.writeFile(font.lazy_path, cached);
            loadedFontFiles.add(font.file || font.lazy_path);
            console.log('[Worker] Reused cached payload for', font.family, font.weight || '',
                        '(dedup via hash, saved', cached.length, 'bytes)');
            return true;
        } catch (err) {
            console.error('[Worker] Error writing cached font payload', font.family || font.uri, ':', err.message || String(err));
            return false;
        }
    }

    try {
        const fontUrl = font.uri.startsWith('/') ? appRoot + font.uri.slice(1) : font.uri;
        const fontResponse = await fetch(fontUrl);
        // B1: a refused font must fail the conversion with the busy message. The
        // `return false` below would let it continue without the font — a silent
        // typeface change, and every later font would be requested anyway.
        checkRateLimitedResponse(fontResponse);
        if (!fontResponse.ok) {
            console.warn('[Worker] Failed to fetch font:', font.uri, 'status:', fontResponse.status);
            return false;
        }
        const fontData = new Uint8Array(await fontResponse.arrayBuffer());
        Module.FS.writeFile(font.lazy_path, fontData);
        loadedFontFiles.add(font.file || font.lazy_path);
        if (font.hash) loadedFontPayloads.set(font.hash, fontData);
        // Only log every 10th font to reduce noise
        if (loadedFontFiles.size <= 3 || loadedFontFiles.size % 50 === 0) {
            console.log('[Worker] Loaded font:', font.family, font.weight || '', '(' + fontData.length + ' bytes)');
        }
        return true;
    } catch (err) {
        if (ConversionProtocol.isRateLimitedError(err)) throw err;   // B1
        console.error('[Worker] Error loading font', font.family || font.uri, ':', err.message || String(err));
        return false;
    }
}

/**
 * Load only specified fonts (selective loading for COA #5)
 * @param {Array} fonts - Array of font objects to load
 */
async function setupSelectiveFonts(fonts) {
    if (!fonts || fonts.length === 0) {
        console.log('[Worker] No fonts to load selectively');
        return;
    }

    const startTime = performance.now();
    let loaded = 0;
    let skipped = 0;
    let failed = 0;

    console.log('[Worker] Loading', fonts.length, 'fonts selectively...');

    let processed = 0;
    for (const font of fonts) {
        processed++;
        if (loadedFontFiles.has(font.file || font.lazy_path)) {
            skipped++;
        } else {
            const success = await loadSingleFont(font);
            if (success) {
                loaded++;
            } else {
                failed++;
            }
        }
        // M3: per-font liveness so a slow font download does not trip the stall
        // timer. Fonts are fetched serially, so each completed fetch is a genuine
        // signal; a dead connection emits nothing and still stalls out. Cap at 69
        // (init_office posts 70).
        postFontProgress(processed, fonts.length);
    }

    const elapsed = (performance.now() - startTime).toFixed(1);
    console.log(`[Worker] Selective font loading: ${loaded} loaded, ${skipped} cached, ${failed} failed in ${elapsed}ms`);

    // Mark fonts as loaded if we loaded something
    if (loaded > 0 || skipped > 0) {
        fontsLoaded = true;
    }
}

/**
 * Ensure fonts are loaded if needed for the target format
 * @param {string} targetFormat - Target output format
 * @param {Array|null} requiredFonts - Optional: specific fonts to load (null = load all)
 */
/**
 * FG-054: the font files LibreOffice wrote for a document's embedded fonts. It
 * writes one per ACCEPTED face (EmbeddedFontsHelper::addEmbeddedFont removes a
 * refused one) as <typeface><""|b|i|bi>.ttf for DOCX/PPTX, or fontN.ttf when the
 * name is not a valid file name (ODF), and clears the directory only at engine
 * start and shutdown (vcl svmain.cxx), so it can be listed after a conversion.
 * @returns {string[]|null} file names, or null when the directory cannot be read
 */
const EMBEDDED_FONT_DIR = '/instdir/user/temp/embeddedfonts/fromdocs';
// absentIsEmpty: BEFORE a conversion the directory may simply not exist yet (the
// engine creates it, with osl::Directory::createPath, just before it writes the
// first face). AFTER a conversion that expected faces, an absent directory means
// the engine keeps them somewhere else -- LibreOffice 26.x moves LOK's embedded
// fonts to a temp directory -- so it is reported as null ("cannot verify"), never
// as an empty listing that would look like a refusal and trigger a retry.
function listEmbeddedFontFiles(absentIsEmpty) {
    try {
        return Module.FS.readdir(EMBEDDED_FONT_DIR).filter(n => n !== '.' && n !== '..').sort();
    } catch (e) {
        const absent = !!(e && (e.errno === 44 || e.code === 'ENOENT'));
        return (absent && absentIsEmpty) ? [] : null;
    }
}

async function ensureFontsIfNeeded(targetFormat, requiredFonts = null) {
    const needsFonts = formatRequiresFonts(targetFormat);

    if (!needsFonts) {
        console.log(`[Worker] Target format '${targetFormat}' does not require fonts, skipping font loading`);
        return;
    }

    // If specific fonts provided, use selective loading
    if (requiredFonts && requiredFonts.length > 0) {
        console.log(`[Worker] Target format '${targetFormat}' requires fonts, loading ${requiredFonts.length} selectively...`);
        await setupSelectiveFonts(requiredFonts);
        return;
    }

    // Fall back to loading minimal font (just DejaVu Sans for PDF rendering)
    if (!fontsLoaded) {
        console.log(`[Worker] Target format '${targetFormat}' requires fonts, loading minimal set...`);
        await setupMinimalFont();
    } else {
        console.log('[Worker] Fonts already loaded');
    }
}

/**
 * Load the last-resort font set: the engine's own default families plus the
 * broad-coverage DejaVu faces (see MINIMAL_FONT_FILES for why each one is
 * there), plus any script-coverage font the sniffed content needs (BUG-12).
 *
 * Only reached when the driver sent no font list at all. The normal path is
 * setupSelectiveFonts() with the resolver's set.
 */
async function setupMinimalFont() {
    if (fontsLoaded) {
        console.log('[Worker] Fonts already loaded, skipping minimal font setup');
        return;
    }

    try {
        console.log('[Worker] Loading the engine default font set (no list was supplied)...');
        const response = await fetch(FONT_REGISTRY_URL);
        checkRateLimitedResponse(response);   // B1
        if (!response.ok) throw new Error('Failed to load font registry: ' + response.status);
        const registry = await response.json();
        const allFonts = registry.fonts || registry;

        const wanted = new Set(MINIMAL_FONT_FILES);
        const minimalFonts = allFonts.filter(font =>
            (font.file && wanted.has(font.file)) || isPendingScriptFont(font)
        );

        // A default we asked for and did not get is a silent typeface change,
        // which is precisely BUG-21. Say so rather than quietly loading fewer.
        const got = new Set(minimalFonts.map(f => f.file));
        const missing = MINIMAL_FONT_FILES.filter(f => !got.has(f));
        if (missing.length) {
            console.warn('[Worker] Default font(s) missing from the registry:', missing.join(', '));
        }

        console.log('[Worker] Found', minimalFonts.length, 'default fonts to load');

        let loadedCount = 0;
        let processed = 0;
        for (const font of minimalFonts) {
            const success = await loadSingleFont(font);
            if (success) loadedCount++;
            postFontProgress(++processed, minimalFonts.length);
        }

        fontsLoaded = true;
        console.log('[Worker] Default font loading complete:', loadedCount, 'fonts loaded');
    } catch (e) {
        // B1: the fallback below fetches the registry AND more fonts.
        if (ConversionProtocol.isRateLimitedError(e)) throw e;
        console.error('[Worker] Minimal font setup FAILED:', e.message || String(e));
        // Fall back to full font loading
        console.log('[Worker] Falling back to full font loading...');
        await setupFonts();
    }
}

/**
 * Lazy initialization of LibreOffice
 * Called on first conversion, allows deferring font loading based on target format
 * @param {string} targetFormat - Target output format
 * @param {Array|null} requiredFonts - Optional: specific fonts to load
 */
/**
 * Turn (requested family -> family we ship) pairs into fontconfig rules.
 *
 * Deliberately NOT <alias><prefer>, which is the obvious spelling and does not
 * work here: <prefer> appends with WEAK binding, and LibreOffice adds a strong
 * generic family of its own to every pattern ("sans" for FAMILY_SWISS, "serif"
 * for FAMILY_ROMAN -- vcl/unx/generic/fontmanager/fontconfig.cxx), which then
 * outranks the weakly-bound substitute. Measured: a <prefer> alias for
 * Futura->Jost changed nothing, byte for byte. mode="prepend" binding="same"
 * puts our family first with strong binding, which does win.
 */
function buildSubstitutionRules(pairs) {
    if (!Array.isArray(pairs) || !pairs.length) return '';
    // A character outside the XML 1.0 Char production (a C0 control other than tab/LF/CR, a lone surrogate, U+FFFE/FFFF) makes expat
    // reject the WHOLE config as "not well-formed", and fontconfig then drops every rule silently (WAF review of #713). Names
    // come from documents (CSS bytes, font name tables), so they are filtered here, at the one place that writes them.
    const esc = (s) => String(s)
        .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rules = pairs.map((p) => `\t<match target="pattern">
\t\t<test name="family"><string>${esc(p.requested)}</string></test>
\t\t<edit name="family" mode="prepend" binding="same"><string>${esc(p.family)}</string></edit>
\t</match>`).join('\n');
    return `\n<!-- FM-3: per-document substitutions, generated from the same font\n     resolution that chose which files to mount. -->\n${rules}\n\n`;
}

/**
 * Insert the generated rules into a fonts.conf, immediately before its closing
 * tag. Exported shape kept simple and pure so the gate can exercise THIS
 * function rather than a copy of it.
 *
 * Spliced by index, NOT String.replace(). A string-pattern replace interprets
 * $-sequences in the REPLACEMENT, and the replacement here contains font family
 * names taken straight from the user's document. Measured against the real
 * code: a family named `A$&B` produced "A</fontconfig>amp;B" plus a second
 * </fontconfig>, and one named "P$`Q" injected the entire preceding config into
 * the rule. Either way the file stops being valid XML, and fontconfig discards
 * a malformed config SILENTLY — so every substitution quietly stops working,
 * which is the exact failure this whole feature exists to prevent. Escaping
 * cannot help: `$` is not an XML metacharacter and the damage happens after
 * esc() has run.
 */
function spliceFontConfig(confText, pairs) {
    const rules = buildSubstitutionRules(pairs);
    const close = confText.lastIndexOf('</fontconfig>');
    if (close === -1) return confText;
    return confText.slice(0, close) + rules + confText.slice(close);
}

/**
 * Put fonts.conf where fontconfig actually looks for it.
 *
 * MEASURED 2026-07-31. The worker writes /etc/fonts/fonts.conf and sets
 * Module.ENV.FONTCONFIG_FILE to match. Both are dead:
 *
 *   - external/fontconfig/ExternalProject_fontconfig.mk builds fontconfig with
 *     `--with-baseconfigdir=/instdir/share/fontconfig`, so FcConfigFilename(NULL)
 *     resolves THERE, never at /etc/fonts;
 *   - FONTCONFIG_FILE would override that, but Module.ENV is inert in this build
 *     (Module["ENV"] appears nowhere in the generated soffice.js -- see
 *     web/CLAUDE.md, BUG-11), so the override never reaches the process;
 *   - and /instdir/share/fontconfig/ does not exist in the packaged VFS at all.
 *
 * So the fonts.conf we fetch on every cold start has never been read by anything.
 * Writing it to the real path is the whole fix, and it needs no rebuild.
 *
 * Must run AFTER the packaged VFS is mounted (/instdir does not exist during
 * preRun -- writing there then throws ErrnoError and kills the conversion) and
 * BEFORE init_office(), because fontconfig loads its config once on first use.
 */
/**
 * NTH-13: write the page's own web fonts into the engine's font directory and map the CSS family name each one
 * was declared under to the family the font file really carries (a per-document fontconfig rule, written with the
 * others by writeFontConfigWhereItIsRead). Runs before the engine first lists its fonts: the first conversion of a
 * fresh worker, or (engine snapshot) the start of every conversion. Never throws: a font that cannot be written is
 * reported and the page is drawn with its substitute.
 */
function mountPendingDataFonts() {
    if (!pendingDataFonts || !pendingDataFonts.length) return;
    const pairs = [];
    const dir = '/usr/share/fonts/truetype/pagefonts';
    try { Module.FS.mkdirTree(dir); } catch (e) { /* exists */ }
    for (const f of pendingDataFonts) {
        const path = dir + '/' + f.hash + '.' + (f.kind === 'otf' ? 'otf' : 'ttf');
        try {
            Module.FS.writeFile(path, f.bytes);
            dataFontsMounted.push(path);
            pairs.push({ requested: f.cssFamily, family: f.family });
            console.log('[Worker] Mounted web font from the page:', f.cssFamily, '->', f.family, `(${f.kind}, ${f.bytes.length} bytes, fsType 0x${f.fsType.toString(16)})`);
        } catch (e) {
            console.warn('[Worker] Could not mount web font', f.cssFamily, ':', e && e.message);
            dataFontNotices.push(`This document's web font ${String(f.cssFamily).replace(/[\u0000-\u001f\u007f<>&"]/g, '').slice(0, 60)} isn't included in this conversion; a similar font was used.`);
        }
    }
    pendingDataFonts = null;
    // The page's own font goes FIRST: a rule with mode="prepend" inserts before the family it matched, so the rule written
    // first ends up first. The resolver's guess for the same CSS name (a category fallback) must not outrank the real font.
    if (pairs.length) pendingFontSubstitutions = pairs.concat(pendingFontSubstitutions || []);
}

function writeFontConfigWhereItIsRead(withPageFonts = false) {
    // Only the calls made for a CONVERSION mount the page's fonts: startEngineForSnapshot() calls this before the engine
    // starts and before its snapshot is taken, and a document's font must never be part of the engine's starting state.
    if (withPageFonts) mountPendingDataFonts();
    if (!fontConfigText) {
        // preRun already logs WHY the fetch failed; this logs what it COSTS.
        // Without the base config there is nothing to splice rules into, so
        // every family this document mapped is drawn by glyph fallback instead
        // — and since the conversion still succeeds, the only other symptom is
        // the wrong typeface.
        if (pendingFontSubstitutions && pendingFontSubstitutions.length) {
            console.warn('[Worker] fonts.conf was never loaded, so '
                + `${pendingFontSubstitutions.length} font substitution rule(s) cannot be `
                + 'applied — mapped families will fall back instead of being drawn');
        }
        return;
    }
    try {
        const text = spliceFontConfig(fontConfigText, pendingFontSubstitutions);
        Module.FS.mkdirTree('/instdir/share/fontconfig');
        Module.FS.writeFile('/instdir/share/fontconfig/fonts.conf', text);
        console.log('[Worker] fonts.conf written to fontconfig baseconfigdir'
            + (pendingFontSubstitutions
                ? ` with ${pendingFontSubstitutions.length} substitution rule(s)` : ''));
    } catch (e) {
        // Non-fatal: this is the path that makes substitution rules work, but a
        // conversion without them is still a correct conversion.
        console.warn('[Worker] could not write fontconfig baseconfigdir copy:', e);
    }
}

// ---------------------------------------------------------------------------
// NTH-09: the engine snapshot
//
// What has to come back for the next document to meet the engine exactly as it was
// started, and where each piece lives:
//   - linear memory (everything the C++ engine owns: fonts, caches, statics, heap): copied
//     once, written back after every conversion; memory grown since is zeroed.
//   - mutable WASM globals: the module has two, __stack_pointer and tempRet0 (checked from
//     the binary, NTH-09 PR). Between calls the stack pointer is back at its base
//     (compared below via stackSave()); tempRet0 is a scratch return register.
//   - the function table: fixed size (minimum = maximum), never written; length compared.
//   - exceptions and longjmp: native wasm (-fwasm-exceptions, SUPPORT_LONGJMP=wasm), so
//     there is no JS-side exception state.
//   - the JS runtime (soffice.js): the Emscripten FS (files, mounted fonts, open files,
//     cwd), the keep-alive counter, the main loop (the engine imports
//     emscripten_set_main_loop_arg only for vcl's DoExecute, which LOK never runs), the
//     abort flag, the embind type registry and live embind value handles; compared
//     (engineRuntimeState) and, for the FS, put back.
//   - this worker's own per-document state: reset in restoreEngineSnapshot().
// Settings the engine reads before main() (LANG, the default paper) are part of the
// worker's identity: the driver never reuses a worker started with other settings.
// ---------------------------------------------------------------------------

// A reused engine is replaced instead once its memory has grown past this (linear memory
// never shrinks; a fresh worker gives it back).
const ENGINE_REUSE_MAX_MEMORY = 512 * 1024 * 1024;
// Never walked for snapshot bookkeeping: device and process trees.
const SNAPSHOT_SKIP_DIRS = /^\/(dev|proc)(\/|$)/;
const FONT_FILE_RE = /\.(ttf|otf|ttc|pfa|pfb|woff2?)$/i;

/**
 * Every file and directory in the VFS outside /dev and /proc: path -> "dir", or
 * "size:mtime" for a file (a symlink by its target).
 */
function vfsFileSignatures() {
    const out = new Map();
    const walk = (dir) => {
        let names;
        try { names = Module.FS.readdir(dir); } catch (e) { return; }
        for (const n of names) {
            if (n === '.' || n === '..') continue;
            const p = (dir === '/' ? '' : dir) + '/' + n;
            if (SNAPSHOT_SKIP_DIRS.test(p)) continue;
            let st;
            try { st = Module.FS.lstat(p); } catch (e) { continue; }
            if (Module.FS.isDir(st.mode)) {
                out.set(p, 'dir');
                walk(p);
            } else if (Module.FS.isLink(st.mode)) {
                out.set(p, 'link:' + Module.FS.readlink(p));
            } else {
                out.set(p, st.size + ':' + (+st.mtime));
            }
        }
    };
    walk('/');
    return out;
}

/** The bytes of every regular file, so a file changed after the snapshot can be put back. */
function vfsFileContents(signatures) {
    const out = new Map();
    for (const [p, sig] of signatures) {
        if (sig === 'dir' || sig.startsWith('link:')) continue;
        try {
            out.set(p, { data: Module.FS.readFile(p), mtime: +Module.FS.lstat(p).mtime });
        } catch (e) { /* unreadable: a change to it makes the engine not reusable */ }
    }
    return out;
}

/** fd -> path for every open stream. */
function openStreams() {
    const out = {};
    (Module.FS.streams || []).forEach((st, fd) => { if (st) out[fd] = st.path; });
    return out;
}

/**
 * The streams open at the snapshot: node, path, flags and position. The stream OBJECT may change
 * (a dup2 back onto stdout, as the inline PDF import does, makes a new one on the same node); a
 * different node or path on that number (closed, then reused by another file) may not.
 */
function streamIdentities() {
    const out = new Map();
    (Module.FS.streams || []).forEach((st, fd) => {
        if (st) out.set(fd, { node: st.node, path: st.path, flags: st.flags, position: st.position });
    });
    return out;
}
function sameStream(st, x) {
    return !!st && st.node === x.node && st.path === x.path && st.flags === x.flags;
}

/**
 * The runtime state outside linear memory that must be the same at the snapshot and at
 * every write-back. Each name is a top-level var of soffice.js (a classic script loaded
 * with importScripts, so they are globals here); a missing one reads as null.
 */
function engineRuntimeState() {
    /* global stackSave, runtimeKeepaliveCounter, Browser, ABORT, wasmTable, registeredTypes, emval_handles */
    const read = (f) => { try { return f(); } catch (e) { return null; } };
    return JSON.stringify({
        stackPointer: read(() => stackSave()),
        keepalive: read(() => runtimeKeepaliveCounter),
        mainLoop: read(() => !!Browser.mainLoop.func),
        aborted: read(() => ABORT),
        table: read(() => wasmTable.length),
        cwd: read(() => Module.FS.cwd()),
        embindTypes: read(() => Object.keys(registeredTypes).length),
        // JS values the C++ side holds through embind (val): a handle the engine kept
        // across a conversion would outlive the memory that refers to it.
        emvalHandles: read(() => emval_handles.allocated.length - emval_handles.freelist.length),
    });
}

/**
 * Start the engine for the snapshot: the base fontconfig config and nothing from any
 * document. Refuses on an engine that has already been started or has converted.
 */
function startEngineForSnapshot() {
    if (lokInitialized || engineSnapshot || engineDirty || fontsLoaded || loadedFontFiles.size) {
        throw new Error('engine snapshot refused: the engine has already been started or has seen a document');
    }
    const rules = pendingFontSubstitutions;
    pendingFontSubstitutions = null;
    try {
        writeFontConfigWhereItIsRead();
    } finally {
        pendingFontSubstitutions = rules;
    }
    startEngine(performance.now());
    if (entropyReads > 0) {
        console.warn(`[Worker] Engine snapshot refused: ${entropyReads} entropy read(s) before it, so a `
            + 'generator may be seeded inside it and a write-back would replay its sequence; this engine will not be reused');
        return;
    }
    takeEngineSnapshot();
}

function takeEngineSnapshot() {
    const t0 = realNow();
    try {
        const bytes = new Uint8Array(Module.HEAP8.buffer);
        // Up to the last non-zero 64 KiB block: the memory past it is zero, as a fresh
        // engine's is, and is zeroed again on every write-back.
        const words = new Uint32Array(Module.HEAP8.buffer);
        let end = words.length;
        while (end > 0 && words[end - 1] === 0) end--;
        const length = Math.min(bytes.length, Math.ceil(end * 4 / 65536) * 65536);
        const files = vfsFileSignatures();
        const contents = vfsFileContents(files);
        engineSnapshot = {
            memory: bytes.slice(0, length),
            files,
            contents,
            streams: openStreams(),
            streamIds: streamIdentities(),
            runtime: engineRuntimeState(),
        };
        engineDirty = false;
        let kept = 0;
        for (const c of contents.values()) kept += c.data.length;
        console.log(`[Worker] Engine snapshot taken (entropy reads before it: ${entropyReads}): ${length} of ${bytes.length} bytes of memory, `
            + `${files.size} files and directories (${kept} bytes kept), `
            + `${Object.keys(engineSnapshot.streams).length} open (${[...engineSnapshot.streamIds].map(([fd, x]) => `${fd}@${x.position}`).join(' ')}), `
            + `${(realNow() - t0).toFixed(0)} ms; runtime ${engineSnapshot.runtime}`);
    } catch (e) {
        engineSnapshot = null;
        console.warn('[Worker] Engine snapshot failed; this engine will not be reused:', e);
    }
}

/**
 * Can the next document use this engine? Only when the write-back can make it the
 * engine that was started: the runtime state outside memory is unchanged, no file
 * that existed at the snapshot has changed, and memory has not grown past the limit.
 * Returns null when it can, else the reason.
 */
function engineNotReusableReason() {
    if (!engineSnapshot) return 'no engine snapshot';
    if (engineRestoreFailed) return 'the engine could not be written back, or it trapped';
    for (const [fd, x] of engineSnapshot.streamIds) {
        const st = (Module.FS.streams || [])[fd];
        if (!sameStream(st, x)) return `file descriptor ${fd} is not the one open at the snapshot`;
    }
    const runtime = engineRuntimeState();
    if (runtime !== engineSnapshot.runtime) return `runtime state changed: ${engineSnapshot.runtime} -> ${runtime}`;
    if (Module.HEAP8.length > ENGINE_REUSE_MAX_MEMORY) return `memory grew to ${Module.HEAP8.length} bytes`;
    const now = vfsFileSignatures();
    for (const [p, sig] of engineSnapshot.files) {
        const was = now.get(p);
        if (was === sig) continue;
        // A changed file can be put back only if its bytes were kept; a removed directory
        // or link cannot.
        if (was === undefined || sig === 'dir' || sig.startsWith('link:') || !engineSnapshot.contents.has(p)) {
            return `${was === undefined ? 'removed' : 'changed'} since the snapshot: ${p}`;
        }
    }
    return null;
}

/**
 * Write the snapshot back: memory, the VFS (files and fonts added since removed, streams
 * opened since closed) and this worker's per-document state. Run after every conversion,
 * so the previous document's bytes do not stay in the engine's memory while it waits.
 */
function restoreEngineSnapshot() {
    const t0 = realNow();
    const bytes = new Uint8Array(Module.HEAP8.buffer);
    bytes.set(engineSnapshot.memory);
    if (bytes.length > engineSnapshot.memory.length) bytes.fill(0, engineSnapshot.memory.length);
    const removed = [];
    const now = vfsFileSignatures();
    for (const [p, sig] of now) {
        if (sig === 'dir') continue;
        if (!engineSnapshot.files.has(p)) {
            try { Module.FS.unlink(p); removed.push(p); } catch (e) { /* reported below */ }
        }
    }
    // Every file kept at the snapshot gets its bytes and mtime back, changed or not: a change
    // is not detected by size and mtime alone.
    let putBack = 0;
    for (const [p, c] of engineSnapshot.contents) {
        if (!now.has(p)) continue;
        Module.FS.writeFile(p, c.data);
        Module.FS.utime(p, c.mtime, c.mtime);
        putBack++;
    }
    // directories made since, deepest first
    for (const p of [...now.keys()].filter((q) => now.get(q) === 'dir' && !engineSnapshot.files.has(q))
        .sort((a, b) => b.length - a.length)) {
        try { Module.FS.rmdir(p); } catch (e) { /* reported below */ }
    }
    const closed = [];
    (Module.FS.streams || []).forEach((st, fd) => {
        if (st && !(fd in engineSnapshot.streams)) {
            try { Module.FS.close(st); closed.push(fd); } catch (e) { /* reported below */ }
        }
    });
    // Streams open at the snapshot: their read/write positions live outside linear memory.
    for (const [fd, x] of engineSnapshot.streamIds) {
        const st = (Module.FS.streams || [])[fd];
        if (sameStream(st, x)) st.position = x.position;
    }
    // This worker's own state about the engine and the document, as a fresh worker has it.
    fontsLoaded = false;
    loadedFontFiles.clear();
    pendingScriptFontFiles = new Set();
    pdfOnlyFontRightsUsed = false;
    pendingFontSubstitutions = null;
    const after = vfsFileSignatures();
    const left = [...after.keys()].filter((p) => !engineSnapshot.files.has(p));
    const differ = [...engineSnapshot.files].filter(([p, sig]) => after.get(p) !== sig).map(([p]) => p);
    const open = Object.keys(openStreams()).filter((fd) => !(fd in engineSnapshot.streams));
    for (const [fd, x] of engineSnapshot.streamIds) {
        const st = (Module.FS.streams || [])[fd];
        if (!sameStream(st, x) || st.position !== x.position) open.push(fd + " (not the snapshot's file or position)");
    }
    if (left.length || differ.length || open.length) {
        throw new Error(`VFS not back to the snapshot: left ${left.join(', ') || 'none'}; `
            + `differ ${differ.join(', ') || 'none'}; still open ${open.join(', ') || 'none'}`);
    }
    engineDirty = false;
    console.log(`[Worker] Engine restored to its snapshot in ${(realNow() - t0).toFixed(0)} ms `
        + `(memory ${bytes.length}, ${removed.filter((p) => FONT_FILE_RE.test(p)).length} fonts and `
        + `${removed.filter((p) => !FONT_FILE_RE.test(p)).length} other files removed, ${putBack} put back, `
        + `${closed.length} files closed)`);
}

/**
 * After a conversion (or a failed start): restore, and latch a failure. Never throws. Runs even
 * on a latched engine, so a document's bytes are overwritten whatever happened.
 */
function writeEngineBack() {
    if (!engineSnapshot || !engineDirty) return;
    try {
        restoreEngineSnapshot();
    } catch (e) {
        engineRestoreFailed = true;
        console.error('[Worker] Engine could not be written back to its snapshot:', e);
    }
}

async function ensureLokInitialized(targetFormat, requiredFonts = null) {
    // BUG-10. onRuntimeInitialized already posted a fatal ERROR and returned, but a
    // CONVERT message that was already queued would otherwise arrive here and run
    // against a partially-populated VFS. Throwing routes it through the normal
    // per-conversion error path, so the user gets the specific reason rather than
    // whatever LibreOffice happens to say about a missing registry.
    if (vfsInitError) {
        throw new Error(vfsInitError);
    }
    // B1: a module/font request of this worker was refused; nothing here can work.
    throwIfRateLimited();
    // NTH-09: with a snapshot the engine is always the one just started (first conversion)
    // or written back to it (every later one), so this document's fonts and substitution
    // rules are simply put in place: the engine reads both lazily, after init.
    if (engineSnapshotWanted && !lokInitialized) {
        startEngineForSnapshot();
    }
    if (engineSnapshot) {
        if (formatRequiresFonts(targetFormat)) {
            postMessage({ type: MSG.PROGRESS, stage: 'Loading fonts...', percent: 50 });
            if (requiredFonts && requiredFonts.length > 0) {
                await setupSelectiveFonts(requiredFonts);
            } else {
                await setupMinimalFont();
            }
        }
        writeFontConfigWhereItIsRead(true);   // NTH-13: also mounts the page's own web fonts
        return;
    }
    if (lokInitialized) {
        // Already initialized, but check if we need fonts now but didn't load them before
        const needsFonts = formatRequiresFonts(targetFormat);
        // BUG-12 follow-up: `fontsLoaded` is a single boolean meaning "we loaded
        // SOME fonts once". That was fine when the set never varied, but script
        // fonts are now chosen PER DOCUMENT, so it silently became wrong:
        // convert an ASCII file (loads the 7 Latin faces, sets fontsLoaded), then
        // convert a Chinese file in the SAME worker -- and this function returned
        // early, so the CJK font was never mounted and the text rendered as tofu.
        // Workers are reused across conversions, so that is the ORDINARY flow, not
        // an edge case. It went unnoticed because every test drives a fresh page,
        // i.e. only ever a FIRST conversion.
        // REACHABILITY, measured not assumed: today this branch cannot fire,
        // because conversion_driver.js sets hasConverted after every conversion
        // and `needsFresh = hasConverted || exceededLimit` forces a FRESH worker
        // each time, so lokInitialized is always false here. Verified empirically:
        // two conversions in one page session load the right fonts even with the
        // old guard. This is therefore DEFENCE IN DEPTH, not a live fix -- kept
        // because per-conversion recycling is a stability mitigation, not a design
        // guarantee (see CONVERSION_CONFIG.maxConversionsPerWorker = 4 and its
        // comment), and the moment anyone relaxes it to avoid respawning a ~25MB
        // worker per file, the stale-font-set bug becomes live and silent.
        // Ask the precise question instead: are the fonts THIS job needs mounted?
        const missingFonts = (requiredFonts || []).filter(
            (f) => !loadedFontFiles.has(f.file || f.lazy_path)
        );
        if (needsFonts && (!fontsLoaded || missingFonts.length > 0)) {
            if (fontsLoaded && missingFonts.length > 0) {
                // CORRECTION, measured 2026-07-30: re-initialising does NOT make
                // the engine rescan, and this comment previously claimed it did.
                // Instrumented run with worker reuse ON, simple.txt then
                // utf8_korean.txt in one worker: hangul was detected,
                // shutdown_office() completed cleanly (all five teardown steps,
                // post-BUG-20), NanumGothic-Regular.ttf mounted ("1 loaded, 24
                // cached"), init_office() returned success -- and the PDF still
                // embedded ONLY LiberationMono with every Hangul glyph an empty
                // box. The font list lives in an engine static that
                // shutdown_office() does not clear, so a font mounted after first
                // enumeration cannot take effect in this worker at all.
                //
                // The real fix therefore lives in the driver, which now refuses to
                // reuse a worker for a document needing fonts that worker never
                // enumerated (see `mountedFonts` / the font-boundary guard in
                // conversion_driver.js, gated by tests/gates/test_worker_reuse.js).
                // This branch is kept as defence in depth for the case where the
                // driver's set and the worker's disagree, but do NOT rely on it to
                // recover a missing font -- it cannot.
                console.log('[Worker] New script font(s) needed for this document:',
                            missingFonts.map((f) => f.file || f.lazy_path).join(', '),
                            '— re-initializing (note: engine will NOT re-enumerate fonts; '
                            + 'the driver is expected to have given us a fresh worker)');
            } else {
                console.log('[Worker] LOK initialized without fonts, but now need fonts. Re-initializing...');
            }
            // Must shutdown and re-init with fonts
            try {
                const shutdown_office = Module.cwrap('shutdown_office', null, []);
                shutdown_office();
                console.log('[Worker] shutdown_office() called for re-init with fonts');
                lokInitialized = false;
            } catch (e) {
                console.error('[Worker] Failed to shutdown for re-init:', e);
            }
        } else {
            return; // Already initialized with correct font state
        }
    }

    console.log('[Worker] Lazy LOK initialization starting...');
    const startTime = performance.now();

    // Load fonts if needed for this target format
    const needsFonts = formatRequiresFonts(targetFormat);
    if (needsFonts) {
        postMessage({ type: MSG.PROGRESS, stage: 'Loading fonts...', percent: 50 });
        if (requiredFonts && requiredFonts.length > 0) {
            await setupSelectiveFonts(requiredFonts);
        } else {
            await setupMinimalFont();
        }
    } else {
        console.log('[Worker] Target format', targetFormat, 'does not require fonts, skipping font loading');
        postMessage({ type: MSG.PROGRESS, stage: 'Skipping fonts (not needed)...', percent: 50 });
    }

    writeFontConfigWhereItIsRead(true);   // NTH-13: also mounts the page's own web fonts

    // Now initialize LibreOffice
    startEngine(startTime);
}

/** init_office(); throws with the bridge's categorized error when it fails. */
function startEngine(startTime) {
    try {
        postMessage({ type: MSG.PROGRESS, stage: 'Starting LibreOffice engine...', percent: 70 });
        console.log('[Worker] Calling init_office...');
        const init_office = Module.cwrap('init_office', 'number', ['string']);
        const status = init_office('/instdir/program');
        console.log('[Worker] init_office returned:', status);

        if (status === 1) {
            lokInitialized = true;
            const elapsed = (performance.now() - startTime).toFixed(0);
            console.log('[Worker] LOK lazy initialization complete in', elapsed, 'ms');
        } else {
            // H11: surface the categorized bridge init error when available.
            const detail = ConversionProtocol.readBridgeError(Module);
            throw new Error(detail || 'init_office returned 0');
        }
    } catch (err) {
        console.error('[Worker] LOK lazy init failed:', err);
        throw err;
    }
}

// Diagnostic function to check VFS for critical files
function checkVFS() {
    const criticalPaths = [
        '/instdir/program/bootstraprc',
        '/instdir/program/fundamentalrc',
        '/instdir/program/versionrc',
        '/instdir/program/services.rdb',
        '/instdir/program/services/services.rdb',  // Application services (writerfilter etc)
        '/instdir/program/types.rdb',
        '/instdir/program/types/offapi.rdb',
        '/instdir/share/registry/main.xcd',
        '/instdir/share/registry/writer.xcd',
        '/etc/fonts/fonts.conf'
    ];
    console.log('[VFS] Checking critical files...');
    criticalPaths.forEach(path => {
        try {
            const stat = Module.FS.stat(path);
            console.log('[VFS] Found:', path, '(size:', stat.size, ')');
        } catch(e) {
            console.error('[VFS] MISSING:', path);
        }
    });
}

/**
 * BUG-10. Files whose presence (non-empty) means the package has been unpacked far
 * enough to initialise LibreOffice. Readiness used to be inferred from main.xcd
 * ALONE, which proves only that the packager reached one entry.
 *
 * All nine are verified present in EVERY module's package — checked against
 * web/modules/<m>/soffice.data.js.metadata for documents, spreadsheets,
 * presentations, pdf-docx and pdf-pptx — so gating on them cannot fail for a
 * module simply because it does not ship one of them. That check matters: this
 * list is now load-bearing, and a module-specific path here would brick that
 * module. `/etc/fonts/fonts.conf` is deliberately NOT in the list even though
 * checkVFS() probes it: it is not in the package at all, it is written during
 * preRun, so requiring it would test the wrong thing.
 */
const REQUIRED_VFS_PATHS = [
    '/instdir/program/bootstraprc',
    '/instdir/program/fundamentalrc',
    '/instdir/program/versionrc',
    '/instdir/program/services.rdb',
    '/instdir/program/services/services.rdb',
    '/instdir/program/types.rdb',
    '/instdir/program/types/offapi.rdb',
    '/instdir/share/registry/main.xcd',
    '/instdir/share/registry/writer.xcd'
];

/**
 * Wait for the VFS to be populated. Resolves {ready, missing, waitedMs}.
 *
 * The budget is generous ON PURPOSE. It used to be 15 s, and a false timeout was
 * harmless because the caller logged "trying anyway" and carried on. Now a timeout
 * aborts the conversion with an error, so a slow device must not be able to trip it:
 * unpacking is a memcpy out of an already-downloaded blob, so anything approaching
 * 30 s means the population genuinely is not happening, not that the device is slow.
 */
async function waitForVFS(maxWaitMs = 30000, checkIntervalMs = 100) {
    const startTime = realNow();
    let missing = REQUIRED_VFS_PATHS.slice();

    console.log('[VFS] Waiting for VFS to be fully populated...');

    while (realNow() - startTime < maxWaitMs) {
        missing = REQUIRED_VFS_PATHS.filter((p) => {
            try {
                return !(Module.FS.stat(p).size > 0);
            } catch (e) {
                return true;   // not there yet (or not a stat-able node)
            }
        });
        if (missing.length === 0) {
            console.log('[VFS] all', REQUIRED_VFS_PATHS.length, 'required files populated after',
                        realNow() - startTime, 'ms');
            return { ready: true, missing: [], waitedMs: realNow() - startTime };
        }
        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    }

    console.error('[VFS] Timeout waiting for VFS population after', maxWaitMs, 'ms —',
                  `still missing/empty: ${missing.join(', ')}`);
    return { ready: false, missing, waitedMs: realNow() - startTime };
}

/**
 * Determine the paths for the module's files
 * Note: Paths must be absolute (start with /) because worker is in js/ subdirectory
 */
function getModulePaths(moduleName, config) {
    if (config) {
        // Use paths from config, make absolute if not already. The fallback
        // stem below only matters when config is missing one of these three
        // fields individually (config normally supplies all three) — derive it
        // from whichever field IS present instead of assuming 'soffice'.
        const makeAbsolute = (p) => p.startsWith('/') ? p : '/' + p;
        const stem = deriveArtifactStem(config.wasm || config.js || config.data);
        return {
            js: makeAbsolute(config.js || `modules/${moduleName}/${stem}.js`),
            wasm: makeAbsolute(config.wasm || `modules/${moduleName}/${stem}.wasm`),
            data: makeAbsolute(config.data || `modules/${moduleName}/${stem}.data`)
        };
    }

    // Default/legacy paths (absolute)
    if (moduleName === 'default') {
        return {
            js: '/soffice.js',
            wasm: '/soffice.wasm',
            data: '/soffice.data'
        };
    }

    // Standard module paths: /modules/{moduleName}/soffice.*
    return {
        js: `/modules/${moduleName}/soffice.js`,
        wasm: `/modules/${moduleName}/soffice.wasm`,
        data: `/modules/${moduleName}/soffice.data`
    };
}

// Module directory URL — used for locateFile, importScripts, and mainScriptUrlOrBlob.
// Computed from worker URL which lives in modules/<name>/ directory.
const workerDir = self.location.href.substring(0, self.location.href.lastIndexOf('/') + 1);

// Set up Module config for main worker only
if (!isPThread) {
    // NOTE: wasmMemory injection disabled because builds were not compiled with -sIMPORTED_MEMORY.
    // The WASM modules manage their own memory internally. This may cause issues with V8's
    // compiled module cache on sequential conversions, but would require rebuild to fix.
    // See: bugs/WASM_THREADING_PATTERNS.md for details on build configuration.

    self.Module = {
        // Pre-define ENV with fontconfig paths BEFORE soffice.js loads
        ENV: {
            'FONTCONFIG_FILE': '/etc/fonts/fonts.conf',
            'FONTCONFIG_PATH': '/etc/fonts',
            'HOME': '/tmp'
        },
        // preRun executes BEFORE main() - use sync XHR to load fonts.conf
        preRun: [function() {
            console.log('[Worker] preRun: Setting up fonts synchronously...');

            // Create directories
            try { Module.FS.mkdirTree('/etc/fonts'); } catch(e) {}
            try { Module.FS.mkdirTree('/var/cache/fontconfig'); } catch(e) {}
            try { Module.FS.mkdirTree('/usr/share/fonts/truetype/liberation'); } catch(e) {}
            try { Module.FS.mkdirTree('/usr/share/fonts/truetype/dejavu'); } catch(e) {}
            try { Module.FS.mkdirTree('/tmp'); } catch(e) {}

            // Create Impress/Draw/Math VFS directories that may be missing from soffice.js
            // These are needed for sdraw, simpress, and smath modules
            const impressDirs = [
                '/instdir/share/config/soffice.cfg/modules/sdraw/menubar',
                '/instdir/share/config/soffice.cfg/modules/sdraw/popupmenu',
                '/instdir/share/config/soffice.cfg/modules/sdraw/statusbar',
                '/instdir/share/config/soffice.cfg/modules/sdraw/toolbar',
                '/instdir/share/config/soffice.cfg/modules/sdraw/ui',
                '/instdir/share/config/soffice.cfg/modules/simpress/menubar',
                '/instdir/share/config/soffice.cfg/modules/simpress/popupmenu',
                '/instdir/share/config/soffice.cfg/modules/simpress/statusbar',
                '/instdir/share/config/soffice.cfg/modules/simpress/toolbar',
                '/instdir/share/config/soffice.cfg/modules/simpress/ui',
                '/instdir/share/config/soffice.cfg/modules/smath/menubar',
                '/instdir/share/config/soffice.cfg/modules/smath/popupmenu',
                '/instdir/share/config/soffice.cfg/modules/smath/statusbar',
                '/instdir/share/config/soffice.cfg/modules/smath/toolbar',
                '/instdir/share/config/soffice.cfg/modules/smath/ui',
                '/instdir/share/config/soffice.cfg/simpress',
                '/instdir/share/themes'
            ];
            for (const dir of impressDirs) {
                try { Module.FS.mkdirTree(dir); } catch(e) {}
            }

            // Load fonts.conf synchronously (sync XHR works in workers)
            try {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', FONT_CONFIG_URL, false);  // false = synchronous
                xhr.send(null);
                if (ConversionProtocol.isRateLimitStatus(xhr.status)) {
                    // B1: the send() hook has normally latched and reported this
                    // already (both calls are idempotent); onRuntimeInitialized
                    // then withholds the ready signal.
                    let header = null;
                    try { header = xhr.getResponseHeader('Retry-After'); } catch (e2) { header = null; }
                    noteRateLimit(ConversionProtocol.rateLimitedError(
                        ConversionProtocol.parseRetryAfter(header, realNow())));
                    reportRateLimited();
                } else if (xhr.status === 200) {
                    Module.FS.writeFile('/etc/fonts/fonts.conf', xhr.responseText);
                    fontConfigText = xhr.responseText;
                    console.log('[Worker] preRun: fonts.conf loaded');
                } else {
                    console.warn('[Worker] preRun: fonts.conf fetch failed:', xhr.status);
                }
            } catch (e) {
                console.warn('[Worker] preRun: fonts.conf error:', e);
            }

            console.log('[Worker] preRun: Directories and fonts.conf ready');

            // BUG-11 / FG-164: before main(), so the engine's first page-size
            // question already finds it.
            writeDefaultPaperPin(Module.FS);
            setEngineLocale();
            setEngineEotSwitch();   // FG-054
            setEngineDocumentPasswordSwitch();   // FG-021
        }],
        onRuntimeInitialized: async function() {
            console.log('[Worker] Wasm Runtime Initialized. Preparing for lazy LOK init...');
            postMessage({ type: MSG.PROGRESS, stage: 'WebAssembly compiled, configuring...', percent: 30 });

            // CRITICAL: Wait for VFS to be fully populated before checking/using files
            // This is needed because Emscripten's data file extraction may not be complete
            // even when onRuntimeInitialized fires
            postMessage({ type: MSG.PROGRESS, stage: 'Extracting data files...', percent: 40 });
            console.log('[Worker] About to call waitForVFS...');
            let vfsReady = false;
            try {
                const vfs = await waitForVFS(30000, 200);
                vfsReady = vfs.ready;
                if (!vfs.ready) {
                    // BUG-10. This used to log "trying anyway" and carry on, which is
                    // the silent failure this project forbids: the engine would be
                    // initialised against a partially-populated filesystem and the
                    // user got either a mystery error from deep inside LibreOffice or,
                    // worse, a plausible-looking document produced without the
                    // registry that defines its filters.
                    //
                    // Failing here is not a new failure mode — an unpopulated VFS
                    // could not have converted anything anyway. It replaces an
                    // undefined outcome with a stated one, and names the missing
                    // files so the cause is diagnosable from a user's console rather
                    // than requiring a repro.
                    vfsInitError = 'The conversion engine could not finish loading: '
                        + `${vfs.missing.length} required file(s) never became available `
                        + `after ${Math.round(vfs.waitedMs / 1000)}s `
                        + `(${vfs.missing.join(', ')}). Please reload the page and try again.`;
                    console.error('[Worker] FATAL:', vfsInitError);
                    postMessage({ type: MSG.ERROR, error: vfsInitError,
                        id: activeConvertId, fatal: true });
                    return;   // do not inject components or init LOK on a broken VFS
                }
            } catch (vfsErr) {
                // A throw here is itself a broken-VFS signal (Module.FS absent, etc.)
                // and must not be swallowed either.
                vfsInitError = `The conversion engine could not finish loading: ${vfsErr
                    && vfsErr.message || String(vfsErr)}. Please reload the page and try again.`;
                console.error('[Worker] FATAL: waitForVFS threw:', vfsErr);
                postMessage({ type: MSG.ERROR, error: vfsInitError,
                    id: activeConvertId, fatal: true });
                return;
            }

            // Component injection based on module type (AFTER VFS is ready)
            // - Documents module: components already in services.rdb from build
            // - Spreadsheets module: Calc components may be missing (build system issue), inject them
            // - Presentations module: Impress Oasis XML importers missing from services.rdb
            if (moduleName === 'spreadsheets' && vfsReady) {
                console.log('[Worker] Injecting Calc components into services.rdb');
                injectCalcComponents();
            } else if ((moduleName === 'presentations' || moduleName === 'pdf-pptx') && vfsReady) {
                console.log('[Worker] Injecting Impress/Draw components into services.rdb');
                injectImpressComponents();
            }
            // The former third branch — "VFS not ready, forcing component injection"
            // — is gone with BUG-10. It existed to salvage the "trying anyway" path,
            // and it cannot be reached now: !vfsReady returns above. Injecting
            // components into a services.rdb that may not be fully written was never
            // a salvage anyway, just a second undefined state layered on the first.

            // LAZY INIT: Don't load fonts or call init_office here!
            // Fonts and LOK initialization are deferred until first conversion.
            // This saves ~1MB bandwidth for TXT/CSV conversions that don't need fonts.
            // See: bugs/fonts_loaded_unconditionally.md
            console.log('[Worker] Deferring font loading and LOK init until conversion (lazy init)');

            // Check VFS for critical files
            console.log('[Worker] About to call checkVFS...');
            checkVFS();

            // B1: a request made while loading was refused (e.g. fonts.conf in
            // preRun). Already reported; a "ready" now would let the driver send
            // a conversion that can only fail after more requests.
            if (rateLimitHit) {
                reportRateLimited();
                return;
            }

            // Signal that module is ready for conversion requests
            // LOK will be initialized lazily on first CONVERT message
            postMessage({ type: MSG.PROGRESS, stage: 'ready', percent: 100 });
            console.log('[Worker] Module ready. LOK will initialize on first conversion.');
            postMessage({ type: MSG.LOK_READY });  // Keep same message for compatibility
        },
        onAbort: function(what) {
            console.error('[Worker] WASM ABORT:', what);
            // B1: Emscripten's wasm loader aborts with "both async and sync
            // fetching of the wasm failed", which has lost the HTTP status. The
            // fetch wrapper recorded it; report the real cause instead.
            if (rateLimitHit) {
                reportRateLimited();
                return;
            }
            let stackTrace = '';
            try {
                throw new Error('Abort context');
            } catch(e) {
                stackTrace = e.stack || '';
                console.error('[Worker] Stack at abort:', stackTrace);
            }

            // Analyze stack trace to provide more helpful error messages
            let errorMsg = 'WASM Abort: ' + String(what);

            // Detect add-in formula errors (external functions not available in WASM)
            if (stackTrace.includes('ScUnoAddInCall') || stackTrace.includes('ScInterpreter::ScExternal')) {
                // BUG-30: WORKDAY/NETWORKDAYS and the other built-in add-ins DO run in the
                // browser since #132, so this no longer names them as unsupported. An abort
                // here is an unexpected failure in an add-in call, reported as such.
                errorMsg = 'The conversion stopped while calculating one of this spreadsheet\'s add-in formulas. ' +
                    'Try opening the file in Excel or LibreOffice Desktop and replacing add-in formulas with their calculated values, or export to PDF from the desktop application.';
            }
            // Detect assertion failures
            else if (typeof what === 'string' && what.includes('Assertion')) {
                errorMsg += ' (Check browser console for details)';
            }

            // A WASM abort kills the Emscripten runtime — tag id + fatal so the
            // driver rejects the active conversion with this curated message
            // (which wins over the raw RuntimeError CONVERT_ERROR that follows)
            // and tears the poisoned worker out of the pool (H4).
            postMessage({ type: MSG.ERROR, error: errorMsg, id: activeConvertId, fatal: true });
        },
        print: function(text) { console.log(`[Wasm stdout] ${text}`); },
        printErr: function(text) { console.error(`[Wasm stderr] ${text}`); },
        // Monitor run dependencies (disabled - too verbose for production)
        // Uncomment for debugging WASM initialization issues:
        // monitorRunDependencies: function(left) {
        //     console.log('[Worker] Run dependencies remaining:', left);
        // },
        dynamicLibraries: [],
        locateFile: function(path, prefix) {
            // For multi-module setup, use module directory for all resources
            // Use workerDir which is computed from the worker URL at script load time
            // If content-addressed hashed filenames are available, use them
            // so browsers/CDNs can cache with immutable headers
            if (hashedFiles) {
                // Emscripten's own glue script passes back whatever stem IT was
                // built with (e.g. '<artifact_prefix>.wasm'), which is always the
                // same stem moduleConfig.wasm advertises — see web/js/artifact_stem.js.
                const stem = deriveArtifactStem(moduleConfig && moduleConfig.wasm);
                if (path === stem + '.wasm' && hashedFiles.wasm) return workerDir + hashedFiles.wasm;
                if (path === stem + '.data' && hashedFiles.data) return workerDir + hashedFiles.data;
            }
            return workerDir + path;
        },
        // Custom WASM instantiation hook - DISABLED for debugging
        // instantiateWasm will be dynamically added only when freshWasmBinary is set
    };
}

// Define ENV global before loading soffice.js (it uses ENV.SAL_LOG in preRun)
if (typeof ENV === 'undefined') {
    self.ENV = {};
}

/**
 * Best-effort HTTP status of a script loaded with importScripts(), from Resource
 * Timing (PerformanceResourceTiming.responseStatus). 0 when unknown.
 * @param {string} url
 * @returns {number}
 */
function importedScriptStatus(url) {
    try {
        if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') return 0;
        const abs = new URL(url, self.location.href).href;
        const entries = performance.getEntriesByName(abs);
        const last = entries && entries[entries.length - 1];
        return (last && typeof last.responseStatus === 'number') ? last.responseStatus : 0;
    } catch (e) {
        return 0;
    }
}

/**
 * Load the module's JS glue code
 */
function loadModuleScript() {
    // B1: a script this worker loaded earlier was refused; do not ask for the module.
    if (rateLimitHit) { reportRateLimited(); return; }
    const paths = getModulePaths(moduleName, moduleConfig);
    // Use hashed JS filename for immutable CDN caching if available
    const jsUrl = (hashedFiles && hashedFiles.js) ? (workerDir + hashedFiles.js) : paths.js;
    console.log('[Worker] Loading module script:', jsUrl);

    if (!isPThread) {
        postMessage({ type: MSG.PROGRESS, stage: `Downloading ${moduleName} module (~25MB)...`, percent: 5 });
    }

    try {
        importScripts(jsUrl);
        console.log('[Worker] Module script imported successfully:', jsUrl);
        if (!isPThread) {
            postMessage({ type: MSG.PROGRESS, stage: `Compiling WebAssembly...`, percent: 15 });
        }
    } catch (e) {
        console.error('[Worker] Failed to import module script:', jsUrl, e);
        if (!isPThread) {
            // B1: importScripts reports no status. Resource Timing's responseStatus
            // does, in browsers that implement it; elsewhere this finds nothing and
            // the generic message below stands. No extra request is made to ask.
            const status = importedScriptStatus(jsUrl);
            if (ConversionProtocol.isRateLimitStatus(status)) {
                noteRateLimit(ConversionProtocol.rateLimitedError(ConversionProtocol.RETRY_AFTER_DEFAULT_SEC));
                reportRateLimited();
                return;
            }
            postMessage({ type: MSG.ERROR, error: `Failed to import ${jsUrl}: ${e.message}` });
        }
    }
}

/**
 * Add a unique custom section to a WASM binary to force V8 to recompile it.
 * This bypasses V8's compiled code cache which persists static state.
 * @param {ArrayBuffer} wasmBinary - Original WASM binary
 * @returns {ArrayBuffer} - Modified WASM binary with unique custom section
 */
function addUniqueCustomSection(wasmBinary) {
    const original = new Uint8Array(wasmBinary);

    // Custom section format:
    // - 1 byte: section ID (0 for custom section)
    // - LEB128: section size
    // - LEB128: name length
    // - name bytes
    // - payload bytes (our unique timestamp)

    const sectionName = 'fresh_wasm_bypass';
    const timestamp = realNow().toString() + '_' + Math.random().toString(36).substr(2, 9);
    const nameBytes = new TextEncoder().encode(sectionName);
    const payloadBytes = new TextEncoder().encode(timestamp);

    const contentSize = nameBytes.length + payloadBytes.length + 1; // +1 for name length byte
    const sectionSizeBytes = [];

    // Encode section size as LEB128
    let size = contentSize;
    do {
        let byte = size & 0x7f;
        size >>= 7;
        if (size !== 0) byte |= 0x80;
        sectionSizeBytes.push(byte);
    } while (size !== 0);

    // Build custom section: ID (0) + size + name_len + name + payload
    const customSection = new Uint8Array([
        0,  // Custom section ID
        ...sectionSizeBytes,
        nameBytes.length,
        ...nameBytes,
        ...payloadBytes
    ]);

    // Append custom section to the end of the WASM binary
    const result = new Uint8Array(original.length + customSection.length);
    result.set(original);
    result.set(customSection, original.length);

    console.log('[Worker] Added unique custom section to WASM binary (' +
                customSection.length + ' bytes, timestamp: ' + timestamp + ')');
    return result.buffer;
}

// Content-addressable hashed filenames (set in INIT handler)
// When modules.json provides hashes, these override default filenames
// in locateFile(), importScripts(), and mainScriptUrlOrBlob
let hashedFiles = null;

// Store forceFreshWasm flag for the module loading process
let forceFreshWasm = false;
let freshWasmBinary = null;

// Set up message handler for main worker (for INIT and CONVERT messages)
if (!isPThread) {
    let isModuleLoading = false;

    self.addEventListener('message', async function(e) {
        const msg = e.data;
        console.log('[Worker] Received message type:', msg.type);

        if (msg.type === MSG.INIT) {
            // Initialize with module config from driver
            moduleName = msg.moduleName || 'default';
            moduleConfig = msg.moduleConfig || null;
            forceFreshWasm = msg.forceFreshWasm || false;
            // Conversion settings (CONTRACT_VERSION 2): both are required and
            // must be values the resolver can produce. Refuse, never guess.
            const settingsError =
                (ConversionProtocol.PAPER_SIZES.indexOf(msg.paperSize) < 0) ? 'paperSize'
                : (!ConversionProtocol.toPosixLocale(msg.formatLocale)) ? 'formatLocale'
                : null;
            if (settingsError) {
                const bad = settingsError === 'paperSize' ? msg.paperSize : msg.formatLocale;
                postMessage({
                    type: MSG.ERROR, id: null, fatal: true,
                    code: 'INVALID_SETTINGS', field: settingsError,
                    error: 'INVALID_SETTINGS: INIT ' + settingsError + ' ' + JSON.stringify(bad === undefined ? null : bad) +
                           ' is not a valid value (ConversionProtocol.resolveConversionSettings produces it)'
                });
                return;
            }
            pinnedPaper = msg.paperSize;
            engineLang = ConversionProtocol.toPosixLocale(msg.formatLocale);
            // NTH-09 (optional, additive): absent means no snapshot, as before.
            engineSnapshotWanted = msg.engineSnapshot === true;
            allowEmbeddedEot = msg.allowEmbeddedEot === true;   // FG-054
            engineKey = ConversionProtocol.isEngineKey && ConversionProtocol.isEngineKey(msg.engineKey) ? msg.engineKey : null;   // FEAT-16, optional
            allowDocumentPasswords = msg.allowDocumentPasswords === true;   // FG-021
            // BUG-68 (B): optional, additive. Absent means the module family's default ceiling, so a host that sends nothing (the MCP) has it;
            // 0 means none (the website's kill switch). Installed before the engine loads, so its first growth is already counted.
            memoryCeilingBytes = ConversionProtocol.memoryCeilingMB(moduleName, msg.memoryCeilingMB) * 1024 * 1024;
            if (memoryCeilingBytes > 0 && !memoryGuardInstalled && typeof WebAssembly !== 'undefined' && WebAssembly.Memory && WebAssembly.Memory.prototype
                && typeof WebAssembly.Memory.prototype.grow === 'function') {
                WebAssembly.Memory.prototype.grow = ConversionProtocol.guardMemoryGrow(WebAssembly.Memory.prototype.grow, () => memoryCeilingBytes, (r) => {
                    // the glue retries a refused growth with smaller over-growth: the first refusal of a conversion is the one reported
                    if (memoryRefusal) return;
                    memoryRefusal = r;
                    console.log('[Worker] MEMORY CEILING: refused a growth from ' + Math.round(r.currentBytes / 1048576) + ' MB to ' + Math.round(r.requestedBytes / 1048576) + ' MB (ceiling ' + Math.round(r.ceilingBytes / 1048576) + ' MB)');
                });
                memoryGuardInstalled = true;
            }
            
            // Set appRoot and update font paths
            if (msg.appRoot) {
                appRoot = msg.appRoot;
                FONT_REGISTRY_URL = appRoot + 'fonts/fonts.json';
                FONT_CONFIG_URL = appRoot + 'fonts/fonts.conf';
            }

            // Store content-addressed hashed filenames (if provided by pipeline)
            // These override default filenames in locateFile, importScripts, etc.
            if (msg.hashedFiles) {
                hashedFiles = msg.hashedFiles;
            }

            console.log('[Worker] Initializing with module:', moduleName,
                        moduleConfig, forceFreshWasm ? '(forcing fresh WASM)' : '',
                        hashedFiles ? '(content-addressed)' : '',
                        msg.wasmBinary ? '(pre-fetched WASM)' : '');

            if (!isModuleLoading) {
                isModuleLoading = true;

                // Resolve WASM binary from one of three sources:
                // 1. Pre-fetched by driver (from IndexedDB cache or delta patch)
                // 2. Fetched here for forceFreshWasm (V8 cache bypass)
                // 3. Let Emscripten fetch normally (no binary provided)
                let wasmBinary = msg.wasmBinary || null;

                if (forceFreshWasm) {
                    if (wasmBinary) {
                        // Modify the pre-fetched binary to bypass V8's compiled code cache
                        wasmBinary = addUniqueCustomSection(wasmBinary);
                        console.log('[Worker] Modified pre-fetched WASM for fresh instantiation (' +
                                    (wasmBinary.byteLength / (1024*1024)).toFixed(1) + ' MB)');
                    } else {
                        // No pre-fetched binary — fetch and modify ourselves (legacy path)
                        console.log('[Worker] Fetching WASM binary for fresh instantiation...');
                        try {
                            const wasmFile = (hashedFiles && hashedFiles.wasm)
                                ? hashedFiles.wasm
                                : deriveArtifactStem(moduleConfig && moduleConfig.wasm) + '.wasm';
                            const wasmUrl = workerDir + wasmFile;
                            const response = await fetch(wasmUrl);
                            checkRateLimitedResponse(response);   // B1
                            if (!response.ok) throw new Error('Failed to fetch WASM: ' + response.status);
                            const originalBinary = await response.arrayBuffer();
                            wasmBinary = addUniqueCustomSection(originalBinary);
                            console.log('[Worker] Fresh WASM binary ready (' +
                                        (wasmBinary.byteLength / (1024*1024)).toFixed(1) + ' MB)');
                        } catch (e) {
                            if (ConversionProtocol.isRateLimitedError(e)) {
                                // B1: do NOT fall back to Emscripten's loader — it
                                // would request the same .wasm again.
                                reportRateLimited();
                                return;
                            }
                            console.error('[Worker] Failed to prepare fresh WASM:', e);
                            wasmBinary = null;  // Fall back to normal Emscripten loading
                        }
                    }
                }

                // If we have a WASM binary (from any source), install instantiateWasm hook
                // so Emscripten uses our binary instead of fetching its own
                if (wasmBinary) {
                    freshWasmBinary = wasmBinary;
                    Module.instantiateWasm = function(imports, successCallback) {
                        console.log('[Worker] instantiateWasm: Using provided WASM binary (' +
                                    (freshWasmBinary.byteLength / (1024*1024)).toFixed(1) + ' MB)');
                        WebAssembly.instantiate(freshWasmBinary, imports)
                            .then(result => {
                                console.log('[Worker] WASM instantiated successfully');
                                successCallback(result.instance, result.module);
                            })
                            .catch(err => {
                                console.error('[Worker] WASM instantiation failed:', err);
                                throw err;
                            });
                        return {};  // Return empty object to indicate we're handling it
                    };
                    console.log('[Worker] instantiateWasm hook installed');
                }

                loadModuleScript();
            }
        }
        else if (msg.type === MSG.SHUTDOWN) {
            console.log('[Worker] Received SHUTDOWN - cleaning up...');
            try {
                // Call C++ shutdown to release LOK office instance
                if (Module && Module.cwrap && lokInitialized) {
                    const shutdown_office = Module.cwrap('shutdown_office', null, []);
                    shutdown_office();
                    console.log('[Worker] shutdown_office() called');
                }
                // Reset initialization state
                lokInitialized = false;
                fontsLoaded = false;
            } catch (e) {
                console.warn('[Worker] Shutdown error (non-fatal):', e);
            }
            postMessage({ type: MSG.SHUTDOWN_COMPLETE });
            return;
        }
        else if (msg.type === MSG.CONVERT) {
            const { id, fileData, fileName, requiredFonts } = msg;
            let options = msg.options;   // CB-012 may replace the CSV delimiter below, never anything else
            // The bridge compares exact lower-case names ("pdf"); a host that sends "PDF" must get the same branch (WAF nit on #715).
            const targetFormat = ConversionProtocol.normalizeTargetFormat(msg.targetFormat);
            // One conversion at a time: a second CONVERT while one is running (e.g. during its
            // font fetch) would unmount the first one's fonts at its write-back.
            if (activeConvertId !== null) {
                postMessage({ type: MSG.CONVERT_ERROR, id, code: 'WORKER_BUSY',
                    error: 'WORKER_BUSY: this worker is converting another document' });
                return;
            }
            // Conversion time (CONTRACT_VERSION 3, docs/design/conversion-time.md
            // §6): required, and refused BEFORE the document is read or the
            // engine started — never guessed at, and the driver does not retry
            // it (it is neither a stall nor a WASM trap). Same shape as INIT's
            // INVALID_SETTINGS, on the conversion's own reply.
            const timeSetting = ConversionProtocol.parseConversionTime(msg.conversionTime);
            if (!timeSetting.ok) {
                postMessage({
                    type: MSG.CONVERT_ERROR, id,
                    code: 'INVALID_SETTINGS', field: 'conversionTime',
                    error: 'INVALID_SETTINGS: CONVERT conversionTime ' +
                           JSON.stringify(msg.conversionTime === undefined ? null : msg.conversionTime) +
                           ' is not a valid value (' + timeSetting.reason + '; ConversionProtocol.parseConversionTime)'
                });
                return;
            }
            // FG-021 (§2, §6): passwords arrive in CONVERT's own `secrets` field, never in
            // `options`. They stay in this handler: never in a worker global, a log line or
            // an error text (validateConversionSecrets names the field, never the value).
            // Refused BEFORE the document is read, like conversionTime above.
            const secrets = msg.secrets;
            const secretsCheck = ConversionProtocol.validateConversionSecrets(secrets, targetFormat);
            if (!secretsCheck.ok) {
                postMessage({
                    type: MSG.CONVERT_ERROR, id, code: secretsCheck.code, field: secretsCheck.field,
                    error: secretsCheck.code + ': ' + secretsCheck.message
                });
                return;
            }
            // Fail closed until this worker applies passwords (WORKER_APPLIES_SECRETS, above)
            // AND the engine supports them (the bridge's set_conversion_secrets, design §4.1;
            // ConversionProtocol.FEATURES lists them then): a password is never silently
            // ignored, least of all an output password, which would hand back an unprotected
            // file the user believes is protected.
            const engineTakesSecrets = typeof Module !== 'undefined' && Module
                && typeof Module._set_conversion_secrets === 'function';
            if (ConversionProtocol.hasConversionSecrets(secrets) && !(WORKER_APPLIES_SECRETS && engineTakesSecrets)) {
                const codes = ConversionProtocol.PASSWORD_ERROR_CODES;
                const code = secrets.outputProtection !== undefined ? codes.OUTPUT_PROTECTION_UNSUPPORTED : codes.PASSWORD_UNSUPPORTED;
                postMessage({
                    type: MSG.CONVERT_ERROR, id, code,
                    error: code + ': this engine cannot ' +
                           (secrets.outputProtection !== undefined ? 'password-protect its output' : 'open password-protected files') + ' yet'
                });
                return;
            }
            // NTH-09: an engine that could not be written back to its snapshot converts
            // nothing more; the driver sends no CONVERT to a worker that reported itself
            // not reusable, so this is defence in depth.
            if (engineRestoreFailed || (engineSnapshot && engineDirty)) {
                postMessage({
                    type: MSG.CONVERT_ERROR, id,
                    code: 'ENGINE_NOT_RESTORED',
                    error: 'ENGINE_NOT_RESTORED: this engine could not be put back to its start state; convert in a fresh worker'
                });
                return;
            }
            // D4: an engine that loaded fonts only a PDF output may use never makes an
            // editable output (see pdfOnlyFontRightsUsed). Refused before anything is
            // read; not retried by the driver, which never sends it.
            if (pdfOnlyFontRightsUsed && String(targetFormat || '').toLowerCase() !== 'pdf') {
                postMessage({
                    type: MSG.CONVERT_ERROR, id,
                    code: 'PDF_ONLY_FONTS_LOADED',
                    error: 'PDF_ONLY_FONTS_LOADED: this engine has loaded embedded fonts only a PDF output may use (Word\'s small subsets), ' +
                           'so it cannot produce ' + JSON.stringify(String(targetFormat)) + '; convert in a fresh worker'
                });
                return;
            }
            // FM-3: recorded before ensureLokInitialized(), because the fontconfig
            // config is read once at engine startup and rules that arrive later
            // are never seen.
            pendingFontSubstitutions = msg.fontSubstitutions || null;
            // NTH-13: the page's own web fonts (data: URLs in its CSS). The rights decision for this output is made here,
            // once, on each decoded font's OS/2 (prepareHtmlDataFonts -> engineWillAcceptEmbedded); only a font the rule
            // clears reaches the engine, and every font it refuses or cannot read becomes a visible notice.
            pendingDataFonts = null; dataFontNotices = []; dataFontsMounted = [];
            {
                const inExt = ConversionProtocol.sanitizeExtension(fileName);
                // Kill switch (rule 9, both parse untrusted input): the release flag `htmlDataFonts` (the page sends options.htmlDataFonts = false)
                // turns the page's own data: fonts off, as before NTH-13. The worker's default is ON, so a host that sends nothing (the MCP) has them.
                if ((inExt === 'html' || inExt === 'htm') && typeof ConversionProtocol.prepareHtmlDataFonts === 'function'
                    && !(options && options.htmlDataFonts === false)
                    && formatRequiresFonts(targetFormat)) {
                    const plan = await ConversionProtocol.prepareHtmlDataFonts(fileData, { pdfOnly: String(targetFormat || '').toLowerCase() === 'pdf' });
                    dataFontNotices = plan.notices.slice();
                    if (plan.fonts.length) pendingDataFonts = plan.fonts;
                }
            }
            activeConvertId = id;  // S3: tag abort/global-error posts with this id
            memoryRefusal = null;  // BUG-68 (B): only a refusal during THIS conversion counts
            const fileSizeMB = fileData ? (fileData.length / (1024 * 1024)).toFixed(2) : 0;
            console.log('[Worker] CONVERT request - id:', id, 'file:', fileName, 'format:', targetFormat, 'size:', fileData?.length, `(${fileSizeMB} MB)`);
            if (options) {
                // FG-021 §4.5: a redacted copy (no password ever reaches `options`; this is
                // defence in depth, and the shape a later field would take).
                console.log('[Worker] Conversion options:', ConversionProtocol.redactConversionOptions(options));
            }
            if (requiredFonts) {
                console.log('[Worker] Required fonts:', requiredFonts.length, 'files');
            } else {
                // BUG-12 safety net: no resolver-supplied list (FontResolver
                // missing or errored) — sniff the input so non-Latin text still
                // gets a covering font instead of tofu. No-op for ASCII input.
                sniffScriptFontFiles(fileData, fileName);
            }

            // Log memory before conversion starts
            logMemoryStats('Before conversion');

            // LAZY INIT: Initialize LOK and load fonts only if needed
            // This defers initialization until first conversion, saving bandwidth for TXT/CSV
            try {
                await ensureLokInitialized(targetFormat, requiredFonts);
                if (pendingDataFonts && pendingDataFonts.length) {
                    // The engine was already running with its fonts listed (no snapshot): a font mounted now would not be seen.
                    for (const f of pendingDataFonts) dataFontNotices.push(`This document's web font ${String(f.cssFamily).replace(/[\u0000-\u001f\u007f<>&"]/g, '').slice(0, 60)} isn't included in this conversion; a similar font was used.`);
                    pendingDataFonts = null;
                }
                if (engineSnapshot) engineDirty = true;
            } catch (initErr) {
                if (engineSnapshot) {
                    engineDirty = true;
                    writeEngineBack();
                }
                console.error('[Worker] LOK initialization failed:', initErr);
                // H2 fix: driver only handles CONVERT_ERROR. Previously this
                // posted CONVERSION_ERROR, which the driver dropped — the user
                // waited out the 30s stall timeout and burned the auto-retry.
                // B1: a refused request keeps its own message and travels with
                // code + retryAfterSec so the driver rebuilds the same error.
                postMessage(Object.assign({
                    type: MSG.CONVERT_ERROR,
                    id: id,
                    error: ConversionProtocol.isRateLimitedError(initErr)
                        ? initErr.message
                        : 'Failed to initialize LibreOffice: ' + initErr.message
                }, errorCodeFields(initErr)));
                activeConvertId = null;
                return;
            }

            // `document` mode: the document's own date, read from its bytes
            // BEFORE the engine loads it (§4.1: XLSX recalculates NOW() on
            // load, so the clock must already be right then). Never rejects; a
            // document without a usable date falls back to the real clock.
            let documentTime = null;
            if (timeSetting.mode === 'document') {
                documentTime = await ConversionProtocol.documentTimeOf(fileData, ConversionProtocol.sanitizeExtension(fileName));
                console.log('[Worker] Document time:', documentTime.ok
                    ? `${documentTime.field} (${documentTime.source})` : `none (${documentTime.reason})`);
            }

            // H1-JS: stage at FIXED, sanitized, ASCII-only VFS paths so non-ASCII /
            // special-char filenames (Résumé.docx, budget 50%.docx, notes#1.docx)
            // never break the VFS write or the C++ file:// URL. The download name
            // (built API-side from the original File.name) is unaffected.
            // Hoisted above the try so M5's finally can always unlink them.
            let inputPath = null;
            let outputPath = null;
            try {
                // The conversion's clock (§3-§5): decided once, then FROZEN for
                // the whole conversion (N5) — what is typed is what the document
                // shows, even at 23:59:59. Set before the input is written, so
                // everything the engine does with this document sees one "now";
                // restored in the finally below, with the input's unlink. `system`
                // and the no-date fallback leave Date.now untouched.
                const clock = ConversionProtocol.conversionClockOf(timeSetting, documentTime, realNow());
                if (clock.pin) {
                    const pinned = clock.instant;
                    Date.now = () => pinned;
                }
                console.log('[Worker] Conversion time:', clock.conversionTime,
                            `(${timeSetting.mode}${clock.fallback ? ', no document date: the computer clock' : ''}` +
                            `${clock.offsetChanged ? ', the typed offset is not this zone\'s: wall time kept' : ''})`);

                const safeInExt = ConversionProtocol.sanitizeExtension(fileName);
                const safeOutExt = ConversionProtocol.sanitizeExtension('x.' + targetFormat);
                // FG-161: stage under the user's own (sanitized) base name, because
                // LibreOffice computes a FILENAME field from the load URL; a fixed
                // /tmp/input.<ext> printed "input.doc" into the user's document. Its
                // own directory keeps the input and output paths distinct by
                // construction (a PDF named "output.pdf" converted to PDF). Measured:
                // a collision there still converts, but nothing should rely on that.
                try { Module.FS.mkdir('/tmp/in'); } catch (e) { /* EEXIST: reused worker */ }
                inputPath = '/tmp/in/' + ConversionProtocol.sanitizeBaseName(fileName) + '.' + safeInExt;
                outputPath = '/tmp/output.' + safeOutExt;

                // Progress: Starting conversion
                postMessage({ type: MSG.CONVERSION_PROGRESS, stage: 'STARTING', percent: 5 });

                // FG-054: the engine's embedded-font files before this document
                // (a reused worker keeps earlier documents' until shutdown).
                const embeddedFontsBefore = listEmbeddedFontFiles(true);

                // FG-040: an HTML page's form controls are drawn as text (their value, checked
                // state, selected option) before the engine reads it; the engine drops them
                // itself. Done here, in the worker, so every host that runs this worker
                // (the website and the MCP) gets the same page. Byte-preserving outside the
                // controls; the same buffer when there is nothing to draw.
                let engineInput = fileData;
                let formControlsSkipped = null;   // reported to the driver, which notes it where the page really has values
                // Kill switch (rule 9): the release flag `htmlFormValues` (the page sends options.htmlFormValues = false) leaves the controls to the
                // engine, as before FG-040. The worker's default is ON, so a host that sends nothing (the MCP) gets them drawn.
                if ((safeInExt === 'html' || safeInExt === 'htm') && !(options && options.htmlFormValues === false)) {
                    const flat = ConversionProtocol.flattenHtmlFormControls(fileData);
                    if (flat.changed) {
                        engineInput = flat.bytes;
                        console.log('[Worker] Form controls drawn as text:', flat.count);
                    }
                    if (flat.reason) {
                        formControlsSkipped = flat.reason;
                        console.log('[Worker] Some form controls left as they are (' + flat.reason + ')');
                    }
                }
                // BUG-65: a file that is not the kind of document its name says (empty, random bytes, plain text named .odt, a PDF
                // with no %PDF-) is refused HERE. Without this LibreOffice quietly fell back to its text importer and "converted"
                // it. Looks at the container only, so a damaged but real document still reaches the engine. No content in the message.
                {
                    const notDoc = ConversionProtocol.inputSanityError(engineInput, safeInExt);
                    if (notDoc) {
                        console.log('[Worker] NOT_A_DOCUMENT (' + notDoc.reason + ') for a .' + notDoc.ext + ' of ' + (engineInput && engineInput.length) + ' bytes');
                        throw codedError(notDoc.message, notDoc.code, { reason: notDoc.reason });
                    }
                }
                // BUG-68: a zip whose directory points outside the file made the spreadsheets engine allocate ~2 GiB (sized from the bad
                // offset) before it failed anyway. Refused here, container only. Switched off by the release flag `zipOffsetCheck`
                // (the page sends options.checkZipOffsets = false); the worker's default is ON, so the MCP gets the check.
                if (!(options && options.checkZipOffsets === false)) {
                    const damaged = ConversionProtocol.damagedZipError(engineInput, safeInExt);
                    if (damaged) {
                        console.log('[Worker] DAMAGED_FILE (' + damaged.reason + ') for a .' + damaged.ext + ' of ' + (engineInput && engineInput.length) + ' bytes, ' + damaged.count + ' entries outside the file');
                        throw codedError(damaged.message, damaged.code, { reason: damaged.reason });
                    }
                }
                // FEAT-08: an ODF whose manifest the engine would IGNORE (unknown algorithm / key derivation / start key, Argon2 values not above
                // zero, an encrypted-package without usable encryption data) was converted to a blank page with no error. Refused here,
                // container only. Switched off by the release flag `odfManifestCheck` (the page sends options.checkOdfManifest = false).
                if (!(options && options.checkOdfManifest === false)) {
                    const refused = await ConversionProtocol.odfManifestRefusal(engineInput, safeInExt);
                    if (refused) {
                        console.log('[Worker] ENCRYPTION_REFUSED (' + refused.why + ') for a .' + refused.ext);
                        throw codedError(refused.message, refused.code, { reason: refused.reason });
                    }
                }
                // CB-012: a missing or "auto" CSV/TSV delimiter is resolved HERE to a real separator, never passed to the bridge as 0
                // (an empty separator that Calc does not detect: every row came out as ONE column, silently). The website's driver
                // resolves it first (FG-171), so for the website this changes nothing; a host that calls this worker directly (the
                // MCP) now gets the same. An explicit delimiter is respected; a plain comma CSV / tab TSV with no CSV options stays
                // on the plain route.
                if (isCsvExt(safeInExt)) {
                    const resolved = ConversionProtocol.resolveCsvDelimiterOptions(engineInput, safeInExt, options);
                    if (resolved !== options) {
                        console.log('[Worker] CSV delimiter resolved to ' + resolved.csv.delimiter + ' (' + (options && options.csv ? 'auto' : 'none chosen') + ')');
                        options = resolved;
                    }
                }
                // BUG-70: Calc holds 1,048,576 rows and 16,384 columns per sheet and drops the rest of a bigger CSV/TSV
                // without a word. Refuse, before the engine sees the file, naming the count and the limit; nothing partial
                // is ever produced. Here in the worker so the website and the MCP refuse the same files.
                if (isCsvExt(safeInExt)) {
                    const over = ConversionProtocol.engineTableLimitError(engineInput, safeInExt, options && options.csv);
                    if (over) {
                        console.log('[Worker] ' + over.code + ': ' + over.rows + ' rows, widest row ' + over.cols + ' columns (limits ' +
                                    ConversionProtocol.ENGINE_MAX_ROWS + ' x ' + ConversionProtocol.ENGINE_MAX_COLS + ')');
                        throw codedError(over.message, over.code);
                    }
                }
                console.log('[Worker] Writing input file to VFS:', inputPath);
                Module.FS.writeFile(inputPath, engineInput);
                // D4: before the document (and its embedded fonts) is loaded.
                setPdfOnlyFontRights(Module.FS, targetFormat);

                // Progress: File loaded into virtual filesystem
                postMessage({ type: MSG.CONVERSION_PROGRESS, stage: 'LOADING', percent: 15 });

                // Log memory after writing input file
                logMemoryStats('After writing input file');

                // Verify file was written correctly (only log errors)
                try {
                    const stat = Module.FS.stat(inputPath);
                    if (stat.size !== engineInput.length) {
                        console.error('[Worker] File size mismatch:', stat.size, '!=', engineInput.length);
                    }
                } catch (statErr) {
                    console.error('[Worker] ERROR: Cannot stat file after writing:', statErr);
                }

                // Log memory before calling LOK conversion
                logMemoryStats('Before convert_document()');
                const conversionStartTime = realNow();

                // Determine if this is a spreadsheet file that needs special handling.
                // Use the sanitized extension so routing and the staged path agree.
                const ext = safeInExt;
                const isSpreadsheet = isSpreadsheetExt(ext);
                const isCSV = isCsvExt(ext);

                let success;
                // Progress: About to call LibreOffice conversion
                postMessage({ type: MSG.CONVERSION_PROGRESS, stage: 'CONVERTING', percent: 25 });

                // BUG-36: cell comments in a Calc PDF only when asked (the bridge's default is
                // off, and it resets after each convert_*). FG-021: the passwords, IMMEDIATELY
                // before the convert_* call below; the bridge wipes them when that call returns,
                // and the finally clears them again. Nothing between here and the call touches
                // the engine.
                if (typeof Module._set_calc_pdf_options === 'function') {
                    const includeCellComments = !!(options && options.spreadsheet && options.spreadsheet.includeCellComments === true);
                    Module.cwrap('set_calc_pdf_options', null, ['number'])(includeCellComments ? 1 : 0);
                }
                if (ConversionProtocol.hasConversionSecrets(secrets)) {
                    const op = secrets.outputProtection || null;
                    const pm = (op && op.permissions) || null;
                    const tri = (v, map) => (v === undefined ? -1 : map[String(v)]);
                    const set_conversion_secrets = Module.cwrap('set_conversion_secrets', 'number',
                        ['string', 'string', 'string', 'number', 'number', 'number']);
                    const ok = set_conversion_secrets(
                        secrets.inputPassword === undefined ? null : secrets.inputPassword,
                        op ? op.openPassword : null,
                        pm ? pm.permissionPassword : null,
                        pm ? tri(pm.printing, { none: 0, low: 1, high: 2 }) : -1,
                        pm ? tri(pm.changes, { none: 0, any: 4 }) : -1,
                        pm ? tri(pm.copying, { false: 0, true: 1 }) : -1);
                    if (ok !== 1) {
                        // INVALID_PARAM naming the field, never its value (the JS validator
                        // mirrors the bridge's rules, so this is defence in depth).
                        throw new Error(ConversionProtocol.readBridgeError(Module) || 'INVALID_PARAM: the passwords were refused');
                    }
                    console.log('[Worker] Conversion secrets set (input ' + (secrets.inputPassword !== undefined ? '<set>' : '<not set>') +
                                ', output ' + (op ? '<set>' : '<not set>') + ')');
                }

                if (isCSV && options && options.csv) {
                    // M14 JS mirror: validate before the bridge call (same rules as
                    // wasm_bridge.cpp) so bad options fail fast with INVALID_PARAM.
                    const csvRaw = options.csv;
                    if (ConversionProtocol.canonicalEncoding(csvRaw.encoding) === null) {
                        throw new Error('INVALID_PARAM: Unsupported encoding: ' + csvRaw.encoding);
                    }
                    if (!(csvRaw.delimiter === 'auto' || csvRaw.delimiter == null)) {
                        const d = parseInt(csvRaw.delimiter, 10);
                        if (Number.isNaN(d) || d < 1 || d > 255) {
                            throw new Error('INVALID_PARAM: Invalid CSV delimiter: ' + csvRaw.delimiter);
                        }
                    }
                    // Use CSV-specific conversion with custom options
                    console.log('[Worker] Calling convert_csv_with_options...');
                    const convert_csv_with_options = Module.cwrap(
                        'convert_csv_with_options',
                        'number',
                        ['string', 'string', 'string', 'number', 'string', 'number']
                    );
                    // Map UI CSV options to the C++ bridge args via the shared,
                    // node-tested helper (H7). startRow is always 1 — the header
                    // row is never skipped; the "Header row" checkbox is a
                    // fast-path styling feature (plan C4), a no-op on WASM styling.
                    const { delimiter, encoding, startRow } =
                        ConversionProtocol.csvOptionsToBridgeArgs(options.csv);
                    console.log('[Worker] CSV bridge args: delimiter=' + delimiter +
                                ', encoding=' + encoding + ', startRow=' + startRow +
                                ' (header always preserved; styling is fast-path only)');
                    success = convert_csv_with_options(inputPath, outputPath, targetFormat, delimiter, encoding, startRow);
                } else if (isSpreadsheet && options && (options.sheetIndex !== undefined || options.printArea || options.pageRange)) {
                    // Use the new spreadsheet-specific conversion with options
                    console.log('[Worker] Calling convert_spreadsheet_with_options...');
                    const convert_spreadsheet_with_options = Module.cwrap(
                        'convert_spreadsheet_with_options',
                        'number',
                        ['string', 'string', 'string', 'number', 'string']
                    );
                    const sheetIndex = options.sheetIndex !== undefined ? options.sheetIndex : -1;
                    // printArea can be cell range (A1:M50) or page range (1-5)
                    // pageRange is an alias for page numbers specifically
                    const printArea = options.printArea || options.pageRange || '';
                    // M14 JS mirror: reject an injectable print-area before the bridge call.
                    if (printArea && !ConversionProtocol.isValidPrintArea(printArea)) {
                        throw new Error('INVALID_PARAM: Invalid print area: ' + printArea);
                    }
                    success = convert_spreadsheet_with_options(inputPath, outputPath, targetFormat, sheetIndex, printArea);
                } else if (targetFormat === 'pdf' && options && options.pdf) {
                    // Use PDF-specific conversion with export options (non-spreadsheet inputs only,
                    // since spreadsheet branch above handles spreadsheet→PDF with sheet selection)
                    console.log('[Worker] Calling convert_document_with_pdf_options...');
                    const convert_document_with_pdf_options = Module.cwrap(
                        'convert_document_with_pdf_options',
                        'number',
                        ['string', 'string', 'string', 'string', 'number', 'number']
                    );
                    const pdfOpts = options.pdf;
                    // M14 JS mirror: reject an injectable page range before the bridge call.
                    const pdfPageRange = pdfOpts.pageRange || '';
                    if (pdfPageRange && !ConversionProtocol.isValidPageRange(pdfPageRange)) {
                        throw new Error('INVALID_PARAM: Invalid page range: ' + pdfPageRange);
                    }
                    success = convert_document_with_pdf_options(
                        inputPath, outputPath, targetFormat,
                        pdfPageRange,
                        pdfOpts.maxImageResolution || 0,
                        pdfOpts.quality || 0
                    );
                } else {
                    // Use standard conversion
                    console.log('[Worker] Calling convert_document...');
                    const convert_document = Module.cwrap('convert_document', 'number', ['string', 'string', 'string']);
                    success = convert_document(inputPath, outputPath, targetFormat);
                }

                // A duration for the log, from the real clock (the engine's clock
                // may be pinned and frozen here). Not the CONVERT field of the
                // same name, which is a point in time.
                const engineSeconds = ((realNow() - conversionStartTime) / 1000).toFixed(2);
                console.log('[Worker] convert_document returned:', success, `(took ${engineSeconds}s)`);

                // Progress: Conversion completed, preparing output
                postMessage({ type: MSG.CONVERSION_PROGRESS, stage: 'RENDERING', percent: 75 });

                // Log memory after conversion
                logMemoryStats('After convert_document()');

                if (success !== 1) {
                    // H11: pull the categorized bridge error when the build exports
                    // it; degrade to the generic message on older builds.
                    const detail = ConversionProtocol.readBridgeError(Module);
                    // FG-021: the bridge's password tags become CONVERT_ERROR codes.
                    const passwordCode = ConversionProtocol.bridgeErrorCode(detail);
                    if (passwordCode) throw codedError(detail, passwordCode);
                    // BUG-66: an export that failed with a page range that may name no page. Convert
                    // once more without the range: if that works, the range was the cause, and the
                    // user is told so with the real page count; if not, the original error stands.
                    const range = targetFormat === 'pdf' && options && options.pdf && options.pdf.pageRange;
                    if (range && /^EXPORT_FAILED\b/.test(String(detail || '')) && !isSpreadsheet
                        && typeof ConversionProtocol.pageRangeOutsideMessage === 'function') {
                        const pages = pageCountWithoutRange(inputPath, outputPath, options.pdf);
                        if (pages !== null) {
                            throw codedError(ConversionProtocol.pageRangeOutsideMessage(range, pages),
                                ConversionProtocol.PAGE_RANGE_OUTSIDE, { pageCount: pages });
                        }
                    }
                    throw new Error(detail || 'Conversion failed in C++');
                }

                // Progress: Reading output file
                postMessage({ type: MSG.CONVERSION_PROGRESS, stage: 'SAVING', percent: 85 });

                console.log('[Worker] Reading output file...');
                const outputData = Module.FS.readFile(outputPath);
                console.log('[Worker] Output file size:', outputData.length);

                // FG-021 §4.4, fail closed: an output password must be PROVEN to have taken
                // effect. Otherwise the output is dropped here, never posted, and the user is
                // told; it is never offered as "protected".
                if (secrets && secrets.outputProtection !== undefined) {
                    const proof = await ConversionProtocol.verifyOutputProtection(outputData, targetFormat, secrets.outputProtection);
                    if (!proof.ok) {
                        console.error('[Worker] Output protection check FAILED: ' + proof.reason);
                        throw codedError(ConversionProtocol.PASSWORD_ERROR_CODES.OUTPUT_PROTECTION_FAILED +
                            ': the output was not protected as asked (' + proof.reason + '); it was not kept',
                            ConversionProtocol.PASSWORD_ERROR_CODES.OUTPUT_PROTECTION_FAILED);
                    }
                    console.log('[Worker] Output protection verified');
                }

                // BUG-65 phase 2: a PDF that "converts" to a DOCX / PPTX with NOTHING in it (a damaged cross-reference table does this, silently).
                // Positive evidence only (ConversionProtocol.outputIsEmpty); an input of 4 KB or more is an error, a smaller one a notice with the
                // output. Switched off by the release flag `emptyOutputCheck` (the page sends options.checkEmptyOutput = false).
                let emptyOutputNotice = null;
                if (safeInExt === 'pdf' && (targetFormat === 'docx' || targetFormat === 'pptx') && !(options && options.checkEmptyOutput === false)) {
                    const verdict = await ConversionProtocol.emptyOutputVerdict(outputData, targetFormat, fileData ? fileData.length : 0);
                    if (verdict && verdict.kind === 'error') {
                        console.log('[Worker] EMPTY_OUTPUT: the ' + targetFormat + ' of a ' + (fileData && fileData.length) + '-byte PDF holds nothing; it was not kept');
                        throw codedError(verdict.message, 'EMPTY_OUTPUT');
                    }
                    if (verdict) { emptyOutputNotice = verdict.message; console.log('[Worker] The ' + targetFormat + ' is empty, but the PDF is tiny: a notice'); }
                }

                // Progress: Finalizing
                postMessage({ type: MSG.CONVERSION_PROGRESS, stage: 'FINALIZING', percent: 95 });

                // Log memory after reading output
                logMemoryStats('After reading output');

                // Transfer output back (include targetFormat for MIME type selection).
                // Output was already read (above) and its buffer is transferred here,
                // so the finally-block unlink does not affect the sent data.
                // conversionTime*: the "now" actually used (CONTRACT_VERSION 3, §6).
                // FG-054: and after it, so the driver can check that every embedded
                // face it skipped a substitute for was really accepted (optional,
                // additive reply fields; null = the directory could not be read).
                const embeddedFontsAfter = listEmbeddedFontFiles(false);
                // NTH-09 (optional, additive): true only when this engine can be written back
                // to its snapshot after this conversion; the driver reuses a worker only then.
                let notReusable = engineSnapshot ? engineNotReusableReason() : 'no engine snapshot';
                // The output has been read: write the engine back now, before CONVERT_DONE, so
                // the driver never hears "reusable" from an engine whose write-back then failed.
                writeEngineBack();
                if (!notReusable && engineRestoreFailed) notReusable = 'the engine could not be written back';
                if (!notReusable && memoryRefusal) notReusable = 'the memory ceiling refused a growth';   // BUG-68 (B): succeeded anyway, but not reused
                // NTH-13: a worker that mounted a page's web font is replaced after this conversion: a font that a
                // later conversion in the same engine might meet (a bit-8 font allowed for DOCX, then a PDF) never outlives it.
                if (!notReusable && dataFontsMounted.length) notReusable = 'a web font from the page was mounted';
                if (engineSnapshot && notReusable) {
                    console.log('[Worker] This engine will not be reused:', notReusable);
                }
                console.log('[Worker] Sending CONVERT_DONE');
                postMessage({
                    type: MSG.CONVERT_DONE, id, outputData, targetFormat,
                    conversionTime: clock.conversionTime,
                    conversionTimeFallback: clock.fallback,
                    conversionTimeOffsetChanged: clock.offsetChanged,
                    embeddedFontsBefore, embeddedFontsAfter,
                    formControlsSkipped,
                    emptyOutputNotice,
                    dataFontNotices: dataFontNotices.slice(),
                    engineReusable: !notReusable
                }, [outputData.buffer]);

            } catch (err) {
                console.error('[Worker] Conversion Error:', err);
                // A WASM trap leaves the engine mid-call (its stack pointer included): it
                // converts nothing more, written back or not.
                if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) engineRestoreFailed = true;
                // BUG-68 (B): a conversion that failed after the memory ceiling refused a growth failed BECAUSE of it (the engine saw a failed
                // allocation, whatever it then threw): one plain sentence, whatever the raw error was, and this engine is not reused.
                let outErr = err;
                if (memoryRefusal) {
                    console.log('[Worker] MEMORY_LIMIT: the conversion failed after the ceiling refused a growth (raw error: ' + String(err && err.message).slice(0, 120) + ')');
                    outErr = codedError(ConversionProtocol.MEMORY_LIMIT_TEXT, 'MEMORY_LIMIT', { reason: 'memory-ceiling', ceilingMB: Math.round(memoryRefusal.ceilingBytes / 1048576) });
                    engineRestoreFailed = true;
                }
                // BUG-76: a trap of the engine is a CODED failure: ENGINE_TRAP plus one sentence for the user. `error` keeps the raw text so
                // every host's trap retry (a fresh engine) works exactly as before; the raw text is for logs, never for a user. A failure that
                // already has a code keeps it: MEMORY_LIMIT WINS (tested on outErr, not err), so a ceiling hit is never retried as a trap.
                let trapFields = {};
                if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError && !errorCodeFields(outErr).code) {
                    trapFields = { code: ConversionProtocol.ENGINE_TRAP_CODE, userMessage: ConversionProtocol.ENGINE_TRAP_TEXT };
                }
                postMessage(Object.assign({ type: MSG.CONVERT_ERROR, id, error: outErr.toString() },
                    errorCodeFields(outErr), trapFields));
            } finally {
                // Conversion time: the real clock again, whatever happened.
                Date.now = nativeDateNow;
                // M5: always release VFS files (success, failure, or abort) so a
                // failed conversion never pins the input (and any partial output)
                // in WASM linear memory until the next conversion recycles it.
                tryUnlink(inputPath);
                tryUnlink(outputPath);
                // D4: the PDF-only font-rights flag never outlives its conversion.
                tryUnlink(PDF_ONLY_FONT_RIGHTS_FILE);
                // NTH-13: this conversion's web fonts do not outlive it.
                for (const p of dataFontsMounted) tryUnlink(p);
                dataFontsMounted = []; pendingDataFonts = null;
                // FG-161: a LibreOffice lock file next to the staged input
                // (".~lock.<name>#"), in case an error path skipped the close
                // that normally removes it.
                if (inputPath) {
                    const slash = inputPath.lastIndexOf('/');
                    tryUnlink(inputPath.slice(0, slash + 1) + '.~lock.' + inputPath.slice(slash + 1) + '#');
                }
                // FG-021: the passwords out of the engine, whatever happened (the bridge also
                // wipes them when a convert_* returns; this covers every other path).
                if (typeof Module !== 'undefined' && Module && typeof Module._clear_conversion_secrets === 'function') {
                    try { Module.cwrap('clear_conversion_secrets', null, [])(); } catch (e) { /* engine gone: nothing held */ }
                }
                // NTH-09: the engine back to its snapshot now, not when the next document
                // arrives, so this document's bytes do not wait in its memory.
                writeEngineBack();
                activeConvertId = null;
            }
        }
        // Note: the dead sheet-info handler was removed (finding M12) — it had no
        // driver-side sender, cwrapped a malloc'd 'string' (dropping the pointer),
        // and never ran ensureLokInitialized. Its C++ backend is now WASM_DEBUG-only.
    });
    console.log('[Worker] Message handler installed.');

    // For backwards compatibility: if no module param, load legacy soffice.js immediately
    if (moduleName === 'default' && !urlParams.has('module')) {
        console.log('[Worker] Legacy mode: loading soffice.js immediately');
        loadModuleScript();
    }
}
