// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
'use strict';
// The user's own fonts (fontDirs), matched against the families a document asks for. Runs in the engine
// child's analysis, after the converter's own font resolution (FontResolver) has chosen its files and
// substitutes; it only has the fonts' names (src/user-fonts.js scans the folders in the MCP process) and
// gets the chosen files' bytes later (child.js, USER_FONTS).
//
// A family the document asks for and a configured folder has is used from that folder: every face of the
// family is mounted (the engine picks weight and style) and a fontconfig rule names it first for the
// requested name (a mounted font alone is not used; mode="prepend" binding="same", worker
// buildSubstitutionRules). Everything else keeps the converter's own fonts and substitutions.
// The user's fonts are used whatever their licence flags (owner decision 2026-10-30); the MCP process
// warns when an output embeds one against them (src/font-embedding.js).

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_]+/g, '');

/** The names a FontResolver result says the document asked for. */
function requestedNames(matches) {
    const out = [];
    for (const m of Array.isArray(matches) ? matches : []) {
        for (const r of (m && (m.requestedFonts || [m.requestedFont])) || []) if (r) out.push(String(r));
    }
    return out;
}

/**
 * The user's fonts for the requested names. A name matches a family name (typographic or legacy) first,
 * then a face's full or PostScript name; the first folder (in the configured order) that has it wins.
 * @param {object[]} faces       in priority order: { fileId, fileName, ext, size, dirIndex, family, legacyFamily, subfamily, fullName, psName }
 * @param {string[]} requested
 * @returns {{ requested: string, family: string, faces: object[] }[]}
 */
function matchUserFonts(faces, requested) {
    const out = [];
    const seen = new Set();
    for (const name of requested) {
        const n = norm(name);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        let hit = null;
        let family = null;
        for (const f of faces) {
            if (norm(f.family) === n) { hit = f; family = f.family; break; }
            if (norm(f.legacyFamily) === n) { hit = f; family = f.legacyFamily; break; }
        }
        if (!hit) {
            for (const f of faces) if (norm(f.fullName) === n || norm(f.psName) === n) { hit = f; family = f.legacyFamily || f.family; break; }
        }
        if (!hit) continue;
        const group = faces.filter((f) => f.dirIndex === hit.dirIndex && norm(f.family) === norm(hit.family));
        out.push({ requested: name, family, faces: group });
    }
    return out;
}

/**
 * Add the user's fonts to a document's font plan.
 * @returns {null | { requiredFonts: object[], fontSubstitutions: object[], warnings: object[] }}
 */
function applyUserFonts({ requiredFonts, fontSubstitutions, requested, faces }) {
    const matches = matchUserFonts(faces, requested);
    if (!matches.length) return null;
    const files = new Map();
    for (const m of matches) for (const f of m.faces) if (!files.has(f.fileId)) files.set(f.fileId, f);
    const entries = [...files.values()].map((f) => ({
        family: f.family, weight: f.subfamily || '', file: `user:${f.fileId}`, user: true, fileId: f.fileId, size: f.size,
        uri: `/user-fonts/${f.fileId}`, lazy_path: `/usr/share/fonts/user/${f.fileId}.${f.ext}`,
    }));
    const matched = new Set(matches.map((m) => norm(m.requested)));
    const pairs = [...(fontSubstitutions || []).filter((p) => !matched.has(norm(p.requested))),
        ...matches.map((m) => ({ requested: m.requested, family: m.family }))];
    const fileList = (m) => [...new Set(m.faces.map((f) => f.fileName))].join(', ');
    const warnings = [{
        code: 'USER_FONTS_USED', level: 'info',
        message: 'Your fonts were used: ' + matches.map((m) => `${m.requested}${norm(m.requested) === norm(m.family) ? '' : ` (as ${m.family})`} from ${fileList(m)}`).join('; ') + '.',
        fonts: matches.map((m) => ({ requested: m.requested, family: m.family, files: [...new Set(m.faces.map((f) => f.fileName))] })),
    }];
    return { requiredFonts: [...(requiredFonts || []), ...entries], fontSubstitutions: pairs, warnings };
}

module.exports = { requestedNames, matchUserFonts, applyUserFonts };
