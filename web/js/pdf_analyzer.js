// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2025-2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
/**
 * pdf_analyzer.js - Minimal PDF page dimension extractor
 *
 * Analyzes PDF files to detect if they are presentations (landscape) or documents (portrait)
 * before loading the WASM module. This allows routing to the appropriate converter:
 * - Landscape PDFs (aspect ratio >= 1.2) -> pdf-pptx module
 * - Portrait PDFs (aspect ratio < 1.2) -> pdf-docx module
 *
 * When no page dimensions can be found (e.g. PDF 1.5+ files whose page objects live in
 * compressed object streams that we do not inflate), analyze() returns type 'unknown' with
 * confidence 0 rather than silently guessing 'document'. Consumers must surface this to the
 * user (default + explicit choice) instead of routing blindly.
 *
 * Size: ~3KB minified, no dependencies
 */

// How much of the file to scan for a MediaBox. Linearized PDFs keep page objects up front;
// many non-linearized writers emit the page tree near the end. Scanning both head and tail
// cheaply covers both without reading the whole file.
const PDF_HEAD_SCAN_BYTES = 65536;
const PDF_TAIL_SCAN_BYTES = 65536;

const PDFAnalyzer = {
    // Common page sizes for reference (in PDF points, 1 point = 1/72 inch)
    PAGE_SIZES: {
        // Portrait documents
        LETTER_PORTRAIT: { width: 612, height: 792 },      // 8.5 x 11 inches
        A4_PORTRAIT: { width: 595, height: 842 },          // 210 x 297 mm
        LEGAL_PORTRAIT: { width: 612, height: 1008 },      // 8.5 x 14 inches

        // Landscape presentations
        LETTER_LANDSCAPE: { width: 792, height: 612 },     // 11 x 8.5 inches
        SLIDE_16_9: { width: 960, height: 540 },           // 16:9 common
        SLIDE_16_9_ALT: { width: 1280, height: 720 },      // 16:9 HD
        SLIDE_4_3: { width: 720, height: 540 },            // 4:3 standard
    },

    // Aspect ratio thresholds
    LANDSCAPE_THRESHOLD: 1.2,  // Anything >= 1.2 is considered presentation-like

    /**
     * Analyze a PDF file to detect if it's a presentation or document
     * @param {File|Blob} file - The PDF file to analyze
     * @returns {Promise<{type: string, confidence: number, width: number, height: number, aspectRatio: number, reason: string}>}
     *          type is one of 'presentation' | 'document' | 'unknown'. 'unknown' means the
     *          caller could not determine orientation and must ask the user / apply an
     *          explicit default (never treat 'unknown' as a confident 'document').
     */
    async analyze(file) {
        try {
            const text = await this.readScanText(file);

            // BUG-09. All boxes in the scan window, earliest first. Element 0 is the
            // page-1 proxy; the rest exist only to tell us whether the document
            // actually agrees with itself.
            const boxes = this.extractAllBoxes(text);
            const mediaBox = boxes.length ? { width: boxes[0].width, height: boxes[0].height } : null;

            if (!mediaBox) {
                console.log('[PDFAnalyzer] Could not find MediaBox/CropBox in scanned window -> unknown');
                return {
                    type: 'unknown',
                    confidence: 0,
                    width: 0,
                    height: 0,
                    aspectRatio: 0,
                    reason: 'MediaBox not found (possibly compressed object streams)'
                };
            }

            const { width, height } = mediaBox;
            const aspectRatio = width / height;
            const classified = this.classifyDimensions(width, height);
            let { type, confidence, reason } = classified;

            // BUG-09. Report mixed orientation as its OWN signal rather than folding it
            // into `confidence`, because the two are different uncertainties:
            //
            //   confidence      — how sure we are of the classification OF PAGE 1.
            //                     Unaffected by later pages; page 1's box is exact.
            //   mixedOrientation — whether page 1 is representative of the document.
            //
            // Collapsing them into one scalar looked tidier and was wrong. The driver
            // auto-routes PDF→PDF to pdf-pptx at `confidence >= 0.75`
            // (conversion_driver.js), so discounting a 16:9 first page to ~0.5 because
            // page 7 is portrait would have sent a mixed-orientation PRESENTATION to
            // pdf-docx — silently breaking the very acceptance criterion this fix
            // exists for ("routes by page 1"). Routing therefore still follows page 1,
            // and the driver raises a visible warning on this flag instead, so the user
            // can override in Advanced Options rather than being quietly guessed at.
            const orientations = new Set(boxes.map((b) => b.landscape));
            const mixedOrientation = orientations.size > 1;
            if (mixedOrientation) {
                reason = `${reason}; mixed page orientations in scan window `
                    + `(${boxes.length} boxes seen) — classified from the first page`;
            }

            console.log(`[PDFAnalyzer] Detected dimensions: ${width}x${height} (ratio: ${aspectRatio.toFixed(2)}) -> ${type.toUpperCase()} (confidence: ${confidence.toFixed(2)})`
                + (mixedOrientation ? ` [mixed orientation across ${boxes.length} boxes]` : ''));

            return {
                type, confidence, width, height, aspectRatio, reason,
                mixedOrientation, pageBoxesSeen: boxes.length
            };
        } catch (error) {
            console.warn('[PDFAnalyzer] Analysis failed:', error);
            return {
                type: 'unknown',
                confidence: 0,
                width: 0,
                height: 0,
                aspectRatio: 0,
                reason: `Analysis error: ${error.message}`
            };
        }
    },

    /**
     * Classify a page's dimensions into presentation vs document.
     * Pure function (no I/O) so it is directly unit-testable.
     * @param {number} width
     * @param {number} height
     * @returns {{type: string, confidence: number, reason: string}}
     */
    classifyDimensions(width, height) {
        const aspectRatio = width / height;

        // Landscape with ratio >= threshold is likely a presentation
        if (aspectRatio >= this.LANDSCAPE_THRESHOLD) {
            const confidence = this.calculateConfidence(width, height, aspectRatio);
            return {
                type: 'presentation',
                confidence,
                reason: `Landscape aspect ratio ${aspectRatio.toFixed(2)} >= ${this.LANDSCAPE_THRESHOLD}`
            };
        }

        return {
            type: 'document',
            confidence: 0.9,
            reason: `Portrait/square aspect ratio ${aspectRatio.toFixed(2)} < ${this.LANDSCAPE_THRESHOLD}`
        };
    },

    /**
     * Calculate confidence based on how well dimensions match known slide sizes
     */
    calculateConfidence(width, height, aspectRatio) {
        // Common presentation aspect ratios
        const RATIO_16_9 = 16/9;  // 1.778
        const RATIO_4_3 = 4/3;    // 1.333
        const RATIO_16_10 = 16/10; // 1.6

        const tolerance = 0.05;

        // Check for exact standard presentation ratios
        if (Math.abs(aspectRatio - RATIO_16_9) < tolerance) return 0.95;
        if (Math.abs(aspectRatio - RATIO_4_3) < tolerance) return 0.95;
        if (Math.abs(aspectRatio - RATIO_16_10) < tolerance) return 0.90;

        // General landscape with good ratio
        if (aspectRatio >= 1.3) return 0.85;

        // Borderline landscape
        return 0.75;
    },

    /**
     * Read the scan window (head + tail) of a file and decode it as latin1 text.
     * Note: a box found in the tail may belong to a later page than page 1. That is
     * inherent to scanning a window rather than parsing the page tree, and it is why
     * analyze() now takes the EARLIEST box in document order as its page-1 proxy and
     * lowers confidence when the boxes disagree (BUG-09) — previously any box could
     * win and the result was reported as confidently as a uniform document's.
     * @param {File|Blob} file
     * @returns {Promise<string>}
     */
    async readScanText(file) {
        const size = file.size;

        // Small file: read it all once.
        if (size <= PDF_HEAD_SCAN_BYTES + PDF_TAIL_SCAN_BYTES) {
            const buf = await this.readChunk(file, 0, size);
            return this.decodeLatin1(buf);
        }

        // Large file: read head and tail, join with a newline so a bracket structure can
        // never be spuriously matched across the (non-contiguous) boundary.
        const headBuf = await this.readChunk(file, 0, PDF_HEAD_SCAN_BYTES);
        const tailBuf = await this.readChunk(file, size - PDF_TAIL_SCAN_BYTES, PDF_TAIL_SCAN_BYTES);
        return this.decodeLatin1(headBuf) + '\n' + this.decodeLatin1(tailBuf);
    },

    decodeLatin1(bytes) {
        return new TextDecoder('latin1').decode(bytes);
    },

    /**
     * Read a chunk of bytes from a file.
     * Prefers the modern Blob.arrayBuffer() path (also works with Node's built-in Blob,
     * which lets analyze() run under unit tests), falling back to FileReader.
     */
    readChunk(file, start, length) {
        const end = start + length;

        if (typeof file.slice === 'function') {
            const blob = file.slice(start, end);
            if (blob && typeof blob.arrayBuffer === 'function') {
                return blob.arrayBuffer().then(buf => new Uint8Array(buf));
            }
        }

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(new Uint8Array(reader.result));
            reader.onerror = () => reject(new Error('Failed to read file chunk'));
            reader.readAsArrayBuffer(file.slice(start, end));
        });
    },

    /**
     * Extract MediaBox dimensions from PDF text.
     * PDF MediaBox format: /MediaBox [x1 y1 x2 y2] where x1,y1 is lower-left and
     * x2,y2 is upper-right. Coordinates may be negative, decimal, or with a leading dot,
     * and whitespace (including newlines) may separate the tokens.
     * @param {string} text
     * @returns {{width: number, height: number}|null}
     */
    extractMediaBox(text) {
        const all = this.extractAllBoxes(text);
        return all.length ? { width: all[0].width, height: all[0].height } : null;
    },

    /**
     * BUG-09. Every box in the scan window, in document order.
     *
     * The single-match version could not distinguish "this document has one page
     * geometry" from "this is the first of several disagreeing geometries", so a
     * mixed-orientation PDF was classified from whichever box the regex happened to
     * reach first and reported with the same confidence as a uniform one. In a
     * mixed-orientation file that decides which MODULE runs (pdf-docx vs pdf-pptx),
     * so a wrong guess is a wrong conversion, not a cosmetic mislabel.
     *
     * Order matters and is preserved: element 0 is the earliest box in the scanned
     * text, which is the best available proxy for page 1 — linearized PDFs keep the
     * first page object up front, and an inherited box on the /Pages node also
     * applies to page 1. Properly identifying page 1 would mean walking
     * /Type /Pages → /Kids, which needs the whole file and object-stream
     * decompression; that is a different tool, not a bigger regex.
     *
     * MediaBox and CropBox are gathered separately and MediaBox wins outright when
     * present, matching the previous fallback order (some PDFs carry only a CropBox).
     * @param {string} text
     * @returns {Array<{width:number,height:number,landscape:boolean}>}
     */
    extractAllBoxes(text) {
        // Number token: optional sign, optional integer part, optional fractional part.
        // Separators between the four numbers are required whitespace (\s+, matches
        // newlines too), which avoids mis-tokenizing e.g. "612792" and is not
        // backtracking-prone.
        const collect = (name) => {
            const re = new RegExp(
                `/${name}\\s*\\[\\s*(-?\\d*\\.?\\d+)\\s+(-?\\d*\\.?\\d+)\\s+(-?\\d*\\.?\\d+)\\s+(-?\\d*\\.?\\d+)\\s*\\]`,
                'gi');
            const out = [];
            let m;
            while ((m = re.exec(text)) !== null) {
                const box = this.boxFromMatch(m);
                if (box) out.push({ ...box, landscape: box.width > box.height });
                // A zero-length match cannot happen with this pattern, so lastIndex
                // always advances and this loop terminates.
            }
            return out;
        };

        const media = collect('MediaBox');
        if (media.length) return media;
        return collect('CropBox');
    },

    /**
     * Convert a regex match of four box coordinates into validated {width,height}.
     * @returns {{width:number, height:number}|null}
     */
    boxFromMatch(match) {
        if (!match) return null;

        const x1 = parseFloat(match[1]);
        const y1 = parseFloat(match[2]);
        const x2 = parseFloat(match[3]);
        const y2 = parseFloat(match[4]);

        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);

        // Sanity check - dimensions should be reasonable (using Math.abs above is exactly
        // what lets negative-origin boxes like [0 -792 612 0] resolve correctly).
        if (width > 0 && height > 0 && width < 10000 && height < 10000) {
            return { width, height };
        }
        return null;
    },

    /**
     * Quick check if file is a valid PDF
     */
    async isPDF(file) {
        try {
            const chunk = await this.readChunk(file, 0, 8);
            const header = new TextDecoder('latin1').decode(chunk);
            return header.startsWith('%PDF-');
        } catch {
            return false;
        }
    }
};

// Export for use in conversion_driver.js
if (typeof window !== 'undefined') {
    window.PDFAnalyzer = PDFAnalyzer;
}

// Export for module systems / unit tests
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PDFAnalyzer;
}
