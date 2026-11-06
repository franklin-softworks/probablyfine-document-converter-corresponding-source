#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

'use strict';
/**
 * Generate ConversionProtocol's FORMAT_LOCALES table from the LibreOffice tree
 * this release is built from (engine/upstream.json).
 *
 * An entry is a locale the engine can actually look up: it has locale data
 * (i18npool/source/localedata/data/<name>.xml) AND a row in localedata.cxx's
 * aLibTable — with DISABLE_DYNLOADING that table is the only way a name reaches
 * its data, so an XML without a row (ti_ET, at the pinned commit) is not
 * reachable and is left out.
 *
 * Each entry carries the script LibreOffice uses for it, which is NOT always
 * what Intl.Locale.maximize() says: sr_ME and sr_CS take their calendar from
 * sr_RS and are Cyrillic, while Intl maximises sr-ME to Latin. The script is
 * the tag's own script subtag, else Intl's maximised script when the locale's
 * own month and day names use it, else those names' dominant script (scriptOf).
 *
 * Usage:
 *   node engine/tools/gen_format_locales.js            # rewrite the block in conversion_protocol.js
 *   node engine/tools/gen_format_locales.js --check    # exit 1 if the block is stale
 * Needs libreoffice/ checked out at engine/upstream.json's commit.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const LO = process.env.LIBREOFFICE_DIR || path.join(REPO, 'libreoffice');
const DATA = path.join(LO, 'i18npool/source/localedata/data');
const TABLE = path.join(LO, 'i18npool/source/localedata/localedata.cxx');
const TARGET = path.join(REPO, 'web/js/conversion_protocol.js');
const BEGIN = '    // BEGIN GENERATED FORMAT_LOCALES';
const END = '    // END GENERATED FORMAT_LOCALES';

// Scripts month names can be written in, as ISO 15924 codes (Node's \p{Script=}
// accepts these). Order does not matter: a letter has exactly one script.
const SCRIPTS = ['Latn', 'Cyrl', 'Grek', 'Arab', 'Hebr', 'Armn', 'Geor', 'Ethi', 'Deva', 'Beng',
    'Guru', 'Gujr', 'Orya', 'Taml', 'Telu', 'Knda', 'Mlym', 'Sinh', 'Thai', 'Laoo', 'Khmr', 'Mymr',
    'Tibt', 'Mong', 'Olck', 'Thaa', 'Tfng', 'Cher', 'Glag', 'Copt', 'Hang', 'Hani', 'Hira', 'Kana',
    'Limb', 'Bopo', 'Yiii', 'Tale', 'Talu', 'Cans', 'Vaii', 'Bamu', 'Nkoo', 'Adlm', 'Syrc', 'Tglg',
    'Bali', 'Java', 'Sund', 'Lepc', 'Saur', 'Mtei', 'Cakm', 'Lisu', 'Tavt', 'Bugi', 'Batk', 'Osge'];

function fail(msg) { console.error('gen_format_locales: ' + msg); process.exit(2); }

function read(name) {
    const p = path.join(DATA, name + '.xml');
    if (!fs.existsSync(p)) fail('no locale data ' + p);
    return fs.readFileSync(p, 'utf8');
}

function libTable() {
    const src = fs.readFileSync(TABLE, 'utf8');
    const m = src.match(/aLibTable\[\]\s*=\s*\{([\s\S]*?)\n\};/);
    if (!m) fail('aLibTable not found in ' + TABLE);
    return new Set([...m[1].matchAll(/\{\s*"([^"]+)"/g)].map(x => x[1]));
}

function tagOf(xml, name) {
    const lang = (xml.match(/<LangID>([^<]*)<\/LangID>/) || [])[1];
    const country = (xml.match(/<CountryID>([^<]*)<\/CountryID>/) || [])[1] || '';
    const variant = (xml.match(/<Variant>([^<]*)<\/Variant>/) || [])[1] || '';
    if (!lang) fail('no LangID in ' + name);
    // 'qlt' means "the full BCP 47 tag is in Variant" (ha-Latn-NG, ca-ES-valencia).
    const tag = lang === 'qlt' ? variant : (country ? lang + '-' + country : lang);
    if (tag.replace(/-/g, '_') !== name) fail(`${name}.xml declares ${tag}`);
    return tag;
}

/** Full month or day names (elem MonthsOfYear / DaysOfWeek) of a locale's default calendar (or the one named by unoid), following refs. */
function calendarNames(elem, name, unoid, depth) {
    if (depth > 5) fail('ref loop at ' + name);
    const xml = read(name);
    const calRef = xml.match(/<LC_CALENDAR ref="([^"]+)"/);
    if (calRef) return calendarNames(elem, calRef[1], unoid, depth + 1);
    const cals = [...xml.matchAll(/<Calendar unoid="([^"]+)" default="(true|false)">([\s\S]*?)<\/Calendar>/g)];
    const cal = cals.find(c => (unoid ? c[1] === unoid : c[2] === 'true'));
    if (!cal) fail(`no calendar ${unoid || '(default)'} in ${name}`);
    const ref = cal[3].match(new RegExp(`<${elem} ref="([^"]+)"`));
    if (ref) {
        // Three forms: "en_US_gregorian" (locale + calendar), "ro_RO" (a locale,
        // same calendar) and "gregorian" (a calendar of this locale).
        const r = ref[1];
        const m = r.match(/^(.*)_([a-z]+)$/);
        if (m && fs.existsSync(path.join(DATA, m[1] + '.xml'))) return calendarNames(elem, m[1], m[2], depth + 1);
        if (fs.existsSync(path.join(DATA, r + '.xml'))) return calendarNames(elem, r, cal[1], depth + 1);
        return calendarNames(elem, name, r, depth + 1);
    }
    const block = cal[3].match(new RegExp(`<${elem}>([\\s\\S]*?)</${elem}>`));
    if (!block) fail(`no ${elem} in ${name}`);
    return [...block[1].matchAll(/<DefaultFullName>([^<]*)<\/DefaultFullName>/g)].map(x => x[1]);
}

