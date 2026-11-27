// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
'use strict';
// Engine child process: one process = one conversion (PLAN.md §3.1).
//
// Phases, each started by a message from the parent:
//   HOST_START   {tree, debugLog}          → HOST_READY
//   ANALYZE      {bytes, fileName, ...}    → ANALYSIS     (website driver helpers)
//   ENGINE_START {module, wasmFile, ...}   → ENGINE_LOADED, then worker messages
//   INIT / CONVERT                          → forwarded to the served worker
//
// Everything that parses untrusted document bytes runs here, so a pathological
// file is stopped by the parent's timeout and kill, never inside the server.
// Web Worker surface for the served conversion_worker.js: self, location,
// postMessage, addEventListener, importScripts, XMLHttpRequest, fetch. All file
// reads are confined to the verified release tree; there is no network access.
// Nothing is written to stdout; console output goes to a debug log only when set.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const vm = require('vm');
const { Worker } = require('worker_threads');

// BUG-75: analysis and HTML sanitising run in heap-limited worker threads (host/js-worker.js).
const JS_WORKER = path.join(__dirname, 'js-worker.js');
// The child <-> parent message contract of this file set (the MCP checks it; it is not the converter's CONTRACT_VERSION).
const MCP_HOST_CONTRACT = 1;
const OUT_OF_MEMORY_MESSAGE = 'Reading this file needed more memory than the converter allows, so nothing was converted.';

// BUG-75 (orch 2026-11-08): this process never outlives the server. When the server is gone (its IPC channel closed, or
// this process re-parented), it exits at once, so the document it holds goes with it. The channel closing is seen when
// the event loop is free; during the engine's synchronous conversion call, the check in send() sees it, because the
// engine reports its progress through send() while that call runs.
const PARENT = process.ppid;
const parentGone = () => !process.connected || process.ppid !== PARENT;
process.on('disconnect', () => process.exit(0));
// ...and when its main thread is stuck without reporting progress: a watchdog thread (host/parent-watch.js).
require('./parent-watch').watchParent({ parent: PARENT });
const send = (msg) => {
    if (parentGone()) process.exit(0);
    process.send(msg);
};

const state = {
    root: null,
    fetchBase: null,         // directory that relative URLs resolve against
    languages: null,
    debugLog: null,
    jsHeapMiB: null,         // the workers' heap limit
    listeners: { message: [], error: [], unhandledrejection: [] },
    engineStarted: false,
    wasmBinary: null,
    userFonts: new Map(),   // fileId -> bytes (USER_FONTS)
    sanitize: false,
    countUnsafe: false,
};

process.on('message', (msg) => {
    try {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'HOST_START') return hostStart(msg);
        if (msg.type === 'ANALYZE') return void runAnalysis(msg);
        if (msg.type === 'ENGINE_START') return engineStart(msg);
        // The user's chosen font files (fontDirs), read by the MCP process: served to the worker's fetch
        // at /user-fonts/<id> (they are never on disk here, and this process cannot read those folders).
        if (msg.type === 'USER_FONTS') { for (const f of msg.fonts || []) state.userFonts.set(String(f.id), Buffer.from(f.bytes)); return; }
        if (!state.engineStarted) throw new Error(`message ${msg.type} before the engine started`);
        if (msg.type === 'INIT') msg = { ...msg, wasmBinary: state.wasmBinary };
        if (msg.type === 'CONVERT') {
            state.sanitize = msg.targetFormat === 'html' && !!(msg.options && msg.options.html && msg.options.html.sanitizeLinks);
            // html.sanitize_links false (FEAT-22): the output is left exactly as converted, but its unsafe links are counted, so
            // the caller is told how many were kept.
            state.countUnsafe = msg.targetFormat === 'html' && !!(msg.options && msg.options.html) && msg.options.html.sanitizeLinks === false;
        }
        for (const fn of state.listeners.message) fn({ data: msg });
    } catch (e) {
        send({ type: 'HOST_FATAL', error: String(e && e.stack || e) });
    }
});

const toForwardSlashes = (p) => (path.sep === '\\' ? p.split('\\').join('/') : p);

