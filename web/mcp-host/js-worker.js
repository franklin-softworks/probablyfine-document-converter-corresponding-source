// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
'use strict';
// BUG-75: the engine child's JavaScript work on a document (the website driver's analysis, and HTML link sanitising), in
// a worker thread with a heap limit (host/child.js inWorker). Out of memory, this worker is stopped
// (ERR_WORKER_OUT_OF_MEMORY) instead of the process aborting, which could leave a core file with the document. It sees
// what the child's main thread would: the verified release's helpers, the conversion's format locale, the debug log.

const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const analysis = require('./analysis');

const { task, root, languages, debugLog, data } = workerData;
const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
for (const lvl of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    console[lvl] = debugLog ? (...a) => fs.appendFileSync(debugLog, `[${lvl}] ${fmt(a)}\n`) : () => {};
}
// The page's scope, as the child's main thread gives it before the engine starts (host/child.js hostStart): `self`,
// and `fetch` of the release's own files (fonts/fonts.json, ...), relative to the site root, never outside the tree.
globalThis.self = globalThis;
globalThis.fetch = async (url) => {
    let p = String(typeof url === 'string' ? url : url.url).replace(/[?#].*$/, '');
    if (p.startsWith('file://')) p = new URL(p).pathname;
    p = path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p);
    let buf = null;
    if (p === root || p.startsWith(root + path.sep)) {
        try { buf = fs.statSync(p).isFile() ? fs.readFileSync(p) : null; } catch { buf = null; }
    } else {
        console.error('engine host: access outside the release tree refused: ' + url);
    }
    return buf ? new Response(buf, { status: 200 }) : new Response(null, { status: 404, statusText: 'Not Found' });
};
if (Array.isArray(languages) && languages.length) {
    Object.defineProperty(navigator, 'languages', { value: Object.freeze([...languages]), configurable: true });
    Object.defineProperty(navigator, 'language', { value: languages[0], configurable: true });
}

(async () => {
    const h = analysis.loadHelpers(root);
    if (task === 'analyze') return analysis.analyze(h, data);
    if (task === 'sanitizeHtml') return analysis.sanitizeHtml({ ConversionProtocol: h.ConversionProtocol }, data.bytes);
    throw new Error(`unknown task ${task}`);
})().then((result) => parentPort.postMessage({ result }), (e) => parentPort.postMessage({ error: String((e && e.stack) || e) }));
