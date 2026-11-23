// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
/**
 * artifact_stem.js
 * Pure, DOM-free derivation of the shipped artifact filename STEM (e.g.
 * `soffice` in `soffice.wasm`) from a module's advertised path.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `artifact_prefix` in pipeline/config/modules.json is a real BUILD-PIPELINE
 * mechanism (get_module_artifact_prefix() in pipeline/lib/module_registry.sh):
 * it names the .wasm/.data/.js triplet a module actually ships as. The browser
 * runtime never read it — `web/js/conversion_driver.js` and
 * `web/js/conversion_worker.js` reconstructed artifact filenames from a
 * hardcoded `'soffice'` literal, so a renamed module would ship artifacts the
 * site could not fetch (a silent 404, not a visible error). See
 * tests/gates/test_artifact_prefix_wiring.sh section D for the history.
 *
 * THE FIX DOES NOT SHIP A NEW CONFIG FIELD. The browser already receives every
 * artifact's real path in `web/modules.json`, e.g.
 * `"documents": { "wasm": "modules/documents/soffice.wasm", ... }`. The stem is
 * DERIVABLE from that path, so this module extracts it instead of guessing or
 * fetching pipeline/config/modules.json (which is not served to the browser at
 * all).
 *
 * Dual environment: attaches to `self`/`window` (page) and `module.exports`
 * (node), same pattern as ui_decisions.js and embedded_object_check.js.
 */
const ArtifactStem = (function() {

    var DEFAULT_STEM = 'soffice';

    /**
     * Derive the artifact stem from a module's advertised path, e.g.
     * "modules/documents/soffice.wasm" -> "soffice", or
     * "modules/documents/mystem.wasm"  -> "mystem".
     *
     * Falls back to `fallback` (default 'soffice' — today's hardcoded
     * behaviour) whenever `path` is missing or does not look like a
     * well-formed "<dir>/<stem>.<ext>" path, so a config gap degrades to
     * current behaviour rather than breaking a conversion.
     *
     * Only the basename is inspected, so dots elsewhere in the path (a
     * directory named "release-1.2.3", say) do not affect the result.
     *
     * @param {*} path       e.g. moduleConfig.wasm from web/modules.json
     * @param {string} [fallback='soffice']
     * @returns {string}
     */
    function deriveStem(path, fallback) {
        var fb = (typeof fallback === 'string' && fallback) ? fallback : DEFAULT_STEM;
        if (typeof path !== 'string' || !path) return fb;

        var basename = path.split('/').pop();
        if (!basename) return fb; // e.g. path ends in '/'

        var dot = basename.lastIndexOf('.');
        if (dot <= 0) return fb; // no extension at all, or a dotfile like ".wasm"

        var stem = basename.slice(0, dot);
        return stem || fb;
    }

    return { deriveStem: deriveStem, DEFAULT_STEM: DEFAULT_STEM };
})();

// Page (window === self in browsers); node unit tests use require().
if (typeof self !== 'undefined') self.ArtifactStem = ArtifactStem;
if (typeof window !== 'undefined') window.ArtifactStem = ArtifactStem;
if (typeof module !== 'undefined' && module.exports) module.exports = ArtifactStem;
