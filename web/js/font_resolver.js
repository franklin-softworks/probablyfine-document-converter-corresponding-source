// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
/**
 * font_resolver.js
 * Main entry point for the smart font loading system (COA #5).
 * Combines FontExtractor, FontMatcher, and FontLoader to:
 * 1. Extract fonts from documents
 * 2. Find best open source substitutes
 * 3. Load only required fonts
 *
 * Usage:
 *   await FontResolver.initialize();
 *   const fonts = await FontResolver.resolveFontsForDocument(file);
 *   // fonts contains the list of font files to load
 */

const FontResolver = (function() {
    'use strict';

    let initialized = false;
    let fontRegistry = null;
    // M19: de-duplicate concurrent init attempts so a failed fonts.json fetch
    // RETRIES on the next conversion instead of latching (initialized stays false).
    let initInFlight = null;

    // User-facing, non-blocking warning when the registry is unavailable but the
    // conversion needs fonts. Surfaced via conversion:font-warning (driver/api).
    const FONTS_UNAVAILABLE_MSG =
        'Font library could not be loaded — the document was converted without embedded fonts, ' +
        'so some characters (especially non-Latin) may not display correctly.';

    // Format facts come from the shared registry (single source of truth).
    // See web/js/format_registry.js.
    const _R = (typeof window !== 'undefined' && window.FormatRegistry) ||
               (typeof self !== 'undefined' && self.FormatRegistry) || null;
    if (!_R) {
        throw new Error('[FontResolver] format_registry.js must load before font_resolver.js');
    }

    // Script table + sniffing helpers are shared with conversion_worker.js so the
    // two font paths can never drift (BUG-12). See conversion_protocol.js.
    const _P = (typeof window !== 'undefined' && window.ConversionProtocol) ||
               (typeof self !== 'undefined' && self.ConversionProtocol) || null;
    if (!_P) {
        throw new Error('[FontResolver] conversion_protocol.js must load before font_resolver.js');
    }

    // Formats that support font extraction (ZIP-based, derived from registry).
    const EXTRACTABLE_FORMATS = _R.getExtractableFormats();
    // Formats we can read font NAMES from = the ZIP ones plus html/rtf. Kept
    // separate from EXTRACTABLE_FORMATS because that list ALSO selects which
    // formats detectScripts() samples by unzipping; html/rtf must keep using
    // the raw-text sniff below.
    const FONT_NAME_FORMATS = _R.getFontNameFormats();

    // Binary formats - can't extract fonts from metadata (PDF handled separately).
    const BINARY_FORMATS = _R.getBinaryFormats();

    // How much of the input to sniff for non-Latin scripts (BUG-12).
    const SCRIPT_SAMPLE_BYTES = 256 * 1024;

    // ------------------------------------------------------------------
    // OLE2 (.doc/.xls/.ppt): we do NOT sniff, we ASSUME.
    //
    // This is deliberate, not an oversight. An OLE2 compound file is a
    // container of records, streams, sector allocation tables and embedded
    // objects; text is only one of the things in it, and there is no cheap
    // way to find the text streams from the raw bytes. Decoding the whole
    // sample as UTF-16LE therefore turns arbitrary binary into arbitrary code
    // points, and the script regexes hit constantly. Measured over the 87
    // legacy binary fixtures in test_corpus (256 KB sample, UTF-16LE decode,
    // >=3 hits required): han 100%, hangul 100%, devanagari 98.9%, emoji 92%,
    // thai 88.5% — i.e. essentially every legacy document "contains" every
    // script. Raising the hit threshold does not rescue it, and neither does
    // requiring contiguous same-script RUNS: random binary reaches runs of
    // 332 chars (p95 154, median 16) while genuine CJK prose only reaches 5-9,
    // because real text is broken up by spaces and punctuation. The
    // discriminator is inverted, so there is no threshold that separates them.
    //
    // What we do instead: assume the expensive case. `han` pulls in
    // DroidSansFallbackFull.ttf (~4 MB), which is exactly what `main` loaded
    // for ~100% of legacy binaries via its own (single-hit, equally
    // false-positive) CJK sniff. Keeping it means a genuine CJK .doc still
    // renders; dropping it would be a real regression for those users. It
    // costs one unnecessary 4 MB font download for Latin-only legacy files —
    // the same cost as today — but it is now honest about being a guess, and
    // a guess is never allowed to produce a user-facing warning (see
    // buildScriptWarning).
    // ------------------------------------------------------------------
    //
    // PERF-04 (2026-11): the assumption now applies only to a file whose text could not be READ. detectScripts() first reads the real
    // text with ConversionProtocol.oleTextSample (DOC piece table, PPT text atoms, XLS string records; bounded, never throws) and runs the
    // same detector the ZIP formats use. The raw-bytes sniff measured above is still not used. Kill switch: release flag `legacyTextSniff`.
    const ASSUMED_BINARY_SCRIPTS = ['han'];

    // PERF-04: the registry's CJK-capable faces a legacy file can pull in by NAME (file name prefixes). A legacy file that names one
    // keeps the assumed CJK font; see the note where it is used.
    const LEGACY_CJK_FONT_PREFIXES = ['BIZUD', 'DroidSansFallback', 'Nanum', 'NotoSerifSC', 'NotoSerifTC'];

    // Essential font families. Shared with conversion_worker.js's fallback path via
    // ConversionProtocol — this used to be a local literal whose own comment said it
    // "mirrors ESSENTIAL_FONT_FAMILIES in conversion_worker.js". Nothing enforced
    // that. Do not reintroduce a local copy; tests/unit/test_protocol_helpers.js
    // fails if either file grows one back.
    const ESSENTIAL_FAMILIES = _P.ESSENTIAL_FONT_FAMILIES;
    const ESSENTIAL_FAMILY_SET = new Set(ESSENTIAL_FAMILIES);

    // NOT a subset-by-accident of ESSENTIAL_FAMILIES — a different set, on purpose.
    // ESSENTIAL_FAMILIES is what a conversion loads when nothing better is known.
    // This one is unioned into EVERY extractable-format resolution, so its cost is
    // paid by every DOCX/XLSX/PPTX conversion; the DejaVu faces are ~742 KB that
    // those documents do not need (they name their own fonts and get real
    // substitutes). See getEngineDefaultFonts() for the full reasoning and the
    // measurements. Hoisted here so the difference between the two sets is visible
    // in one place rather than 1,000 lines apart, where it read as a stale copy.
    const FALLBACK_CORE_FAMILIES = Object.freeze([
        'Liberation Sans',
        'Liberation Serif',
        'Liberation Mono'
    ]);

    // Whether an output format needs fonts is derived from the registry
    // (requiresFontsForOutput) — see needsFonts(). Plain-text-style outputs
    // (txt, csv, tsv, html) embed no fonts; this now matches the worker, which
    // already skipped fonts for those outputs (fixes the html drift in M6).

    /**
     * Initialize the font resolver system.
     * M19: on failure this does NOT latch — `initialized` stays false so the next
     * conversion retries the fetch. Concurrent conversions share one in-flight
     * attempt (`initInFlight`) rather than firing N parallel fetches.
     */
    async function initialize() {
        if (initialized) return;          // only short-circuits on SUCCESS
        if (initInFlight) return initInFlight;

        initInFlight = (async () => {
            try {
                // Load font registry
                const response = await fetch('fonts/fonts.json');
                // B1: 429 means "stop asking". Fail the conversion with the
                // busy message instead of degrading to "no fonts" and letting the
                // worker request the registry (and fonts) again.
                const limited = _P.rateLimitErrorFromResponse
                    ? _P.rateLimitErrorFromResponse(response, Date.now()) : null;
                if (limited) throw limited;
                if (!response.ok) throw new Error('Failed to load fonts.json');
                fontRegistry = await response.json();

                // Initialize sub-modules
                if (typeof FontMatcher !== 'undefined') {
                    await FontMatcher.initialize(fontRegistry);
                }
                if (typeof FontLoader !== 'undefined') {
                    await FontLoader.initialize(fontRegistry);
                }

                initialized = true;
                console.log('[FontResolver] Initialized with', fontRegistry.fonts?.length || 0, 'fonts');
            } catch (e) {
                // Do NOT latch (was: initialized = true) — retry next conversion.
                console.error('[FontResolver] Initialization failed (will retry next conversion):', e);
                initialized = false;
                fontRegistry = null;
                if (_P.isRateLimitedError && _P.isRateLimitedError(e)) throw e;   // B1
            }
        })();

        try {
            await initInFlight;
        } finally {
            initInFlight = null;
        }
    }

    /**
     * @returns {boolean} True if the font registry is loaded and usable.
     */
    function isReady() {
        return initialized && !!fontRegistry;
    }

    /**
     * Check if a format supports font extraction
     */
    function canExtractFonts(filename) {
        const ext = getExtension(filename);
        return FONT_NAME_FORMATS.includes(ext);
    }

    /**
     * Check if a format needs fonts at all
     */
    function needsFonts(filename, targetFormat) {
        const outputExt = targetFormat?.toLowerCase() || 'pdf';
        // Registry is the single source of truth for font requirements.
        return _R.requiresFontsForOutput(outputExt);
    }

    /**
     * Get file extension
     */
    function getExtension(filename) {
        return (filename || '').split('.').pop().toLowerCase();
    }

    /**
     * Resolve fonts for a document
     * @param {File} file - The document file
     * @param {string} targetFormat - Target output format
     * @returns {Promise<Object>} Resolution result with fonts to load
     */
    /**
     * @param {Object} [resolveOptions]
     * @param {boolean} [resolveOptions.ignoreSelfSupplied] FG-054: ignore the
     *   document's own embedded fonts (the engine refused one we counted on).
     * @param {boolean} [resolveOptions.acceptEot] FG-054: the host has switched the
     *   engine's EOT decoding on (INIT.allowEmbeddedEot), so a PPTX's embedded faces
     *   are counted on. Absent or false: they are not, and every substitute is kept.
     */
    async function resolveFontsForDocument(file, targetFormat = 'pdf', resolveOptions = null) {
        await initialize();

        const filename = file.name || '';
        const inputExt = getExtension(filename);

        // Check if fonts are needed for this conversion
        if (!needsFonts(filename, targetFormat)) {
            console.log('[FontResolver] No fonts needed for', targetFormat, 'output');
            return {
                strategy: 'none',
                fontsToLoad: [],
                message: 'Output format does not require fonts'
            };
        }

        // M19: fonts ARE needed. If the registry failed to load (retry pending),
        // tag every resolution result so the driver can surface a non-blocking
        // "converted without embedded fonts" warning. warn() is a no-op when the
        // registry is available, so the normal path is byte-identical.
        const fontsUnavailable = !fontRegistry;
        // L-7: surface the user-facing FONTS_UNAVAILABLE_MSG as `message` but keep
        // the strategy-specific text (e.g. 'Binary/PDF format', 'FontExtractor not
        // loaded') as `strategyMessage` for diagnostics instead of discarding it.
        const warn = (obj) => fontsUnavailable
            ? { ...obj, fontsUnavailable: true, strategyMessage: obj.message, message: FONTS_UNAVAILABLE_MSG }
            : obj;

        // BUG-12: sniff the CONTENT for non-Latin scripts wherever the bytes can
        // actually be decoded (text and ZIP text parts). Latin-only content
        // detects nothing and the font set below is byte-identical to the
        // pre-fix behaviour. Containers we cannot decode (OLE2 binary, PDF)
        // detect NOTHING and instead declare an assumption — see detectScripts.
        let detection = await detectScripts(file, inputExt);
        // Fonts cover detected AND assumed scripts; only DETECTED ones are ever
        // reported to the user (assumptions are guesses, guesses must stay silent).
        //
        // `embeddedCoverage` (NTH-07) is the ONE thing allowed to shorten this
        // list: a font the document supplies itself, that the engine will
        // accept, and whose cmap draws every code point of that script the
        // document contains. Callers that have no such evidence pass nothing and
        // get exactly the pre-NTH-07 set.
        const addScripts = (obj, embeddedCoverage) => {
            let kept = scriptsStillNeeded(detection, embeddedCoverage);

            // NTH-12: the SECOND thing allowed to shorten the list — a font we
            // are ALREADY going to download whose cmap draws every CJK code
            // point this document contains. Same proof, different provider.
            const protectedByProof = new Set();
            const coverer = hanCoveredByDownload(obj.fontsToLoad, detection, kept);
            if (coverer) {
                const detected = kept.detected.filter(id => id !== 'han');
                kept = {
                    detected,
                    covered: detected.concat(detection.assumedScripts || []),
                    suppressed: kept.suppressed.concat(['han'])
                };
                protectedByProof.add(coverer.file);
                obj = { ...obj, hanCoveredBy: coverer.file };
            }

            if (kept.suppressed.length) obj = { ...obj, suppressedScripts: kept.suppressed };
            return warn(withScriptFonts(
                obj,
                detection,
                kept.covered,
                getScriptFonts(kept.covered),
                // The warning is built from what is STILL uncovered: a script we
                // have no font for, in a document that embeds one that draws it,
                // would otherwise produce a warning about text that renders
                // perfectly — the one thing the warning channel must never do.
                buildScriptWarning({ ...detection, scripts: kept.detected }),
                protectedByProof));
        };

        // Binary formats and PDFs - can't extract font metadata, load essentials.
        // OLE2 additionally gets the assumed `han` fallback (see detectScripts);
        // PDF does not, so a CJK PDF input can still lose its glyphs. That gap is
        // pre-existing and identical on main (main's latin1 PDF sniff could never
        // fire); closing it needs real PDF text extraction, not another byte sniff.
        if (BINARY_FORMATS.includes(inputExt) || inputExt === 'pdf') {
            const essentialFonts = getEssentialFonts();

            // Legacy binaries DO name their fonts — just not in a zip we can read.
            // Sniff the family names out of the raw bytes and mount the metric
            // compatible substitutes, because the essential set does not contain
            // them: it has no Carlito, so a deck asking for Calibri (the Office
            // default since 2007) was drawn in the WIDER DejaVu Sans and its text
            // overran the margins. Found by human review 2026-08-23 on
            // rmb170901_fellowship_workshop.ppt p12/p27.
            //
            // Mounting is sufficient — Calibri -> Carlito is a hardcoded table in
            // LibreOffice's PhysicalFontCollection.cxx (see web/CLAUDE.md), so no
            // fontconfig rule is required for the metric-compatible pairs.
            //
            // PDFs are not byte-sniffed (a stray family name in a content stream is
            // not a request); their font dictionaries' /BaseFont names are read
            // instead (D3, below).
            let sniffed = [];
            let sniffedMatches = null;
            if (inputExt === 'pdf' && typeof BinaryFontSniff !== 'undefined'
                && typeof BinaryFontSniff.readPdfBaseFontNames === 'function'
                && fontRegistry && Array.isArray(fontRegistry.fonts)) {
                try {
                    const t0 = Date.now();
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    const known = Object.keys(FontMatcher.PROPRIETARY_MAPPINGS || {});
                    const baseFonts = await BinaryFontSniff.readPdfBaseFontNames(bytes);
                    const names = BinaryFontSniff.familiesFromPdfBaseFonts(baseFonts, known);
                    if (names.length) {
                        const matched = FontMatcher.matchFonts(names);
                        // Only the faces the PDF draws in (its /BaseFont names say which),
                        // plus Regular, which is kept as the ZIP path keeps it.
                        const faces = BinaryFontSniff.pdfFamilyFaces(baseFonts, known);
                        const allowed = new Map();
                        for (const m of matched) {
                            const set = allowed.get(m.family) || new Set(['regular']);
                            for (const req of (m.requestedFonts || [m.requestedFont])) {
                                for (const f of (faces[req] || ['regular'])) set.add(f);
                            }
                            allowed.set(m.family, set);
                        }
                        const faceOf = (f) => (String(f.weight).toLowerCase() === 'bold' ? 'bold' : '')
                            + (String(f.style).toLowerCase() === 'italic' ? 'italic' : '') || 'regular';
                        sniffed = (FontMatcher.getFontFiles(matched) || [])
                            .filter((f) => !allowed.has(f.family) || allowed.get(f.family).has(faceOf(f)));
                        sniffedMatches = matched;
                    }
                    console.log(`[FontResolver] PDF names ${names.join(', ') || '(no known family)'} `
                        + `(${baseFonts.length} /BaseFont, ${Date.now() - t0} ms) -> mounting `
                        + `${sniffed.map(f => f.file).join(', ') || '(no substitutes)'}`);
                } catch (e) {
                    // A diagnostic aid must never break a conversion.
                    console.log(`[FontResolver] PDF font names skipped: ${e && e.message}`);
                }
            } else if (inputExt !== 'pdf' && typeof BinaryFontSniff !== 'undefined'
                && fontRegistry && Array.isArray(fontRegistry.fonts)) {
                try {
                    // BUG-81: the font table of a legacy file (a .doc's FFN, in its Table stream) sits AFTER the document body, so for a large
                    // file the first 8 MB never held it: a 9.8 MB .doc (Helvetica, Times, ArialMT named in its table) found no name at all and
                    // every one of its fonts fell to DejaVu. Up to 16 MB is read whole; larger files are read at BOTH ends, 8 MB each
                    // (~250 ms per 8 MB). A name cut in two at the join cannot match, and cannot be invented either.
                    const MAX_SNIFF_BYTES = 8 * 1024 * 1024;
                    let bytes;
                    if (file.size <= 2 * MAX_SNIFF_BYTES) {
                        bytes = new Uint8Array(await file.arrayBuffer());
                    } else {
                        const head = new Uint8Array(await file.slice(0, MAX_SNIFF_BYTES).arrayBuffer());
                        const tail = new Uint8Array(await file.slice(file.size - MAX_SNIFF_BYTES).arrayBuffer());
                        bytes = new Uint8Array(head.length + tail.length);
                        bytes.set(head, 0);
                        bytes.set(tail, head.length);
                    }
                    // The 110 proprietary families the matcher can already
                    // substitute. Scanning for names we cannot act on would cost
                    // time and buy nothing.
                    const known = Object.keys(FontMatcher.PROPRIETARY_MAPPINGS || {});
                    const names = BinaryFontSniff.sniffBinaryFontFamilies(bytes, known);
                    if (names.length) {
                        const matched = FontMatcher.matchFonts(names);
                        sniffed = FontMatcher.getFontFiles(matched) || [];
                        sniffedMatches = matched;
                        console.log(`[FontResolver] Binary format names ${names.join(', ')} -> mounting ${sniffed.map(f => f.file).join(', ') || '(no substitutes)'}`);
                    }
                } catch (e) {
                    // A diagnostic aid must never break a conversion.
                    console.log(`[FontResolver] binary font sniff skipped: ${e && e.message}`);
                }
            }

            // PERF-04: a legacy file that NAMES a CJK font (SimSun, MS Mincho, Malgun Gothic ...) declares itself a CJK document, and
            // its font budget is already spent on those faces: dropping the assumed 4 MB font frees budget, which re-admits faces
            // that were shed (bold and italic variants), and one document then printed a different glyph. Measured on the 88 corpus
            // files: 6 of the 9 documents that name CJK fonts changed. So they keep today's behaviour exactly: the assumption.
            if (detection.legacyText && sniffed.some((f) => f && LEGACY_CJK_FONT_PREFIXES.some((p) => String(f.file).startsWith(p)))) {
                console.log('[FontResolver] legacy file names a CJK font: keeping the assumed CJK font (output unchanged)');
                detection = { scripts: [], trusted: false, sampled: false, assumedScripts: ASSUMED_BINARY_SCRIPTS };
            }

            const seen = new Set(essentialFonts.map((f) => f.file));
            const merged = essentialFonts.concat(sniffed.filter((f) => f && !seen.has(f.file)));
            console.log(`[FontResolver] Binary/PDF format, loading ${merged.length} fonts (${essentialFonts.length} essential + ${merged.length - essentialFonts.length} named)`);
            return addScripts({
                strategy: 'selective',
                fontsToLoad: merged,
                // The sniffed matches also drive FM-3, exactly as for ZIP formats.
                // Without them a legacy binary got its substitute files MOUNTED but no
                // fontconfig rule saying to draw them, so only LibreOffice's built-in
                // metric-compatible pairs (Calibri->Carlito, ...) took effect and every
                // other mapped family fell through to DejaVu Sans (FG-162, FG-167).
                matches: sniffedMatches || undefined,
                message: 'Binary/PDF format'
            });
        }

        // Try to extract fonts from ZIP-based formats
        if (canExtractFonts(filename)) {
            try {
                const startTime = performance.now();

                // Extract font names from document
                let documentFonts;
                let selfSupplied = new Set();
                let faceUsage = null;
                let embeddedCoverage = null;
                let embeddedExpected = null;
                if (typeof FontExtractor !== 'undefined') {
                    if (typeof FontExtractor.extractFontsDetailed === 'function') {
                        const detail = await FontExtractor.extractFontsDetailed(
                            file, filename, {
                                // D4: a PDF-only conversion accepts more embedded
                                // fonts (viewing rights), so it skips more substitutes.
                                targetFormat,
                                acceptEot: !!(resolveOptions && resolveOptions.acceptEot),
                                detectedScripts: themeScriptEvidence(detection),
                                // Reading cmaps is only worth anything when there
                                // is a script font at stake; a Latin document
                                // pays nothing for this.
                                wantCoverage: detection.scripts.length > 0
                            });
                        documentFonts = detail.fonts;
                        selfSupplied = detail.selfSupplied || new Set();
                        faceUsage = detail.usage || null;
                        embeddedCoverage = detail.embeddedCoverage || null;
                        embeddedExpected = detail.embeddedExpected || null;
                        // FG-054: the retry after the engine refused a face we
                        // counted on. Trust nothing the document supplies: fetch
                        // every substitute and every script font.
                        if (resolveOptions && resolveOptions.ignoreSelfSupplied) {
                            selfSupplied = new Set();
                            embeddedCoverage = null;
                            embeddedExpected = null;
                        }
                    } else {
                        documentFonts = await FontExtractor.extractFonts(file, filename);
                    }
                } else {
                    console.warn('[FontResolver] FontExtractor not available');
                    return addScripts({
                        strategy: 'all',
                        fontsToLoad: null,
                        message: 'FontExtractor not loaded'
                    });
                }

                // No font NAMES were declared: the ENGINE picks, so mount what
                // the engine's own default table names (getEngineDefaultFonts).
                //
                // BUG-21: this used to return strategy 'fallback', and
                // conversion_driver.js only forwards fontsToLoad for
                // 'selective' — so this carefully chosen list was computed and
                // then THROWN AWAY, and the worker fell through to its
                // DejaVu-Sans-only emergency set. Every document declining to
                // name a font was typeset sans-serif where Writer's default is
                // Liberation Serif. 'selective' is the honest strategy here:
                // these are specific fonts chosen for this document, which is
                // exactly what that word means to the driver.
                //
                // Faces are narrowed by the same document-wide face union as
                // the fallbacks below. "No font NAMES were declared" says
                // nothing about which WEIGHTS the text uses, and the face scan
                // read the same parts either way; when it resolved, a document
                // with no bold run still cannot render bold in the substitute
                // it lands on. Left untouched when the scan did not resolve.
                if (!documentFonts || documentFonts.size === 0) {
                    const defaults = getEngineDefaultFonts(faceUsage);
                    console.log('[FontResolver] No fonts declared — mounting the engine defaults:',
                                defaults.map(f => f.file).join(', '));
                    return addScripts({
                        strategy: 'selective',
                        fontsToLoad: defaults,
                        message: 'No fonts declared, using the engine defaults'
                    }, embeddedCoverage);
                }

                // Families the document supplies itself need no substitute from
                // our CDN: LibreOffice's embedded-font import is live in this
                // WASM build (proven 2026-07-26 on both the ODF and obfuscated
                // OOXML paths), so it will render those runs from the document's
                // own font and ignore anything we fetch for them. Bandwidth is
                // the dominant production cost, so not fetching it is the win.
                //
                // Only families that pass the ENGINE's own fsType gate are listed
                // here (see FontExtractor.extractEmbeddedFontFamilies) — a font
                // LibreOffice would refuse still needs its substitute downloaded,
                // or the user gets tofu. Anything unparseable is not suppressed.
                //
                // The fallback set below is deliberately NOT reduced: it is the
                // safety net for every run this document does NOT cover, and it
                // is small and cache-hot.
                let requestedFonts = Array.from(documentFonts);
                if (selfSupplied.size) {
                    const before = requestedFonts.length;
                    requestedFonts = requestedFonts.filter(n => !selfSupplied.has(n));
                    console.log(
                        `[FontResolver] ${before - requestedFonts.length} family(ies) supplied by the ` +
                        `document itself — skipping their download:`, Array.from(selfSupplied)
                    );
                }

                // Match document fonts to available substitutes
                let matches;
                if (typeof FontMatcher !== 'undefined') {
                    matches = FontMatcher.matchFonts(requestedFonts);
                } else {
                    console.warn('[FontResolver] FontMatcher not available');
                    return addScripts({
                        strategy: 'all',
                        fontsToLoad: null,
                        message: 'FontMatcher not loaded'
                    });
                }

                // Get font files to load, narrowed to the faces the document
                // actually uses (NTH-03). `faceUsage` is null/unresolved for
                // everything we cannot read statically, and getFontFiles then
                // behaves exactly as it did before.
                let fontsToLoad = FontMatcher.getFontFiles(matches, faceUsage);

                // SUBSET TIERS. A family may ship at more than one coverage
                // level (today: Noto Serif SC as a 2.53 MB GB2312 subset and an
                // 8.49 MB full CJK build). getFontFiles() returns every face of
                // a matched family and cannot choose between them — it has no
                // document context, which is the same reason the byte budget
                // lives in this layer rather than in the matcher. Narrow to one
                // tier here, where `detection` is in scope.
                fontsToLoad = selectFontTier(fontsToLoad, detection);
                fontsToLoad = dropNameMatchedHanFallback(fontsToLoad, detection);

                // Always include fallback fonts - narrowed by the DOCUMENT-WIDE
                // face union only.
                //
                // WHY THE FALLBACK SET IS NARROWED AT ALL. It is the majority of
                // the bytes: the Liberation trio is 4.36 MB of a typical 7.1 MB
                // resolution, three quarters of it bold and italic. It is also
                // the one part of the set we can bound without knowing which
                // family a run will land on: these faces exist to catch runs
                // whose OWN font we did not fetch, and such a run still has a
                // bold/italic attribute that the same scan already read. If the
                // document contains no bold run anywhere, nothing can be
                // rendered bold - in any family, fetched or substituted.
                //
                // WHY IT IS NARROWED DIFFERENTLY. Per-family narrowing keys on
                // the requested names; a fallback family is by construction the
                // family for text we could NOT attribute, so it is given
                // `usage.global` (every face used anywhere) rather than any
                // per-family set. narrowFallbackFaces() enforces that by passing
                // no names at all, which allowedFaces() answers with the global
                // union plus the always-kept Regular.
                const fallbacks = narrowFallbackFaces(getFallbackFonts(), faceUsage);
                const fallbackFiles = new Set(fallbacks.map(f => f.file));
                for (const font of fontsToLoad) {
                    fallbackFiles.delete(font.file);
                }
                // Add any fallbacks not already included
                const fallbacksToAdd = fallbacks.filter(f => fallbackFiles.has(f.file));

                const allFonts = [...fontsToLoad, ...fallbacksToAdd];
                const elapsed = (performance.now() - startTime).toFixed(1);

                console.log(`[FontResolver] Resolved ${documentFonts.size} doc fonts → ${allFonts.length} files in ${elapsed}ms`);
                if (faceUsage && faceUsage.resolved) {
                    console.log('[FontResolver] Face narrowing active — document uses:',
                                Array.from(faceUsage.global).sort().join(', ') || '(no text found)');
                }

                // Log matching details
                for (const match of matches) {
                    const conf = Math.round(match.confidence * 100);
                    console.log(`  ${match.requestedFont} → ${match.family} (${conf}%, ${match.reason})`);
                }

                return addScripts({
                    strategy: 'selective',
                    fontsToLoad: allFonts,
                    // FG-150: the catch-all faces no matched family asked for.
                    // applyFontBudget ranks these after the matched families.
                    fallbackOnlyFiles: fallbacksToAdd.map(f => f.file),
                    documentFonts: Array.from(documentFonts),
                    matches,
                    // FG-054: the embedded-font files the engine should write for
                    // the families whose substitute we skipped (null: none skipped).
                    embeddedExpected: selfSupplied.size ? embeddedExpected : null,
                    message: `Matched ${matches.length} fonts`
                }, embeddedCoverage);

            } catch (e) {
                console.error('[FontResolver] Font extraction failed:', e);
                return addScripts({
                    strategy: 'all',
                    fontsToLoad: null,
                    message: 'Extraction failed: ' + e.message
                });
            }
        }

        // Text-ish (txt, rtf, html) and unknown formats - essential fonts, plus
        // whatever the content sniff says the scripts need (BUG-12: a .txt was
        // previously never sniffed at all, so CJK/Thai/Hindi rendered as tofu).
        console.log('[FontResolver] Text/unknown format, loading essential fonts');
        return addScripts({
            strategy: 'selective',
            fontsToLoad: getEssentialFonts(),
            message: 'Text/unknown format'
        });
    }

    /**
     * Which detected/assumed scripts still need a font FROM US (NTH-07).
     *
     * A document that carries its own font covering the script it contains does
     * not need the 3.85 MB CJK face, or the 2.05 MB Korean one, or any of the
     * other script fonts — the engine will draw those runs from the document's
     * own font (proven for the DOCX and ODF embedding paths; for PPTX the
     * engine decodes EOT since FG-054, see ENGINE_ACCEPTS_EOT_EMBEDDED in
     * font_extractor.js, but a compressed .fntdata has no cmap we can read, so
     * a PPTX contributes no coverage here).
     *
     * THIS IS THE ONE PLACE ALLOWED TO REMOVE A PROTECTED FONT, so every
     * condition below is a veto and every unknown means "keep it":
     *   1. `coverage` — the cmap union of embedded faces the ENGINE will accept
     *      (fsType, and the subsetted-glyph-count rule). No coverage, no change.
     *   2. `trusted` — a container whose text we could really decode. OLE2/PDF
     *      are excluded, and they cannot carry embedded fonts we can read anyway.
     *   3. `sampled` — some text was actually read. An empty read proves nothing.
     *   4. `complete` — we read ALL of the document's text, not the first 200 KB.
     *      Otherwise "no uncovered code point" only means "none in the part we
     *      looked at", and a deck whose last slide is Japanese loses its font.
     *   5. every code point of that script IN THE TEXT is in the cmap. Partial
     *      coverage keeps the download — one missing glyph is one box.
     * `assumedScripts` are never eligible: they are a declared guess with no
     * code points behind them, so there is nothing to prove covered.
     *
     * @returns {{detected:string[], covered:string[], suppressed:string[]}}
     *   detected  — detected scripts that still need a font from us
     *   covered   — detected + assumed, i.e. what to actually load fonts for
     *   suppressed— detected scripts the document covers by itself
     */
    function scriptsStillNeeded(detection, coverage, provider) {
        const assumed = detection.assumedScripts || [];
        const all = { detected: detection.scripts.slice(),
                      covered: detection.scripts.concat(assumed),
                      suppressed: [] };
        if (!coverage || typeof coverage.has !== 'function') return all;
        if (!detection.trusted || !detection.sampled || !detection.complete) return all;
        if (!detection.codePoints) return all;

        const suppressed = [];
        for (const id of detection.scripts) {
            const points = detection.codePoints[id];
            // No code points recorded for a script we claim to have detected is
            // a contradiction, not an opportunity: keep the font.
            if (!points || !points.length) continue;
            if (points.every(cp => coverage.has(cp))) suppressed.push(id);
        }
        if (!suppressed.length) return all;

        const keptDetected = detection.scripts.filter(id => !suppressed.includes(id));
        console.log(
            `[FontResolver] ${suppressed.join(', ')} covered by ` +
            `${provider || "the document's own embedded font(s)"} — not downloading ` +
            `our script font(s) for it.`);
        return {
            detected: keptDetected,
            covered: keptDetected.concat(assumed),
            suppressed
        };
    }

    /**
     * The han safety net is redundant when a font we are ALREADY downloading
     * draws every CJK character the document contains (NTH-12).
     *
     * A Chinese document naming SimSun fetches BOTH Noto Serif SC (the matched
     * substitute) AND Droid Sans Fallback (the `han` script font, a safety net
     * for text whose own family we did not fetch). When the serif face provably
     * covers the document, the net catches nothing and costs 1.10 MB as a subset
     * or 3.85 MB full — measured 2026-07-29 as 23% and 30% of those two
     * conversions' entire font download.
     *
     * THE PROOF IS scriptsStillNeeded(), unchanged. That predicate already does
     * exactly this for fonts the DOCUMENT EMBEDS (NTH-07) — trusted, sampled,
     * COMPLETE, recorded code points, and every one of them in the coverage —
     * and NTH-08's rejection established that the per-code-point form is the
     * only sound one. All this function does is supply a different provider of
     * the coverage. It does not re-implement the test, and must not: a second
     * copy is how the two formulations drift apart.
     *
     * TWO THINGS ARE DELIBERATELY STRICTER THAN THE NTH-07 CASE:
     *   1. The code points proven are `detection.cjkPoints`, not
     *      `codePoints.han`. The han PATTERN does not match U+3002 。or U+FF0C
     *      ，, and MEASURED 2026-07-29 no Latin face we ship draws either — so
     *      proving only the pattern's own points would have dropped the one font
     *      rendering the document's punctuation. See cjkCoveragePoints().
     *   2. The covering font must have a MEASURED cmap table
     *      (ConversionProtocol.CJK_COVERAGE, generated from the shipped file).
     *      A CJK font with no entry — every BIZ UD face today — can never
     *      justify a suppression, so a Japanese document keeps its safety net.
     *      That is unclaimed saving, not a risk, and adding an entry is the
     *      single, explicit way to opt a font in.
     *
     * @param {Array<Object>|null} fonts the set we are about to download
     * @param {Object} detection
     * @param {{detected:string[]}} kept result of scriptsStillNeeded so far
     * @returns {Object|null} the registry entry that justified the suppression —
     *   which the caller MUST protect from the byte budget (see withScriptFonts)
     */
    function hanCoveredByDownload(fonts, detection, kept) {
        if (!kept || !kept.detected.includes('han')) return null;   // nothing to drop
        if (!Array.isArray(fonts) || !fonts.length) return null;
        const points = (detection && detection.cjkPoints) || [];
        if (!points.length) return null;
        if (!_P.cjkCoverageOf || !_P.fontCoversAllCJK) return null;

        // Smallest sufficient coverer wins, for the same reason selectFontTier
        // prefers the smallest sufficient tier: they are equally sound and one
        // is cheaper. Ties keep registry order.
        let coverer = null;
        for (const f of fonts) {
            if (!f || !f.file) continue;
            if (!_P.fontCoversAllCJK(points, f.file)) continue;
            if (!coverer || (f.size || 0) < (coverer.size || 0)) coverer = f;
        }
        if (!coverer) return null;

        // Hand the SAME predicate a han-only view whose recorded code points are
        // the wider CJK set, and the candidate's cmap as the coverage.
        const view = { ...detection, scripts: ['han'], codePoints: { han: points } };
        const proof = scriptsStillNeeded(
            view, _P.cjkCoverageOf(coverer.file), `${coverer.file} (already downloading)`);
        return proof.suppressed.includes('han') ? coverer : null;
    }

    /**
     * Evidence good enough to DROP a font, as opposed to good enough to ADD one.
     *
     * An OOXML theme lists a fallback typeface per script whether or not the
     * document contains that script (see the note in font_extractor.js). Pruning
     * those entries is only safe on POSITIVE PROOF of absence, and the bar is
     * higher than the one script-font LOADING uses:
     *   * `trusted` — a container whose text we could genuinely decode. OLE2 and
     *     PDF report trusted:false and are excluded, and assumedScripts (a
     *     declared guess) is never consulted here.
     *   * `sampled` — we actually read some text. An empty sample yields the
     *     same `scripts: []` as a Latin-only document while proving nothing at
     *     all: an image-only DOCX, a part we could not inflate, or a text-free
     *     deck must keep today's harvest-everything behaviour.
     * Anything short of both returns null, which the extractor reads as "prune
     * nothing".
     * @returns {string[]|null}
     */
    function themeScriptEvidence(detection) {
        if (!detection || !detection.trusted || !detection.sampled) return null;
        if (!Array.isArray(detection.scripts)) return null;
        // FG-186: `kana` is not a script we fetch a font for (kana is part of
        // `han`), but it is the evidence that a theme's Japanese (Jpan) entry is
        // the one Word would use (FontExtractor extractThemeFonts).
        const han = (detection.codePoints && detection.codePoints.han) || [];
        const kana = han.some(cp => (cp >= 0x3040 && cp <= 0x30FF) || (cp >= 0x31F0 && cp <= 0x31FF) ||
                                    (cp >= 0xFF66 && cp <= 0xFF9F));
        return kana ? detection.scripts.concat('kana') : detection.scripts;
    }

    /**
     * Merge script-coverage fonts into a resolution result (BUG-12).
     * No detected AND no assumed script => the object is returned unchanged, so
     * plain-ASCII documents load EXACTLY the fonts they loaded before this fix.
     */
    // ------------------------------------------------------------------
    // Download budget for one document's fonts.
    //
    // MEASURED 2026-07-26: the ENGINE imposes no meaningful limit -- all 319
    // fonts (81.8 MB) load fine and init_office() is constant at ~55 ms from 0 to
    // 4,001 files. So this is NOT the old "fontconfig hangs" folklore. The real
    // constraint is BYTES ON THE WIRE against a conversion timeout that
    // calculateTimeout() derives from the INPUT FILE size and which does not
    // budget font downloads at all. ~10 MB is about 16 s at 5 Mbps, inside the
    // 31 s floor with margin.
    //
    // WHY IT LIVES HERE and not in FontMatcher.getFontFiles(): only this layer
    // sees the FULL set. Fallback faces and script fonts are appended after the
    // matcher returns, so a cap inside the matcher budgeted document fonts alone
    // -- it could drop the document's own body font while still loading megabytes
    // of extras on top, and undercount the very total it was bounding.
    //
    // PRIORITY, highest first (only the tail is ever dropped):
    //   1. script fonts   -- dropping one causes TOFU, a correctness failure
    //   2. fallback faces -- the safety net every substitution relies on
    //   3. document-requested fonts, best match first -- discretionary; losing one
    //      degrades to a substitute, which is a fidelity cost, not a correctness one
    //
    // RAISED 10 MB -> 24 MB on 2026-07-27, and the original rationale above is
    // why it could be. The 10 MB figure was chosen when calculateTimeout() knew
    // nothing about fonts, so every byte fetched ate into a budget derived from
    // the INPUT FILE size alone. That is no longer true: the driver now adds
    // _fontDownloadAllowance(bytes, files) — computed from the ACTUAL resolved
    // set, not from this cap — to the armed timeout (see
    // tests/unit/test_timeout_font_budget.js). A Latin document still gets a
    // near-zero allowance; only a genuinely font-heavy one gets the long window.
    //
    // What forced the change: shipping Japanese faces by NAME. Measured against
    // the real registry on 2026-07-27, resolving
    // test_corpus/fixtures/edge_cases/docx/japanese_mincho_gothic.docx end to
    // end through the real resolver —
    //   BIZ UDMincho 5.87 + BIZ UDGothic 4.45  (both named by the document)
    // + DroidSansFallbackFull 3.85             (the `han` script font, protected)
    // + Liberation Sans/Serif/Mono Regular 1.07 (the fallback set, narrowed to
    //   the faces this document actually uses)
    // = 15.24 MiB, and 18.33 MiB for the same document when face usage cannot be
    //   read at all and all 12 Liberation faces come along.
    //   DOCX naming MS Mincho alone ............................... 13.87 MiB
    //   Japanese .txt (essential set + han) ....................... 11.70 MiB
    //   mixed_cjk.txt (essential + han + hangul) .................. 13.66 MiB
    // At 10 MB the first case dropped BIZ UDGothic *and then every Liberation
    // face*: 3.85 protected + 5.87 Mincho = 9.72 MiB, leaving 0.76 MB, which the
    // 4.45 MB Gothic cannot fit and which the 0.39 MB Liberation Sans then
    // overflows. The document ended up with one Japanese font and NO Latin font
    // at all — silently. Reproduced by mutation: setting this constant back to
    // 10 MB turns tests/unit/test_japanese_substitution.js red. The two .txt cases were already over the cap before any
    // of this work, quietly shedding the tail of the essential set.
    //
    // 24 MB covers a document naming up to three Japanese families plus the CJK
    // safety net plus the full Latin fallback set (22.78 MiB), which is the
    // worst shape a real Office document plausibly takes.
    //
    // RAISING A CAP CANNOT ADD A DOWNLOAD. The budget only ever DROPS entries,
    // so every document that fitted under 10 MB fetches byte-identically to
    // before; the only behavioural change is that fewer documents lose fonts.
    //
    // The han script font is NOT redundant once Japanese faces ship, and that was
    // measured rather than assumed: BIZ UD covers JIS X 0208/0213 100% but only
    // 61.3% of GB2312 and 58.5% of Big5 hanzi, where DroidSansFallbackFull covers
    // both 100%. Dropping it for a Japanese-named document would put tofu in any
    // document that mixes Chinese in — so it stays, and its 3.85 MB is part of
    // the worst case above rather than something to optimise away.
    const MAX_FONT_BYTES = 24 * 1024 * 1024;
    // RAISED 64 -> 128 on 2026-07-30. The count cap, not MAX_FONT_BYTES, was
    // shedding script fonts and causing tofu.
    //
    // 64 was chosen when ConversionProtocol.SCRIPTS referenced 16 font files. It
    // now references 74, because scripts we ship fonts for were wired up (a
    // document in Tibetan, Mongolian, Syriac, Thaana or Vai previously rendered
    // as boxes). A multi-script document therefore exceeded the COUNT while using
    // only 13.2 MiB of the 24 MiB byte budget — measured — and the tail it shed
    // was script fonts, which is the one category the priority order below calls
    // a correctness failure rather than a fidelity one.
    //
    // Caught by tests/lib/tofu_check.js on utf8_scripts_a_core.txt:
    // NotoSansTifinagh-Regular covers all 10 Tifinagh code points in that
    // fixture, DejaVuSans covers 6, and the PDF embedded NEITHER because the
    // Tifinagh entry never survived the budget.
    //
    // Why raising it is safe: the cap originally guarded a hang that does not
    // exist. "Loading all 319 fonts hangs init_office() during the fontconfig
    // scan" was measured FALSE on 2026-07-26 — init_office() is constant at
    // 51-62 ms from 0 to 4,001 font files. So bytes are the real constraint and
    // this number should be high enough that MAX_FONT_BYTES always binds first.
    // Worst realistic set: 74 script files + 12 Liberation faces + a document's
    // own families ~= 95.
    const MAX_FONT_FILES = 128;

    // ========================================================================
    // DO NOT ADD A "CAP CONCURRENT CJK FACES" RULE HERE. It was a real, costed
    // proposal, and FM-3 made it actively harmful. This is the function it
    // would naturally be written into, so the warning lives here.
    //
    // THE PROPOSAL: a document naming several CJK families downloads several
    // multi-megabyte faces, so mount the highest-priority one and skip the
    // rest. It was measured saving 10.8 MB on one document with no fidelity
    // loss, and on the numbers of the day it was correct.
    //
    // WHY IT WAS TRUE: the engine drew ONE face for every CJK run in the
    // document, because it could not resolve the requested family by name and
    // fell through to glyph fallback, which is per-DOCUMENT, not per-family.
    // The other faces genuinely were pure transfer cost.
    //
    // WHY IT IS NOW FALSE: FM-3 gave the engine per-family substitution rules,
    // so each mounted face is drawn for the family that asked for it.
    // Re-measured on the SAME document that produced the 10.8 MB figure
    // (ＭＳ 明朝, ＭＳ ゴシック, Yu Gothic, 宋体, SimSun):
    //
    //     asked MSMincho   drawn BIZUDMincho-Regular
    //     asked MSGothic   drawn BIZUDGothic-Regular
    //     asked YuGothic   drawn BIZUDPGothic-Regular
    //     asked SongTi     drawn NotoSerifSC-Regular
    //     asked SimSun     drawn NotoSerifSC-Regular   (same family, correctly)
    //
    // Four distinct faces, all four embedded, all four used. The bytes the cap
    // would have saved are now the bytes doing the work. Capping would pick one
    // face and render the other families in it — a Gothic (sans) heading drawn
    // in Mincho (serif), which is precisely the bug FM-3 fixed.
    //
    // If you are here to reduce CJK bytes, the honest levers are: subsetting to
    // the code points a document actually uses, or selectFontTier()'s coverage
    // tiers below. Dropping a face a document asked for is not a bandwidth
    // optimisation, it is a fidelity regression with a bandwidth side effect.
    //
    // Full record: docs/backlog/font-mapping-coverage.md -> "The CJK download
    // cap" and triage-fix-or-accept.md.
    // ========================================================================
    function applyFontBudget(fonts, protectedFiles, fallbackOnlyFiles) {
        const kept = [];
        const dropped = [];
        let bytes = 0;
        // BUG-17: fonts that share a content hash are fetched ONCE on the wire
        // (font_loader.js / conversion_worker.js reuse the payload for every
        // entry with the same hash) -- so a second entry with an
        // already-counted hash costs 0 additional bytes here. Charging the
        // budget per-ENTRY instead of per-PAYLOAD would let duplicate bytes
        // evict a font the document genuinely needs, which defeats the entire
        // point of shipping the hash. Entries with no `hash` (older registry
        // rows, or a registry that predates this field) are never deduped --
        // each counts its own size, byte-identical to pre-hash behavior.
        const countedHashes = new Set();
        // Protected entries are admitted first and are never dropped, so the
        // budget can only shed discretionary document faces.
        //
        // WITHIN the discretionary tail, UPRIGHT REGULAR FACES GO FIRST.
        // Measured 2026-07-27, this is not cosmetic. The essential Latin set is
        // 24 files / 7.85 MB, three quarters of which is bold + italic, and the
        // registry is ordered alphabetically by FILE, so "LiberationMono-Bold"
        // sorts ahead of "LiberationMono-Regular". Adding the 2.05 MB Korean
        // font tipped mixed_cjk.txt over MAX_FONT_BYTES and the budget evicted
        // Liberation Mono REGULAR while keeping Liberation Mono BOLD — the PDF
        // then set the document's plain body text in Bold. Caught by
        // tests/gates/test_font_embedding.js, which asserts the Latin base font
        // survives every script addition.
        //
        // Regular-first is the right order regardless of that trigger: a missing
        // Bold or Italic is SYNTHESISED by fontconfig (that is exactly why
        // getScriptFonts loads only Regular faces), while a missing Regular has
        // nothing to synthesise from and drops the family entirely. Sort is
        // stable in every engine we target, so entries of equal rank keep their
        // caller-supplied priority order.
        //
        // FG-150: and among the upright regulars, the LIBERATION fallbacks go
        // first. They are small (0.1-0.4 MB each) and carry every Latin run in
        // the document; a large discretionary CJK family is the better thing to
        // shed, because the protected script font still covers its text. Under
        // the old order a near-exact fill by CJK families dropped every Latin
        // face, silently (measured at the 10 MB cap; computed possible at 24 MB).
        //
        // Bounded (Fable review, 2026-10-05): the head-of-line rank goes only to
        // an essential face the DOCUMENT reached, i.e. a declared family matched
        // to it (Times New Roman -> Liberation Serif), or the essential set of a
        // text-ish file, which is all it has. A face present only as the
        // catch-all fallback (`fallbackOnlyFiles`, appended by resolveFonts) may
        // never be used: a document that sets its Latin runs in MS Mincho has
        // them drawn by BIZ UDMincho. Ranking such a face first would shed a
        // CJK family the document names, so it keeps its caller position, after
        // the matched families. The family list is ESSENTIAL_FAMILIES, not a
        // second copy of it.
        const fallbackOnly = fallbackOnlyFiles || new Set();
        const isDocumentEssential = (f) => ESSENTIAL_FAMILY_SET.has(f.family || '')
                                           && !fallbackOnly.has(f.file);
        const faceRank = (f) => (((f.style || 'normal') !== 'normal') ? 4 : 0) +
                                (((f.weight || 'Regular') !== 'Regular') ? 2 : 0) +
                                (isDocumentEssential(f) ? 0 : 1);
        const ordered = fonts.filter(f => protectedFiles.has(f.file))
                             .concat(fonts.filter(f => !protectedFiles.has(f.file))
                                          .sort((a, b) => faceRank(a) - faceRank(b)));
        for (const font of ordered) {
            const isDupPayload = !!font.hash && countedHashes.has(font.hash);
            const size = isDupPayload ? 0 : (font.size || 0);
            const isProtected = protectedFiles.has(font.file);
            if (!isProtected && (kept.length >= MAX_FONT_FILES || bytes + size > MAX_FONT_BYTES)) {
                dropped.push(font);
                continue;
            }
            kept.push(font);
            bytes += size;
            if (font.hash) countedHashes.add(font.hash);
        }
        if (dropped.length) {
            // Never silent: a capped download means some requested face silently
            // falls back to a substitute, and whoever debugs that needs to know.
            console.warn(
                `[FontResolver] Font budget reached (${kept.length} files, ` +
                `${(bytes / 1048576).toFixed(1)} MB) — dropped ${dropped.length} ` +
                `lower-priority face(s); those families fall back to a substitute.`
            );
        }
        return kept;
    }

    function withScriptFonts(result, detection, coveredScripts, scriptFonts, warningMsg,
                            protectedByProof) {
        // Nothing detected and nothing assumed: byte-identical to pre-BUG-12.
        if (!detection.scripts.length && !(detection.assumedScripts || []).length) return result;

        const out = { ...result };
        // Keep the two apart on the result object as well: `detectedScripts` is
        // evidence, `assumedScripts` is a guess. Anything user-facing may only
        // ever read `detectedScripts`.
        if (detection.scripts.length) out.detectedScripts = detection.scripts;
        if (detection.assumedScripts && detection.assumedScripts.length) {
            out.assumedScripts = detection.assumedScripts;
        }
        if (warningMsg) out.fontWarning = warningMsg;
        // Every script the document covers by itself (NTH-07) — the evidence is
        // still REPORTED even though no font is loaded for it, because
        // "detected" and "we fetched something for it" are different facts and
        // conflating them is how a silent behaviour change hides.
        //
        // NTH-12 INVARIANT: THE FONT THAT JUSTIFIED A SUPPRESSION MUST ITSELF BE
        // UNSHEDDABLE.
        //
        // This is the ordering hazard that kept NTH-12 unimplemented, and it is
        // the whole reason this parameter exists. applyFontBudget() runs AFTER
        // script fonts are appended and DROPS discretionary entries over
        // MAX_FONT_BYTES. Today that is safe because the han font is
        // unconditionally protected. The moment a suppression moves the
        // document's han coverage onto a MATCHED family — which is discretionary,
        // exactly the class the budget is allowed to shed — the failure mode
        // becomes: suppress Droid, shed Noto Serif SC, ship a document with no
        // han font at all. Silent tofu, and worse than the download we saved.
        //
        // So a suppression's justification is promoted to protected for the
        // budget pass. Anything in `protectedByProof` was proven, one code point
        // at a time, to be the reason a script font is missing from this set.
        // Do not drop this argument, and do not add another producer of
        // suppression that does not supply it.
        const proven = new Set(protectedByProof || []);
        if (!coveredScripts.length && !proven.size) return out;
        if ((!scriptFonts.length && !proven.size) || !Array.isArray(result.fontsToLoad)) return out;

        // The driver only forwards fontsToLoad for strategy 'selective'; a
        // 'fallback' result would be dropped and the worker would fall back to
        // its emergency set. Promote it — and widen the base to the full
        // essential set, because the 3-family fallback list has no DejaVu and
        // would LOSE the Arabic coverage the emergency path had.
        //
        // REACHABILITY (BUG-21): no producer returns 'fallback' any more — the
        // no-fonts-declared path returns 'selective' with getEngineDefaultFonts(),
        // whose set already contains DejaVu Sans, precisely so that the fonts it
        // picks are not silently discarded by the driver. This branch is kept as
        // defence in depth for any future strategy that is not forwarded, and is
        // asserted directly in tests/unit/test_font_resolver.js rather than left
        // as an untested claim.
        let base = result.fontsToLoad;
        if (out.strategy === 'fallback') {
            out.strategy = 'selective';
            const essential = getEssentialFonts();
            const have = new Set(base.map(f => f.file));
            base = base.concat(essential.filter(f => !have.has(f.file)));
        }

        const seen = new Set(base.map(f => f.file));
        // Script fonts are appended here, AFTER the matched-font tier filter in
        // resolveFonts(), so they need their own pass. Same rule, same proof:
        // the han safety net may ship as a subset only when the document's own
        // han code points are provably inside it. Droid is 3.85 MB full and
        // 1.10 MB as a GB2312 subset, and it is fetched for EVERY document
        // containing CJK — a wider reach than any matched family.
        //
        // Ext-A (U+3400-U+4DBF) is deliberately absent from the subset. It IS
        // inside the measured coverage blocks, so the table describes it
        // honestly — as 6,582 zero bits — and a document using Ext-A therefore
        // fails up to the full font on the evidence rather than on a gap in the
        // table's reach. Carrying those glyphs in the subset would have bought
        // nothing: the subset would never be the tier serving such a document.
        const extra = (coveredScripts.length && scriptFonts.length)
            ? selectFontTier(scriptFonts.filter(f => !seen.has(f.file)), detection)
            : [];

        // Script fonts are protected: dropping one is a correctness failure (tofu),
        // not a fidelity trade-off. So is anything that stands in for one.
        const protectedFiles = new Set(extra.map(f => f.file));
        for (const file of proven) protectedFiles.add(file);
        if (!protectedFiles.size) {
            out.fontsToLoad = base;
            return out;
        }

        out.fontsToLoad = applyFontBudget(base.concat(extra), protectedFiles,
                                          new Set(result.fallbackOnlyFiles || []));
        console.log('[FontResolver] Script coverage:',
                    (detection.scripts.length ? detection.scripts.join(', ') : '(none detected)'),
                    (out.assumedScripts ? `+ assumed ${out.assumedScripts.join(', ')}` : ''),
                    '→ +' + (extra.length ? extra.map(f => f.file).join(', ') : '(no script font needed)'),
                    (proven.size ? `[protected as the proof of a suppression: ${Array.from(proven).join(', ')}]` : ''));
        return out;
    }

    /**
     * User-facing message for a detected script we have no font for.
     *
     * AS OF 2026-07-27 THERE ARE NO SUCH SCRIPTS — Korean and pictographic emoji
     * were the last two and both now ship a font, so this function returns null
     * for every real input. That is the desired state, not dead code: the moment
     * a new script is added to SCRIPTS with `files: []` this is what tells the
     * user instead of handing them silent boxes. It is kept under test with a
     * synthetic gap entry (tests/unit/test_font_resolver.js, "the warning channel
     * itself still works") so it cannot rot while it has no live subject.
     *
     * THE WARNING CHANNEL MUST STAY TRUSTWORTHY. It is the only way we tell a
     * user their output will be wrong, so a single phantom warning costs more
     * than the tofu it was meant to prevent. Two independent gates enforce that
     * only real evidence can reach it:
     *   1. `trusted === false` (a container we cannot reliably decode) returns
     *      null unconditionally, whatever the scripts list claims;
     *   2. only `detection.scripts` (evidence) is consulted — never
     *      `detection.assumedScripts`, which is by definition a guess.
     * This is the single producer of `result.fontWarning`; the driver just
     * forwards it (conversion_driver.js -> libreoffice-font-warning). Do not add
     * a second producer that reads assumedScripts or an untrusted detection.
     */
    function buildScriptWarning(detection) {
        if (!detection.trusted) return null;
        const labels = _P.unsupportedScriptLabels(detection.scripts);
        if (!labels.length) return null;
        return `No font for ${labels.join(' / ')} is available, so that text may appear ` +
               `as empty boxes in the converted file. All other text converts normally.`;
    }

    /**
     * Get essential font entries from the registry
     * These are the 7 families needed for basic text rendering
     */

    /**
     * Collapse multi-tier families to a single tier per family.
     *
     * Registry entries may carry a `tier`: 'full' is the complete font, anything
     * else names a subset whose coverage ConversionProtocol.fontCoversAllCJK()
     * can test. Families with no `tier` are untouched.
     *
     * CHOOSES THE SMALL TIER ONLY ON POSITIVE PROOF. Both must hold:
     *   1. detection.complete === true — the sampled text was the WHOLE
     *      document. A bounded prefix proves nothing about the rest, and the
     *      sample cap is 256 KB.
     *   2. every han code point seen is in that tier's coverage bitmap.
     * Otherwise the 'full' entry is kept. An unsniffable container (OLE2, PDF),
     * a truncated read, or one uncovered character all take the full font.
     *
     * WHY THE ASYMMETRY IS NOT OPTIONAL: LibreOffice selects ONE covering font
     * per run. A subset that misses a single character does not fall back for
     * that character — the WHOLE document demotes to the sans fallback, losing
     * the serif everywhere. Choosing "too big" costs bytes; choosing "too
     * small" silently destroys the fidelity this font exists to provide. So
     * every uncertain path resolves upward.
     */
    /**
     * FG-055: CJK-only faces a document can pull in by NAME, and the text that
     * makes one worth downloading.
     *
     * Droid Sans Fallback is a fallback face with almost no Latin; family names
     * pull it in (SimHei, 黑体, 等线, Microsoft JhengHei — and Office themes name
     * Microsoft JhengHei for Bopomofo in nearly every English document). Noto
     * Serif TC, NanumMyeongjo and NanumGothic are named by MingLiU/PMingLiU,
     * Batang and Malgun Gothic, which
     * a document's font table often lists with no Chinese or Korean in it. When
     * the document's whole, trusted text has none of the characters a face
     * exists for, it is not downloaded on account of a name. That is output-
     * neutral: before FG-055 those names reached Droid or nothing, neither of
     * which drew their Latin either. The substitution rule still names the face;
     * fontconfig skips an absent family.
     *
     * The proof is that of scriptsStillNeeded(): trusted, sampled AND complete,
     * plus the CJK census (cjkCoveragePoints: ideographs, kana, CJK punctuation,
     * fullwidth forms, Bopomofo — not just the `han` pattern; a SimHei run of
     * only `（１２３）` needs Droid). Anything less keeps the face.
     *
     * Not applied to Noto Serif SC or the BIZ UD faces: on main they are mounted
     * for such documents and draw the Latin of runs that name them, so dropping
     * them would change output (recorded in FG-055 as a follow-up).
     */
    const NAME_MATCHED_CJK_FACES = {
        'droid sans fallback': { scripts: ['han'] },
        'noto serif tc': { scripts: ['han'] },
        'nanummyeongjo': { scripts: ['han', 'hangul', 'hangul-jamo'] },
        'nanumgothic': { scripts: ['han', 'hangul', 'hangul-jamo'] }
    };
    function dropNameMatchedHanFallback(fonts, detection) {
        if (!Array.isArray(fonts) || !detection) return fonts;
        if (!detection.trusted || !detection.sampled || !detection.complete) return fonts;
        if (!Array.isArray(detection.cjkPoints)) return fonts;
        const present = (detection.scripts || []).concat(detection.assumedScripts || []);
        const dropped = new Set();
        const kept = fonts.filter(f => {
            const rule = NAME_MATCHED_CJK_FACES[(f.family || '').toLowerCase()];
            if (!rule) return true;
            if (detection.cjkPoints.length) return true;
            if (rule.scripts.some(id => present.includes(id))) return true;
            dropped.add(f.family);
            return false;
        });
        if (dropped.size) {
            console.log(`[FontResolver] ${[...dropped].join(', ')} named by a family, but the document ` +
                        'has no text it draws: not downloading it.');
        }
        return kept;
    }

    function selectFontTier(fonts, detection) {
        // NOTE: this narrows a family to ONE COVERAGE TIER of itself. It must
        // never be widened into "one family per script" — that is the CJK
        // download cap, which FM-3 made a fidelity regression. See the block
        // above applyFontBudget() for the measurements.
        if (!Array.isArray(fonts) || fonts.length === 0) return fonts;
        if (!fonts.some(f => f && f.tier)) return fonts;          // nothing tiered

        const complete = !!(detection && detection.complete);
        const han = (detection && detection.codePoints && detection.codePoints.han) || [];

        const byFamily = new Map();
        for (const f of fonts) {
            const k = (f.family || '').toLowerCase();
            if (!byFamily.has(k)) byFamily.set(k, []);
            byFamily.get(k).push(f);
        }

        const keep = new Set();
        for (const [, group] of byFamily) {
            const tiered = group.filter(f => f.tier);
            if (tiered.length <= 1) { group.forEach(f => keep.add(f)); continue; }

            const full = tiered.find(f => f.tier === 'full') || tiered[0];
            let chosen = full;
            if (complete && han.length) {
                // Smallest proven-sufficient tier wins.
                const subsets = tiered
                    .filter(f => f.tier !== 'full')
                    .sort((a, b) => (a.size || 0) - (b.size || 0));
                for (const s of subsets) {
                    // Keyed by FILE, not by tier id: two families may both ship a
                    // tier called 'gb2312' (they do — Noto Serif SC and Droid Sans
                    // Fallback) and only the file identifies whose cmap was
                    // measured. A font with no measured table never wins here.
                    if (_P.fontCoversAllCJK && _P.fontCoversAllCJK(han, s.file)) { chosen = s; break; }
                }
            }
            if (chosen !== full) {
                console.log(`[FontResolver] Tier: ${chosen.family} -> ${chosen.tier} ` +
                            `(${(chosen.size / 1048576).toFixed(2)} MB instead of ` +
                            `${(full.size / 1048576).toFixed(2)} MB; ${han.length} han code points, all covered)`);
            } else if (tiered.length > 1) {
                const why = !complete ? 'text sample incomplete'
                          : !han.length ? 'no han code points recorded'
                          : 'document uses characters outside every subset';
                console.log(`[FontResolver] Tier: ${full.family} -> full (${why})`);
            }
            keep.add(chosen);
            group.filter(f => !f.tier).forEach(f => keep.add(f));
        }
        return fonts.filter(f => keep.has(f));
    }

    function getEssentialFonts() {
        if (!fontRegistry?.fonts) return [];

        const result = [];
        const seenFiles = new Set();

        for (const family of ESSENTIAL_FAMILIES) {
            const fonts = fontRegistry.fonts.filter(f =>
                f.family.toLowerCase() === family.toLowerCase()
            );
            for (const font of fonts) {
                if (!seenFiles.has(font.file)) {
                    seenFiles.add(font.file);
                    result.push(font);
                }
            }
        }

        return result;
    }

    /**
     * Registry entries for the fonts that cover the given scripts (BUG-12).
     * Matches on the exact FILE name from ConversionProtocol.SCRIPTS, every one
     * of which is present in web/fonts/fonts.json. The table there is the single
     * source of truth — do NOT re-list the mapping here, it only rots; as of
     * 2026-07-27 every one of its 18 entries names a font and there are NO
     * declared gaps left (Korean and pictographic emoji were the last two).
     * Most scripts cost ONE file of 0.05-0.3 MB, and only when the document
     * actually contains that script. Three are worth knowing about:
     *   emoji               DejaVuSans.ttf — already in the essential set, so 0 B
     *   hangul              NanumGothic-Regular.ttf, 2.05 MB
     *   emoji-pictographic  NotoEmoji[wght].ttf, 1.98 MB
     * A document containing BOTH Korean and pictographic emoji therefore adds
     * ~3.9 MB of protected script fonts on top of the ~7.85 MB essential set.
     * Under the old 10 MB cap that overflowed and applyFontBudget shed the tail
     * of the essential list (DejaVu Sans Mono first) rather than a script font —
     * the intended priority, but a real loss. At the current 24 MB cap it fits
     * (11.7 MiB) and nothing is dropped. The priority still governs whenever the
     * cap IS reached; see the budget note above for the shapes that reach it.
     * Bold/italic faces are deliberately NOT loaded: fontconfig synthesises
     * them, and every extra file costs startup time in the fontconfig scan.
     * @param {string[]} scripts
     * @returns {Array<Object>} registry font entries
     */
    function getScriptFonts(scripts) {
        if (!fontRegistry?.fonts || !scripts || !scripts.length) return [];
        const wanted = _P.scriptFontFiles(scripts);
        if (!wanted.length) return [];

        const result = [];
        for (const file of wanted) {
            const entry = fontRegistry.fonts.find(f => f.file === file);
            if (!entry) {
                console.warn('[FontResolver] Script font missing from registry:', file);
                continue;
            }
            result.push(entry);
            // SCRIPTS names one FILE per script, which is the right contract —
            // it is the single source of truth for "what draws this script".
            // But a family may also ship subset tiers, and the caller decides
            // between them (selectFontTier). Offer the siblings so there is
            // something to choose from; with none, the named file is returned
            // unchanged and behaviour is exactly as before.
            if (entry.tier) {
                for (const sib of fontRegistry.fonts) {
                    if (sib !== entry && sib.tier &&
                        sib.family.toLowerCase() === entry.family.toLowerCase() &&
                        !result.includes(sib)) {
                        result.push(sib);
                    }
                }
            }
        }
        return result;
    }

    /**
     * Detect which non-Latin scripts the document actually contains (BUG-12).
     *
     * The previous implementation only looked at BINARY/PDF inputs and only for
     * CJK, so a .txt or a DOCX whose runs claim a Latin font was never sniffed —
     * the covering font was never loaded and LibreOffice emitted tofu even though
     * the PDF text layer held the right code points.
     *
     * @param {File} file - The document file
     * @param {string} ext - File extension
     * @returns {Promise<{scripts: string[], trusted: boolean, sampled: boolean,
     *                    assumedScripts?: string[]}>}
     *   scripts        — scripts we have EVIDENCE for (decoded real text).
     *   trusted        — whether that evidence is reliable. false means "we could
     *                    not read this container's text", and the caller must not
     *                    show the user anything based on it.
     *   sampled        — whether any text was actually read. `scripts: []` with
     *                    sampled:false is "we saw nothing", NOT "there is
     *                    nothing"; only the latter may be used as proof that a
     *                    script is absent (see themeScriptEvidence).
     *   complete       — whether the sample is ALL of the document's text. Only
     *                    a complete read can justify dropping a script font
     *                    (NTH-07, scriptsStillNeeded); absent/false everywhere
     *                    else, which simply means "change nothing".
     *   codePoints     — per detected script, the actual code points seen. The
     *                    only thing a cmap can be checked against.
     *   assumedScripts — scripts we deliberately load fonts for WITHOUT evidence,
     *                    because the container is undecodable and guessing wrong
     *                    in the other direction means tofu. Never user-facing.
     */
    /**
     * PERF-04: the detection for a legacy binary whose text could be read, or null (keep the assumption).
     * Kill switch: the release flag `legacyTextSniff`; off, or no flag system at all, means null.
     */
    async function legacyTextDetection(file, ext) {
        try {
            if (ext !== 'doc' && ext !== 'xls' && ext !== 'ppt') return null;
            if (typeof FeatureFlags === 'undefined' || typeof FeatureFlags.isEnabled !== 'function') return null;
            if (FeatureFlags.initialize) { try { await FeatureFlags.initialize(); } catch (e) { return null; } }
            if (FeatureFlags.isEnabled('legacyTextSniff') !== true) return null;
            if (typeof _P.oleTextSample !== 'function') return null;
            if (!file || typeof file.arrayBuffer !== 'function' || !(file.size <= _P.OLE_TEXT_MAX_BYTES)) return null;
            const r = _P.oleTextSample(new Uint8Array(await file.arrayBuffer()), ext);
            if (r.text === null) {
                console.log('[FontResolver] legacy text not read (' + r.reason + '): keeping the assumed CJK font for ' + (file.name || ext));
                return null;
            }
            const scripts = _P.detectScripts(r.text, 1);
            console.log('[FontResolver] legacy text read: ' + r.text.length + ' chars, scripts detected: ' + (scripts.join(',') || 'none'));
            return {
                scripts,
                trusted: true,
                sampled: r.text.length > 0,
                // DELIBERATELY not `complete`. PERF-04 phase 1 only ever REMOVES the assumed CJK font for a file whose text was
                // read and has no Han in it. `complete` would also unlock the proof-based machinery of the ZIP path (a smaller CJK
                // tier, or dropping the CJK font because another download covers it); that is a separate decision with its own
                // proof. So a real CJK legacy file gets exactly the font it got before.
                complete: false,
                codePoints: _P.scriptCodePoints(r.text, scripts),
                cjkPoints: _P.cjkCoveragePoints(r.text),
                legacyText: true
            };
        } catch (e) {
            console.log('[FontResolver] legacy text sniff failed (' + (e && e.message) + '): keeping the assumption');
            return null;
        }
    }

    async function detectScripts(file, ext) {
        const none = { scripts: [], trusted: true, sampled: false };
        try {
            // ZIP-based documents: sniff the real text parts, because font
            // metadata lies (Japanese text tagged w:ascii="Calibri").
            if (EXTRACTABLE_FORMATS.includes(ext)) {
                if (typeof FontExtractor === 'undefined' ||
                    !FontExtractor.extractTextSampleDetailed) return none;
                const sample = await FontExtractor.extractTextSampleDetailed(
                    file, file.name || '', SCRIPT_SAMPLE_BYTES);
                const text = sample.text;
                const scripts = _P.detectScripts(text, 1);
                return {
                    scripts,
                    trusted: true,
                    sampled: !!(text && text.length),
                    // Only a COMPLETE read can ever justify not loading a script
                    // font (see scriptsStillNeeded); it has no other effect.
                    complete: !!sample.complete,
                    codePoints: _P.scriptCodePoints(text, scripts),
                    // NTH-12: the wider CJK set — see cjkCoveragePoints(). Only
                    // ever used to justify REMOVING a font, never to add one, so
                    // it is recorded next to codePoints rather than folded into
                    // it: the two answer different questions and conflating them
                    // would change what gets downloaded.
                    cjkPoints: _P.cjkCoveragePoints(text)
                };
            }

            if (BINARY_FORMATS.includes(ext)) {
                // OLE2 (.doc/.xls/.ppt): DO NOT SNIFF THE RAW BYTES. See ASSUMED_BINARY_SCRIPTS
                // for the measurements — a UTF-16LE decode of the raw container
                // false-positives ~100% of the time and no threshold fixes it.
                //
                // PERF-04: what works is a STRUCTURED read that decodes only the places
                // text lives (ConversionProtocol.oleTextSample: DOC piece table, PPT text
                // atoms, XLS string records). When it read the text, the SAME detector the
                // ZIP formats use runs on it, and a Latin-only file no longer pulls in the
                // 4 MB CJK font. When it did not (pre-97 files, encrypted, charts, embedded
                // objects, vector pictures, over 32 MB, any parse trouble, or the kill
                // switch `legacyTextSniff` is off) this is exactly the old assumption.
                const sniffed = await legacyTextDetection(file, ext);
                if (sniffed) return sniffed;
                return { scripts: [], trusted: false, sampled: false,
                         assumedScripts: ASSUMED_BINARY_SCRIPTS };
            }
            if (ext === 'pdf') {
                // PDF: DO NOT SNIFF either. The old code decoded the sample as
                // latin1 (which WHATWG resolves to windows-1252), whose entire
                // image over all 256 byte values is Latin letters and
                // punctuation, topping out at U+2122 — so the non-Latin patterns
                // (Devanagari U+0900+, Thai U+0E00+, Hangul U+1100+,
                // Han U+3040+, emoji U+1F300+) could NEVER match.
                // Measured over the 155 PDF fixtures in test_corpus: 0 hits for
                // every script, exactly as the arithmetic requires. It was a
                // detector that could not detect — worse than nothing, because
                // it read 256 KB and looked like coverage. Removed rather than
                // "made honest": doing it properly means decompressing FlateDecode
                // content streams and resolving font encodings/ToUnicode CMaps,
                // which is a PDF text extractor, not a sniff.
                //
                // No assumed script here, unlike OLE2: `main`'s latin1 sniff also
                // never fired, so PDFs never loaded the CJK fallback. Assuming
                // `han` would be a NEW ~4 MB download on every PDF input, not the
                // preservation of an existing behaviour. CJK PDF input remains a
                // known gap, identical to main — see the note in resolveFontsForDocument.
                return { scripts: [], trusted: false, sampled: false };
            }

            if (typeof file.slice !== 'function') return none;
            const sampleSize = Math.min(file.size || 0, SCRIPT_SAMPLE_BYTES);
            if (!sampleSize) return none;
            const buffer = await file.slice(0, sampleSize).arrayBuffer();

            // Text-ish (txt, rtf, html) and unknown: decode + un-escape.
            let text = _P.decodeTextSample(buffer, ext);
            // FG-186: an RTF list table's CJK numbering formats (\levelnfcN)
            // generate labels that are in no text run; count them as text.
            if (ext === 'rtf' && typeof _P.listLabelCharsForRtf === 'function') {
                const labels = _P.listLabelCharsForRtf(text);
                if (labels) text += ' ' + labels;
            }
            return { scripts: _P.detectScripts(text, 1), trusted: true, sampled: !!(text && text.length) };
        } catch (e) {
            console.warn('[FontResolver] Script detection failed:', e.message);
            return none;
        }
    }

    /**
     * Get fallback fonts (always loaded)
     */
    function getFallbackFonts() {
        if (!fontRegistry?.fonts) return [];

        const fallbackFamilies = FALLBACK_CORE_FAMILIES;

        const result = [];
        const seenFiles = new Set();

        for (const family of fallbackFamilies) {
            const fonts = fontRegistry.fonts.filter(f =>
                f.family.toLowerCase() === family.toLowerCase()
            );
            for (const font of fonts) {
                if (!seenFiles.has(font.file)) {
                    seenFiles.add(font.file);
                    result.push(font);
                }
            }
        }

        return result;
    }

    /**
     * Is this registry row the upright Regular of its family?
     * Defers to FontMatcher.registryFace so the four-face vocabulary has exactly
     * one definition; the inline test is only for the (test-only) case where
     * FontMatcher is not loaded, and answers identically for our registry rows.
     */
    function isRegistryRegular(entry) {
        if (typeof FontMatcher !== 'undefined' &&
            typeof FontMatcher.registryFace === 'function') {
            return FontMatcher.registryFace(entry) === 'regular';
        }
        return String((entry && entry.weight) || 'Regular').toLowerCase() !== 'bold' &&
               String((entry && entry.style) || 'normal').toLowerCase() !== 'italic';
    }

    // The one broad-coverage face the Liberation trio cannot stand in for.
    // Measured from the shipped cmaps (web/fonts), assigned code points drawn:
    //
    //   block                Liberation (any of the 3)   DejaVuSans
    //   Armenian                        0/96                86/96
    //   Arabic                          0/256              165/256
    //   Georgian                        0/96                83/96
    //   Arrows                          8/112              112/112
    //   Math Operators                 18/256              256/256
    //   Box Drawing                    40/128              128/128
    //   Dingbats                        0/192              174/192
    //
    // None of those scripts is in ConversionProtocol.SCRIPTS, so nothing else
    // in the pipeline will ever fetch a font for them: on this path DejaVu Sans
    // is the only thing standing between an Armenian or Arabic font-less
    // document and a page of boxes. It is loaded as a COVERAGE font, i.e. the
    // upright Regular only, on the same reasoning getScriptFonts uses — a
    // missing Bold or Italic is synthesised by fontconfig.
    const BROAD_COVERAGE_FILE = 'DejaVuSans.ttf';

    /**
     * The font set for a document that declares NO fonts of its own (BUG-21).
     *
     * WHAT THE ENGINE ACTUALLY DEFAULTS TO — read from LibreOffice's own
     * configuration, officecfg/registry/data/org/openoffice/VCL.xcu, node
     * DefaultFonts/en, rather than assumed:
     *   LATIN_TEXT ........... Liberation Serif;…;DejaVu Serif;Times;…
     *   LATIN_HEADING ........ Liberation Sans;…
     *   LATIN_SPREADSHEET .... Liberation Sans;…
     *   LATIN_PRESENTATION ... Liberation Sans;…
     *   LATIN_FIXED .......... Liberation Mono;…
     * So the answer genuinely DIFFERS per module — Writer body text is serif,
     * Calc and Impress are sans — which is why all three families ship rather
     * than the module's one. A single document needs more than one of them
     * anyway: test_corpus/fixtures/documents/simple.odt has a Heading 1
     * (LATIN_HEADING -> Sans) above body paragraphs (LATIN_TEXT -> Serif), and
     * mounting only the module's "primary" default would have re-created the
     * same class of bug one level down.
     *
     * getFallbackFonts() already lists exactly those three families, so this
     * adds only the coverage face. It is deliberately NOT folded into
     * getFallbackFonts(): that list is unioned into EVERY extractable-format
     * resolution (see the selective path below), where adding 742 KB of DejaVu
     * to every DOCX would be a large bandwidth regression for no correctness
     * gain — those documents name their own fonts and get real substitutes.
     *
     * WHY NO-EVIDENCE MEANS REGULAR-ONLY HERE, unlike everywhere else.
     * The usual rule is "if the face scan proves nothing, fetch all four faces"
     * — because a face we skip for a family the document NAMED would be missing
     * from the typeface the author chose. Nothing on this path was named: the
     * whole set is the engine's substitute for an unstated choice, and a missing
     * Bold or Italic is SYNTHESISED by fontconfig (the same reason
     * getScriptFonts loads Regular faces only), while a missing Regular would
     * drop the family. Measured on simple.odt, which reaches this path with the
     * face scan in total doubt (its `Heading_20_1` style is not declared in the
     * file, so ODF style resolution widens to all four faces): all twelve
     * Liberation faces is 5.12 MB on the wire against 1.88 MB for the four
     * Regulars — 3.3 MB to keep real bold/italic in a family the document never
     * asked for. Where the scan DOES resolve, its answer is used as usual, so a
     * document with genuine bold text still gets the real bold face.
     *
     * @param {Object|null} usage - FontExtractor face-usage report
     * @returns {Array<Object>} registry entries
     */
    function getEngineDefaultFonts(usage) {
        const all = getFallbackFonts();
        const narrowed = narrowFallbackFaces(all, usage);
        // narrowFallbackFaces returns the list UNTOUCHED both when the scan did
        // not resolve and when it resolved to "all four faces are used". Both
        // are "no face was ruled out", which on this path means "no face is
        // justified beyond the Regular".
        const base = (narrowed.length === all.length)
            ? all.filter(f => isRegistryRegular(f))
            : narrowed;
        const have = new Set(base.map(f => f.file));
        const coverage = (fontRegistry?.fonts || [])
            .filter(f => f.file === BROAD_COVERAGE_FILE && !have.has(f.file));
        // Only a registry that LOADED and is missing the file is worth warning
        // about; "no registry at all" is already reported as fontsUnavailable
        // and would just double up the noise.
        if (fontRegistry?.fonts && !coverage.length && !have.has(BROAD_COVERAGE_FILE)) {
            console.warn('[FontResolver] Broad-coverage default missing from the registry:',
                         BROAD_COVERAGE_FILE);
        }
        return base.concat(coverage);
    }

    /**
     * Drop fallback faces the document provably cannot use (NTH-03).
     *
     * DELIBERATELY CONSERVATIVE in three ways, because this set is the safety
     * net for every run whose own font we chose not to fetch:
     *   1. It only ever consults `usage.global` - the union of faces used
     *      ANYWHERE in the document - never a per-family observation.
     *   2. `usage.resolved !== true` returns the list untouched. That covers
     *      every binary/text/PDF input and every ZIP we failed to read, so those
     *      paths are byte-identical to before.
     *   3. The upright Regular of each fallback family always survives, because
     *      allowedFaces() always admits it. Evicting a Regular while keeping its
     *      Bold is the exact bug applyFontBudget() below was fixed for.
     *
     * @param {Array<Object>} fonts - registry entries
     * @param {Object|null} usage - FontExtractor face-usage report
     */
    function narrowFallbackFaces(fonts, usage) {
        if (!usage || usage.resolved !== true) return fonts;
        if (typeof FontMatcher === 'undefined' ||
            typeof FontMatcher.allowedFaces !== 'function') return fonts;
        const allowed = FontMatcher.allowedFaces(usage, []);
        if (!allowed) return fonts;
        return fonts.filter(f => allowed.has(FontMatcher.registryFace(f)));
    }

    /**
     * Get all fonts (for binary formats)
     */
    function getAllFonts() {
        return fontRegistry?.fonts || [];
    }

    /**
     * Calculate total size of fonts to load
     */
    function calculateFontSize(fonts) {
        if (!fonts) return 0;
        return fonts.reduce((sum, f) => sum + (f.size || 0), 0);
    }

    /**
     * Get statistics about font resolution
     */
    function getStats() {
        const matcherStats = typeof FontMatcher !== 'undefined' ? FontMatcher.getStats() : null;
        const loaderStats = typeof FontLoader !== 'undefined' ? FontLoader.getStats() : null;

        return {
            initialized,
            totalFonts: fontRegistry?.fonts?.length || 0,
            extractableFormats: EXTRACTABLE_FORMATS,
            binaryFormats: BINARY_FORMATS,
            matcher: matcherStats,
            loader: loaderStats
        };
    }

    // Public API
    return {
        initialize,
        isReady,
        resolveFontsForDocument,
        canExtractFonts,
        needsFonts,
        getFallbackFonts,
        // BUG-21: what a document declaring no fonts actually gets. Exposed
        // because "the engine's defaults" is a claim about LibreOffice's
        // configuration, and a test that pins it is the only thing stopping the
        // list drifting back to a sans-only set.
        getEngineDefaultFonts,
        getAllFonts,
        calculateFontSize,
        getStats,
        // Exposed for unit tests only: the budget is pure and worth asserting
        // directly, since its failure mode (dropping the wrong thing) is silent.
        _applyFontBudget: applyFontBudget,
        // The caps themselves, so a test can assert against the REAL ceiling
        // instead of restating the number and then not noticing when it moves.
        _MAX_FONT_BYTES: MAX_FONT_BYTES,
        _MAX_FONT_FILES: MAX_FONT_FILES,
        // NTH-03: dropping the wrong fallback face is likewise silent in the PDF.
        _narrowFallbackFaces: narrowFallbackFaces,
        // NTH-07: the only function permitted to drop a PROTECTED script font.
        // Its failure mode is tofu, and it is pure, so it is asserted directly
        // rather than only through a whole resolution.
        _scriptsStillNeeded: scriptsStillNeeded,
        // NTH-12: the second producer of a suppression. Pure, and its failure
        // mode is the same silent tofu, so it is asserted directly as well as
        // through whole resolutions (tests/gates/test_font_tiers.js).
        _hanCoveredByDownload: hanCoveredByDownload,
        // The gate that decides whether a theme's per-script fallbacks may be
        // pruned at all. Exposed because one of its two guards (`trusted`) is
        // not reachable through any real input today — every extractable format
        // is a ZIP we can decode — so without a direct test it would be an
        // untested claim rather than defence in depth.
        _themeScriptEvidence: themeScriptEvidence,
        _dropNameMatchedHanFallback: dropNameMatchedHanFallback,
        // The 'fallback'-strategy promotion inside it is unreachable from any
        // real input since BUG-21 (nothing returns that strategy), so without a
        // direct test it would be an untested claim rather than defence in depth.
        _withScriptFonts: withScriptFonts
    };
})();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FontResolver;
}