function resolveLocal(url, base = state.fetchBase) {
    let p = String(url).replace(/[?#].*$/, '');
    if (p.startsWith('file://')) p = new URL(p).pathname;
    p = path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p);
    if (p !== state.root && !p.startsWith(state.root + path.sep)) {
        throw new Error('engine host: access outside the release tree refused: ' + url);
    }
    return p;
}
function readLocal(url) {
    const p = resolveLocal(url);
    const buf = fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p) : null;
    // The worker only logs a font or fonts.conf it could not load; report it so
    // the caller is told (no silent failures).
    if (!buf && state.engineStarted && /(^|\/)fonts\/[^/]+$/.test(String(url).replace(/[?#].*$/, ''))) {
        send({ type: 'RESOURCE_MISSING', path: path.relative(state.root, p) });
    }
    return buf;
}

function hostStart({ tree, languages, debugLog, jsHeapMiB }) {
    // The parent always sends an absolute path; this process runs in a temporary folder of its own (BUG-75).
    if (!path.isAbsolute(String(tree))) throw new Error('engine host: the release tree must be an absolute path');
    state.root = path.normalize(tree);
    state.languages = Array.isArray(languages) ? languages : null;
    state.debugLog = debugLog || null;
    // The heap a worker may use: what this process itself would have (so no file fails that converted before), unless
    // a test sets a smaller one.
    state.jsHeapMiB = Number.isFinite(jsHeapMiB) && jsHeapMiB > 0 ? jsHeapMiB : Math.floor(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));

    // The format locale of this conversion. The Emscripten loader derives its default LANG
    // from navigator.languages[0] once at start-up; the worker then sets ENV.LANG from
    // INIT.formatLocale (contract 2), so both are the same.
    if (Array.isArray(languages) && languages.length) {
        Object.defineProperty(navigator, 'languages', { value: Object.freeze([...languages]), configurable: true });
        Object.defineProperty(navigator, 'language', { value: languages[0], configurable: true });
    }
    state.fetchBase = state.root;   // the website page lives at the site root

    const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
    for (const lvl of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
        console[lvl] = debugLog ? (...a) => fs.appendFileSync(debugLog, `[${lvl}] ${fmt(a)}\n`) : () => {};
    }

    globalThis.self = globalThis;
    globalThis.require = require;   // the Emscripten loader's Node branch uses require('fs'/'path')
    globalThis.fetch = async (url) => {
        let buf = null;
        const u = String(typeof url === 'string' ? url : url.url).replace(/[?#].*$/, '');
        const user = /\/user-fonts\/([0-9a-f]{24})$/.exec(u);
        if (user) {
            buf = state.userFonts.get(user[1]) || null;
            if (!buf) send({ type: 'RESOURCE_MISSING', path: `user-fonts/${user[1]}` });
            return buf ? new Response(buf, { status: 200 }) : new Response(null, { status: 404, statusText: 'Not Found' });
        }
        try { buf = readLocal(typeof url === 'string' ? url : url.url); } catch (e) { console.error(e.message); }
        return buf ? new Response(buf, { status: 200 }) : new Response(null, { status: 404, statusText: 'Not Found' });
    };
    globalThis.addEventListener = (type, fn) => { (state.listeners[type] ||= []).push(fn); };
    process.on('uncaughtException', (err) => {
        for (const fn of state.listeners.error) fn({ message: (err && err.message) || String(err), error: err });
        send({ type: 'HOST_FATAL', error: String(err && err.stack || err) });
    });
    process.on('unhandledRejection', (reason) => {
        for (const fn of state.listeners.unhandledrejection) fn({ reason });
        if (!state.engineStarted) send({ type: 'HOST_FATAL', error: String(reason && reason.stack || reason) });
    });
    // Whether Node's permission model confines this process (R-10); the parent refuses to
    // hand it a document otherwise.
    send({ type: 'HOST_READY', hostContract: MCP_HOST_CONTRACT, sandboxed: typeof process.permission === 'object' && process.permission !== null && !process.permission.has('fs.read', require('os').homedir()) });
}

/** Run a task of host/js-worker.js in a heap-limited worker thread; its out-of-memory error keeps its code. */
function inWorker(task, data) {
    return new Promise((resolve, reject) => {
        const w = new Worker(JS_WORKER, { workerData: { task, root: state.root, languages: state.languages, debugLog: state.debugLog, data },
            resourceLimits: { maxOldGenerationSizeMb: state.jsHeapMiB }, stdout: true });
        let done = false;
        w.once('message', (m) => { done = true; if (m.error) reject(new Error(m.error)); else resolve(m.result); });
        w.once('error', (e) => { if (!done) { done = true; reject(e); } });
        w.once('exit', (code) => { if (!done) { done = true; reject(new Error(`the analysis worker stopped (exit ${code})`)); } });
    });
}
const asBuffer = (b) => (b && !Buffer.isBuffer(b) && ArrayBuffer.isView(b) ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : b);

async function runAnalysis(msg) {
    try {
        const result = await inWorker('analyze', {
            bytes: msg.bytes, fileName: msg.fileName, targetFormat: msg.targetFormat,
            formatMap: msg.formatMap, pdfInputKind: msg.pdfInputKind, csvSourceEncoding: msg.csvSourceEncoding,
            userFonts: Array.isArray(msg.userFonts) ? msg.userFonts : null,
        });
        if (result && result.bytes) result.bytes = asBuffer(result.bytes);
        send({ type: 'ANALYSIS', result });
    } catch (e) {
        if (e && e.code === 'ERR_WORKER_OUT_OF_MEMORY') return send({ type: 'ANALYSIS', result: { ok: false, error: { code: 'OUT_OF_MEMORY', message: OUT_OF_MEMORY_MESSAGE } } });
        send({ type: 'HOST_FATAL', error: 'analysis failed: ' + String(e && e.stack || e) });
    }
}

function engineStart({ module, wasmFile, wasmSha256 }) {
    // The website's helpers never load on this thread (they run in workers), so the served worker starts from the
    // scope it has on the website.

    const workerFile = path.join(state.root, 'modules', module, 'conversion_worker.js');
    state.fetchBase = path.dirname(workerFile);
    const search = '?module=' + encodeURIComponent(module);
    // The worker finds its directory by cutting location.href at the last "/",
    // so it must see forward slashes on Windows too (Node accepts them there).
    const href = toForwardSlashes(workerFile);
    globalThis.location = { href: href + search, search, pathname: href };

    // While CONVERT_DONE waits for its sanitising worker, the worker's later messages wait behind it: the parent sees them
    // in the order they were posted (WAF review of #223).
    let queue = null;
    globalThis.postMessage = (m) => {
        if (queue) { queue = queue.then(() => send(m)); return; }
        if (m && m.type === 'CONVERT_DONE' && state.countUnsafe) {
            queue = inWorker('sanitizeHtml', { bytes: m.outputData }).then(
                (r) => send({ ...m, unsafeLinksKept: { removed: r.removed } }),
                (e) => send({ ...m, unsafeLinksKept: { failed: true } }));
            return;
        }
        if (m && m.type === 'CONVERT_DONE' && state.sanitize) {
            queue = inWorker('sanitizeHtml', { bytes: m.outputData }).then(
                (r) => send({ ...m, outputData: asBuffer(r.bytes), sanitized: { removed: r.removed, message: r.message } }),
                // Ship the converted output (as the website does), but never silently.
                (e) => send({ ...m, sanitized: { failed: true, error: e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'it needed more memory than the converter allows' : String(e && e.message || e) } }));
            return;
        }
        send(m);
    };
    globalThis.importScripts = (...urls) => {
        for (const u of urls) {
            const p = resolveLocal(u);
            vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
        }
    };
    globalThis.XMLHttpRequest = class XMLHttpRequest {
        constructor() { this.readyState = 0; this.status = 0; this.responseType = ''; this.response = null; this.responseText = ''; }
        open(method, url, async = true) { this._url = url; this._async = async !== false; this.readyState = 1; }
        overrideMimeType() {}
        setRequestHeader() {}
        send() {
            const done = () => {
                let buf = null;
                try { buf = readLocal(this._url); } catch (e) { console.error(e.message); }
                this.readyState = 4;
                this.responseURL = this._url;
                if (buf) {
                    this.status = 200;
                    if (this.responseType === 'arraybuffer') this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
                    else { this.responseText = buf.toString('utf8'); this.response = this.responseText; }
                } else {
                    this.status = 404;
                }
                if (this.onreadystatechange) this.onreadystatechange();
                const cb = buf ? this.onload : this.onerror;
                if (cb) cb.call(this, {});
            };
            if (this._async) setImmediate(done); else done();
        }
    };

    // The verified engine binary, re-hashed at load and handed to the worker in INIT.
    const wasm = fs.readFileSync(resolveLocal(path.join(state.root, wasmFile)));
    if (crypto.createHash('sha256').update(wasm).digest('hex') !== wasmSha256) {
        throw new Error(`engine binary ${wasmFile} does not match its signed hash`);
    }
    state.wasmBinary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length);

    state.engineStarted = true;
    vm.runInThisContext(fs.readFileSync(workerFile, 'utf8'), { filename: workerFile });
    send({ type: 'ENGINE_LOADED' });
}