/** Letter counts per script in a text. */
function scriptsOfText(text, name) {
    const counts = new Map();
    for (const ch of text) {
        if (!/\p{L}/u.test(ch) || /[\p{Script=Common}\p{Script=Inherited}]/u.test(ch)) continue;
        const s = SCRIPTS.find(code => new RegExp(`\\p{Script=${code}}`, 'u').test(ch));
        if (!s) fail(`${name}: calendar-name letter ${ch} (U+${ch.codePointAt(0).toString(16)}) in no known script`);
        counts.set(s, (counts.get(s) || 0) + 1);
    }
    if (!counts.size) fail(`${name}: calendar names have no letters`);
    return counts;
}

// Intl scripts that are written with several Unicode scripts.
const COMPOSITE = { Jpan: ['Hani', 'Hira', 'Kana'], Kore: ['Hang', 'Hani'], Hans: ['Hani'], Hant: ['Hani'] };

/**
 * The script LibreOffice writes a locale in: Intl's maximised script when the
 * locale's own month and day names use it (ko_KR's full month names are
 * English, its day names Korean), else the names' dominant script (sr_ME and
 * sr_CS take sr_RS's Cyrillic calendar; Intl says Latin).
 */
function scriptOf(tag, name) {
    const text = calendarNames('MonthsOfYear', name, null, 0).join('') + calendarNames('DaysOfWeek', name, null, 0).join('');
    const counts = scriptsOfText(text, name);
    let intl;
    try { intl = new Intl.Locale(tag).maximize().script; } catch (_) { intl = undefined; }
    if (intl && (counts.has(intl) || (COMPOSITE[intl] || []).some(s => counts.has(s)))) return intl;
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function generate() {
    const table = libTable();
    const files = fs.readdirSync(DATA).filter(f => f.endsWith('.xml')).map(f => f.slice(0, -4)).sort();
    const entries = [];
    const skipped = [];
    for (const name of files) {
        if (!table.has(name)) { skipped.push(name); continue; }
        const tag = tagOf(read(name), name);
        const explicit = tag.split('-').find((p, i) => i > 0 && /^[A-Z][a-z]{3}$/.test(p));
        let script = explicit;
        if (!script) script = scriptOf(tag, name);
        entries.push([tag, script]);
    }
    for (const name of table) if (!files.includes(name)) fail(`aLibTable names ${name} but there is no ${name}.xml`);
    return { entries, skipped };
}

function render(entries, commit) {
    const lines = [BEGIN + ` — engine/tools/gen_format_locales.js, LibreOffice ${commit.slice(0, 12)}. Do not edit by hand.`];
    lines.push('    const FORMAT_LOCALE_SCRIPTS = Object.freeze({');
    for (const [tag, script] of entries) lines.push(`        '${tag}': '${script}',`);
    lines.push('    });');
    lines.push(END);
    return lines.join('\n');
}

const commit = JSON.parse(fs.readFileSync(path.join(REPO, 'engine/upstream.json'), 'utf8')).commit;
const { entries, skipped } = generate();
const block = render(entries, commit);
const src = fs.readFileSync(TARGET, 'utf8');
const i = src.indexOf(BEGIN), j = src.indexOf(END);
if (i < 0 || j < 0) fail('generated-block markers not found in ' + TARGET);
const next = src.slice(0, i) + block + src.slice(j + END.length);
if (process.argv.includes('--check')) {
    if (next !== src) { console.error('FORMAT_LOCALES is stale: run node engine/tools/gen_format_locales.js'); process.exit(1); }
    console.log(`FORMAT_LOCALES up to date (${entries.length} locales)`);
} else {
    fs.writeFileSync(TARGET, next);
    console.log(`wrote ${entries.length} locales; not reachable (no aLibTable row): ${skipped.join(', ') || 'none'}`);
}
for (const [tag, script] of entries) {
    if (/^[a-z]+$/.test(tag)) continue;
    let m; try { m = new Intl.Locale(tag).maximize().script; } catch (_) { m = '?'; }
    if (m !== script && process.argv.includes('--verbose')) console.log(`  script differs from Intl: ${tag} LibreOffice ${script}, Intl ${m}`);
}
