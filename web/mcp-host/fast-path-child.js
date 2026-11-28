// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
'use strict';
// FF-7 route (b): the website's CSV/TSV → PDF layout (the release's js/csv_fast_path.js with its jsPDF), run unmodified
// in this child, which src/engine/fast-path.js starts for one conversion with the same read-only file permissions as the
// engine child (plus worker threads).
// The layout runs in a worker thread with a heap limit: at the limit the worker is stopped (ERR_WORKER_OUT_OF_MEMORY)
// and this process says so. A process that reaches V8's own heap limit aborts instead, and the system may write a core
// file, which would hold the document, into the folder the server was started from: that never happens here.
// The page's browser globals are provided in the worker, from verified release files only:
// - window/self, window.ConversionProtocol and window.jspdf (the page loads jsPDF with a <script> tag);
// - fetch, for the fast path's fonts (fonts/<name>.ttf): asked of the parent, which serves them from the verified cache
//   (downloading one the first time it is needed); nothing else, and no network from here;
// - CustomEvent/dispatchEvent (its warnings also arrive in the result's stats.warnings, which is what is used);
// - the MCP's own paper size, locale and conversion time, pinned with the documented
//   ConversionProtocol.pinBrowserConversionSettings (as the page pins a queued file's settings).
// Messages with the parent: START { tree, input, fileName, options, settings, heapMiB } → PROGRESS*, FETCH* (FETCHED
// back), then DONE or ERROR. The worker uses the same messages with this process, which passes them on.

const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (isMainThread) {
    // BUG-75: never outlive the server (its IPC channel closed, or this process re-parented): exit, with the document.
    const PARENT = process.ppid;
    process.on('disconnect', () => process.exit(0));
    setInterval(() => { if (process.ppid !== PARENT) process.exit(0); }, 1000).unref();
    const send = (m) => { if (process.connected) process.send(m); };
    let worker = null;
    process.on('message', (m) => {
        if (m && m.type === 'FETCHED') {
            if (worker) worker.postMessage(m);
        } else if (m && m.type === 'START') {
            const { heapMiB, ...data } = m;
            worker = new Worker(__filename, { workerData: data, resourceLimits: { maxOldGenerationSizeMb: heapMiB }, stdout: true, stderr: true });
            worker.on('message', send);
            worker.on('error', (e) => send(e && e.code === 'ERR_WORKER_OUT_OF_MEMORY'
                ? { type: 'ERROR', code: 'FAST_PATH_MEMORY', message: 'the CSV layout needed more memory than its limit' }
                : { type: 'ERROR', code: (e && e.code) || 'FAST_PATH_FAILED', message: String((e && e.message) || e) }));
            worker.on('exit', (code) => { if (code !== 0) send({ type: 'ERROR', code: 'FAST_PATH_FAILED', message: `the CSV layout stopped (exit ${code})` }); });
        }
    });
} else {
    for (const l of ['log', 'info', 'warn', 'debug']) console[l] = () => {};   // the fast path's diagnostics stay here
    let fetchId = 0;
    const fetches = new Map();
    parentPort.on('message', (m) => {
        const done = m && m.type === 'FETCHED' && fetches.get(m.id);
        if (done) { fetches.delete(m.id); done(m.bytes ? Buffer.from(m.bytes) : null); }
    });
    const run = async ({ tree, input, fileName, options, settings }) => {
        const send = (m) => parentPort.postMessage(m);
        globalThis.window = globalThis;
        globalThis.self = globalThis;
        globalThis.ConversionProtocol = require(path.join(tree, 'js', 'conversion_protocol.js'));
        globalThis.jspdf = require(path.join(tree, 'js', 'vendor', 'jspdf.umd.min.js'));
        globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
        globalThis.dispatchEvent = () => true;
        globalThis.fetch = (url) => new Promise((resolve) => {
            const id = ++fetchId;
            fetches.set(id, (bytes) => resolve(bytes
                ? { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }
                : { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) }));
            send({ type: 'FETCH', id, url: String(url) });
        });
        const P = globalThis.ConversionProtocol;
        P.pinBrowserConversionSettings(settings);
        const FP = require(path.join(tree, 'js', 'csv_fast_path.js'));

        const bytes = Buffer.from(input);
        // The release decides whether this file is one for the fast path: its extension, its size (CSV_FAST_PATH_MAX_BYTES),
        // and, from BUG-73's estimate of its rows and cells (estimateSize), CSV_FAST_PATH_MAX_ROWS / _CELLS.
        const estimateSize = typeof FP.estimateSize === 'function' ? FP.estimateSize : typeof P.estimateSize === 'function' ? P.estimateSize : null;
        const estimate = estimateSize ? estimateSize(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)) : undefined;
        if (!FP.shouldUseFastPath(fileName, bytes.length, estimate)) {
            send({ type: 'ERROR', code: 'NOT_FAST_PATH', message: 'the fast path does not take this file' });
            return;
        }
        const file = { name: fileName, size: bytes.length, type: 'text/csv', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
        const r = await FP.convert(file, (p) => send({ type: 'PROGRESS', stage: p && p.stage, percent: p && p.percent }), options);
        const output = Buffer.from(await r.blob.arrayBuffer());
        const stats = r.stats || {};
        send({ type: 'DONE', hostContract: 1, output, conversionTime: r.conversionTime || null, conversionTimeFallback: r.conversionTimeFallback === true,
            conversionTimeOffsetChanged: r.conversionTimeOffsetChanged === true,
            // Plain data only (the warnings' code, count and fact-only message, as the PDF's notice states them).
            stats: JSON.parse(JSON.stringify({ ...stats, warnings: undefined })),
            warnings: (stats.warnings || []).map((w) => ({ code: String(w.code), count: w.count, message: String(w.message || w.code) })) });
    };
    run(workerData).then(() => parentPort.close(),
        (e) => { parentPort.postMessage({ type: 'ERROR', code: (e && e.code) || 'FAST_PATH_FAILED', message: String((e && e.message) || e) }); parentPort.close(); });
}
