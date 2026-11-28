// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
/**
 * embedded_object_check.js
 * Pure, DOM-free detection of embedded objects a module cannot render.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An ODF container can embed another whole document:
 *
 *     <draw:object xlink:href="./Components" xlink:show="embed"/>
 *
 * Normally the container ALSO stores a pre-rendered snapshot under
 * `ObjectReplacements/`, so any consumer can display the object without being
 * able to open its native format. When that snapshot is absent, a consumer that
 * cannot instantiate the embedded document's type renders NOTHING.
 *
 * That is a live defect here (item 12, `bugs/…`): the `documents` module ships
 * the Writer engine but not Draw, so an embedded ODF *graphics* object with no
 * replacement image silently disappears. Measured on
 * `update-replacement-nosetting.odt`: the reference draws two full diagrams, we
 * draw the headings only — ink 0.19% vs 3.04%.
 *
 * THE POINT OF THIS MODULE IS THAT THE FAILURE IS CURRENTLY SILENT. Converting
 * that fixture produces 122 lines of engine stderr and ZERO mention of `draw`,
 * `graphic`, `embed` or `DrawingDocument`. The engine neither attempts nor
 * complains, so there is nothing to diagnose from. This detects the condition
 * from the INPUT FILE, before conversion, where it is cheap and unambiguous.
 *
 * Scope: this reports. It does not change conversion behaviour, and it does not
 * put anything in front of the user — engine/driver diagnostics go to the browser
 * console (developers), never to the page. A user-facing notice would belong in
 * the `ui-v2.js` notice channel and is a separate, deliberate decision.
 */
const EmbeddedObjectCheck = (function() {

    // Media types an embedded object can declare, mapped to the engine that has
    // to exist for it to render. Verified against the shipped VFS registries by
    // ENUMERATING them (`grep -ao 'uri="[^"]*lo\.a"' soffice.data | sort -u`)
    // rather than grepping for a guessed library name — that mistake produced a
    // wrong conclusion about charts once already.
    const ENGINE_FOR_TYPE = {
        'application/vnd.oasis.opendocument.graphics':    'draw',
        'application/vnd.oasis.opendocument.graphics-flat-xml': 'draw',
        'application/vnd.oasis.opendocument.presentation': 'draw',
        'application/vnd.oasis.opendocument.chart':       'chart',
        'application/vnd.oasis.opendocument.formula':     'math',
        'application/vnd.oasis.opendocument.text':        'writer',
        'application/vnd.oasis.opendocument.spreadsheet': 'calc',
    };

    // Which engines each module actually ships. `documents` lacking `draw` is the
    // whole reason this file exists; `chart` is present in BOTH (libchart2lo.a),
    // which is why embedded charts render correctly today.
    const MODULE_ENGINES = {
        documents:     ['writer', 'calc', 'chart', 'math'],
        spreadsheets:  ['calc', 'chart', 'math'],
        presentations: ['draw', 'chart', 'math'],
        'pdf-docx':    ['writer', 'chart', 'math'],
        'pdf-pptx':    ['draw', 'chart', 'math'],
    };

    /**
     * @param {string[]} names        every entry name in the container zip
     * @param {string}   manifestXml  META-INF/manifest.xml, or '' if unreadable
     * @param {string}   contentXml   content.xml, or '' — used only to mark which
     *                                objects the BODY actually references
     * @returns {{path,mediaType,engine,hasReplacement,referenced}[]}
     *
     * `referenced` matters: a package can carry embedded parts the body never
     * draws. `update-replacement-nosetting.odt` declares FOUR graphics objects in
     * its manifest but its body references only two (`Components`,
     * `Components_1`). Reporting the other two as "will render as nothing" would
     * be true-but-misleading — nothing was going to render them anyway.
     */
    function inspectEmbeddedObjects(names, manifestXml, contentXml) {
        if (!Array.isArray(names)) return [];
        const xml = typeof manifestXml === 'string' ? manifestXml : '';
        const body = typeof contentXml === 'string' ? contentXml : '';

        // xlink:href="./Components" | "Components" | "Components/"
        const refs = new Set();
        const refRe = /xlink:href="\.?\/?([^"#]+?)\/?"/g;
        let r;
        while ((r = refRe.exec(body)) !== null) refs.add(r[1]);

        // Replacement snapshots live under ObjectReplacements/. Compare on a
        // normalised basename so "./Components" and "Components" agree.
        const replacements = new Set();
        for (const n of names) {
            const m = /^ObjectReplacements\/(.+)$/.exec(n);
            if (m) replacements.add(m[1].replace(/^\.?\//, '').replace(/\/$/, ''));
        }

        const out = [];
        const re = /full-path="([^"]+)\/"[^>]*media-type="([^"]+)"/g;
        let hit;
        while ((hit = re.exec(xml)) !== null) {
            const path = hit[1].replace(/^\.?\//, '');
            const mediaType = hit[2];
            if (!Object.prototype.hasOwnProperty.call(ENGINE_FOR_TYPE, mediaType)) continue;
            out.push({
                path,
                mediaType,
                engine: ENGINE_FOR_TYPE[mediaType],
                hasReplacement: replacements.has(path),
                // No content.xml supplied => cannot tell; assume referenced rather
                // than silently dropping a real finding.
                referenced: body ? refs.has(path) : true,
            });
        }
        return out;
    }

    /**
     * Objects that will render as NOTHING: the module lacks the engine AND the
     * container carries no snapshot to fall back on. Either alone is fine.
     */
    function findUnrenderable(objects, moduleName) {
        const have = MODULE_ENGINES[moduleName];
        if (!have || !Array.isArray(objects)) return [];
        return objects.filter((o) => o.engine && o.referenced && !o.hasReplacement
                                     && !have.includes(o.engine));
    }

    /** One line per finding, for the developer console. */
    function describe(findings, moduleName) {
        return findings.map((f) =>
            `embedded object "${f.path}" (${f.mediaType}) needs the '${f.engine}' engine, ` +
            `which the '${moduleName}' module does not ship, and the file carries no ` +
            `ObjectReplacements/ snapshot — it will render as NOTHING`);
    }

    return { inspectEmbeddedObjects, findUnrenderable, describe, ENGINE_FOR_TYPE, MODULE_ENGINES };
})();

// Page (window === self in browsers); node unit tests use require().
if (typeof self !== 'undefined') self.EmbeddedObjectCheck = EmbeddedObjectCheck;
if (typeof window !== 'undefined') window.EmbeddedObjectCheck = EmbeddedObjectCheck;
if (typeof module !== 'undefined' && module.exports) module.exports = EmbeddedObjectCheck;
