// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
/**
 * font_matcher.js
 * Smart font matching algorithm for finding the best open source substitute
 * for any proprietary font. Uses multi-tier matching:
 * 1. Exact mapping (curated proprietary → open source)
 * 2. Metric-compatible (same character widths)
 * 3. Visually similar (looks similar)
 * 4. Category fallback (same font category)
 */

const FontMatcher = (function() {
    'use strict';

    let fontRegistry = null;
    let initialized = false;
    let matchCache = new Map();

    // ------------------------------------------------------------------
    // FACE VOCABULARY (NTH-03)
    //
    // A "face" is one cell of the 2x2 upright/slanted x normal/bold grid. It is
    // the unit the document's formatting can ask for and the unit the registry
    // ships, so it is the unit we narrow the download to.
    //
    // This is the SINGLE definition of the four strings. FontExtractor produces
    // them (from w:b/w:i, fo:font-weight, <b/>, a:rPr b="1") and this file
    // consumes them; tests/unit/test_font_usage.js asserts the producer and the
    // consumer agree for all four combinations, so the two cannot drift.
    //
    // Registry weights that are neither Regular nor Bold (Light/Medium/Thin -
    // only the Ubuntu family ships them) map to the NON-bold bucket. That
    // over-fetches Ubuntu-L/M/Th for a document that uses plain Ubuntu, which is
    // the safe direction: those are separate optical weights a document can name
    // directly ("Ubuntu Light"), and normalizeFontName() folds that name back
    // onto the Ubuntu family, so treating them as droppable would lose a face
    // the document really asked for.
    const FACES = {
        REGULAR: 'regular',
        BOLD: 'bold',
        ITALIC: 'italic',
        BOLD_ITALIC: 'bolditalic'
    };
    const ALL_FACES = [FACES.REGULAR, FACES.BOLD, FACES.ITALIC, FACES.BOLD_ITALIC];

    /** @returns {string} the face key for a (bold, italic) pair. */
    function faceOf(bold, italic) {
        if (bold && italic) return FACES.BOLD_ITALIC;
        if (bold) return FACES.BOLD;
        if (italic) return FACES.ITALIC;
        return FACES.REGULAR;
    }

    /** @returns {string} the face key a fonts.json entry provides. */
    function registryFace(entry) {
        const bold = String((entry && entry.weight) || 'Regular').toLowerCase() === 'bold';
        const italic = String((entry && entry.style) || 'normal').toLowerCase() === 'italic';
        return faceOf(bold, italic);
    }

    // Proprietary → Open Source mappings (curated for best substitution)
    const PROPRIETARY_MAPPINGS = {
        // Microsoft Office Core Fonts
        'Arial': { best: 'Liberation Sans', alternatives: ['Noto Sans', 'Open Sans', 'Roboto'] },
        // FG-059: a black-weight face. Archivo Black sets text ~1.21x wider than Liberation
        // Sans Regular, matching Word's Arial Black (~1.20x the regular-weight width).
        'Arial Black': { best: 'Archivo Black', alternatives: ['Liberation Sans', 'Noto Sans'] },
        'Arial Narrow': { best: 'Liberation Sans Narrow', alternatives: ['Noto Sans'] },
        // Windows 3.x / early-Excel family names, still found in old .xls and .doc files
        // (FG-183). Mapped to what DESKTOP LibreOffice renders, measured 2026-10-16 (lo-letter
        // reference image, H82wccn.xls: `Helv` -> Noto Sans): none is installed, so fontconfig
        // resolves `Helv`, `Tms Rmn` and `Small Fonts` (unknown to it) and
        // `MS Sans Serif` (45-latin: sans-serif) to its default sans, Noto Sans, and
        // `MS Serif` (45-latin: serif) to its default serif, Noto Serif (60-latin). Without
        // these we mounted no Noto face for a binary file, so they fell to DejaVu Sans,
        // whose wider metrics turned a date column into `###`. (`Courier` needs no entry:
        // fontconfig's 30-metric-aliases.conf covers it. `System` is left out on purpose: the
        // binary sniff would match the ordinary word in a sheet's text.)
        'Helv': { best: 'Noto Sans', alternatives: ['Liberation Sans'] },
        'MS Sans Serif': { best: 'Noto Sans', alternatives: ['Liberation Sans'] },
        'Small Fonts': { best: 'Noto Sans', alternatives: ['Liberation Sans'] },
        'Tms Rmn': { best: 'Noto Sans', alternatives: ['Liberation Serif'] },
        // BUG-81 (2026-11-14): names a legacy .doc/.rtf/.xls/.ppt writes for fonts Word draws as Times New Roman or Arial, and measured as DejaVu in our output
        // (wider than either, so lines wrap differently and pages break elsewhere). The binary sniff only reads names that are KEYS here, so a name that
        // is not listed never reached the matcher at all and the engine drew its default (DejaVu). Each mapping follows what the Office reference drew
        // for the name (its PDF fonts: Times New Roman or Arial), and is metric-compatible with it (Liberation Serif / Sans / Mono). No new font file.
        // CG Times (W1): Times-style serif (CG Times is Times New Roman's ancestor); "Swiss Roman 12pt" is a WordPerfect-era Helvetica-class sans
        // (Word drew it as Arial: p-e791). The PostScript-style names (ArialMT, TimesNewRomanPSMT, CourierNewPSMT, Helvetica-Bold ...) are the
        // family names some producers write instead of the family (p-163f's font table names ArialMT and Arial-BoldMT as families).
        'Times': { best: 'Liberation Serif', alternatives: ['Noto Serif', 'DejaVu Serif'] },
        'Times-Roman': { best: 'Liberation Serif', alternatives: ['Noto Serif', 'DejaVu Serif'] },
        'CG Times': { best: 'Liberation Serif', alternatives: ['Noto Serif', 'DejaVu Serif'] },
        'CG Times (W1)': { best: 'Liberation Serif', alternatives: ['Noto Serif', 'DejaVu Serif'] },
        'TimesNewRoman': { best: 'Liberation Serif', alternatives: ['Noto Serif', 'DejaVu Serif'] },
        'TimesNewRomanPSMT': { best: 'Liberation Serif', alternatives: ['Noto Serif', 'DejaVu Serif'] },
        'TimesNewRomanPS-BoldMT': { best: 'Liberation Serif', alternatives: ['Noto Serif', 'DejaVu Serif'] },
        'TimesNewRomanPS-ItalicMT': { best: 'Liberation Serif', alternatives: ['Noto Serif', 'DejaVu Serif'] },
        'TimesNewRomanPS-BoldItalicMT': { best: 'Liberation Serif', alternatives: ['Noto Serif', 'DejaVu Serif'] },
        'Swiss Roman 12pt': { best: 'Liberation Sans', alternatives: ['Noto Sans', 'DejaVu Sans'] },
        'ArialMT': { best: 'Liberation Sans', alternatives: ['Noto Sans', 'DejaVu Sans'] },
        'Arial-BoldMT': { best: 'Liberation Sans', alternatives: ['Noto Sans', 'DejaVu Sans'] },
        'Arial-ItalicMT': { best: 'Liberation Sans', alternatives: ['Noto Sans', 'DejaVu Sans'] },
        'Arial-BoldItalicMT': { best: 'Liberation Sans', alternatives: ['Noto Sans', 'DejaVu Sans'] },
        'Helvetica-Bold': { best: 'Liberation Sans', alternatives: ['Noto Sans', 'DejaVu Sans'] },
        'Helvetica-Oblique': { best: 'Liberation Sans', alternatives: ['Noto Sans', 'DejaVu Sans'] },
        'Helvetica-BoldOblique': { best: 'Liberation Sans', alternatives: ['Noto Sans', 'DejaVu Sans'] },
        'CourierNew': { best: 'Liberation Mono', alternatives: ['DejaVu Sans Mono', 'Noto Mono'] },
        'CourierNewPSMT': { best: 'Liberation Mono', alternatives: ['DejaVu Sans Mono', 'Noto Mono'] },
        'CourierNewPS-BoldMT': { best: 'Liberation Mono', alternatives: ['DejaVu Sans Mono', 'Noto Mono'] },
        'MS Serif': { best: 'Noto Serif', alternatives: ['Liberation Serif'] },
        'Calibri': { best: 'Carlito', alternatives: ['Liberation Sans', 'Open Sans'] },
        'Calibri Light': { best: 'Carlito', alternatives: ['Liberation Sans'] },
        'Cambria': { best: 'Caladea', alternatives: ['Liberation Serif', 'Noto Serif'] },
        'Cambria Math': { best: 'Caladea', alternatives: ['Liberation Serif'] },
        'Candara': { best: 'Liberation Sans', alternatives: ['Open Sans'] },
        'Comic Sans MS': { best: 'Comic Neue', alternatives: ['Liberation Sans'] },
        'Consolas': { best: 'Liberation Mono', alternatives: ['DejaVu Sans Mono', 'Noto Mono'] },
        'Constantia': { best: 'Liberation Serif', alternatives: ['Noto Serif'] },
        'Corbel': { best: 'Liberation Sans', alternatives: ['Open Sans'] },
        'Courier New': { best: 'Liberation Mono', alternatives: ['DejaVu Sans Mono', 'Noto Mono'] },
        'Franklin Gothic': { best: 'Liberation Sans', alternatives: ['Noto Sans'] },
        'Georgia': { best: 'Liberation Serif', alternatives: ['Noto Serif'] },
        'Impact': { best: 'Liberation Sans', alternatives: ['Noto Sans'] },
        // FG-162: Arial Unicode MS shares Arial's Latin metrics; its wider coverage is
        // left to glyph fallback.
        'Arial Unicode MS': { best: 'Liberation Sans', alternatives: ['DejaVu Sans', 'Noto Sans'] },
        'Lucida Console': { best: 'Liberation Mono', alternatives: ['DejaVu Sans Mono'] },
        'Lucida Sans': { best: 'Liberation Sans', alternatives: ['DejaVu Sans'] },
        'Lucida Sans Unicode': { best: 'Liberation Sans', alternatives: ['DejaVu Sans'] },
        'Palatino Linotype': { best: 'Liberation Serif', alternatives: ['Noto Serif'] },
        'Segoe UI': { best: 'Liberation Sans', alternatives: ['Noto Sans', 'Open Sans'] },
        'Segoe UI Light': { best: 'Liberation Sans', alternatives: ['Noto Sans'] },
        'Segoe UI Semibold': { best: 'Liberation Sans', alternatives: ['Noto Sans'] },
        'Tahoma': { best: 'Liberation Sans', alternatives: ['DejaVu Sans'] },
        'Times New Roman': { best: 'Liberation Serif', alternatives: ['Noto Serif', 'DejaVu Serif'] },
        'Trebuchet MS': { best: 'Liberation Sans', alternatives: ['Noto Sans'] },
        'Verdana': { best: 'Liberation Sans', alternatives: ['DejaVu Sans', 'Noto Sans'] },

        // Apple Fonts
        'Helvetica': { best: 'Liberation Sans', alternatives: ['Nimbus Sans', 'Noto Sans'] },
        'Helvetica Neue': { best: 'Liberation Sans', alternatives: ['Open Sans', 'Roboto'] },
        'San Francisco': { best: 'Liberation Sans', alternatives: ['Noto Sans'] },
        'SF Pro': { best: 'Liberation Sans', alternatives: ['Open Sans'] },
        'Menlo': { best: 'Liberation Mono', alternatives: ['DejaVu Sans Mono'] },
        'Monaco': { best: 'Liberation Mono', alternatives: ['DejaVu Sans Mono'] },
        'Avenir': { best: 'Nunito', alternatives: ['Montserrat', 'Open Sans'] },
        'Avenir Next': { best: 'Nunito', alternatives: ['Montserrat'] },
        'Baskerville': { best: 'Libre Baskerville', alternatives: ['Liberation Serif'] },
        'Futura': { best: 'Jost', alternatives: ['Nunito', 'Montserrat'] },
        'Gill Sans': { best: 'Lato', alternatives: ['Open Sans'] },
        'Optima': { best: 'Liberation Sans', alternatives: ['Open Sans'] },
        'Palatino': { best: 'Liberation Serif', alternatives: ['Noto Serif'] },

        // Google Fonts (already open source, but map for convenience)
        'Roboto': { best: 'Roboto', alternatives: ['Noto Sans'] },
        'Open Sans': { best: 'Open Sans', alternatives: ['Noto Sans'] },
        'Lato': { best: 'Lato', alternatives: ['Open Sans'] },
        'Montserrat': { best: 'Montserrat', alternatives: ['Nunito'] },
        'Oswald': { best: 'Oswald', alternatives: ['Liberation Sans'] },
        'Source Sans Pro': { best: 'Source Sans 3', alternatives: ['Open Sans'] },
        'Raleway': { best: 'Raleway', alternatives: ['Montserrat'] },
        'Poppins': { best: 'Poppins', alternatives: ['Nunito'] },
        'Noto Sans': { best: 'Noto Sans', alternatives: ['Liberation Sans'] },
        'Noto Serif': { best: 'Noto Serif', alternatives: ['Liberation Serif'] },
        'PT Sans': { best: 'PT Sans', alternatives: ['Open Sans'] },
        'PT Serif': { best: 'PT Serif', alternatives: ['Liberation Serif'] },
        'Merriweather': { best: 'Merriweather', alternatives: ['Noto Serif'] },
        'Ubuntu': { best: 'Ubuntu', alternatives: ['Open Sans'] },
        // ------------------------------------------------------------------
        // UFL 1.0 CLAUSE 2(c) — THE RENAMED DERIVATIVES
        //
        // Ten faces in web/fonts/ are OUR derived works: single-instance statics cut
        // from the Ubuntu variable fonts (plans/font-compliance-plan.md §3b). UFL 1.0
        // clause 2(c) requires a Modified Version that is not Substantially Changed to
        // be renamed, so their `name` tables — and fonts.json — now say
        //
        //     Ubuntu       -> Ubuntu derivative Probably Fine       (B BI C L LI M MI Th)
        //     Ubuntu Mono  -> Ubuntu Mono derivative Probably Fine  (B BI)
        //
        // "Ubuntu" therefore still resolves, and still resolves to the UNMODIFIED
        // Ubuntu: Ubuntu-R/-RI and the two variable fonts are byte-identical distro
        // originals, which clause 2(a) forbids renaming, and they stayed behind under
        // the original name. These two keys are for the other direction — a document
        // that names the derivative, which includes any document THIS converter
        // produces from one that used those weights. normalizeFontName() strips a
        // trailing weight token, so "… derivative Probably Fine Bold/Light/Medium/Thin"
        // folds onto the family key; nothing folds it back onto "Ubuntu".
        //
        // WHAT DOES NOT WORK, measured rather than reasoned, so it is not re-attempted:
        //
        //   * Redirecting "Ubuntu" to the derivative family (an FM-3 fontconfig rule)
        //     does NOT restore real Bold. LibreOffice consults fontconfig only for a
        //     family it does not already have, and it still has "Ubuntu"; the rule is
        //     generated and never fires. Measured through the real pipeline: the rule
        //     appears in the spliced fonts.conf and the PDF still embeds a Type 3
        //     synthetic bold built from Ubuntu-Regular.
        //   * Redirecting it UNCONDITIONALLY is worse than doing nothing. Family
        //     outranks weight in both fontconfig and LibreOffice, and the derivative
        //     family has no Regular — so an upright request lands on whichever face is
        //     weight-closest, which is Ubuntu Condensed (weight 80 exactly). Measured
        //     both ways: fc-match "Ubuntu Light" -> UbuntuDerivativeProbablyFine-Condensed,
        //     and a document naming the derivative family at regular weight converts to
        //     a PDF embedding UbuntuDerivativeProbablyFine-Condensed.
        //
        // So the derived weights are reachable by their new name and not by the old
        // one. That is what clause 2(c) asks for, and the cost is stated in the PR:
        // a document naming plain "Ubuntu" now gets synthesised bold rather than our
        // derived Ubuntu Bold, and one naming "Ubuntu Light"/"Medium"/"Thin" gets
        // Ubuntu Regular. No document loses text, and none renders tofu.
        'Ubuntu derivative Probably Fine': { best: 'Ubuntu derivative Probably Fine', alternatives: ['Ubuntu', 'Open Sans'] },
        'Ubuntu Mono derivative Probably Fine': { best: 'Ubuntu Mono derivative Probably Fine', alternatives: ['Ubuntu Mono', 'Liberation Mono'] },
        'Playfair Display': { best: 'Playfair Display', alternatives: ['Liberation Serif'] },
        'Nunito': { best: 'Nunito', alternatives: ['Open Sans'] },
        'Fira Sans': { best: 'Fira Sans', alternatives: ['Open Sans'] },
        'Work Sans': { best: 'Work Sans', alternatives: ['Open Sans'] },

        // ------------------------------------------------------------------
        // JAPANESE. Until 2026-07-27 all nine of these named `Noto Sans/Serif
        // CJK JP`, which THIS TREE HAS NEVER SHIPPED. findExactMapping then fell
        // through to `Droid Sans Fallback` for every one of them, so a Mincho
        // (serif) document rendered SANS — a visible downgrade with no warning,
        // and the reason tests/unit/test_font_registry_consistency.js exists.
        //
        // The substitutes below are the Morisawa BIZ UD faces (SIL OFL 1.1,
        // fsType 0). Every field here was read from the font's own name table,
        // never from the filename: family (nameID 1, Windows English) is
        // literally "BIZ UDGothic" / "BIZ UDMincho" / "BIZ UDPGothic" /
        // "BIZ UDPMincho", which is what fonts.json records and therefore what
        // fontFamilyIndex can resolve. (Each file ALSO carries a Windows
        // Japanese nameID 1 — "BIZ UDゴシック", "BIZ UD明朝" — which is why the
        // alias block below exists and why a name reader that just takes the
        // last Windows record gets the family wrong.)
        //
        // WHY BIZ UD AND NOT NOTO SANS/SERIF JP. Measured 2026-07-27 on the real
        // binaries: coverage is equal or better (JIS X 0208 100% both; JIS X
        // 0213 8833/8835 for BIZ UD vs 8673/8835 for Noto JP), transfer size is
        // a wash (4.45/5.87 MiB vs 4.32/5.92 MiB), and the static Noto JP faces
        // exist upstream ONLY as CFF `.otf` — an extension `.gitignore` excludes
        // and `pipeline/package.sh` does not copy or pre-compress, on an outline
        // format no font in this tree has ever pushed through LibreOffice's PDF
        // embedder. BIZ UD is ordinary `glyf` TrueType, the mechanism all 329
        // other faces already exercise. (Same reasoning the `emoji-pictographic`
        // entry in conversion_protocol.js used to reject NotoColorEmoji's CBDT
        // path.) The `google/fonts` Noto JP files are the VARIABLE TTFs — 9.6 MB
        // and 13.6 MB — i.e. roughly double the bytes on the wire for the one
        // weight we would actually use.
        //
        // FIXED vs PROPORTIONAL IS NOT COSMETIC — it is the Calibri/Carlito
        // argument again. MS Gothic and MS Mincho are fixed-pitch; MS PGothic,
        // MS PMincho, Meiryo, Yu Gothic/Mincho and the Hiragino faces are
        // proportional. BIZ UD ships both cuts and they genuinely differ in the
        // Latin/kana advances that decide where lines break (measured, upem
        // 2048: 'A' 1024 in UDGothic vs 1556 in UDPGothic; 'i' 1024 vs 655),
        // while sharing identical CJK outlines. Mapping every one of these onto
        // a single face would reflow half of them.
        //
        // Only the Regular face of each family is shipped. getFontFiles() below
        // pulls EVERY registry entry of a matched family, so adding a Bold would
        // put another 4.64 MB (Gothic) / 6.48 MB (Mincho) on the wire for every
        // document that names the family, bold text or not; fontconfig
        // synthesises the emboldening. Shipping the Bold cuts is a separate,
        // costed decision, not an oversight.
        'MS Gothic': { best: 'BIZ UDGothic', alternatives: ['Droid Sans Fallback'] },
        'MS Mincho': { best: 'BIZ UDMincho', alternatives: ['Droid Sans Fallback'] },
        'MS PGothic': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        'MS PMincho': { best: 'BIZ UDPMincho', alternatives: ['Droid Sans Fallback'] },
        'Yu Gothic': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        'Yu Mincho': { best: 'BIZ UDPMincho', alternatives: ['Droid Sans Fallback'] },
        'Meiryo': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        'Hiragino Sans': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        'Hiragino Mincho': { best: 'BIZ UDPMincho', alternatives: ['Droid Sans Fallback'] },

        // THE NAMES JAPANESE DOCUMENTS ACTUALLY CARRY.
        //
        // The nine ASCII keys above are what a Word running in an English locale
        // writes. A document authored in Japanese Word writes the font's JAPANESE
        // name into w:rFonts/@w:eastAsia — full-width "ＭＳ 明朝", not "MS Mincho"
        // — and none of the keys above match it. findExactMapping() misses,
        // findMetricCompatible() misses, and findCategoryFallback() lands on
        // 'serif'/'sans-serif' by regexing the name for Latin words like
        // "mincho", which a full-width Japanese string does not contain: every
        // one of these fell through to Liberation Sans. So the substitution
        // above would have been correct for translated documents and useless for
        // the Japanese ones it was written for.
        //
        // Weight suffixes need no keys of their own: normalizeFontName() strips a
        // trailing Light/Medium/Bold/Regular, so "游明朝 Light" and "游ゴシック
        // Medium" — the defaults in modern Japanese Word — fold onto the bases
        // below before lookup. The UI cuts are proportional, hence the P targets.
        'ＭＳ 明朝': { best: 'BIZ UDMincho', alternatives: ['Droid Sans Fallback'] },
        'ＭＳ Ｐ明朝': { best: 'BIZ UDPMincho', alternatives: ['Droid Sans Fallback'] },
        'ＭＳ ゴシック': { best: 'BIZ UDGothic', alternatives: ['Droid Sans Fallback'] },
        'ＭＳ Ｐゴシック': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        'ＭＳ ＵＩ ゴシック': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        'MS UI Gothic': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        '游明朝': { best: 'BIZ UDPMincho', alternatives: ['Droid Sans Fallback'] },
        '游ゴシック': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        'Yu Gothic UI': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        'メイリオ': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        'Meiryo UI': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        'ヒラギノ明朝 ProN': { best: 'BIZ UDPMincho', alternatives: ['Droid Sans Fallback'] },
        'ヒラギノ明朝 Pro': { best: 'BIZ UDPMincho', alternatives: ['Droid Sans Fallback'] },
        'ヒラギノ角ゴ ProN': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        'ヒラギノ角ゴシック': { best: 'BIZ UDPGothic', alternatives: ['Droid Sans Fallback'] },
        // Simplified Chinese. The SERIF/SANS split matters here and was wrong
        // before: SimSun (宋体) and NSimSun (新宋体) are Song-style SERIF faces —
        // SimSun is the default body text of most Chinese business documents —
        // while SimHei (黑体) and Microsoft YaHei (微软雅黑) are SANS.
        // All five used to point at 'Noto Sans CJK SC', which we do not ship, so
        // all five fell through to Droid Sans Fallback. That is stylistically
        // CORRECT for the sans three and WRONG for the serif two: a SimSun
        // document came out looking like Times New Roman rendered in Arial.
        // Only the serif entries change; the sans ones were never broken.
        'SimSun': { best: 'Noto Serif SC', alternatives: ['Droid Sans Fallback'] },
        'NSimSun': { best: 'Noto Serif SC', alternatives: ['Droid Sans Fallback'] },
        '宋体': { best: 'Noto Serif SC', alternatives: ['Droid Sans Fallback'] },
        '新宋体': { best: 'Noto Serif SC', alternatives: ['Droid Sans Fallback'] },
        'SimHei': { best: 'Noto Sans CJK SC', alternatives: ['Droid Sans Fallback'] },
        'Microsoft YaHei': { best: 'Noto Sans CJK SC', alternatives: ['Droid Sans Fallback'] },
        // The same sans faces under the names Chinese Word writes (w:eastAsia),
        // and DengXian, Office's default Simplified Chinese face since 2016.
        // Unmapped, they fell to the Latin category fallback (Liberation Sans),
        // so their hanzi went to whichever CJK face was mounted: in a document
        // with SimSun body text, the SimHei/YaHei headings drew serif (FG-055,
        // measured).
        '黑体': { best: 'Droid Sans Fallback', alternatives: [] },
        '微软雅黑': { best: 'Droid Sans Fallback', alternatives: [] },
        'Microsoft YaHei UI': { best: 'Droid Sans Fallback', alternatives: [] },
        'DengXian': { best: 'Droid Sans Fallback', alternatives: [] },
        '等线': { best: 'Droid Sans Fallback', alternatives: [] },
        // Traditional Chinese Ming (serif) faces: Noto Serif TC, which draws the
        // Taiwan-standard glyph forms these documents are written for (all of
        // Big5 and HKSCS). Noto Serif SC would give the right style but mainland
        // forms (FG-055). Kai (DFKai-SB / 標楷體) is a different class and is
        // not mapped here.
        'MingLiU': { best: 'Noto Serif TC', alternatives: ['Droid Sans Fallback'] },
        'PMingLiU': { best: 'Noto Serif TC', alternatives: ['Droid Sans Fallback'] },
        'MingLiU_HKSCS': { best: 'Noto Serif TC', alternatives: ['Droid Sans Fallback'] },
        'MingLiU-ExtB': { best: 'Noto Serif TC', alternatives: ['Droid Sans Fallback'] },
        'PMingLiU-ExtB': { best: 'Noto Serif TC', alternatives: ['Droid Sans Fallback'] },
        '細明體': { best: 'Noto Serif TC', alternatives: ['Droid Sans Fallback'] },
        '新細明體': { best: 'Noto Serif TC', alternatives: ['Droid Sans Fallback'] },
        '細明體_HKSCS': { best: 'Noto Serif TC', alternatives: ['Droid Sans Fallback'] },
        // The TC sans faces must name a family of their own. With Noto Serif TC
        // mounted, a sans run with no rule falls back to whichever CJK face is
        // present, so in a document mixing PMingLiU and JhengHei the sans
        // paragraphs would turn serif (measured). Droid Sans Fallback is what
        // they drew in before.
        'Microsoft JhengHei': { best: 'Droid Sans Fallback', alternatives: [] },
        'Microsoft JhengHei UI': { best: 'Droid Sans Fallback', alternatives: [] },
        '微軟正黑體': { best: 'Droid Sans Fallback', alternatives: [] },
        // Korean Gothic (sans) faces: NanumGothic, which draws all of Hangul.
        // They used to map to Droid Sans Fallback (3 Hangul syllables) and reach
        // NanumGothic only by glyph fallback, which is not reliable once
        // NanumMyeongjo can be mounted too (FG-055).
        'Malgun Gothic': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        '맑은 고딕': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        'Gulim': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        'GulimChe': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        '굴림': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        '굴림체': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        'Dotum': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        'DotumChe': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        '돋움': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        '돋움체': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        'Malgun Gothic Semilight': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        'HCR Dotum': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        '함초롬돋움': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        '한컴돋움': { best: 'NanumGothic', alternatives: ['Droid Sans Fallback'] },
        // Korean Myeongjo (serif) faces: NanumMyeongjo, the Myeongjo design
        // closest to Batang (FG-055). It has no hanja; those keep the script
        // fallback. Shipped unmodified: Nanum declares Reserved Font Names.
        'Batang': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        'BatangChe': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        '바탕': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        '바탕체': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        'Gungsuh': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        'GungsuhChe': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        '궁서': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        '궁서체': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        'HCR Batang': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        '함초롬바탕': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        '한컴바탕': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        '신명조': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },
        'HY신명조': { best: 'NanumMyeongjo', alternatives: ['Droid Sans Fallback'] },

        // Arabic Fonts
        'Arabic Typesetting': { best: 'Noto Sans Arabic', alternatives: ['Droid Sans Fallback'] },
        'Simplified Arabic': { best: 'Noto Sans Arabic', alternatives: ['Droid Sans Fallback'] },
        'Traditional Arabic': { best: 'Noto Naskh Arabic', alternatives: ['Droid Sans Fallback'] },
        'Sakkal Majalla': { best: 'Noto Sans Arabic', alternatives: ['Droid Sans Fallback'] },

        // Hebrew Fonts
        'Arial Hebrew': { best: 'Noto Sans Hebrew', alternatives: ['Droid Sans Fallback'] },
        'David': { best: 'Noto Sans Hebrew', alternatives: ['Droid Sans Fallback'] },
        'Miriam': { best: 'Noto Sans Hebrew', alternatives: ['Droid Sans Fallback'] },

        // Other
        'Andale Mono': { best: 'Liberation Mono', alternatives: ['DejaVu Sans Mono'] },
        'Book Antiqua': { best: 'Liberation Serif', alternatives: ['Noto Serif'] },
        'Bookman Old Style': { best: 'Liberation Serif', alternatives: ['Noto Serif'] },
        'Century': { best: 'Liberation Serif', alternatives: ['Noto Serif'] },
        // FG-163: Century Gothic was drawn to ITC Avant Garde Gothic's metrics, and TeX Gyre
        // Adventor is URW++'s Avant Garde clone (GUST Font License). Its advances match
        // Word's Century Gothic Bold to 0.3% RMS on the measured labels (Jost: 4.3%), which
        // restores tab gaps a narrower face collapses (Belegdatum:22.01.2015).
        'Century Gothic': { best: 'TeX Gyre Adventor', alternatives: ['Jost', 'Nunito', 'Liberation Sans'] },
        'ITC Avant Garde Gothic': { best: 'TeX Gyre Adventor', alternatives: ['Jost'] },
        'Avant Garde Gothic': { best: 'TeX Gyre Adventor', alternatives: ['Jost'] },
        'Avant Garde': { best: 'TeX Gyre Adventor', alternatives: ['Jost'] },
        'URW Gothic': { best: 'TeX Gyre Adventor', alternatives: ['Jost'] },
        'URW Gothic L': { best: 'TeX Gyre Adventor', alternatives: ['Jost'] },
        'Garamond': { best: 'EB Garamond', alternatives: ['Liberation Serif'] },
        'Rockwell': { best: 'Liberation Serif', alternatives: ['Noto Serif'] }
    };

    // Metric-compatible fonts (same character widths for layout preservation)
    const METRIC_COMPATIBLE = {
        'Liberation Sans': ['Arial', 'Helvetica'],
        'Liberation Serif': ['Times New Roman', 'Times'],
        'Liberation Mono': ['Courier New', 'Courier'],
        'Carlito': ['Calibri'],
        'Caladea': ['Cambria']
    };

    // Font categories for fallback matching
    const CATEGORIES = {
        'sans-serif': {
            default: 'Liberation Sans',
            fonts: ['Liberation Sans', 'Noto Sans', 'Open Sans', 'DejaVu Sans', 'Roboto', 'Lato', 'Montserrat']
        },
        'serif': {
            default: 'Liberation Serif',
            fonts: ['Liberation Serif', 'Noto Serif', 'DejaVu Serif', 'Merriweather', 'PT Serif']
        },
        'monospace': {
            default: 'Liberation Mono',
            fonts: ['Liberation Mono', 'DejaVu Sans Mono', 'Noto Mono']
        },
        'display': {
            default: 'Liberation Sans',
            fonts: ['Oswald', 'Playfair Display', 'Liberation Sans']
        },
        'handwriting': {
            default: 'Comic Neue',
            fonts: ['Comic Neue', 'Liberation Sans']
        }
    };

    /**
     * Initialize the font matcher with the font registry
     * @param {Object} registry - Font registry from fonts.json or enhanced registry
     */
    async function initialize(registry = null) {
        if (initialized && fontRegistry) {
            return;
        }

        if (registry) {
            fontRegistry = registry;
        } else {
            // Load from fonts.json
            try {
                const response = await fetch('fonts/fonts.json');
                if (!response.ok) throw new Error('Failed to load fonts.json');
                fontRegistry = await response.json();
            } catch (e) {
                console.error('[FontMatcher] Failed to load font registry:', e);
                fontRegistry = { fonts: [], fallback: 'Liberation Sans' };
            }
        }

        // Build lookup indices
        buildIndices();
        initialized = true;
        console.log('[FontMatcher] Initialized with', fontRegistry.fonts?.length || 0, 'fonts');
    }

    // Index structures for fast lookup
    let fontFamilyIndex = new Map(); // family name → array of font entries
    let fontFileIndex = new Map();   // file name → font entry

    /**
     * Build lookup indices for fast font matching
     */
    function buildIndices() {
        fontFamilyIndex.clear();
        fontFileIndex.clear();

        if (!fontRegistry?.fonts) return;

        for (const font of fontRegistry.fonts) {
            // Index by family (lowercase for case-insensitive matching)
            const familyKey = font.family.toLowerCase();
            if (!fontFamilyIndex.has(familyKey)) {
                fontFamilyIndex.set(familyKey, []);
            }
            fontFamilyIndex.get(familyKey).push(font);

            // Index by file
            fontFileIndex.set(font.file, font);
        }
    }

    /**
     * Normalize font name for matching
     * Removes weight/style suffixes and normalizes whitespace
     */
    function normalizeFontName(name) {
        if (!name) return '';
        return name
            .replace(/\s+(Regular|Book|Roman|Normal|Medium|Text)$/i, '')
            .replace(/\s+(Bold|Light|Thin|Black|Heavy|Semibold|Demi|Extra).*$/i, '')
            .replace(/\s+(Italic|Oblique|Slanted)$/i, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Find best match for a font
     * @param {string} requestedFont - Font name from document
     * @param {Object} context - Optional context (weight, style needed)
     * @returns {Object} Match result with font, confidence, and reason
     */
    function findMatch(requestedFont, context = {}) {
        if (!requestedFont) {
            return createFallbackMatch();
        }

        const normalized = normalizeFontName(requestedFont);
        const rawName = String(requestedFont).trim();
        // Keyed on the RAW name, not the normalized one. Normalization is lossy and
        // many names collapse onto the same normalized form ("Times New Roman" and
        // "Times New Regular" both become "Times New"), so a normalized key made
        // the first caller's result stand in for every later one. That was
        // invisible while the result depended only on the normalized string; it
        // stops being invisible now that the raw name is consulted below.
        const cacheKey = `${rawName}:${context.weight || ''}:${context.style || ''}`;

        // Check cache
        if (matchCache.has(cacheKey)) {
            return matchCache.get(cacheKey);
        }

        let match;

        // 1. Check if we have this font directly
        match = findDirectMatch(normalized, context);
        if (match) {
            matchCache.set(cacheKey, match);
            return match;
        }

        // 2. Check exact proprietary mapping.
        //
        // The RAW name is tried before the normalized one. normalizeFontName()
        // strips a trailing style token, and `Roman` is both a style token and the
        // last word of "Times New Roman" — the most common document font there is —
        // so the normalized form ("Times New") missed its own PROPRIETARY_MAPPINGS
        // entry and fell through to category fallback at confidence 0.5. The result
        // was INVERTED: "Times New Roman Bold" normalized to the intact family name
        // and matched at 0.95, while the plain name did not, because rule 2 of the
        // normalizer strips " Bold" and leaves the family alone.
        //
        // Nothing rendered wrong — findCategoryFallback('Times New') independently
        // classifies it as serif and picks the same Liberation Serif the mapping
        // would have. Nor does the confidence value change any behaviour:
        // `match.confidence` is consumed ONLY by the diagnostic log at
        // font_resolver.js:428 (checked — applyFontBudget() never reads it), so an
        // earlier version of this comment claiming it fed budget priority was wrong.
        // What was actually wrong is narrower and still worth fixing: the mapping
        // table was unreachable by the name documents actually write, the log
        // misreported how the font was chosen, and the correct outcome depended on
        // two unrelated code paths happening to agree — so any change to category
        // fallback would have moved Times New Roman silently.
        //
        // Consulting the raw name is general: it repairs any family whose final
        // token collides with the style list, now or later. It cannot regress the
        // styled variants, which already normalize to a key. Today "Times New Roman"
        // is the only one of the 110 mapping keys affected (it is the sole key whose
        // normalized form is not itself a key) — asserted in
        // tests/unit/test_font_name_normalization.js so a future key cannot slip in.
        match = (rawName !== normalized ? findExactMapping(rawName) : null)
            || findExactMapping(normalized);
        if (match) {
            matchCache.set(cacheKey, match);
            return match;
        }

        // 3. Check metric-compatible fonts
        match = findMetricCompatible(normalized);
        if (match) {
            matchCache.set(cacheKey, match);
            return match;
        }

        // 4. Category-based fallback
        match = findCategoryFallback(normalized);
        matchCache.set(cacheKey, match);
        return match;
    }

    /**
     * Check if we already have this font in our registry
     */
    function findDirectMatch(fontName, context) {
        const familyKey = fontName.toLowerCase();
        const fonts = fontFamilyIndex.get(familyKey);

        if (!fonts || fonts.length === 0) {
            return null;
        }

        // Find best variant based on context
        let bestFont = fonts[0];
        if (context.weight || context.style) {
            for (const font of fonts) {
                const weightMatch = !context.weight || font.weight?.toLowerCase().includes(context.weight.toLowerCase());
                const styleMatch = !context.style || font.style === context.style;
                if (weightMatch && styleMatch) {
                    bestFont = font;
                    break;
                }
            }
        }

        return {
            font: bestFont,
            family: bestFont.family,
            confidence: 1.0,
            reason: 'direct-match',
            requestedFont: fontName
        };
    }

    /**
     * Find font via curated proprietary mapping
     */
    // Faces that draw CJK but (almost) no Latin, and the Latin face that
    // stands in front of them (FG-055). A family matched to one of these is
    // NOT the run's face: its Latin characters would fall to LibreOffice's
    // generic family, serif for an unknown name (a 等线 or SimHei run's Latin
    // came out in Liberation Serif, measured). So the match keeps the Latin
    // face as `family` — exactly what these names resolved to before they were
    // mapped, and what a host that knows nothing about `cjkFamily` still gets
    // — and names the CJK face in `cjkFamily`. getFontFiles() fetches both;
    // ConversionProtocol.buildFontSubstitutions adds a second rule so the run's
    // CJK characters go to `cjkFamily` rather than to whichever CJK face
    // happens to be mounted.
    const CJK_FALLBACK_FACES = { 'droid sans fallback': 'Liberation Sans' };
    function withCjkFallback(match) {
        const latin = CJK_FALLBACK_FACES[String(match.family || '').toLowerCase()];
        if (!latin) return match;
        const latinFonts = fontFamilyIndex.get(latin.toLowerCase()) || [];
        if (!latinFonts.length) return match;
        return { ...match, font: latinFonts[0], family: latinFonts[0].family, cjkFamily: match.family };
    }

    function findExactMapping(fontName) {
        // Try exact match first
        let mapping = PROPRIETARY_MAPPINGS[fontName];

        // Try case-insensitive match
        if (!mapping) {
            const normalizedKey = Object.keys(PROPRIETARY_MAPPINGS).find(
                key => key.toLowerCase() === fontName.toLowerCase()
            );
            if (normalizedKey) {
                mapping = PROPRIETARY_MAPPINGS[normalizedKey];
            }
        }

        if (!mapping) {
            return null;
        }

        // Find the best font in our registry
        const fonts = fontFamilyIndex.get(mapping.best.toLowerCase());
        if (!fonts || fonts.length === 0) {
            // Try alternatives
            for (const alt of mapping.alternatives || []) {
                const altFonts = fontFamilyIndex.get(alt.toLowerCase());
                if (altFonts && altFonts.length > 0) {
                    return withCjkFallback({
                        font: altFonts[0],
                        family: altFonts[0].family,
                        confidence: 0.9,
                        reason: 'exact-mapping-alt',
                        requestedFont: fontName,
                        mappedFrom: mapping.best
                    });
                }
            }
            return null;
        }

        return withCjkFallback({
            font: fonts[0],
            family: fonts[0].family,
            confidence: 0.95,
            reason: 'exact-mapping',
            requestedFont: fontName
        });
    }

    /**
     * Find metric-compatible font (same character widths)
     */
    function findMetricCompatible(fontName) {
        for (const [openSource, proprietaryList] of Object.entries(METRIC_COMPATIBLE)) {
            if (proprietaryList.some(p => p.toLowerCase() === fontName.toLowerCase())) {
                const fonts = fontFamilyIndex.get(openSource.toLowerCase());
                if (fonts && fonts.length > 0) {
                    return {
                        font: fonts[0],
                        family: fonts[0].family,
                        confidence: 0.95,
                        reason: 'metric-compatible',
                        requestedFont: fontName
                    };
                }
            }
        }
        return null;
    }

    /**
     * Infer font category from name and return category default
     */
    function findCategoryFallback(fontName) {
        const lower = fontName.toLowerCase();
        let category = 'sans-serif'; // Default

        // Infer category from name patterns
        if (/mono|code|courier|console|fixed|terminal/i.test(lower)) {
            category = 'monospace';
        } else if (/comic|hand|script|brush|casual/i.test(lower)) {
            category = 'handwriting';
        } else if (/impact|display|poster|headline|decorative/i.test(lower)) {
            category = 'display';
        } else if (/times|georgia|garamond|palatino|serif|roman|baskerville|book|antiqua|century/i.test(lower)) {
            category = 'serif';
        }

        const categoryConfig = CATEGORIES[category];
        const defaultFont = categoryConfig?.default || 'Liberation Sans';
        const fonts = fontFamilyIndex.get(defaultFont.toLowerCase());

        if (fonts && fonts.length > 0) {
            return {
                font: fonts[0],
                family: fonts[0].family,
                confidence: 0.5,
                reason: 'category-fallback',
                requestedFont: fontName,
                inferredCategory: category
            };
        }

        return createFallbackMatch();
    }

    /**
     * Create a fallback match using the registry's default font
     */
    function createFallbackMatch() {
        const fallbackName = fontRegistry?.fallback || 'Liberation Sans';
        const fonts = fontFamilyIndex.get(fallbackName.toLowerCase());

        if (fonts && fonts.length > 0) {
            return {
                font: fonts[0],
                family: fonts[0].family,
                confidence: 0.3,
                reason: 'fallback',
                requestedFont: null
            };
        }

        // Ultimate fallback - first font in registry
        if (fontRegistry?.fonts?.length > 0) {
            return {
                font: fontRegistry.fonts[0],
                family: fontRegistry.fonts[0].family,
                confidence: 0.1,
                reason: 'first-available',
                requestedFont: null
            };
        }

        return {
            font: null,
            family: null,
            confidence: 0,
            reason: 'no-fonts-available',
            requestedFont: null
        };
    }

    /**
     * Match multiple fonts and return unique matches
     * @param {Array<string>} fontNames - Array of font names from document
     * @param {Object} options - Options for matching
     * @returns {Array<Object>} Array of unique match results
     */
    function matchFonts(fontNames, options = {}) {
        const seenFamilies = new Map();   // family -> the match entry we pushed
        const matches = [];

        for (const name of fontNames) {
            if (!name) continue;

            const match = findMatch(name, options);
            if (!match || !match.family) continue;

            // A CJK-fallback match (FG-055) shares its Latin `family` with plain
            // Latin matches; keyed apart, so its `cjkFamily` is neither lost nor
            // lent to Arial.
            const groupKey = match.family + '\u0000' + (match.cjkFamily || '');
            const existing = seenFamilies.get(groupKey);
            if (existing) {
                // SEVERAL document fonts routinely collapse onto ONE family:
                // "Calibri" and "Calibri Light" both normalize to Calibri and both
                // match Carlito. Before NTH-03 the extra names were simply dropped,
                // which was harmless because every face was fetched anyway. Now the
                // face narrowing is keyed on the requested names, so losing one
                // would silently narrow Carlito by Calibri's usage alone and miss
                // the bold heading set in Calibri Light. Keep them all.
                if (!existing.requestedFonts.includes(name)) existing.requestedFonts.push(name);
                continue;
            }

            // CLONE, never push the object findMatch returned. That object lives in
            // matchCache and is shared by every document in the tab (and by every
            // name that normalizes the same way), so annotating it in place would
            // leak one document's requested names into the next conversion's
            // narrowing decision.
            const entry = { ...match, requestedFont: name, requestedFonts: [name] };
            seenFamilies.set(groupKey, entry);
            matches.push(entry);
        }

        return matches;
    }

    /**
     * Get all font files needed for matched fonts
     * Includes all weights/styles for each matched family
     * @param {Array<Object>} matches - Match results from matchFonts
     * @returns {Array<Object>} Font entries to load
     */
    // NOTE: deliberately UNCAPPED. The download budget is applied by the CALLER
    // (FontResolver.applyFontBudget), because only the caller knows the full set:
    // fallback faces and script fonts are appended AFTER this returns. A cap here
    // budgeted document fonts alone, so it could drop the document's own body font
    // while still loading several MB of extras on top of it -- and undercount the
    // total it was supposed to be bounding.
    function getFontFiles(matches, usage) {
        const files = [];
        const seenFiles = new Set();

        for (const match of matches) {
            if (!match.family) continue;

            // Get all variants of this family
            const familyFonts = fontFamilyIndex.get(match.family.toLowerCase()) || [];
            const allowed = allowedFaces(usage, match.requestedFonts ||
                                                (match.requestedFont ? [match.requestedFont] : []));

            for (const font of familyFonts) {
                if (allowed && !allowed.has(registryFace(font))) continue;
                if (!seenFiles.has(font.file)) {
                    seenFiles.add(font.file);
                    files.push(font);
                }
            }

            // FG-055: the CJK face behind a Latin `family` (withCjkFallback).
            // Every coverage tier is offered; the resolver picks one
            // (selectFontTier) and drops it when the text has no CJK
            // (dropNameMatchedHanFallback). No face narrowing: it is a fallback
            // face with one upright face per tier.
            for (const font of (match.cjkFamily && fontFamilyIndex.get(match.cjkFamily.toLowerCase())) || []) {
                if (!seenFiles.has(font.file)) {
                    seenFiles.add(font.file);
                    files.push(font);
                }
            }
        }

        return files;
    }

    /**
     * Which faces of a family are worth downloading, given what the document
     * actually asked for (NTH-03).
     *
     * THE RULE, in priority order:
     *   1. No usage information at all (`usage.resolved !== true`) - every input
     *      we cannot statically read: .doc/.xls/.ppt, PDF, .txt/.rtf/.html, a ZIP
     *      whose parts were unreadable, or a FontExtractor too old to report
     *      usage. Returns null, meaning "no filter", i.e. EXACTLY the pre-NTH-03
     *      behaviour of fetching every variant.
     *   2. A requested name we resolved - its own observed faces.
     *   3. A requested name we did NOT resolve (declared in fontTable/theme but
     *      never reached by a run we could attribute) - falls back to
     *      `usage.global`, the union of every face the whole document uses. This
     *      is the honest over-approximation: we know the document contains no
     *      italic run anywhere, so no family needs an italic, whichever family
     *      that unattributed name turns out to be.
     *   4. `usage.unattributed` - faces of runs whose FONT we could not resolve
     *      (unknown style id, unresolvable theme reference, placeholder
     *      inheritance in PPTX). Those runs could be set in ANY family, so their
     *      faces are added to every family unconditionally.
     *   5. The upright Regular is ALWAYS kept, even for a family we believe is
     *      used in bold only. A missing Bold or Italic is synthesised by
     *      fontconfig; a missing Regular has nothing to synthesise from and the
     *      family drops out entirely. This repo has already shipped that bug once
     *      (the budget evicted Liberation Mono Regular and kept its Bold, and
     *      body text came out bold) - see applyFontBudget in font_resolver.js.
     *
     * @param {Object} usage - FontExtractor usage report, or null/undefined
     * @param {string[]} names - every document font name that matched this family
     * @returns {Set<string>|null} allowed face keys, or null for "all faces"
     */
    function allowedFaces(usage, names) {
        if (!usage || usage.resolved !== true) return null;

        const allowed = new Set([FACES.REGULAR]);
        const add = (iterable) => { if (iterable) for (const f of iterable) allowed.add(f); };

        let sawUnresolvedName = !names || !names.length;
        for (const name of (names || [])) {
            const observed = usage.faces && usage.faces.get(String(name).trim().toLowerCase());
            if (observed) add(observed);
            else sawUnresolvedName = true;
        }
        if (sawUnresolvedName) add(usage.global);
        add(usage.unattributed);

        // Nothing was narrowed away - say so with null so callers can log/branch
        // on "the filter did nothing" without re-deriving it.
        return allowed.size >= ALL_FACES.length ? null : allowed;
    }

    /**
     * Clear the match cache (useful for testing)
     */
    function clearCache() {
        matchCache.clear();
    }

    /**
     * Get matching statistics
     */
    function getStats() {
        return {
            initialized,
            totalFonts: fontRegistry?.fonts?.length || 0,
            totalFamilies: fontFamilyIndex.size,
            cacheSize: matchCache.size,
            proprietaryMappings: Object.keys(PROPRIETARY_MAPPINGS).length
        };
    }

    // Public API
    return {
        initialize,
        findMatch,
        matchFonts,
        getFontFiles,
        normalizeFontName,
        clearCache,

        // NTH-03 face narrowing. FACES is the single definition of the four face
        // keys; FontExtractor emits them and tests/unit/test_font_usage.js pins
        // the two ends together. faceOf/registryFace/allowedFaces are pure and
        // are unit-tested directly - their failure mode (dropping a face the
        // document needs) is silent in the output, so they are asserted here
        // rather than only observed through a conversion.
        FACES,
        ALL_FACES,
        faceOf,
        registryFace,
        allowedFaces,
        getStats,

        // Expose mappings for debugging
        get PROPRIETARY_MAPPINGS() { return PROPRIETARY_MAPPINGS; },
        get METRIC_COMPATIBLE() { return METRIC_COMPATIBLE; },
        get CATEGORIES() { return CATEGORIES; }
    };
})();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FontMatcher;
}
