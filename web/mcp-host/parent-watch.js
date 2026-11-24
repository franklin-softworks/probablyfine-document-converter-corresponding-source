// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.
'use strict';
// BUG-75 (WAF review of #226): a child that holds a document never outlives the server, even when its main thread is
// stuck in a long synchronous call that reports nothing (the server's stall and deadline timers are gone with it). A
// watchdog worker thread runs beside that call: once a second it compares the parent pid with the one at start, and when
// the parent is gone it ends the process with SIGKILL (which writes no core file). The worker never keeps the process
// alive. Needs --allow-worker (granted to these children).

const { Worker } = require('worker_threads');

const WATCHDOG = `
const { workerData } = require('worker_threads');
setInterval(() => { if (process.ppid !== workerData.parent) process.kill(process.pid, 'SIGKILL'); }, workerData.everyMs);`;

/**
 * Start the watchdog for this process; returns the worker (unref'd). `parent`: the parent pid the caller recorded at its
 * own start, so a server that dies before the watchdog starts is still seen as gone.
 */
function watchParent({ parent = process.ppid, everyMs = 1000 } = {}) {
    const w = new Worker(WATCHDOG, { eval: true, workerData: { parent, everyMs }, stdout: true, stderr: true });
    w.unref();
    return w;
}

module.exports = { watchParent };
