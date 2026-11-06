// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2025-2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

/*
 * wasm_bridge.cpp
 *
 * Bridge code between JavaScript and LibreOfficeKit (LOK) for WebAssembly.
 * Exports C-style functions that can be called via Module.cwrap / Module.ccall.
 *
 * Error reporting: every exported entry point calls clearLastError() on entry and,
 * on any failure path, sets a categorized last-error (see BridgeErrCat / get_last_error)
 * so JS can surface a specific message instead of a generic failure. LOK error strings
 * are always paired getError()/freeError() via logAndCaptureLokError() (no leaks).
 */

#include <LibreOfficeKit/LibreOfficeKit.hxx>
#include <LibreOfficeKit/LibreOfficeKitEnums.h>
#include <emscripten.h>
#include <iostream>
#include <string>
#include <cstring>
#include <cstdlib>
#include <cctype>
#include <cstdio>
#include <vector>
#include <algorithm>   // std::replace / std::remove (print-area normalisation)
#include <unistd.h>
#include <osl/file.hxx>
#include <osl/file.h>
#include <osl/diagnose.h>
#include <osl/process.h>
#include <rtl/uri.hxx>
#include <rtl/ustring.hxx>
#include "password_policy.h"   // FG-021: engine/bridge/password_policy.h (build.sh copies it beside this file)
#include <vcl/svapp.hxx>   // FG-021: Application::SetDialogCancelMode
#include <sys/stat.h>
#include <malloc.h>  // For mallinfo() heap diagnostics
#include <unordered_set>
#include <array>
#include <map>

// --- UNO model access (spreadsheet print area) -------------------------------
// wasm_bridge.cpp is not an external file: engine/build/build.sh copies it to
// desktop/source/app/wasm_bridge.cxx and it is compiled inside LibreOffice's
// `desktop` module, so it may include desktop internals and the UNO API the
// same way desktop/source/lib/init.cxx does. Executable_soffice_bin.mk gains
// gb_Executable_use_sdk_api / boost_headers / -I desktop/inc for exactly this
// (see engine/patches/*_uno-print-area-model-level.patch).
#include <lib/init.hxx>                                    // desktop/inc/lib/init.hxx (LibLODocument_Impl)
#include <com/sun/star/container/XIndexAccess.hpp>
#include <com/sun/star/container/XNamed.hpp>
#include <com/sun/star/sheet/XCellRangeAddressable.hpp>
#include <com/sun/star/sheet/XPrintAreas.hpp>
#include <com/sun/star/sheet/XSpreadsheet.hpp>
#include <com/sun/star/sheet/XSpreadsheetDocument.hpp>
#include <com/sun/star/sheet/XSpreadsheets.hpp>
#include <com/sun/star/sheet/XSheetCellCursor.hpp>
#include <com/sun/star/sheet/XUsedAreaCursor.hpp>
#include <com/sun/star/beans/XPropertySet.hpp>
#include <com/sun/star/table/XColumnRowRange.hpp>
#include <com/sun/star/table/CellRangeAddress.hpp>
#include <com/sun/star/table/XCellRange.hpp>
#include <com/sun/star/uno/Any.hxx>
#include <com/sun/star/uno/Exception.hpp>
#include <com/sun/star/uno/Reference.hxx>
#include <com/sun/star/uno/Sequence.hxx>

using namespace lok;

// LibreOffice document type constants (from LibreOfficeKitEnums.h)
#define LOK_DOCTYPE_TEXT         0
#define LOK_DOCTYPE_SPREADSHEET  1
#define LOK_DOCTYPE_PRESENTATION 2
#define LOK_DOCTYPE_DRAWING      3
#define LOK_DOCTYPE_OTHER        4

// ============================================================================
// Progress Reporting via EM_JS
// ============================================================================
// This function sends progress updates from C++ to JavaScript.
// The JavaScript worker can forward these to the UI.
EM_JS(void, report_conversion_progress, (const char* stage, int percent), {
    // Only report if we're in a worker context with postMessage
    if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
        self.postMessage({
            type: 'CONVERSION_PROGRESS',
            stage: UTF8ToString(stage),
            percent: percent
        });
    }
    // Also log to console for debugging
    console.log('[WASM Progress] Stage:', UTF8ToString(stage), 'Percent:', percent);
});

// FG-173: relay the engine's progress. A long PDF export (a large Calc sheet)
// used to report nothing until it returned, and the web driver's 30 s
// no-progress watchdog stopped it. The LOK save path now carries a status
// indicator (engine/patches/*lok-save-progress-indicator-wasm.patch), and LOK's
// LOAD path already had one (framework StatusIndicator -> comphelper), whose
// updates were simply dropped while no office callback was registered. Both
// arrive here, synchronously on the conversion thread, and each becomes a
// CONVERSION_PROGRESS message, which resets the watchdog.
//
// Which one is which is decided by g_inSave, set around every saveAs() by
// SaveProgressScope (Fable review): save progress is EXPORTING 60-90, anything
// else (import) is LOADING 15-45, so the stage text is truthful, the bar moves
// forward (LOADED is 50), and gate large_export_progress counts real export
// progress only. A long import now shows liveness too.
static bool g_inSave = false;
static void engine_phase_save_begin();
static void engine_phase_save_end();
struct SaveProgressScope {
    SaveProgressScope() { g_inSave = true; engine_phase_save_begin(); }
    ~SaveProgressScope() { g_inSave = false; engine_phase_save_end(); }
    SaveProgressScope(const SaveProgressScope&) = delete;
    SaveProgressScope& operator=(const SaveProgressScope&) = delete;
};

// ============================================================================
// BUG-38: engine progress POSITION
// ============================================================================
// A CONVERSION_PROGRESS percent is an integer in a 30-point band, so a long
// import or layout that really is advancing repeats the same percent for
// minutes. These messages add `phase` ("import" | "layout" | "export") and a
// monotonic `position` that only grows when the engine does first-time work:
//   import  paragraphs + shapes parsed (OOXML import hooks)
//   layout  highest page reached + distinct anchored objects attached to frames
//           (frame creation) + distinct anchored objects formatted, each at
//           least once and keyed by their SwFrameFormat (a loop over the same
//           page and objects does not advance it)
//   export  the export's own status-indicator percent
// The driver extends the size deadline only while (phase, position) advances
// (owner decision 2026-10-23). Two kinds of positioned message, both at most
// kPositionMinIntervalMs apart:
//   - an ADVANCE: position strictly greater than the last one posted for its
//     phase. It resets the no-progress watchdog and may extend the deadline;
//   - LIVENESS (layout only): the same position again, while layout keeps
//     re-formatting objects it has already counted (convergence passes). It
//     resets the watchdog only; it can never extend the deadline, so a layout
//     that loops is still stopped at the deadline + 30 s, or at the cap.
// Every message is caused by engine work; the clock only thins them out, it
// never produces one. Additive fields: a host that ignores them behaves as before.
EM_JS(void, report_engine_position, (const char* stage, int percent, const char* phase, double position, int log), {
    if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
        self.postMessage({
            type: 'CONVERSION_PROGRESS',
            stage: UTF8ToString(stage),
            percent: percent,
            phase: UTF8ToString(phase),
            position: position
        });
    }
    // Import/layout ticks are frequent and not logged; export keeps the line
    // report_conversion_progress() writes (gate large_export_progress reads it).
    if (log) console.log('[WASM Progress] Stage:', UTF8ToString(stage), 'Percent:', percent);
});

static long long g_importPos = 0;
static std::unordered_set<const void*> g_layoutSeen;
static std::unordered_set<const void*> g_appendSeen;   // attached to frames at least once
static int g_layoutPage = 0;
static long long g_layoutCalls = 0;
static constexpr double kPositionMinIntervalMs = 250.0;   // at most 4 positioned messages a second
static long long g_lastPostedImport = -1, g_lastPostedLayout = -1;
static double g_lastPostTime = 0;
static long long g_layoutRepeatCalls = 0;
static int g_lastExportPct = -1;
static int g_lastPercent = 0;
static double g_tLoadBegin = 0, g_tFirstLayout = 0, g_tLoaded = 0, g_tSaveBegin = 0, g_tSaveEnd = 0;
// Diagnostic counters (lo_wasm_counter_add): only a local instrumentation patch calls it;
// shipped builds never do, so nothing is counted or printed there.
static constexpr int kCounterKinds = 32;
static long long g_counters[kCounterKinds] = {};
static std::map<int, std::array<long long, 3>> g_pageCounters;   // kinds 0-2 per page

static void post_now(const char* phase, long long pos, int bandLo, int bandSpan, double half);
static void post_position(const char* phase, long long pos, int bandLo, int bandSpan, double half) {
    if (g_tLoadBegin <= 0)
        return;                                   // not converting (engine start, preload)
    long long& last = (phase[0] == 'i') ? g_lastPostedImport : g_lastPostedLayout;
    if (pos <= last)
        return;                                   // strictly advancing, per phase
    const double now = emscripten_get_now();
    if (now - g_lastPostTime < kPositionMinIntervalMs)
        return;                                   // rate bound; a later advance carries it
    last = pos;
    g_lastPostTime = now;
    post_now(phase, pos, bandLo, bandSpan, half);
}

static void post_now(const char* phase, long long pos, int bandLo, int bandSpan, double half) {
    // Percent rises toward the top of the band and never falls back.
    int pct = bandLo + static_cast<int>(bandSpan * (static_cast<double>(pos) / (pos + half)));
    if (pct < g_lastPercent) pct = g_lastPercent;
    g_lastPercent = pct;
    report_engine_position(g_inSave ? "EXPORTING" : "LOADING", pct, phase, static_cast<double>(pos), 0);
}

// Called at the start of each conversion (next to its LOADING 0 report).
static void engine_progress_begin() {
    g_importPos = 0;
    g_layoutSeen.clear();
    g_appendSeen.clear();
    g_layoutPage = 0;
    g_layoutCalls = 0;
    g_lastPostedImport = g_lastPostedLayout = -1;
    g_lastPostTime = 0;
    g_layoutRepeatCalls = 0;
    g_lastExportPct = -1;
    g_lastPercent = 0;
    g_tLoadBegin = emscripten_get_now();
    g_tFirstLayout = g_tLoaded = g_tSaveBegin = g_tSaveEnd = 0;
    std::fill(std::begin(g_counters), std::end(g_counters), 0);
    g_pageCounters.clear();
}

static void dump_counters(const char* when) {
    bool any = false;
    for (long long n : g_counters) any = any || n != 0;
    if (!any)
        return;
    std::cerr << "[COUNTERS] " << when;
    for (int k = 0; k < kCounterKinds; ++k)
        if (g_counters[k]) std::cerr << " k" << k << "=" << g_counters[k];
    std::cerr << std::endl;
    // The 10 pages with the most FormatContent calls (kind 2): visits, FormatObjsAtFrame, FormatContent.
    std::vector<std::pair<int, std::array<long long, 3>>> v(g_pageCounters.begin(), g_pageCounters.end());
    std::sort(v.begin(), v.end(), [](const auto& a, const auto& b) { return a.second[2] > b.second[2]; });
    for (size_t i = 0; i < v.size() && i < 10; ++i)
        std::cerr << "[COUNTERS] page=" << v[i].first << " visits=" << v[i].second[0]
                  << " formatobjsatframe=" << v[i].second[1] << " formatcontent=" << v[i].second[2] << std::endl;
    std::cerr << std::flush;
}

// Called when documentLoad() returns (import and initial layout are done).
static void engine_progress_loaded() {
    g_tLoaded = emscripten_get_now();
    dump_counters("after load (import + layout)");
    g_lastPercent = std::max(g_lastPercent, 50);   // the LOADED report that follows
}

static void engine_phase_save_begin() {
    g_tSaveBegin = emscripten_get_now();
    g_lastPercent = std::max(g_lastPercent, 60);   // EXPORTING starts at 60
}

static void engine_phase_save_end() {
    g_tSaveEnd = emscripten_get_now();
    if (g_tLoadBegin <= 0)
        return;
    const double tLoaded = g_tLoaded > 0 ? g_tLoaded : g_tSaveBegin;
    const double tImportEnd = g_tFirstLayout > 0 && g_tFirstLayout < tLoaded ? g_tFirstLayout : tLoaded;
    struct mallinfo mi = mallinfo();
    std::cerr << "[PHASE] import_ms=" << static_cast<long long>(tImportEnd - g_tLoadBegin)
              << " layout_ms=" << static_cast<long long>(tLoaded - tImportEnd)
              << " export_ms=" << static_cast<long long>(g_tSaveEnd - g_tSaveBegin)
              << " import_pos=" << g_importPos
              << " layout_pages=" << g_layoutPage
              << " layout_objects=" << g_layoutSeen.size()
              << " attached_objects=" << g_appendSeen.size()
              << " formatobj_calls=" << g_layoutCalls
              << " heap_mb=" << (mi.arena / 1024 / 1024) << std::endl;
    dump_counters("after export (cumulative)");
    std::cerr << std::flush;
    g_tLoadBegin = 0;
}

// Layout re-formatting objects it has already counted: the SAME position, for the
// watchdog only. The clock is read at most every 64 such calls.
static void layout_liveness() {
    if (g_tLoadBegin <= 0 || g_lastPostedLayout < 0 || (++g_layoutRepeatCalls & 63) != 0)
        return;
    const double now = emscripten_get_now();
    if (now - g_lastPostTime < kPositionMinIntervalMs)
        return;
    g_lastPostTime = now;
    // An advance the 250 ms floor held back goes out now, as the advance it is.
    const long long cur = g_layoutPage + static_cast<long long>(g_layoutSeen.size() + g_appendSeen.size());
    if (cur > g_lastPostedLayout)
        g_lastPostedLayout = cur;
    post_now("layout", g_lastPostedLayout, 45, 4, 2000.0);
}

extern "C" {
// Strong definitions of the weak hooks in sw (objectformatter.cxx, layact.cxx,
// OOXMLDocumentImpl.cxx, OOXMLFastContextHandler.cxx).
EMSCRIPTEN_KEEPALIVE void lo_wasm_progress_import_tick() {
    if ((++g_importPos & 15) == 0)              // the clock is read at most every 16 ticks
        post_position("import", g_importPos, 15, 29, 5000.0);
}

EMSCRIPTEN_KEEPALIVE void lo_wasm_progress_layout_object(const void* pKey) {
    if (g_tFirstLayout <= 0 && g_tLoadBegin > 0)
        g_tFirstLayout = emscripten_get_now();
    ++g_layoutCalls;
    if (pKey && g_layoutSeen.insert(pKey).second) {
        if ((g_layoutSeen.size() & 7) == 0)
            post_position("layout", g_layoutPage + static_cast<long long>(g_layoutSeen.size() + g_appendSeen.size()), 45, 4, 2000.0);
        return;
    }
    layout_liveness();
}

EMSCRIPTEN_KEEPALIVE void lo_wasm_progress_layout_append(const void* pKey) {
    if (g_tFirstLayout <= 0 && g_tLoadBegin > 0)
        g_tFirstLayout = emscripten_get_now();
    if (pKey && g_appendSeen.insert(pKey).second && (g_appendSeen.size() & 7) == 0)
        post_position("layout", g_layoutPage + static_cast<long long>(g_layoutSeen.size() + g_appendSeen.size()), 45, 4, 2000.0);
}

EMSCRIPTEN_KEEPALIVE void lo_wasm_progress_layout_page(int nPage) {
    if (g_tFirstLayout <= 0 && g_tLoadBegin > 0)
        g_tFirstLayout = emscripten_get_now();
    if (nPage > g_layoutPage) {
        g_layoutPage = nPage;
        post_position("layout", g_layoutPage + static_cast<long long>(g_layoutSeen.size() + g_appendSeen.size()), 45, 4, 2000.0);
        return;
    }
    layout_liveness();
}

EMSCRIPTEN_KEEPALIVE void lo_wasm_counter_add(int nKind, int nPage, long long n) {
    if (nKind < 0 || nKind >= kCounterKinds)
        return;
    g_counters[nKind] += n;
    if (nKind <= 2 && nPage > 0)
        g_pageCounters[nPage][nKind] += n;
}
}

// ============================================================================
// FG-021: conversion secrets (passwords) and the document-password callback
// ============================================================================
// set_conversion_secrets() stores them just before one convert_* call. They are
// wiped by clear_conversion_secrets() (the worker's finally) and again when that
// convert_* call returns (ConversionSecretsScope). They are never printed: every
// options string that can carry one is logged through redactOptions().
// "Wiped" means the bridge's own copy (g_secrets). Other copies exist and are NOT wiped: the export
// options string built for one convert_* call, LibreOffice's own copies (the load's filePassword,
// the save MediaDescriptor, LOKInteractionHandler::m_Password). They go away with the engine, which is
// why a worker that carried a password is always ended (plan section 6, item 5).
// Design: plans/fg-021-bug-36-password-and-calc-notes.md section 4.
extern "C" { extern Office* g_pOffice; }

struct ConversionSecrets {
    std::string inputPassword;        // opens the input (answered to LOK_CALLBACK_DOCUMENT_PASSWORD)
    std::string openPassword;         // protects the output (PDF open password, ODF/OOXML password)
    std::string permissionPassword;   // PDF only: restricts permissions
    int printing = -1;                // PDF Printing 0..2, -1 = no restriction
    int changes = -1;                 // PDF Changes 0..4, -1 = no restriction
    int copying = -1;                 // PDF EnableCopyingOfContent 0/1, -1 = no restriction
};
static ConversionSecrets g_secrets;
static bool g_calcIncludeCellComments = false;   // BUG-36: Calc PDF ExportNotes, off by default

static void wipeString(std::string& s) {
    if (!s.empty()) {
        volatile char* p = &s[0];
        for (size_t i = 0; i < s.size(); ++i) p[i] = 0;
    }
    s.clear();
    s.shrink_to_fit();
}

static void wipeSecrets() {
    wipeString(g_secrets.inputPassword);
    wipeString(g_secrets.openPassword);
    wipeString(g_secrets.permissionPassword);
    g_secrets.printing = g_secrets.changes = g_secrets.copying = -1;
}

// Every convert_* entry point holds one: the secrets and the Calc PDF option
// apply to exactly one conversion, on every return path.
struct ConversionSecretsScope {
    ~ConversionSecretsScope() {
        wipeSecrets();
        g_calcIncludeCellComments = false;
    }
};

// The key lo_documentLoadWithOptions puts in mInteractionMap for the current
// load, computed exactly as it does (getAbsoluteURL, init.cxx), so that
// lo_setDocumentPassword always finds its entry: a missing key dereferences
// end() in a release build.
static std::string g_loadKey;
static std::string g_stagedName;        // the staged input's file name, stored when the load began (password_policy.h)
static std::string g_loadLokError;      // LOK's error text for the load that just ended (see LoadWindow)
static bool g_loadInProgress = false;   // true only inside loadDocument()'s documentLoad call
static int g_pwRequests = 0;            // LOK_CALLBACK_DOCUMENT_PASSWORD calls during this load
static bool g_pwPayloadMismatch = false;
// FG-021: whether the engine may ask for, and be given, a document password. Off unless the host
// switched it on (INIT.allowDocumentPasswords; the worker sets LO_WASM_ALLOW_DOCUMENT_PASSWORDS=1 in
// the engine's environment before init_office). Off means exactly what it meant before this feature:
// LibreOffice's password request is aborted by LOK itself (the optional feature is not enabled), an
// encrypted input fails to load, and the load options are not touched.
static bool g_passwordsAllowed = false;

static std::string interactionKeyFor(const std::string& url) {
    OUString aURL(url.c_str(), static_cast<sal_Int32>(url.size()), RTL_TEXTENCODING_UTF8);
    if (aURL.isEmpty())
        return std::string();
    OUString aWorkingDir;
    osl_getProcessWorkingDir(&aWorkingDir.pData);
    if (!aWorkingDir.endsWith("/"))
        aWorkingDir += "/";
    try {
        aURL = rtl::Uri::convertRelToAbs(aWorkingDir, aURL);
    } catch (const rtl::MalformedUriException&) {
        return std::string();
    }
    OString key = OUStringToOString(aURL, RTL_TEXTENCODING_UTF8);
    return std::string(key.getStr(), key.getLength());
}

// Every documentLoad of a file goes through here, so the password callback
// always knows the key and the staged name of the load it belongs to, and knows
// when no load is in progress.
static lok::Document* loadDocument(const std::string& fileUrl, const char* filterOptions,
                                   const std::string& inputPath) {
    g_loadKey = interactionKeyFor(fileUrl);
    g_stagedName = pwpolicy::stagedBaseName(inputPath);
    if (!pwpolicy::isSafeStagedName(g_stagedName)) {
        // The worker sanitises every staged name; if one ever is not safe, only the
        // full key is accepted (password_policy.h rule 2).
        std::cerr << "[BRIDGE] Staged file name is outside [A-Za-z0-9._-]; only the full load URL "
                     "will be accepted for a password request" << std::endl << std::flush;
    }
    g_pwRequests = 0;
    g_pwPayloadMismatch = false;
    unsetenv("LO_WASM_PACKAGE_REFUSAL");   // a refusal from an earlier load must not colour this one
    std::string options = filterOptions ? filterOptions : "";
    // "Batch" (the presentations loads) also passes Silent=true to the loader, and
    // a silent load replaces our interaction handler with a QuietInteraction that
    // aborts every request, the password request included (framework loadenv.cxx;
    // measured: encrypted PPTX gave no callback, "type detection aborted"). While
    // document passwords are allowed, keep Batch's other effect, the silent dialog
    // mode, and drop the token, WITH OR WITHOUT a password: with none, the request
    // then reaches the bridge, which refuses it, and the failure is classified
    // PASSWORD_REQUIRED (it used to be a plain LOAD_FAILED, and the MCP has no
    // detection of its own). With passwords off the options are left exactly as
    // before. Only for a named filter: the CSV options are not touched.
    static const std::string kBatch = "Batch=true,";
    if (g_passwordsAllowed && options.rfind(kBatch + "FilterName=", 0) == 0) {
        Application::SetDialogCancelMode(DialogCancelMode::LOKSilent);
        options.erase(0, kBatch.size());
    }
    // The load window: the callback gives a password only inside it, and the key and
    // name are dropped as soon as it closes (also if documentLoad throws).
    // The optional feature is on ONLY inside the window (and only if the host switched passwords on):
    // with it on, LOKInteractionHandler fires the callback and then blocks until setDocumentPassword,
    // which nothing can answer for a request raised by another handler (a save, a linked document)
    // outside our load. Off, such a request is aborted as before.
    struct LoadWindow {
        LoadWindow() {
            g_loadInProgress = true;
            g_loadLokError.clear();
            if (g_passwordsAllowed && g_pOffice) g_pOffice->setOptionalFeatures(LOK_FEATURE_DOCUMENT_PASSWORD);
        }
        ~LoadWindow() {
            if (g_passwordsAllowed && g_pOffice) {
                // lo_setOptionalFeatures clears LOK's stored error (SetLastExceptionMsg), and that text
                // (the package layer's message, "returned an empty reference") is what the host sees:
                // take it first.
                char* pErr = g_pOffice->getError();
                if (pErr && pErr[0]) g_loadLokError = pErr;
                if (pErr) g_pOffice->freeError(pErr);
                g_pOffice->setOptionalFeatures(0);
            }
            g_loadInProgress = false; g_loadKey.clear(); g_stagedName.clear();
        }
    } window;
    if (!options.empty())
        return g_pOffice->documentLoad(fileUrl.c_str(), options.c_str());
    return g_pOffice->documentLoad(fileUrl.c_str());
}

// LOK_CALLBACK_DOCUMENT_PASSWORD, answered synchronously and ALWAYS answered while a
// load is in progress. The handler waits on m_havePassword after the callback returns
// (lokinteractionhandler.cxx); an answer given here has already set it, so the wait
// returns at once. With no answer the wait busy-spins (no pthreads). A nullptr answer
// aborts the load. The decision is pwpolicy::decide (password_policy.h): exact equality
// of the payload with the load key or the stored staged name, first request only. The
// answer always names the bridge's own load key, never the payload.
static void answerDocumentPassword(const char* pPayload) {
    if (!g_loadInProgress) {
        // A password request outside a load (a save handler, a late callback). The bridge
        // has no key to abort it with: an answer naming the payload could only be a key
        // it did not issue. Say so loudly; a spin then shows in the log, not as a mystery.
        std::cerr << "[BRIDGE] ERROR: document password requested with no load in progress "
                     "(not answered; nothing is given)" << std::endl << std::flush;
        return;
    }
    ++g_pwRequests;
    const pwpolicy::Decision d = pwpolicy::decide(true, g_pwRequests, !g_secrets.inputPassword.empty(),
                                                  g_loadKey, g_stagedName, pPayload);
    if (d.mismatch)
        g_pwPayloadMismatch = true;
    std::cerr << "[BRIDGE] Document password requested (request " << g_pwRequests
              << "; payload form=" << pwpolicy::formName(d.form) << "; "
              << (d.givePassword ? "answering with the input password" : "aborting the load") << ")"
              << std::endl << std::flush;
    if (g_loadKey.empty()) {
        std::cerr << "[BRIDGE] ERROR: no load key for this load; the request cannot be answered"
                  << std::endl << std::flush;
        return;
    }
    if (g_pOffice)
        g_pOffice->setDocumentPassword(g_loadKey.c_str(), d.givePassword ? g_secrets.inputPassword.c_str() : nullptr);
}

static void bridge_office_callback(int nType, const char* pPayload, void* /*pData*/) {
    if (nType == LOK_CALLBACK_DOCUMENT_PASSWORD) {
        answerDocumentPassword(pPayload);
    } else if (nType == LOK_CALLBACK_STATUS_INDICATOR_SET_VALUE && pPayload) {
        int pct = std::atoi(pPayload);
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        if (g_inSave && pct > g_lastExportPct) {
            // BUG-38: an advancing export percent carries its position (at most 101 per export).
            g_lastExportPct = pct;
            const int ui = std::max(60 + (pct * 30) / 100, g_lastPercent);
            g_lastPercent = ui;
            report_engine_position("EXPORTING", ui, "export", pct, 1);
        }
        else if (g_inSave) report_conversion_progress("EXPORTING", 60 + (pct * 30) / 100);   // as before
        else          report_conversion_progress("LOADING", 15 + (pct * 30) / 100);
    } else if (nType == LOK_CALLBACK_STATUS_INDICATOR_START) {
        report_conversion_progress(g_inSave ? "EXPORTING" : "LOADING", g_inSave ? 60 : 15);
    } else if (nType == LOK_CALLBACK_ERROR && pPayload) {
        // Delivered only since the office callback exists (I/O and network
        // errors from LOKInteractionHandler). Never silent: log it.
        std::cerr << "[BRIDGE] LOK error callback: " << pPayload << std::endl << std::flush;
    }
}

// ============================================================================
// Heap Memory Diagnostics
// ============================================================================
// Log heap fragmentation stats after each conversion to diagnose stalls.
// Expert analysis suggests heap fragmentation (not leaks) causes sequential stalls.
static int g_conversionCount = 0;

static void log_heap_stats(const char* label) {
#ifdef __EMSCRIPTEN__
    struct mallinfo mi = mallinfo();
    g_conversionCount++;
    std::cerr << "[MEM] " << label << " (conversion #" << g_conversionCount << ")" << std::endl;
    std::cerr << "[MEM]   arena:    " << (mi.arena / 1024 / 1024) << " MB (total heap size)" << std::endl;
    std::cerr << "[MEM]   uordblks: " << (mi.uordblks / 1024 / 1024) << " MB (used)" << std::endl;
    std::cerr << "[MEM]   fordblks: " << (mi.fordblks / 1024 / 1024) << " MB (free)" << std::endl;
    std::cerr << "[MEM]   ordblks:  " << mi.ordblks << " (free chunks - high = fragmented)" << std::endl;
    std::cerr << std::flush;
#endif
}

// ============================================================================
// Formula-to-Value Conversion Helper
// ============================================================================
// This function converts all formulas in a spreadsheet to their cached values.
// This prevents formula evaluation errors during PDF export, especially for
// formulas that reference external add-ins not available in WASM.
//
// The approach uses UNO commands to:
// 1. Iterate through each sheet
// 2. Select all cells
// 3. Copy to internal clipboard
// 4. Paste as values only (Paste Special > Values)
//
// This is equivalent to the user manually doing Edit > Paste Special > Values Only
// on each sheet.

/**
 * Convert all formulas to their cached values in a spreadsheet document.
 * This prevents add-in formula errors during PDF export.
 *
 * @param pDoc - Loaded LibreOffice document (must be a spreadsheet)
 * @return true on success, false on failure
 */
static bool convert_formulas_to_values(lok::Document* pDoc) {
    if (!pDoc) {
        std::cerr << "[FORMULA] Error: null document pointer" << std::endl << std::flush;
        return false;
    }

    // Verify this is a spreadsheet
    int docType = pDoc->getDocumentType();
    if (docType != LOK_DOCTYPE_SPREADSHEET) {
        std::cerr << "[FORMULA] Not a spreadsheet (type=" << docType << "), skipping formula conversion" << std::endl << std::flush;
        return true;  // Not an error, just not applicable
    }

    std::cerr << "[FORMULA] ========================================" << std::endl << std::flush;
    std::cerr << "[FORMULA] Starting formula-to-value conversion" << std::endl << std::flush;

    // Get the number of sheets
    int numSheets = pDoc->getParts();
    std::cerr << "[FORMULA] Document has " << numSheets << " sheet(s)" << std::endl << std::flush;

    // Process each sheet
    for (int sheetIndex = 0; sheetIndex < numSheets; sheetIndex++) {
        std::cerr << "[FORMULA] Processing sheet " << (sheetIndex + 1) << " of " << numSheets << std::endl << std::flush;

        // Switch to this sheet
        pDoc->setPart(sheetIndex);

        // Step 1: Select all cells on this sheet
        // Using .uno:SelectAll command
        std::cerr << "[FORMULA] Step 1: SelectAll" << std::endl << std::flush;
        pDoc->postUnoCommand(".uno:SelectAll", nullptr, false);

        // Step 2: Copy selection to clipboard
        std::cerr << "[FORMULA] Step 2: Copy" << std::endl << std::flush;
        pDoc->postUnoCommand(".uno:Copy", nullptr, false);

        // Step 3: Paste as values only (Paste Special with Flags=V)
        // The Flags parameter specifies what to paste:
        //   V = Values only (no formulas)
        //   T = Text
        //   D = Date/Time
        //   F = Formulas
        //   N = Number formats
        //   A = All (default)
        // Additional options:
        //   SkipEmptyCells = true to not overwrite non-empty cells with empty ones
        //   Transpose = false
        //   AsLink = false
        //   MoveMode = 0 (normal)
        std::cerr << "[FORMULA] Step 3: InsertContents (Values only)" << std::endl << std::flush;

        // JSON arguments for .uno:InsertContents
        // Flags "V" = paste values only, SkipEmptyCells=true preserves structure
        const char* pasteArgs = "{"
            "\"Flags\":{\"type\":\"string\",\"value\":\"V\"},"
            "\"FormulaCommand\":{\"type\":\"long\",\"value\":0},"
            "\"SkipEmptyCells\":{\"type\":\"boolean\",\"value\":false},"
            "\"Transpose\":{\"type\":\"boolean\",\"value\":false},"
            "\"AsLink\":{\"type\":\"boolean\",\"value\":false},"
            "\"MoveMode\":{\"type\":\"long\",\"value\":0}"
            "}";

        pDoc->postUnoCommand(".uno:InsertContents", pasteArgs, false);

        // Step 4: Deselect to clean up
        std::cerr << "[FORMULA] Step 4: Deselect" << std::endl << std::flush;
        pDoc->postUnoCommand(".uno:Deselect", nullptr, false);

        std::cerr << "[FORMULA] Sheet " << (sheetIndex + 1) << " processed" << std::endl << std::flush;
    }

    // Return to first sheet
    if (numSheets > 0) {
        pDoc->setPart(0);
    }

    std::cerr << "[FORMULA] Formula-to-value conversion complete" << std::endl << std::flush;
    std::cerr << "[FORMULA] ========================================" << std::endl << std::flush;

    return true;
}

// ============================================================================
// Bridge helpers (anonymous namespace — internal linkage)
// ============================================================================
// These helpers back the WP5 hardening work: a single import-filter table
// (M15), safe file:// URL construction (H1), categorized error propagation
// (H9/H11), input validation (M14) and JSON escaping (M12). They live above the
// extern "C" block so every exported entry point can share them.

// The global LOK Office instance is defined in the extern "C" block below;
// forward-declare it here so the error helpers can query LOK for detail text.
extern "C" { extern Office* g_pOffice; }

namespace {

// --- M15: extension detection + unified import-filter table -----------------

// Lowercase file extension after the last '.' of the basename (the segment after
// the last '/'). Returns "" when there is no dot or the dot is the final char.
// True suffix semantics: "meeting.docx.txt" -> "txt", not a ".docx" contains-match.
std::string getExtension(const std::string& path) {
    size_t slash = path.find_last_of('/');
    std::string base = (slash == std::string::npos) ? path : path.substr(slash + 1);
    size_t dot = base.find_last_of('.');
    if (dot == std::string::npos || dot + 1 >= base.size()) return "";
    std::string ext = base.substr(dot + 1);
    for (char& c : ext) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return ext;
}

// Single source of truth for LOK import-filter options, keyed on the true file
// suffix. target_format is only consulted for PDF input (mirrors the historical
// convert_document logic). Returns "" to let LOK auto-detect (txt / unknown).
std::string importFilterOptionsForInput(const std::string& input_path, const char* target_format) {
    std::string ext = getExtension(input_path);
    if (ext == "docx") return "FilterName=MS Word 2007 XML";
    if (ext == "doc")  return "FilterName=MS Word 97";
    if (ext == "odt")  return "FilterName=writer8";
    if (ext == "xlsx") return "FilterName=Calc MS Excel 2007 XML";
    if (ext == "xls")  return "FilterName=MS Excel 97";
    if (ext == "ods")  return "FilterName=calc8";
    if (ext == "csv")  return "Batch=true,44,34,UTF-8,1,";
    // FG-172: a .tsv had no entry, so LOK auto-detected its filter, and that
    // route trapped the engine. Name the CSV import with a tab separator.
    if (ext == "tsv")  return "Batch=true,9,34,UTF-8,1,";
    if (ext == "rtf")  return "FilterName=Rich Text Format";
    if (ext == "html" || ext == "htm") return "FilterName=HTML (StarWriter)";
    if (ext == "pptx") return "Batch=true,FilterName=Impress MS PowerPoint 2007 XML";
    if (ext == "pptm") return "Batch=true,FilterName=Impress MS PowerPoint 2007 XML VBA";
    if (ext == "ppt")  return "Batch=true,FilterName=MS PowerPoint 97";
    if (ext == "odp")  return "Batch=true,FilterName=impress8";
    if (ext == "pdf") {
        // PDF import filter depends on the export target (Draw for Calc targets,
        // Writer for document targets, Impress for presentation targets).
        std::string target = target_format ? target_format : "";
        if (target == "xlsx" || target == "xls" || target == "ods" || target == "csv")
            return "FilterName=draw_pdf_import";
        if (target == "docx" || target == "doc" || target == "odt" || target == "rtf")
            return "FilterName=writer_pdf_import";
        if (target == "pptx" || target == "ppt" || target == "odp")
            return "FilterName=impress_pdf_import";
        if (target == "pdf")
            return "FilterName=writer_pdf_import";
        return "";  // auto-detect
    }
    return "";  // txt / unknown -> LOK auto-detect
}

// --- H11 / H9: categorized last-error propagation to JS ---------------------

// Error categories exposed to JS via get_last_error(). Only the category prefix
// is a stable programmatic contract; the message text after the colon is
// human-readable and may change between builds.
enum class BridgeErrCat { None, Init, InputMissing, Load, Export, InvalidParam, Internal,
                          PasswordRequired, PasswordWrong, PasswordUnsupported,
                          EncryptionRefused };   // FG-021

// Bridge-owned last-error string. get_last_error() returns a pointer into this.
// It is process-global; the worker is strictly serial (one CONVERT at a time),
// the same assumption g_pOffice already relies on.
std::string g_lastError;

const char* categoryTag(BridgeErrCat c) {
    switch (c) {
        case BridgeErrCat::Init:         return "INIT_FAILED";
        case BridgeErrCat::InputMissing: return "INPUT_MISSING";
        case BridgeErrCat::Load:         return "LOAD_FAILED";
        case BridgeErrCat::Export:       return "EXPORT_FAILED";
        case BridgeErrCat::InvalidParam: return "INVALID_PARAM";
        case BridgeErrCat::Internal:     return "INTERNAL_ERROR";
        case BridgeErrCat::PasswordRequired:    return "PASSWORD_REQUIRED";
        case BridgeErrCat::PasswordWrong:       return "PASSWORD_WRONG";
        case BridgeErrCat::PasswordUnsupported: return "PASSWORD_UNSUPPORTED";
        case BridgeErrCat::EncryptionRefused:   return "ENCRYPTION_REFUSED";
        case BridgeErrCat::None:
        default:                         return "INTERNAL_ERROR";
    }
}

// Cleared at the entry of every exported conversion/init function so a stale
// error from a previous call can never be reported for a fresh one.
void clearLastError() { g_lastError.clear(); }

void setLastError(BridgeErrCat cat, const std::string& msg) {
    g_lastError = std::string(categoryTag(cat)) + ": " + msg;
    std::cerr << "[BRIDGE] " << g_lastError << std::endl << std::flush;
}

// H9 + H11 in one place: pairs getError()/freeError() AND captures the text.
// Safe when g_pOffice is null (the LOK detail is simply omitted).
void logAndCaptureLokError(BridgeErrCat cat, const std::string& context) {
    std::string msg = context;
    if (!g_loadLokError.empty()) {
        // the load's own error text, taken before LoadWindow switched the password feature off
        // (lo_setOptionalFeatures clears the stored error)
        msg += " (LOK: " + g_loadLokError + ")";
        g_loadLokError.clear();
    } else if (g_pOffice) {
        char* pErr = g_pOffice->getError();  // char*, not const char* — freeError needs it
        if (pErr && pErr[0]) msg += std::string(" (LOK: ") + pErr + ")";
        if (pErr) g_pOffice->freeError(pErr);
    }
    setLastError(cat, msg);
}

// FG-021: a null documentLoad, categorised by what the password callback saw
// during that load. No request: the existing Load error. A request whose payload
// was not the load URL: PasswordUnsupported (the password could not be given).
// Otherwise PasswordRequired without an input password, PasswordWrong with one.
void reportLoadFailure() {
    BridgeErrCat cat = BridgeErrCat::Load;
    std::string msg = "Failed to load document";
    // The package layer reports every failed encrypted read as a wrong password. When it refused the
    // file's own encryption parameters (package-refusal-reason-wasm.patch) it leaves the reason in the
    // environment; that is not a password problem and no password can help.
    const char* refusal = getenv("LO_WASM_PACKAGE_REFUSAL");
    if (refusal && (strncmp(refusal, "pbkdf2-iteration-count=", 23) == 0 || strncmp(refusal, "derived-key-size=", 17) == 0)) {
        cat = BridgeErrCat::EncryptionRefused;
        const bool isCount = refusal[0] == 'p';
        const std::string n = refusal + (isCount ? 23 : 17);
        msg = "The document's encryption settings were refused: ";
        if (isCount)
            msg += n == "missing" ? "no key-derivation iteration count is given"
                                  : "it asks for " + n + " key-derivation rounds and this converter accepts 1 to 10000000";
        else
            msg += "it asks for a " + n + "-byte derived key and this converter accepts up to 64";
        unsetenv("LO_WASM_PACKAGE_REFUSAL");
    } else if (g_pwRequests > 0) {
        if (g_pwPayloadMismatch) {
            cat = BridgeErrCat::PasswordUnsupported;
            msg = "The document is password-protected in a way this converter cannot open";
        } else if (g_secrets.inputPassword.empty()) {
            cat = BridgeErrCat::PasswordRequired;
            msg = "The document is password-protected and no password was given";
        } else {
            cat = BridgeErrCat::PasswordWrong;
            msg = "The password did not open the document";
        }
    }
    logAndCaptureLokError(cat, msg);
}

// --- H9: RAII document lifetime --------------------------------------------

// Owns a loaded LOK document: CloseDoc + delete on scope exit. Replaces the
// triplicated manual "postUnoCommand(.uno:CloseDoc); delete pDoc;" cleanup and
// removes the bare delete on the invalid-sheet path.
class ScopedLokDocument {
    lok::Document* m_p;
public:
    explicit ScopedLokDocument(lok::Document* p = nullptr) : m_p(p) {}
    ~ScopedLokDocument() { reset(); }
    void reset(lok::Document* p = nullptr) {
        if (m_p) {
            // The destructor can run during exception unwind; a throwing
            // destructor would call std::terminate, so swallow any CloseDoc
            // exception here (behavior matches the old catch-block cleanup).
            try { m_p->postUnoCommand(".uno:CloseDoc", nullptr, false); } catch (...) {}
            delete m_p;
        }
        m_p = p;
    }
    lok::Document* get() const { return m_p; }
    lok::Document* operator->() const { return m_p; }
    explicit operator bool() const { return m_p != nullptr; }
    ScopedLokDocument(const ScopedLokDocument&) = delete;
    ScopedLokDocument& operator=(const ScopedLokDocument&) = delete;
};

// --- H1: safe file:// URL construction --------------------------------------

// Convert a VFS system path (UTF-8) into a properly percent-encoded file:// URL
// via the canonical OSL API. getFileURLFromSystemPath percent-encodes '%', '#',
// spaces and non-ASCII bytes, so the result is pure ASCII and round-trips back to
// the exact VFS path (Emscripten FS stores UTF-8 names). Returns false and sets
// the last error on failure (e.g. a non-absolute path). This replaces raw
// "file://" + path concatenation, which broke on names like "Résumé.docx",
// "budget 50%.docx" and "notes#1.docx".
bool makeFileUrl(const char* vfs_path, std::string& out_url) {
    OUString path(vfs_path, static_cast<sal_Int32>(strlen(vfs_path)), RTL_TEXTENCODING_UTF8);
    OUString url;
    if (osl::FileBase::getFileURLFromSystemPath(path, url) != osl::FileBase::E_None) {
        setLastError(BridgeErrCat::Internal,
                     std::string("Cannot build file URL for path: ") + vfs_path);
        return false;
    }
    out_url = OUStringToOString(url, RTL_TEXTENCODING_UTF8).getStr();
    return true;
}

// CSV export filter options (Calc "Text - txt - csv (StarCalc)" positional form),
// shared by both CSV export sites: field separator 44 (','), text delimiter 34
// ('"'), charset 76 (UTF-8, numeric: see canonicalEncoding below), first line 1,
// cell format (none), language 0, quote-all-text false, numbers-as-numbers true,
// save-as-shown true -- LibreOffice desktop's own export default.
// NOT the 4-token form "44,34,76,1": ScImportOptions (sc/source/ui/dbgui/
// imoptdlg.cxx) treats exactly four tokens as the legacy string and switches on
// bQuoteAllText, so every text cell is quoted. Measured 2026-10-03.
const char* const kCsvExportOptions = "44,34,76,1,,0,false,true,true";

// --- M14: input validation for filter-option parameters ---------------------

// Exact whitelist of encodings the UI offers (root CLAUDE.md: UTF-8, ISO-8859-1,
// Windows-1252). Case-insensitive; returns the token to embed in the positional
// CSV option string, or nullptr if not allowed. Only table values are ever
// embedded, so the token can never contain ',' or '='.
//
// The token is the NUMERIC rtl_TextEncoding (rtl/textenc.h), not the name: Calc's
// CSV import reads it with ScGlobal::GetCharsetValue (sc/source/core/data/
// global.cxx), which accepts a number or a few legacy names (ANSI, MAC, IBMPC*,
// UTF8/UTF-8) and silently falls back to the thread encoding -- UTF-8 here -- for
// anything else. Passing "ISO-8859-1" or "Windows-1252" by name therefore read
// every Latin-1 file as UTF-8 and turned each accented byte into U+FFFD (CB-001).
// NOTE: if the UI / M9 adds encodings, extend this table to match.
const char* canonicalEncoding(const char* enc) {
    if (!enc) return nullptr;
    struct Entry { const char* lower; const char* canonical; };
    static const Entry table[] = {
        { "utf-8",        "76" },   // RTL_TEXTENCODING_UTF8
        { "iso-8859-1",   "12" },   // RTL_TEXTENCODING_ISO_8859_1
        { "windows-1252", "1"  },   // RTL_TEXTENCODING_MS_1252
    };
    std::string lower(enc);
    for (char& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    for (const auto& e : table) {
        if (lower == e.lower) return e.canonical;
    }
    return nullptr;
}

// Page range like "1-5" or "1,3,5": first char a digit, then only [0-9,-].
// Rejects empty and length > 64.
bool isValidPageRange(const char* s) {
    if (!s) return false;
    size_t n = strlen(s);
    if (n == 0 || n > 64) return false;
    if (!std::isdigit(static_cast<unsigned char>(s[0]))) return false;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        if (!(std::isdigit(static_cast<unsigned char>(c)) || c == ',' || c == '-')) return false;
    }
    return true;
}

// Print area: a cell range like "A1:M50" / "$A$1:$M$50" / "Sheet1!A1:B2"
// (only [A-Za-z0-9:$.!]) or a page range per isValidPageRange. Rejects
// everything else. Length <= 64. This guarantees the value can never inject
// ',' or '=' into the comma-joined saveAs options string.
//
// MUST STAY IN LOCKSTEP with isValidPrintArea() in web/js/conversion_protocol.js.
// They diverged once — the UI accepted Sheet1!A1:B2 and the conversion then died
// here with INVALID_PARAM, after the user had committed to it.
//
// CORRECTION: an earlier revision of this comment claimed isValidPageRange
// bounds at 128 bytes while JS bounds at 64. It does not — both bound at 64
// (see the n > 64 checks in both functions, and the C++/JS length-bound parity
// assertion in tests/unit/test_ui_decisions.js, which reads this file). The
// claim was captured from a transiently mutated copy of this file during
// mutation testing; there is no asymmetry to leave alone.
//
// What IS a real open question, and is deliberately NOT changed here: whether 64
// is the right bound at all. A legitimate page range ("1-5,10-15,...") can
// exceed 64 characters, so both sides may be rejecting valid input. Widening it
// is a behaviour change needing its own testing, not a drive-by edit — and it
// must be done on BOTH sides at once or the parity test will (correctly) fail.
bool isValidPrintArea(const char* s) {
    if (!s) return false;
    size_t n = strlen(s);
    if (n == 0 || n > 64) return false;
    if (isValidPageRange(s)) return true;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        // '!' admits a sheet-qualified range (Sheet1!A1:B2). The UI has always
        // offered and documented these, but this allowlist rejected them, so the
        // UI accepted the input and the conversion then died here with
        // INVALID_PARAM -- the user lost the whole conversion over a value the
        // interface told them was valid.
        //
        // Safe under this function's stated guarantee: the danger is injecting
        // ',' or '=' into the comma-joined saveAs options string, and '!' is
        // neither. Deliberately NOT admitted: quotes and spaces, which would be
        // needed for sheet names containing spaces ('My Sheet'!A1:B2). Those
        // remain unsupported and are rejected here AND in the UI, so they fail
        // fast with a message instead of failing late.
        bool ok = std::isalnum(static_cast<unsigned char>(c)) ||
                  c == ':' || c == '$' || c == '.' || c == '!';
        if (!ok) return false;
    }
    return true;
}

// --- M12: JSON string escaping ----------------------------------------------

// Escape a string for embedding in a JSON string literal. The previous inline
// loop escaped only '"', so a '\' or control character in a sheet name produced
// invalid JSON that JSON.parse would reject.
std::string jsonEscape(const char* s) {
    std::string out;
    if (!s) return out;
    for (const unsigned char* p = reinterpret_cast<const unsigned char*>(s); *p; ++p) {
        switch (*p) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (*p < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof buf, "\\u%04x", *p);
                    out += buf;
                } else {
                    out += static_cast<char>(*p);
                }
        }
    }
    return out;
}

// --- FG-021 / BUG-36: export options for protection and Calc notes ----------

// A password as a JSON string value: jsonEscape, and ',' escaped as well:
// doc_saveAs splits the WHOLE options string on commas, trims every piece and
// re-joins them with ", " (init.cxx, comphelper::string::convertCommaSeparated),
// which would change a password with a space next to a comma.
static std::string jsonPassword(const std::string& pw) {
    std::string esc = jsonEscape(pw.c_str());
    std::string out;
    for (char c : esc) {
        if (c == ',') out += "\\u002c";
        else out += c;
    }
    return out;
}

static std::string jsonProp(const char* name, const char* type, const std::string& value) {
    return std::string("\"") + name + "\":{\"type\":\"" + type + "\",\"value\":\"" + value + "\"}";
}

static std::string joinJson(const std::vector<std::string>& parts) {
    std::string out = "{";
    for (size_t i = 0; i < parts.size(); i++) {
        if (i > 0) out += ",";
        out += parts[i];
    }
    return out + "}";
}

static bool outputProtectionRequested() { return !g_secrets.openPassword.empty(); }

// Targets whose export filter encrypts with a password: PDF (FilterData) and
// OOXML (MediaDescriptor Password). Anything else asked to be protected is
// refused, never silently written unprotected. ODF is refused too: its AES
// package encryption needs the NSS-based xmlsecurity service, which this build
// does not have (measured: the export fails with an I/O error; FEAT-08).
static bool isPdfTarget(const std::string& fmt) {
    return fmt == "pdf" || fmt == "calc_pdf_Export";
}

static bool checkOutputProtection(const std::string& fmt) {
    if (!outputProtectionRequested())
        return true;
    if (isPdfTarget(fmt))
        return true;
    if (!g_secrets.permissionPassword.empty()) {
        setLastError(BridgeErrCat::InvalidParam,
                     "PDF permissions were requested for a " + fmt + " output");
        return false;
    }
    static const char* const kProtectable[] = { "docx", "xlsx", "pptx" };
    for (const char* f : kProtectable)
        if (fmt == f)
            return true;
    setLastError(BridgeErrCat::InvalidParam, "Output protection is not available for " + fmt);
    return false;
}

// PDF security FilterData (pdfexport.cxx). SelectPdfVersion 20 is what makes the
// writer use AES-256 (PDFEncryptorR6); every other version is RC4-128.
static void appendPdfSecurityJson(std::vector<std::string>& parts) {
    if (!outputProtectionRequested())
        return;
    parts.push_back(jsonProp("EncryptFile", "boolean", "true"));
    parts.push_back(jsonProp("DocumentOpenPassword", "string", jsonPassword(g_secrets.openPassword)));
    parts.push_back(jsonProp("SelectPdfVersion", "long", "20"));
    if (g_secrets.permissionPassword.empty())
        return;
    parts.push_back(jsonProp("RestrictPermissions", "boolean", "true"));
    parts.push_back(jsonProp("PermissionPassword", "string", jsonPassword(g_secrets.permissionPassword)));
    parts.push_back(jsonProp("Printing", "long",
                             std::to_string(g_secrets.printing < 0 ? 2 : g_secrets.printing)));
    parts.push_back(jsonProp("Changes", "long",
                             std::to_string(g_secrets.changes < 0 ? 4 : g_secrets.changes)));
    parts.push_back(jsonProp("EnableCopyingOfContent", "boolean",
                             g_secrets.copying == 0 ? "false" : "true"));
    // Never block screen readers.
    parts.push_back(jsonProp("EnableTextAccessForAccessibilityTools", "boolean", "true"));
}

// Calc PDF export as JSON FilterOptions (BUG-36): the only channel that reaches
// FilterData through LOK, and FilterData is where ExportNotes is read. The old
// plain string's SinglePageSheets token never reached the filter (a no-op), so it
// is deliberately not carried over: in JSON it would take effect.
static std::string calcPdfOptionsJson() {
    std::vector<std::string> parts;
    // doc_saveAs adds ExportBookmarks=true for a pdf export only when FilterOptions is NOT JSON; a JSON
    // string skips it, so say it here. The only intended change to a Calc PDF is the comment annotations.
    parts.push_back(jsonProp("ExportBookmarks", "boolean", "true"));
    parts.push_back(jsonProp("ExportNotes", "boolean", g_calcIncludeCellComments ? "true" : "false"));
    appendPdfSecurityJson(parts);
    return joinJson(parts);
}

// OOXML: doc_saveAs cuts ",Password=<pw>PASSWORDEND" out of the options
// before it splits them, and passes it on as MediaDescriptor Password. The
// leading comma is required even when nothing precedes it.
static void appendOdfPassword(std::string& options) {
    if (outputProtectionRequested())
        options += ",Password=" + g_secrets.openPassword + "PASSWORDEND";
}

// Every print of an export options string goes through here (section 4.5).
static std::string redactOptions(const std::string& in) {
    std::string s = in;
    const std::string* secrets[] = { &g_secrets.openPassword, &g_secrets.permissionPassword,
                                     &g_secrets.inputPassword };
    for (const std::string* sec : secrets) {
        if (sec->empty())
            continue;
        for (const std::string& form : { *sec, jsonPassword(*sec), jsonEscape(sec->c_str()) }) {
            for (size_t at = s.find(form); at != std::string::npos; at = s.find(form, at + 10))
                s.replace(at, form.size(), "<redacted>");
        }
    }
    return s;
}

// set_conversion_secrets() rules (section 2): the output passwords travel inside
// the saveAs options string, so they must not contain a token doc_saveAs cuts
// out of it by indexOf, and must fit PDF 2.0's 127-byte limit.
static bool secretError(const char* field, const std::string& why) {
    setLastError(BridgeErrCat::InvalidParam, std::string("Invalid ") + field + ": " + why);
    return false;
}

static bool validOutputPassword(const char* field, const char* pw) {
    const size_t n = strlen(pw);
    if (n == 0)
        return secretError(field, "empty");
    if (n > 127)
        return secretError(field, "longer than 127 bytes");
    static const char* const kReserved[] = {
        "PASSWORDEND", "PASSWORDTOMODIFYEND", "WATERMARKEND", "FULLSHEETPREVEND", "PDFVEREND",
        ",Watermark=", ",FullSheetPreview=", ",Password=", ",PasswordToModify=", ",PDFVer=" };
    for (const char* r : kReserved)
        if (strstr(pw, r))
            return secretError(field, "contains a reserved word");
    return true;
}

// --- Spreadsheet print area, at the UNO MODEL level --------------------------
//
// WHY NOT .uno:DefinePrintArea. The obvious implementation -- and the one
// LibreOffice's own Calc PDF test uses (sc/qa/extras/scpdfexport.cxx,
// exportToPDFWithUnoCommands) -- is to dispatch .uno:GoToCell followed by
// .uno:DefinePrintArea. That was implemented, built and tested here, and it
// DISPATCHES BUT DOES NOTHING: SID_DEFINE_PRINTAREA is handled by
// ScTabViewShell (sc/source/ui/view/tabvwsh3.cxx:365, tabvwsha.cxx:219), a
// VIEW SHELL command, and headless WASM has no SfxViewShell. The command went
// nowhere, no error was raised, and the exported PDF still contained every
// cell -- the silent wrong answer this project rules out.
//
// The model-level equivalent needs no view shell at all:
// ScTableSheetObj::setPrintAreas (sc/source/ui/unoobj/cellsuno.cxx:6906) goes
// straight to ScDocument::ClearPrintRanges/AddPrintRange via the ScDocShell.
//
// HOW WE REACH THE MODEL. LibLODocument_Impl::mxComponent is exactly the
// XComponent that lo_documentLoadWithOptions stored when this bridge called
// documentLoad (desktop/source/lib/init.cxx: `new LibLODocument_Impl(xComponent,
// nThisDocumentId)`), so it is non-null whenever documentLoad succeeded. The
// struct is declared DESKTOP_DLLPUBLIC in desktop/inc/lib/init.hxx with a public
// mxComponent, so no LibreOffice source change is needed to read it.
//
// REJECTED: css::frame::Desktop::create(ctx)->getCurrentComponent(). It
// resolves through Desktop::getActiveFrame() (framework/source/services/
// desktop.cxx:492 -> getCurrentFrame()), and in this build a headless LOK frame
// is never activated: activation happens only in
// LoadEnv::impl_makeFrameWindowVisible (framework/source/loadenv/loadenv.cxx:1144,
// :1618), which requires a component window, and the __EMSCRIPTEN__ fast path in
// XFrameImpl::setComponent (framework/source/services/frame.cxx) exists
// precisely because there is no component window. It would return null.
static css::uno::Reference<css::sheet::XSpreadsheetDocument>
getSpreadsheetModel(lok::Document* pDoc) {
    if (!pDoc) return {};
    LibreOfficeKitDocument* pRaw = pDoc->get();
    if (!pRaw) return {};
    // LibLODocument_Impl publicly derives from _LibreOfficeKitDocument.
    desktop::LibLODocument_Impl* pImpl = static_cast<desktop::LibLODocument_Impl*>(pRaw);
    return css::uno::Reference<css::sheet::XSpreadsheetDocument>(
        pImpl->mxComponent, css::uno::UNO_QUERY);
}

// FG-047: a CSV opened by the engine keeps every column at Calc's default
// width, so a value wider than its column is clipped wherever the next cell is
// filled: a Japanese or Korean greeting printed as "こんにち" against the next
// column. The JS fast path sizes columns itself; CSVs reach the engine when
// they hold scripts that need shaping (Indic, Thai, emoji ...) or are over
// 60 MB. Give the used columns their optimal width before PDF export, as a
// person opening the file would, with two bounds:
//   - kCsvAutofitMaxCells: optimal width measures every cell, the same class of
//     pass that stalled a 96,020-row workbook in FG-154. Above the bound the
//     columns keep the default width (behaviour unchanged).
//   - kCsvAutofitMaxWidth: Calc cuts a column that is wider than the page at the
//     page edge, which would lose MORE than clipping does. Columns are capped at
//     about half an A4 text width; a longer value is clipped as before.
// Never fatal: any failure leaves the default widths.
static const long long kCsvAutofitMaxCells = 2000000;
static const sal_Int32 kCsvAutofitMaxWidth = 9000;   // 1/100 mm (9 cm)

static bool isCsvInput(const std::string& input_path) {
    std::string ext = getExtension(input_path);
    return ext == "csv" || ext == "tsv";
}

static void autofitCsvColumns(lok::Document* pDoc) {
    try {
        css::uno::Reference<css::sheet::XSpreadsheetDocument> xDoc = getSpreadsheetModel(pDoc);
        if (!xDoc.is()) return;
        css::uno::Reference<css::container::XIndexAccess> xSheets(xDoc->getSheets(), css::uno::UNO_QUERY);
        if (!xSheets.is() || xSheets->getCount() < 1) return;
        css::uno::Reference<css::sheet::XSpreadsheet> xSheet(xSheets->getByIndex(0), css::uno::UNO_QUERY);
        if (!xSheet.is()) return;
        css::uno::Reference<css::sheet::XSheetCellCursor> xCursor = xSheet->createCursor();
        css::uno::Reference<css::sheet::XUsedAreaCursor> xUsed(xCursor, css::uno::UNO_QUERY);
        css::uno::Reference<css::sheet::XCellRangeAddressable> xAddr(xCursor, css::uno::UNO_QUERY);
        css::uno::Reference<css::table::XColumnRowRange> xColRow(xCursor, css::uno::UNO_QUERY);
        if (!xUsed.is() || !xAddr.is() || !xColRow.is()) return;
        xUsed->gotoStartOfUsedArea(false);
        xUsed->gotoEndOfUsedArea(true);
        const css::table::CellRangeAddress a = xAddr->getRangeAddress();
        const long long cells = static_cast<long long>(a.EndRow - a.StartRow + 1)
                              * static_cast<long long>(a.EndColumn - a.StartColumn + 1);
        if (cells > kCsvAutofitMaxCells) {
            std::cerr << "[BRIDGE] CSV autofit skipped: " << cells << " cells > "
                      << kCsvAutofitMaxCells << std::endl << std::flush;
            return;
        }
        css::uno::Reference<css::container::XIndexAccess> xCols(xColRow->getColumns(), css::uno::UNO_QUERY);
        css::uno::Reference<css::beans::XPropertySet> xColsProps(xCols, css::uno::UNO_QUERY);
        if (!xCols.is() || !xColsProps.is()) return;
        xColsProps->setPropertyValue(OUString("OptimalWidth"), css::uno::Any(true));
        int capped = 0;
        for (sal_Int32 i = 0; i < xCols->getCount(); ++i) {
            css::uno::Reference<css::beans::XPropertySet> xCol(xCols->getByIndex(i), css::uno::UNO_QUERY);
            if (!xCol.is()) continue;
            sal_Int32 w = 0;
            if ((xCol->getPropertyValue(OUString("Width")) >>= w) && w > kCsvAutofitMaxWidth) {
                xCol->setPropertyValue(OUString("Width"), css::uno::Any(kCsvAutofitMaxWidth));
                ++capped;
            }
        }
        std::cerr << "[BRIDGE] CSV autofit: " << xCols->getCount() << " column(s), " << cells
                  << " cells, " << capped << " capped" << std::endl << std::flush;
    } catch (const css::uno::Exception& e) {
        std::cerr << "[BRIDGE] CSV autofit failed (default widths kept): " << e.Message << std::endl << std::flush;
    } catch (...) {
        std::cerr << "[BRIDGE] CSV autofit failed (default widths kept)" << std::endl << std::flush;
    }
}

// Split a normalised print area into an optional sheet qualifier and the bare
// cell range. Input has already passed isValidPrintArea() and had '!' mapped to
// '.', so the alphabet is [A-Za-z0-9:$.] only.
//   "A1:B5"                -> sheet "",       range "A1:B5"
//   "Sheet1.A1:B2"         -> sheet "Sheet1", range "A1:B2"
//   "$Sheet1.$A$1:$B$5"    -> sheet "Sheet1", range "$A$1:$B$5"
//   "Sheet1.A1:Sheet1.B2"  -> sheet "Sheet1", range "A1:B2"
// A dot that appears only AFTER the colon is not a leading qualifier, so it is
// left alone and the range is handed to Calc as-is (which will reject it).
void splitPrintArea(const std::string& in, std::string& sheetOut, std::string& rangeOut) {
    sheetOut.clear();
    rangeOut = in;

    const size_t colon = in.find(':');
    const size_t dot = in.find('.');
    if (dot != std::string::npos && colon != std::string::npos && dot < colon) {
        sheetOut = in.substr(0, dot);
        rangeOut = in.substr(dot + 1);
        if (!sheetOut.empty() && sheetOut[0] == '$') sheetOut.erase(0, 1);
    }

    // Drop a repeated qualifier from the end address ("A1:Sheet1.B2" -> "A1:B2").
    const size_t rColon = rangeOut.find(':');
    if (rColon != std::string::npos) {
        const std::string right = rangeOut.substr(rColon + 1);
        const size_t rDot = right.rfind('.');
        if (rDot != std::string::npos) {
            rangeOut = rangeOut.substr(0, rColon + 1) + right.substr(rDot + 1);
        }
    }
}

inline OUString utf8ToOUString(const std::string& s) {
    return OUString(s.c_str(), static_cast<sal_Int32>(s.size()), RTL_TEXTENCODING_UTF8);
}

inline std::string ouStringToUtf8(const OUString& s) {
    return std::string(OUStringToOString(s, RTL_TEXTENCODING_UTF8).getStr());
}

} // namespace

extern "C" {

    // Global pointer to the LOK Office instance
    Office* g_pOffice = nullptr;

    /**
     * FG-021: the passwords for the NEXT convert_* call. Call it just before that
     * call; they are wiped when it returns, and by clear_conversion_secrets().
     * @param inputPassword: opens a protected input. NULL = none.
     * @param openPassword: protects the output (PDF, DOCX/XLSX/PPTX; ODT/ODS/ODP are refused, see checkOutputProtection). NULL = none.
     * @param permissionPassword: PDF only, restricts permissions; needs openPassword and
     *        must differ from it. NULL = no restrictions.
     * @param pdfPrinting: 0 none, 1 low resolution, 2 high (-1 = 2). Needs permissionPassword.
     * @param pdfChanges: 0..4 as the PDF filter's Changes (-1 = 4, any). Needs permissionPassword.
     * @param pdfCopying: 0 or 1 (-1 = 1). Needs permissionPassword.
     * @return 1, or 0 with an INVALID_PARAM last error that names the field, never its value.
     */
    EMSCRIPTEN_KEEPALIVE
    int set_conversion_secrets(const char* inputPassword, const char* openPassword,
                               const char* permissionPassword,
                               int pdfPrinting, int pdfChanges, int pdfCopying) {
        clearLastError();
        wipeSecrets();
        bool ok = true;
        if (inputPassword && !g_passwordsAllowed) {
            // Never let this surface as a wrong password: the engine was not asked to take one.
            setLastError(BridgeErrCat::PasswordUnsupported,
                         "Document passwords are not enabled in this engine (INIT.allowDocumentPasswords)");
            return 0;
        }
        if (inputPassword) {
            const size_t n = strlen(inputPassword);
            if (n == 0) ok = secretError("inputPassword", "empty");
            else if (n > 1024) ok = secretError("inputPassword", "longer than 1024 bytes");
        }
        if (ok && openPassword)
            ok = validOutputPassword("openPassword", openPassword);
        if (ok && permissionPassword) {
            ok = validOutputPassword("permissionPassword", permissionPassword);
            if (ok && !openPassword)
                ok = secretError("permissionPassword", "given without openPassword");
            if (ok && strcmp(permissionPassword, openPassword) == 0)
                ok = secretError("permissionPassword", "the same as openPassword");
        }
        const bool restrictions = pdfPrinting != -1 || pdfChanges != -1 || pdfCopying != -1;
        if (ok && restrictions && !permissionPassword)
            ok = secretError("pdfPermissions", "given without permissionPassword");
        if (ok && (pdfPrinting < -1 || pdfPrinting > 2))
            ok = secretError("pdfPrinting", "out of range");
        if (ok && (pdfChanges < -1 || pdfChanges > 4))
            ok = secretError("pdfChanges", "out of range");
        if (ok && (pdfCopying < -1 || pdfCopying > 1))
            ok = secretError("pdfCopying", "out of range");
        if (!ok)
            return 0;
        if (inputPassword) g_secrets.inputPassword = inputPassword;
        if (openPassword) g_secrets.openPassword = openPassword;
        if (permissionPassword) g_secrets.permissionPassword = permissionPassword;
        g_secrets.printing = pdfPrinting;
        g_secrets.changes = pdfChanges;
        g_secrets.copying = pdfCopying;
        std::cerr << "[BRIDGE] Conversion secrets set: input " << (inputPassword ? "<set>" : "<not set>")
                  << ", output " << (openPassword ? "<set>" : "<not set>")
                  << ", permissions " << (permissionPassword ? "<set>" : "<not set>")
                  << std::endl << std::flush;
        return 1;
    }

    /** FG-021: wipe the passwords (volatile zeroing). Safe to call at any time. */
    EMSCRIPTEN_KEEPALIVE
    void clear_conversion_secrets(void) {
        wipeSecrets();
    }

    /**
     * BUG-36: cell comments in the NEXT Calc PDF export (0 = off, the default).
     * Reset to 0 when that convert_* call returns.
     */
    EMSCRIPTEN_KEEPALIVE
    void set_calc_pdf_options(int includeCellComments) {
        g_calcIncludeCellComments = includeCellComments != 0;
    }

    /**
     * Initialize the LibreOfficeKit engine.
     * @param install_path: Path to the LibreOffice installation in the VFS (e.g., "/usr/lib/libreoffice")
     * @return 1 on success, 0 on failure.
     */
    EMSCRIPTEN_KEEPALIVE
    int init_office(const char* install_path) {
        clearLastError();
        try {
            // Idempotence guard (M13): if an instance already exists, do NOT leak
            // it and re-run lok_init against initialized statics (the static-
            // corruption class documented in docs/STABILITY_FIX_PLAN.md). Return
            // success — callers treat 1 as "initialized". Placed before any setenv
            // so a redundant call can't mutate a live instance's environment. A
            // true re-init must go through shutdown_office() first.
            if (g_pOffice) {
                std::cerr << "[INIT] init_office() called but LOK is already initialized - "
                             "returning success (idempotent). Call shutdown_office() first "
                             "for a true re-init." << std::endl << std::flush;
                return 1;
            }

            // DEBUG: Detailed initialization logging for page-refresh hang investigation
            // See bugs/wasm_static_state_investigation.md
            std::cerr << "[INIT] ========================================" << std::endl << std::flush;
            std::cerr << "[INIT] init_office() called" << std::endl << std::flush;
            std::cerr << "[INIT] install_path: " << install_path << std::endl << std::flush;
            std::cerr << "[INIT] g_pOffice before init: nullptr (expected)" << std::endl << std::flush;

            std::cerr << "[INIT] Step 1: Setting environment variables..." << std::endl << std::flush;
            std::cout << "wasm_bridge: Setting environment variables for WASM mode..." << std::endl;

            // Disable features that may spawn problematic background threads
            setenv("SAL_DISABLE_WATCHDOG", "1", 1);        // Disable watchdog timer
            setenv("SAL_DISABLE_SYNCHRONIZE", "1", 1);     // Disable synchronization
            setenv("SAL_NO_FONT_SCAN", "1", 1);            // Disable background font scanning
            setenv("SAL_DISABLE_OPENCL", "1", 1);          // Disable OpenCL
            setenv("OOO_DISABLE_RECOVERY", "1", 1);        // Disable crash recovery
            setenv("SAL_ENABLE_FILE_LOCKING", "0", 1);     // Disable file locking
            setenv("HOME", "/tmp", 1);                     // Set HOME to writable dir
            // Enable verbose logging for debugging document load failures
            // Note: framework code uses "fwk" prefix, not "framework"
            // Added sdext.pdfimport for PDF import debugging
            setenv("SAL_LOG", "+WARN+INFO.lok+INFO.desktop+INFO.filter+INFO.ucb+INFO.fwk+INFO.fwk.loadenv+WARN.fwk.loadenv+WARN.sdext.pdfimport+INFO.sdext.pdfimport", 1);
            setenv("SAL_LOK_OPTIONS", "unipoll", 1);       // Use single-threaded (unipoll) mode

            // Additional threading controls for XLSX multi-sheet parsing
            setenv("SAL_DISABLE_MULTIPROCESSING", "1", 1); // Disable multiprocessing
            setenv("OOO_FORCE_SINGLETHREADED", "1", 1);    // Force single-threaded operations
            setenv("SAL_SINGLETHREAD", "1", 1);            // Additional single-thread flag
            setenv("SC_NO_THREADED_CALCULATION", "1", 1);  // Disable threaded calculation in Calc (note: exact var name required)
            setenv("VCL_NO_THREAD_SCALE", "1", 1);         // Disable threaded bitmap scaling in VCL
            setenv("VCL_NO_THREAD_IMPORT", "1", 1);        // Disable threaded graphic import in VCL

            std::cerr << "[INIT] Step 2: Environment variables set" << std::endl << std::flush;
            std::cout << "wasm_bridge: Initializing LOK with path: " << install_path << std::endl;

            // Initialize LibreOfficeKit
            // The second argument 'context' is not strictly used in headless svp but good practice to pass nullptr
            std::cerr << "[INIT] Step 3: About to call lok_cpp_init()..." << std::endl << std::flush;
            g_pOffice = lok_cpp_init(install_path);
            std::cerr << "[INIT] Step 4: lok_cpp_init() returned: " << (g_pOffice ? "SUCCESS" : "NULLPTR") << std::endl << std::flush;

            if (!g_pOffice) {
                std::cerr << "[INIT] FAILED: lok_cpp_init returned nullptr" << std::endl << std::flush;
                std::cerr << "wasm_bridge: LOK Initialization Failed! lok_init returned nullptr." << std::endl;
                setLastError(BridgeErrCat::Init,
                             "LibreOffice engine failed to initialize (lok_cpp_init returned null)");
                return 0;
            }

            std::cerr << "[INIT] Step 5: LOK initialized, setting options..." << std::endl << std::flush;
            g_pOffice->registerCallback(bridge_office_callback, nullptr);   // FG-173
            // FG-021: password-protected input raises LOK_CALLBACK_DOCUMENT_PASSWORD,
            // answered by bridge_office_callback. Not ..._TO_MODIFY: a modify-only
            // password then gets no callback and the document opens read-only.
            {
                const char* allow = getenv("LO_WASM_ALLOW_DOCUMENT_PASSWORDS");
                g_passwordsAllowed = allow && allow[0] == '1' && allow[1] == '\0';   // anything but exactly "1" is off
            }
            if (g_passwordsAllowed) {
                // the optional feature itself is switched on per load (LoadWindow), not here
                std::cout << "wasm_bridge: document passwords allowed (LO_WASM_ALLOW_DOCUMENT_PASSWORDS=1)" << std::endl;
            } else {
                std::cout << "wasm_bridge: document passwords NOT allowed (the host did not switch them on)" << std::endl;
            }
            std::cout << "wasm_bridge: LOK Initialized successfully." << std::endl;

            // Enable verbose SAL_LOG at runtime via LOK setOption
            // This should show detailed logging including UCB and framework operations
            // Note: Use "fwk" prefix for framework code logging
            const char* salLogValue = "+WARN+INFO.lok+INFO.desktop+INFO.filter+INFO.ucb+INFO.fwk+INFO.fwk.loadenv+WARN.fwk.loadenv+DEBUG.fwk.loadenv";
            g_pOffice->setOption("sallogoverride", salLogValue);
            std::cout << "wasm_bridge: SAL_LOG override set via LOK setOption" << std::endl;
            std::cout << "wasm_bridge: SAL_LOG value: " << salLogValue << std::endl;

            std::cerr << "[INIT] Step 6: init_office() COMPLETE - returning 1" << std::endl << std::flush;
            std::cerr << "[INIT] ========================================" << std::endl << std::flush;
            return 1;
        } catch (const std::exception& e) {
            std::cerr << "[INIT] EXCEPTION: " << e.what() << std::endl << std::flush;
            std::cerr << "wasm_bridge: Exception during init: " << e.what() << std::endl;
            setLastError(BridgeErrCat::Init, std::string("Exception during init: ") + e.what());
            return 0;
        } catch (...) {
            std::cerr << "[INIT] UNKNOWN EXCEPTION" << std::endl << std::flush;
            std::cerr << "wasm_bridge: Unknown exception during init." << std::endl;
            setLastError(BridgeErrCat::Init, "Unknown exception during init");
            return 0;
        }
    }

    /**
     * Test creating a new document using private:factory/swriter URL
     * This bypasses file loading to test if document creation works at all.
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    int test_factory_url() {
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: Error - Office not initialized." << std::endl;
            return 0;
        }

        std::cout << "wasm_bridge: Testing private:factory/swriter URL..." << std::endl;

        Document* pDoc = nullptr;
        try {
            // Try to create a new Writer document
            pDoc = g_pOffice->documentLoad("private:factory/swriter");
            if (pDoc) {
                std::cout << "wasm_bridge: SUCCESS! Created new document via private:factory/swriter" << std::endl;

                // Get document type
                int docType = pDoc->getDocumentType();
                std::cout << "wasm_bridge: Document type: " << docType << std::endl;

                delete pDoc;
                return 1;
            } else {
                std::cerr << "wasm_bridge: FAILED to create document via private:factory/swriter" << std::endl;
                char* pError = g_pOffice->getError();
                if (pError) {
                    std::cerr << "wasm_bridge: LOK error: " << pError << std::endl;
                    g_pOffice->freeError(pError);
                }
                return 0;
            }
        } catch (const std::exception& e) {
            std::cerr << "wasm_bridge: Exception creating factory document: " << e.what() << std::endl;
            return 0;
        }
    }
#endif

    /**
     * Test creating a new Impress document using private:factory/simpress URL
     * This bypasses file loading to test if Impress document creation works.
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    int test_factory_url_impress() {
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: Error - Office not initialized." << std::endl;
            return 0;
        }

        std::cout << "wasm_bridge: Testing private:factory/simpress URL..." << std::endl;

        Document* pDoc = nullptr;
        try {
            // Try to create a new Impress document
            pDoc = g_pOffice->documentLoad("private:factory/simpress");
            if (pDoc) {
                std::cout << "wasm_bridge: SUCCESS! Created new document via private:factory/simpress" << std::endl;

                // Get document type
                int docType = pDoc->getDocumentType();
                std::cout << "wasm_bridge: Document type: " << docType << " (expected: 1 for presentation)" << std::endl;

                delete pDoc;
                return 1;
            } else {
                std::cerr << "wasm_bridge: FAILED to create document via private:factory/simpress" << std::endl;
                char* pError = g_pOffice->getError();
                if (pError) {
                    std::cerr << "wasm_bridge: LOK error: " << pError << std::endl;
                    g_pOffice->freeError(pError);
                }
                return 0;
            }
        } catch (const std::exception& e) {
            std::cerr << "wasm_bridge: Exception creating Impress factory document: " << e.what() << std::endl;
            return 0;
        }
    }
#endif

    /**
     * Test creating a new Draw document using private:factory/sdraw URL
     * If Draw works but Impress doesn't, the issue is Impress-specific.
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    int test_factory_url_draw() {
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: Error - Office not initialized." << std::endl;
            return 0;
        }

        std::cout << "wasm_bridge: Testing private:factory/sdraw URL..." << std::endl;

        Document* pDoc = nullptr;
        try {
            // Try to create a new Draw document
            pDoc = g_pOffice->documentLoad("private:factory/sdraw");
            if (pDoc) {
                std::cout << "wasm_bridge: SUCCESS! Created new document via private:factory/sdraw" << std::endl;

                // Get document type
                int docType = pDoc->getDocumentType();
                std::cout << "wasm_bridge: Document type: " << docType << " (expected: 3 for drawing)" << std::endl;

                delete pDoc;
                return 1;
            } else {
                std::cerr << "wasm_bridge: FAILED to create document via private:factory/sdraw" << std::endl;
                char* pError = g_pOffice->getError();
                if (pError) {
                    std::cerr << "wasm_bridge: LOK error: " << pError << std::endl;
                    g_pOffice->freeError(pError);
                }
                return 0;
            }
        } catch (const std::exception& e) {
            std::cerr << "wasm_bridge: Exception creating Draw factory document: " << e.what() << std::endl;
            return 0;
        }
    }
#endif

    /**
     * Test creating documents via all available factory URLs
     * This helps diagnose which module types are working
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    int test_all_factory_urls() {
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: Error - Office not initialized." << std::endl;
            return 0;
        }

        std::cout << "wasm_bridge: === Testing ALL Factory URLs ===" << std::endl;

        const char* factoryUrls[] = {
            "private:factory/swriter",
            "private:factory/scalc",
            "private:factory/simpress",
            "private:factory/sdraw",
            nullptr
        };
        const char* factoryNames[] = {
            "Writer",
            "Calc",
            "Impress",
            "Draw",
            nullptr
        };

        int successCount = 0;

        for (int i = 0; factoryUrls[i] != nullptr; i++) {
            std::cout << "wasm_bridge: Testing " << factoryNames[i] << " (" << factoryUrls[i] << ")..." << std::endl;

            Document* pDoc = g_pOffice->documentLoad(factoryUrls[i]);
            if (pDoc) {
                int docType = pDoc->getDocumentType();
                std::cout << "wasm_bridge:   -> SUCCESS (docType=" << docType << ")" << std::endl;
                delete pDoc;
                successCount++;
            } else {
                char* pError = g_pOffice->getError();
                std::cout << "wasm_bridge:   -> FAILED";
                if (pError) {
                    std::cout << " (" << pError << ")";
                    g_pOffice->freeError(pError);
                }
                std::cout << std::endl;
            }
        }

        std::cout << "wasm_bridge: === Factory URL Test Complete: " << successCount << "/4 passed ===" << std::endl;
        return successCount;
    }
#endif

    /**
     * Get detailed filter information from LOK for debugging
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    int test_lok_filters() {
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: Error - Office not initialized." << std::endl;
            return 0;
        }

        std::cout << "wasm_bridge: === Testing LOK Filter Detection ===" << std::endl;

        // Get filter types to verify filter infrastructure is working
        char* filterTypes = g_pOffice->getFilterTypes();
        if (filterTypes) {
            std::cout << "wasm_bridge: Available filter types:" << std::endl;
            std::cout << filterTypes << std::endl;
            g_pOffice->freeError(filterTypes);
            return 1;
        } else {
            std::cerr << "wasm_bridge: getFilterTypes returned null" << std::endl;
            char* pError = g_pOffice->getError();
            if (pError) {
                std::cerr << "wasm_bridge: LOK error: " << pError << std::endl;
                g_pOffice->freeError(pError);
            }
            return 0;
        }
    }
#endif

    /**
     * Convert a document from input_path to output_path.
     * @param input_path: VFS path to source file (e.g., "/tmp/input.docx")
     * @param output_path: VFS path for destination file (e.g., "/tmp/output.pdf")
     * @param format_filter: Export filter name (e.g., "pdf", "html")
     * @return 1 on success, 0 on failure.
     */
    EMSCRIPTEN_KEEPALIVE
    int convert_document(const char* input_path, const char* output_path, const char* format_filter) {
        ConversionSecretsScope secretsScope;   // FG-021: secrets and Calc options live for this call only
        clearLastError();
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: Error - Office not initialized." << std::endl;
            setLastError(BridgeErrCat::Init, "LibreOffice engine not initialized");
            return 0;
        }
        if (!checkOutputProtection(format_filter)) {   // FG-021: refused before any work
            report_conversion_progress("EXPORT_FAILED", 0);
            return 0;
        }

        // Debug: Check if file exists in VFS before trying to load
        FILE* checkFile = fopen(input_path, "rb");
        if (!checkFile) {
            std::cerr << "wasm_bridge: File does NOT exist in VFS: " << input_path << std::endl;
            setLastError(BridgeErrCat::InputMissing,
                         std::string("Input file not found in VFS: ") + input_path);
            return 0;
        } else {
            fseek(checkFile, 0, SEEK_END);
            long fileSize = ftell(checkFile);
            fclose(checkFile);
            std::cout << "wasm_bridge: File exists in VFS: " << input_path << " (size: " << fileSize << " bytes)" << std::endl;
        }

        // Report: Starting conversion
        engine_progress_begin();   // BUG-38
        report_conversion_progress("LOADING", 0);

        // Convert filesystem path to a properly percent-encoded file:// URL
        // (H1: handles non-ASCII, spaces, '%' and '#' in filenames).
        std::string fileUrl;
        if (!makeFileUrl(input_path, fileUrl)) {
            report_conversion_progress("LOAD_FAILED", 0);
            return 0;
        }
        std::cout << "wasm_bridge: Loading document " << fileUrl << std::endl;

#ifdef WASM_DEBUG
        // Debug: Test OSL URL conversion and file operations BEFORE attempting to load.
        // Gated to WASM_DEBUG (H1 / LOW-combined): this ran on every production
        // conversion (5 file opens + stat + reads) and used createFromAscii on
        // user-influenced data.
        std::cout << "wasm_bridge: === Testing OSL file operations ===" << std::endl;
        OUString testUrl(fileUrl.c_str(), static_cast<sal_Int32>(fileUrl.size()), RTL_TEXTENCODING_UTF8);
        OUString testPath;
        osl::FileBase::RC oslResult = osl::FileBase::getSystemPathFromFileURL(testUrl, testPath);
        if (oslResult == osl::FileBase::E_None) {
            OString pathStr = OUStringToOString(testPath, RTL_TEXTENCODING_UTF8);
            std::cout << "wasm_bridge: OSL URL->path SUCCESS: " << pathStr.getStr() << std::endl;

            // Test 1: fopen (libc)
            FILE* checkOslFile = fopen(pathStr.getStr(), "rb");
            if (checkOslFile) {
                std::cout << "wasm_bridge: Test 1 (fopen) - SUCCESS" << std::endl;
                fclose(checkOslFile);
            } else {
                std::cout << "wasm_bridge: Test 1 (fopen) - FAILED errno=" << errno << std::endl;
            }

            // Test 2: stat (libc)
            struct stat st;
            if (stat(pathStr.getStr(), &st) == 0) {
                std::cout << "wasm_bridge: Test 2 (stat) - SUCCESS size=" << st.st_size << std::endl;
            } else {
                std::cout << "wasm_bridge: Test 2 (stat) - FAILED errno=" << errno << std::endl;
            }

            // Test 3: OSL osl_getFileStatus
            oslFileHandle hFile = nullptr;
            oslFileError oslErr = osl_openFile(testUrl.pData, &hFile, osl_File_OpenFlag_Read);
            if (oslErr == osl_File_E_None) {
                std::cout << "wasm_bridge: Test 3 (osl_openFile) - SUCCESS" << std::endl;

                // Read some bytes
                sal_uInt64 bytesRead = 0;
                char buffer[16];
                oslErr = osl_readFile(hFile, buffer, 16, &bytesRead);
                if (oslErr == osl_File_E_None) {
                    std::cout << "wasm_bridge: Test 4 (osl_readFile) - SUCCESS read " << bytesRead << " bytes" << std::endl;
                    std::cout << "wasm_bridge: First 4 bytes: "
                              << std::hex << (int)(unsigned char)buffer[0] << " "
                              << (int)(unsigned char)buffer[1] << " "
                              << (int)(unsigned char)buffer[2] << " "
                              << (int)(unsigned char)buffer[3] << std::dec << std::endl;
                } else {
                    std::cout << "wasm_bridge: Test 4 (osl_readFile) - FAILED error=" << oslErr << std::endl;
                }
                osl_closeFile(hFile);
            } else {
                std::cout << "wasm_bridge: Test 3 (osl_openFile) - FAILED error=" << oslErr << std::endl;
            }

            // Test 5: OSL DirectoryItem (used by UCB)
            osl::DirectoryItem dirItem;
            osl::FileBase::RC dirResult = osl::DirectoryItem::get(testUrl, dirItem);
            if (dirResult == osl::FileBase::E_None) {
                std::cout << "wasm_bridge: Test 5 (DirectoryItem::get) - SUCCESS" << std::endl;

                // Get file status
                osl::FileStatus fileStatus(osl_FileStatus_Mask_FileSize | osl_FileStatus_Mask_Type);
                if (dirItem.getFileStatus(fileStatus) == osl::FileBase::E_None) {
                    std::cout << "wasm_bridge: Test 6 (FileStatus) - SUCCESS size="
                              << fileStatus.getFileSize()
                              << " type=" << fileStatus.getFileType() << std::endl;
                } else {
                    std::cout << "wasm_bridge: Test 6 (FileStatus) - FAILED" << std::endl;
                }
            } else {
                std::cout << "wasm_bridge: Test 5 (DirectoryItem::get) - FAILED error=" << static_cast<int>(dirResult) << std::endl;
            }
        } else {
            std::cout << "wasm_bridge: OSL URL->path FAILED error: " << static_cast<int>(oslResult) << std::endl;
        }
        std::cout << "wasm_bridge: === End OSL tests ===" << std::endl;
#endif  // WASM_DEBUG

        ScopedLokDocument doc;
        try {
            // Determine the import filter from the true file suffix (M15: one
            // shared table with real suffix semantics, no substring matches).
            std::string filterOptions = importFilterOptionsForInput(input_path, format_filter);
            if (!filterOptions.empty()) {
                std::cout << "wasm_bridge: Using filter hint: " << redactOptions(filterOptions) << std::endl;
            } else {
                std::cout << "wasm_bridge: No filter hint; letting LOK auto-detect" << std::endl;
            }

            // Load the document - LOK expects file:// URLs
            // DEBUG: This is where the page-refresh hang occurs - see bugs/wasm_static_state_investigation.md
            std::cerr << "[DOCLOAD] ========================================" << std::endl << std::flush;
            std::cerr << "[DOCLOAD] About to call documentLoad()" << std::endl << std::flush;
            std::cerr << "[DOCLOAD] fileUrl: " << fileUrl << std::endl << std::flush;
            std::cerr << "[DOCLOAD] filterOptions: " << (filterOptions.empty() ? "(none)" : redactOptions(filterOptions)) << std::endl << std::flush;
            std::cerr << "[DOCLOAD] g_pOffice: " << (g_pOffice ? "valid" : "NULLPTR!") << std::endl << std::flush;
            std::cout << "wasm_bridge: Calling g_pOffice->documentLoad()..." << std::endl;
            std::cerr << "[BRIDGE] Calling documentLoad()..." << std::endl << std::flush;
            std::cerr << "[DOCLOAD] Calling documentLoad " << (filterOptions.empty() ? "WITHOUT" : "WITH")
                      << " filterOptions..." << std::endl << std::flush;
            doc.reset(loadDocument(fileUrl, filterOptions.c_str(), input_path));
            std::cerr << "[DOCLOAD] documentLoad() RETURNED!" << std::endl << std::flush;
            std::cerr << "[DOCLOAD] Result: " << (doc ? "SUCCESS - document pointer" : "FAILED - nullptr") << std::endl << std::flush;
            std::cerr << "[DOCLOAD] ========================================" << std::endl << std::flush;
            std::cout << "wasm_bridge: documentLoad() returned: " << (doc ? "document" : "nullptr") << std::endl;
            std::cerr << "[BRIDGE] documentLoad() returned: " << (doc ? "DOCUMENT" : "NULLPTR") << std::endl << std::flush;

            if (!doc) {
                report_conversion_progress("LOAD_FAILED", 0);
                std::cerr << "[BRIDGE] ERROR: Failed to load document." << std::endl << std::flush;
                reportLoadFailure();   // FG-021: password categories
                return 0;
            }

            // Report: Document loaded successfully
            engine_progress_loaded();   // BUG-38
            report_conversion_progress("LOADED", 50);
            std::cerr << "[BRIDGE] Document loaded successfully, preparing export..." << std::endl << std::flush;

            // For spreadsheet documents, convert formulas to values before export
            // This prevents add-in formula errors (e.g., DATE function) during PDF rendering
            int docType = doc->getDocumentType();
            if (docType == LOK_DOCTYPE_SPREADSHEET) {
                std::cerr << "[BRIDGE] Spreadsheet detected, converting formulas to values..." << std::endl << std::flush;
                report_conversion_progress("PROCESSING", 55);
                if (!convert_formulas_to_values(doc.get())) {
                    std::cerr << "[BRIDGE] Warning: formula-to-value conversion failed, continuing anyway" << std::endl << std::flush;
                }
                if (isCsvInput(input_path) && std::string(format_filter) == "pdf") {
                    autofitCsvColumns(doc.get());   // FG-047
                }
            }

            // Convert output path to a properly percent-encoded file:// URL (H1)
            std::string outputUrl;
            if (!makeFileUrl(output_path, outputUrl)) {
                report_conversion_progress("EXPORT_FAILED", 0);
                return 0;
            }
            std::cout << "wasm_bridge: Document loaded. Saving as " << format_filter << " to " << outputUrl << std::endl;

            // Report: Starting export
            report_conversion_progress("EXPORTING", 60);
            std::cerr << "[BRIDGE] Calling saveAs() for " << format_filter << " export..." << std::endl << std::flush;

            // Save the document
            // saveAs(url, format, filter_options)
            // For PDF, format is "pdf". Filter options can be nullptr.
            // For other formats, we may need to specify the filter name.
            std::string exportFormat(format_filter);
            const char* exportOptions = nullptr;
            std::string exportOptionsStr;

            // Map format names to LibreOffice export filters
            if (exportFormat == "html") {
                // HTML export - use internal filter name from LOK filter list
                // The UI name "HTML (StarWriter)" doesn't work, try internal names
                exportOptionsStr = "FilterName=XHTML Writer File";  // Try XHTML first
                exportOptions = exportOptionsStr.c_str();
                std::cerr << "[BRIDGE] Using HTML filter: " << redactOptions(exportOptionsStr) << std::endl << std::flush;
            } else if (exportFormat == "txt") {
                // Text export. Deliberately no exportOptionsStr here (BUG-27):
                // doc_saveAs() (desktop/source/lib/init.cxx) selects the actual
                // export filter from `format_filter` via its own extension map
                // (aWriterExtensionMap) -- it never parses a "FilterName=" prefix
                // out of the FilterOptions argument. Every other token in that
                // string (after stripping the special Watermark/FullSheetPreview/
                // Password/PDFVer/TakeOwnership/... sub-fields, none of which match)
                // is passed straight through, verbatim, as SID_FILE_FILTEROPTIONS.
                // For most writers that is harmless dead weight, but
                // SwASCWriter::SetupFilterOptions() (sw/source/filter/ascii/
                // wrtasc.cxx) is the one writer that actually parses that field --
                // via SwAsciiOptions::ReadUserData(), which treats it as
                // "charset,lineend,font,lang,BOM,hidden" CSV. A literal
                // "FilterName=Text" (no comma) is read whole as the *charset name*,
                // CharSetFromName() doesn't recognize it, and the export charset
                // silently becomes RTL_TEXTENCODING_DONTKNOW -- which is what
                // produced the low-byte truncation this bug report describes
                // (U+2019 -> raw 0x19). Leaving exportOptions as nullptr here means
                // SID_FILE_FILTEROPTIONS is never set for txt at all, so
                // SetupFilterOptions() takes its early return and the writer's own
                // default (SwAsciiOptions::Reset(), UTF-8 under Emscripten) applies
                // undisturbed. format_filter="txt" alone is sufficient for filter
                // selection -- confirmed against aWriterExtensionMap.
            } else if (exportFormat == "rtf") {
                // RTF export
                exportOptionsStr = "FilterName=Rich Text Format";
                exportOptions = exportOptionsStr.c_str();
            } else if (exportFormat == "docx") {
                // DOCX export
                exportOptionsStr = "FilterName=MS Word 2007 XML";
                exportOptions = exportOptionsStr.c_str();
            } else if (exportFormat == "odt") {
                // ODT export
                exportOptionsStr = "FilterName=writer8";
                exportOptions = exportOptionsStr.c_str();
            } else if (exportFormat == "xlsx") {
                // XLSX export
                exportOptionsStr = "FilterName=Calc MS Excel 2007 XML";
                exportOptions = exportOptionsStr.c_str();
            } else if (exportFormat == "ods") {
                // ODS export
                exportOptionsStr = "FilterName=calc8";
                exportOptions = exportOptionsStr.c_str();
            } else if (exportFormat == "csv") {
                // CSV export. These are the CSV filter's own positional options,
                // not a "FilterName=" (CB-002): doc_saveAs() picks the filter from
                // format_filter and passes this string through verbatim as the
                // filter options, the same mechanism as BUG-27 above. The old
                // "FilterName=Text - txt - csv (StarCalc)" was read as the field
                // separator token, and every row was written with no separators.
                exportOptionsStr = kCsvExportOptions;
                exportOptions = exportOptionsStr.c_str();
            } else if (exportFormat == "pptx") {
                // PPTX export
                exportOptionsStr = "FilterName=Impress MS PowerPoint 2007 XML";
                exportOptions = exportOptionsStr.c_str();
            } else if (exportFormat == "odp") {
                // ODP export
                exportOptionsStr = "FilterName=impress8";
                exportOptions = exportOptionsStr.c_str();
            } else if (exportFormat == "pdf") {
                // PDF export - use explicit filter based on document type
                // LOK auto-detection can fail with headless controller (no SfxViewFrame)
                if (docType == LOK_DOCTYPE_TEXT) {
                    exportOptionsStr = "FilterName=writer_pdf_Export";
                } else if (docType == LOK_DOCTYPE_SPREADSHEET) {
                    exportOptionsStr = "FilterName=calc_pdf_Export,SinglePageSheets=true";
                } else if (docType == LOK_DOCTYPE_PRESENTATION) {
                    exportOptionsStr = "FilterName=impress_pdf_Export";
                } else if (docType == LOK_DOCTYPE_DRAWING) {
                    exportOptionsStr = "FilterName=draw_pdf_Export";
                } else {
                    exportOptionsStr = "FilterName=writer_pdf_Export";
                }
                exportOptions = exportOptionsStr.c_str();
                // BUG-36 / FG-021: Calc PDF always, and any protected PDF, as JSON
                // FilterOptions (the one channel that reaches FilterData). The plain
                // strings above carry only a FilterName, which doc_saveAs ignores.
                if (docType == LOK_DOCTYPE_SPREADSHEET) {
                    exportOptionsStr = calcPdfOptionsJson();
                } else if (outputProtectionRequested()) {
                    std::vector<std::string> parts;
                    appendPdfSecurityJson(parts);
                    exportOptionsStr = joinJson(parts);
                }
                exportOptions = exportOptionsStr.c_str();
                std::cerr << "[BRIDGE] Using explicit PDF filter: " << redactOptions(exportOptionsStr) << std::endl << std::flush;
            }
            // FG-021: ODF/OOXML output protection (checkOutputProtection has already
            // refused it for every other target).
            if (outputProtectionRequested() && !isPdfTarget(exportFormat)) {
                appendOdfPassword(exportOptionsStr);
                exportOptions = exportOptionsStr.c_str();
                std::cerr << "[BRIDGE] Export options: " << redactOptions(exportOptionsStr) << std::endl << std::flush;
            }
            // For unknown formats, let LibreOffice auto-detect

            double t_save_start = emscripten_get_now();
            bool success;
            {
                SaveProgressScope saveScope;   // FG-173: progress during save = EXPORTING
                success = doc->saveAs(outputUrl.c_str(), format_filter, exportOptions);
            }
            double t_save_end = emscripten_get_now();
            std::cerr << "[BRIDGE] saveAs() returned: " << (success ? "SUCCESS" : "FAILURE")
                      << " (took " << (t_save_end - t_save_start) << "ms)" << std::endl << std::flush;

            if (success) {
                report_conversion_progress("COMPLETE", 100);
                std::cout << "wasm_bridge: Conversion successful." << std::endl;
                std::cerr << "[BRIDGE] Conversion complete!" << std::endl << std::flush;
            } else {
                report_conversion_progress("EXPORT_FAILED", 0);
                std::cerr << "[BRIDGE] ERROR: Conversion failed inside LOK." << std::endl << std::flush;
                logAndCaptureLokError(BridgeErrCat::Export,
                                      std::string("Export to ") + format_filter + " failed");
            }

            // Properly close document via UNO to release internal caches (CloseDoc
            // + delete) before logging heap stats — ordering preserved by the
            // explicit reset(). This mirrors what Collabora Online does.
            std::cerr << "[BRIDGE] Closing document via .uno:CloseDoc..." << std::endl << std::flush;
            doc.reset();
            std::cerr << "[BRIDGE] Document deleted, returning " << (success ? 1 : 0) << std::endl << std::flush;

            // Log heap stats to diagnose fragmentation
            log_heap_stats("After conversion");

            return success ? 1 : 0;

        } catch (const std::exception& e) {
            std::cerr << "wasm_bridge: Exception during conversion: " << e.what() << std::endl;
            setLastError(BridgeErrCat::Internal, std::string("Exception during conversion: ") + e.what());
            return 0;  // doc closed/deleted by ScopedLokDocument destructor
        } catch (...) {
            std::cerr << "wasm_bridge: Unknown exception during conversion." << std::endl;
            setLastError(BridgeErrCat::Internal, "Unknown exception during conversion");
            return 0;  // doc closed/deleted by ScopedLokDocument destructor
        }
    }

    /**
     * Convert a document to PDF with format-specific export options.
     * @param input_path: VFS path to source file (e.g., "/tmp/input.docx")
     * @param output_path: VFS path for destination file (e.g., "/tmp/output.pdf")
     * @param format_filter: Export filter name (e.g., "pdf")
     * @param page_range: Page range string (e.g., "1-3" or "1,3,5"), empty for all pages
     * @param max_image_resolution: Max image resolution DPI (75/150/300), 0 for default
     * @param quality: JPEG quality for embedded images (1-100), 0 for default
     * @return 1 on success, 0 on failure.
     */
    EMSCRIPTEN_KEEPALIVE
    int convert_document_with_pdf_options(const char* input_path, const char* output_path,
                                          const char* format_filter, const char* page_range,
                                          int max_image_resolution, int quality) {
        ConversionSecretsScope secretsScope;   // FG-021: secrets and Calc options live for this call only
        clearLastError();
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: Error - Office not initialized." << std::endl;
            setLastError(BridgeErrCat::Init, "LibreOffice engine not initialized");
            return 0;
        }
        if (!checkOutputProtection("pdf")) {   // FG-021: this function always exports PDF
            report_conversion_progress("EXPORT_FAILED", 0);
            return 0;
        }

        std::cout << "wasm_bridge: convert_document_with_pdf_options called" << std::endl;
        std::cout << "wasm_bridge:   input: " << input_path << std::endl;
        std::cout << "wasm_bridge:   output: " << output_path << std::endl;
        std::cout << "wasm_bridge:   format: " << format_filter << std::endl;
        std::cout << "wasm_bridge:   page_range: " << (page_range ? page_range : "(null)") << std::endl;
        std::cout << "wasm_bridge:   max_image_resolution: " << max_image_resolution << std::endl;
        std::cout << "wasm_bridge:   quality: " << quality << std::endl;

        // Check if file exists in VFS
        FILE* checkFile = fopen(input_path, "rb");
        if (!checkFile) {
            std::cerr << "wasm_bridge: File does NOT exist in VFS: " << input_path << std::endl;
            setLastError(BridgeErrCat::InputMissing,
                         std::string("Input file not found in VFS: ") + input_path);
            return 0;
        }
        fseek(checkFile, 0, SEEK_END);
        long fileSize = ftell(checkFile);
        fclose(checkFile);
        std::cout << "wasm_bridge: File exists, size: " << fileSize << " bytes" << std::endl;

        engine_progress_begin();   // BUG-38

        report_conversion_progress("LOADING", 0);

        // Convert filesystem path to a properly percent-encoded file:// URL (H1)
        std::string fileUrl;
        if (!makeFileUrl(input_path, fileUrl)) {
            report_conversion_progress("LOAD_FAILED", 0);
            return 0;
        }

        ScopedLokDocument doc;
        try {
            // Determine the import filter from the true file suffix (M15: shared
            // table, same well-tested hints as convert_document).
            std::string filterOptions = importFilterOptionsForInput(input_path, format_filter);

            // Load the document
            std::cerr << "[BRIDGE] Loading document for PDF export with options..." << std::endl << std::flush;
            doc.reset(loadDocument(fileUrl, filterOptions.c_str(), input_path));

            if (!doc) {
                report_conversion_progress("LOAD_FAILED", 0);
                std::cerr << "[BRIDGE] Failed to load document." << std::endl;
                reportLoadFailure();   // FG-021: password categories
                return 0;
            }

            engine_progress_loaded();   // BUG-38

            report_conversion_progress("LOADED", 50);

            // For spreadsheet documents, convert formulas to values before export
            int docType = doc->getDocumentType();
            if (docType == LOK_DOCTYPE_SPREADSHEET) {
                report_conversion_progress("PROCESSING", 55);
                if (!convert_formulas_to_values(doc.get())) {
                    std::cerr << "[BRIDGE] Warning: formula-to-value conversion failed, continuing anyway" << std::endl << std::flush;
                }
                if (isCsvInput(input_path)) {
                    autofitCsvColumns(doc.get());   // FG-047 (this function always exports PDF)
                }
            }

            // Build PDF export options as a JSON FilterOptions object (3b-full).
            //
            // The PDF export filter (filter/source/pdf/pdffilter.cxx) only honors its
            // options through FilterData PropertyValues. Through the LOK saveAs API the
            // one channel that reaches FilterData is a FilterOptions *string that starts
            // with '{'*: doc_saveAs leaves FilterData empty for a JSON FilterOptions
            // (init.cxx), and the filter then parses it via
            // comphelper::JsonToPropertyValues into FilterData. The former flat
            // "PageRange=..,Quality=.." string was set as a plain (non-JSON) FilterOptions,
            // which PDF export never reads — so page range / quality / resolution silently
            // had no effect (output was byte-identical). JSON is the fix.
            //
            // The concrete filter (writer_/calc_/impress_/draw_pdf_Export) is resolved by
            // LOK from the document type via its extension map, so no FilterName is injected
            // here (the old FilterName= token was inert dead weight in the options string).
            //
            // JsonToPropertyValues shape: {"Key":{"type":"<t>","value":"<v>"}, ...}.
            // doc_saveAs comma-splits then re-joins FilterOptions with ", " before the
            // filter sees it; that only inserts spaces after commas (valid JSON, and
            // StringRangeEnumerator skips spaces in a page range), so it is safe.
            std::vector<std::string> jsonParts;
            if (page_range && strlen(page_range) > 0) {
                // M14: reject anything that could break out of the JSON string / inject keys.
                if (!isValidPageRange(page_range)) {
                    setLastError(BridgeErrCat::InvalidParam,
                                 std::string("Invalid page range: ") + page_range);
                    report_conversion_progress("EXPORT_FAILED", 0);
                    return 0;
                }
                jsonParts.push_back("\"PageRange\":{\"type\":\"string\",\"value\":\"" +
                                    jsonEscape(page_range) + "\"}");
                std::cout << "wasm_bridge: Using PageRange=" << page_range << std::endl;
            }
            if (max_image_resolution > 0) {
                // M14: sanity upper bound.
                if (max_image_resolution > 2400) {
                    setLastError(BridgeErrCat::InvalidParam,
                                 "Image resolution out of range: " +
                                 std::to_string(max_image_resolution) + " (max 2400)");
                    report_conversion_progress("EXPORT_FAILED", 0);
                    return 0;
                }
                // MaxImageResolution only takes effect when ReduceImageResolution is on.
                jsonParts.push_back("\"ReduceImageResolution\":{\"type\":\"boolean\",\"value\":\"true\"}");
                jsonParts.push_back("\"MaxImageResolution\":{\"type\":\"long\",\"value\":\"" +
                                    std::to_string(max_image_resolution) + "\"}");
                std::cout << "wasm_bridge: Using MaxImageResolution=" << max_image_resolution << std::endl;
            }
            if (quality > 0 && quality <= 100) {
                jsonParts.push_back("\"Quality\":{\"type\":\"long\",\"value\":\"" +
                                    std::to_string(quality) + "\"}");
                std::cout << "wasm_bridge: Using Quality=" << quality << std::endl;
            }

            // BUG-36: Calc cell comments only when asked, on EVERY Calc path. Not even
            // "no options" is safe to leave to defaults: doc_saveAs puts ExportBookmarks
            // into FilterData for any non-JSON options string, so FilterData is never
            // empty, the PDF filter never reads its registry defaults (pdffilter.cxx),
            // and pdfexport.cxx's own default (ExportNotes = true) applies. Setting it in
            // JSON changes nothing else: the other defaults come from pdfexport.cxx on
            // both routes (measured: every other Calc output is byte-identical).
            if (docType == LOK_DOCTYPE_SPREADSHEET) {
                jsonParts.push_back(jsonProp("ExportNotes", "boolean",
                                             g_calcIncludeCellComments ? "true" : "false"));
            }
            appendPdfSecurityJson(jsonParts);   // FG-021

            // Assemble the JSON object. Empty when no options were requested, in which case
            // saveAs is called with nullptr and produces a default full-fidelity PDF.
            std::string exportOptions;
            if (!jsonParts.empty()) {
                exportOptions = joinJson(jsonParts);
                std::cout << "wasm_bridge: PDF export FilterOptions JSON: " << redactOptions(exportOptions) << std::endl;
            }

            // Convert output path to a properly percent-encoded file:// URL (H1)
            std::string outputUrl;
            if (!makeFileUrl(output_path, outputUrl)) {
                report_conversion_progress("EXPORT_FAILED", 0);
                return 0;
            }

            report_conversion_progress("EXPORTING", 60);
            std::cerr << "[BRIDGE] Calling saveAs() for PDF export with options..." << std::endl << std::flush;

            double t_save_start = emscripten_get_now();
            bool success;
            {
                SaveProgressScope saveScope;   // FG-173
                if (!exportOptions.empty()) {
                    success = doc->saveAs(outputUrl.c_str(), "pdf", exportOptions.c_str());
                } else {
                    success = doc->saveAs(outputUrl.c_str(), "pdf", nullptr);
                }
            }
            double t_save_end = emscripten_get_now();

            std::cerr << "[BRIDGE] saveAs() returned: " << (success ? "SUCCESS" : "FAILURE")
                      << " (took " << (t_save_end - t_save_start) << "ms)" << std::endl << std::flush;

            if (success) {
                report_conversion_progress("COMPLETE", 100);
                std::cerr << "[BRIDGE] PDF conversion with options complete!" << std::endl << std::flush;
            } else {
                report_conversion_progress("EXPORT_FAILED", 0);
                std::cerr << "[BRIDGE] PDF conversion with options failed." << std::endl;
                logAndCaptureLokError(BridgeErrCat::Export, "Export to pdf failed");
            }

            // Properly close document via UNO to release internal caches before
            // logging heap stats.
            doc.reset();
            log_heap_stats("After PDF conversion with options");
            return success ? 1 : 0;

        } catch (const std::exception& e) {
            std::cerr << "wasm_bridge: Exception during PDF conversion: " << e.what() << std::endl;
            setLastError(BridgeErrCat::Internal, std::string("Exception during PDF conversion: ") + e.what());
            return 0;  // doc closed/deleted by ScopedLokDocument destructor
        } catch (...) {
            std::cerr << "wasm_bridge: Unknown exception during PDF conversion." << std::endl;
            setLastError(BridgeErrCat::Internal, "Unknown exception during PDF conversion");
            return 0;  // doc closed/deleted by ScopedLokDocument destructor
        }
    }

    /**
     * Convert a CSV/TSV document with custom import options.
     * @param input_path: VFS path to source file (e.g., "/tmp/input.csv")
     * @param output_path: VFS path for destination file (e.g., "/tmp/output.pdf")
     * @param format_filter: Export filter name (e.g., "pdf")
     * @param delimiter: Field separator ASCII code (44=comma, 9=tab, 59=semicolon, 124=pipe, 0=auto)
     * @param encoding: Character encoding (e.g., "UTF-8", "ISO-8859-1", "Windows-1252")
     * @param start_row: Row to start reading (1=first row, 2=skip header)
     * @return 1 on success, 0 on failure.
     */
    EMSCRIPTEN_KEEPALIVE
    int convert_csv_with_options(const char* input_path, const char* output_path,
                                 const char* format_filter, int delimiter,
                                 const char* encoding, int start_row) {
        ConversionSecretsScope secretsScope;   // FG-021: secrets and Calc options live for this call only
        clearLastError();
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: Error - Office not initialized." << std::endl;
            setLastError(BridgeErrCat::Init, "LibreOffice engine not initialized");
            return 0;
        }
        if (!checkOutputProtection(format_filter)) {   // FG-021: refused before any work
            report_conversion_progress("EXPORT_FAILED", 0);
            return 0;
        }

        std::cout << "wasm_bridge: convert_csv_with_options called" << std::endl;
        std::cout << "wasm_bridge:   input: " << input_path << std::endl;
        std::cout << "wasm_bridge:   output: " << output_path << std::endl;
        std::cout << "wasm_bridge:   format: " << format_filter << std::endl;
        std::cout << "wasm_bridge:   delimiter: " << delimiter << std::endl;
        std::cout << "wasm_bridge:   encoding: " << encoding << std::endl;
        std::cout << "wasm_bridge:   start_row: " << start_row << std::endl;

        report_conversion_progress("STARTING", 0);

        // Build a properly percent-encoded file:// URL (H1)
        std::string fileUrl;
        if (!makeFileUrl(input_path, fileUrl)) {
            report_conversion_progress("LOAD_FAILED", 0);
            return 0;
        }

        ScopedLokDocument doc;
        try {
            // Validate options up front (M14). The LOK CSV import string is
            // strictly positional, so an unvalidated value could shift later
            // tokens — e.g. an encoding of "UTF-8,2" would silently drop the
            // first data row. Reject loudly rather than reinterpret.
            if (delimiter < 0 || delimiter > 255) {
                setLastError(BridgeErrCat::InvalidParam,
                             "Invalid CSV delimiter code: " + std::to_string(delimiter));
                report_conversion_progress("LOAD_FAILED", 0);
                return 0;
            }
            const char* canonicalEnc = canonicalEncoding(encoding);
            if (!canonicalEnc) {
                setLastError(BridgeErrCat::InvalidParam,
                             std::string("Unsupported encoding: ") + (encoding ? encoding : "(null)"));
                report_conversion_progress("LOAD_FAILED", 0);
                return 0;
            }
            if (start_row < 1) {
                setLastError(BridgeErrCat::InvalidParam,
                             "Invalid start row: " + std::to_string(start_row) + " (must be >= 1)");
                report_conversion_progress("LOAD_FAILED", 0);
                return 0;
            }

            // Build CSV filter options
            // Format: Batch=true,[field_sep],[quote_char],[charset],[start_row],
            // Batch=true enables DialogCancelMode::LOKSilent to suppress import dialogs
            std::string filterOptions = "Batch=true,";

            // Delimiter: 0 means auto-detect (use empty to trigger auto-detection)
            if (delimiter > 0) {
                filterOptions += std::to_string(delimiter);
            }
            filterOptions += ",";

            // Quote character (always double quote = 34)
            filterOptions += "34,";

            // Character encoding (canonical whitelist value only)
            filterOptions += canonicalEnc;
            filterOptions += ",";

            // Start row
            filterOptions += std::to_string(start_row);
            filterOptions += ",";

            std::cout << "wasm_bridge: Using CSV filter options: " << redactOptions(filterOptions) << std::endl;

            // Load the document
            engine_progress_begin();   // BUG-38
            report_conversion_progress("LOADING", 10);
            std::cout << "wasm_bridge: Calling documentLoad()..." << std::endl;
            doc.reset(loadDocument(fileUrl, filterOptions.c_str(), input_path));
            std::cout << "wasm_bridge: documentLoad() returned: " << (doc ? "document" : "nullptr") << std::endl;

            if (!doc) {
                report_conversion_progress("LOAD_FAILED", 0);
                reportLoadFailure();   // FG-021: password categories
                return 0;
            }

            engine_progress_loaded();   // BUG-38

            report_conversion_progress("LOADED", 30);

            // Convert formulas to values before export (if any cells were interpreted as formulas)
            // This is less common for CSV but still possible
            report_conversion_progress("PROCESSING", 35);
            if (!convert_formulas_to_values(doc.get())) {
                std::cerr << "wasm_bridge: Warning: formula-to-value conversion failed, continuing anyway" << std::endl;
            }
            if (std::string(format_filter) == "pdf") {
                autofitCsvColumns(doc.get());   // FG-047
            }

            // Determine export format and options
            std::string exportFormat(format_filter);
            std::string exportOptionsStr;
            const char* exportOptions = nullptr;

            if (exportFormat == "pdf") {
                exportOptionsStr = calcPdfOptionsJson();   // BUG-36 / FG-021
                exportOptions = exportOptionsStr.c_str();
            } else if (exportFormat == "xlsx") {
                exportOptionsStr = "FilterName=Calc MS Excel 2007 XML";
                exportOptions = exportOptionsStr.c_str();
            } else if (exportFormat == "ods") {
                exportOptionsStr = "FilterName=calc8";
                exportOptions = exportOptionsStr.c_str();
            } else if (exportFormat == "csv") {
                exportOptionsStr = kCsvExportOptions;  // CB-002: see convert_document
                exportOptions = exportOptionsStr.c_str();
            }
            if (outputProtectionRequested() && !isPdfTarget(exportFormat)) {   // FG-021
                appendOdfPassword(exportOptionsStr);
                exportOptions = exportOptionsStr.c_str();
            }
            std::cout << "wasm_bridge: Export options: " << redactOptions(exportOptionsStr) << std::endl;

            // Build a properly percent-encoded output file:// URL (H1)
            std::string outputUrl;
            if (!makeFileUrl(output_path, outputUrl)) {
                report_conversion_progress("EXPORT_FAILED", 0);
                return 0;
            }

            // Save the document
            report_conversion_progress("EXPORTING", 50);
            std::cout << "wasm_bridge: Calling saveAs()..." << std::endl;
            bool saved;
            {
                SaveProgressScope saveScope;   // FG-173
                saved = doc->saveAs(outputUrl.c_str(), exportFormat.c_str(), exportOptions);
            }
            std::cout << "wasm_bridge: saveAs() returned: " << (saved ? "true" : "false") << std::endl;

            // Properly close document via UNO to release internal caches. Keep the
            // historical ordering: close/delete before reading the error below.
            doc.reset();

            if (!saved) {
                report_conversion_progress("SAVE_FAILED", 0);
                logAndCaptureLokError(BridgeErrCat::Export,
                                      std::string("Export to ") + exportFormat + " failed");
                return 0;
            }

            report_conversion_progress("COMPLETE", 100);
            std::cout << "wasm_bridge: CSV conversion successful!" << std::endl;
            return 1;

        } catch (const std::exception& e) {
            std::cerr << "wasm_bridge: Exception during CSV conversion: " << e.what() << std::endl;
            setLastError(BridgeErrCat::Internal, std::string("Exception during CSV conversion: ") + e.what());
            return 0;  // doc closed/deleted by ScopedLokDocument destructor
        } catch (...) {
            std::cerr << "wasm_bridge: Unknown exception during CSV conversion." << std::endl;
            setLastError(BridgeErrCat::Internal, "Unknown exception during CSV conversion");
            return 0;  // doc closed/deleted by ScopedLokDocument destructor
        }
    }

    /**
     * Convert a spreadsheet document with options for sheet selection and print area.
     * @param input_path: VFS path to source file (e.g., "/tmp/input.xlsx")
     * @param output_path: VFS path for destination file (e.g., "/tmp/output.pdf")
     * @param format_filter: Export filter name (e.g., "pdf")
     * @param sheet_index: Sheet to export (-1 for all sheets, 0-based index otherwise)
     * @param print_area: Print area range (e.g., "A1:M50", empty string for full sheet)
     * @return 1 on success, 0 on failure.
     */
    EMSCRIPTEN_KEEPALIVE
    int convert_spreadsheet_with_options(const char* input_path, const char* output_path,
                                         const char* format_filter, int sheet_index,
                                         const char* print_area) {
        ConversionSecretsScope secretsScope;   // FG-021: secrets and Calc options live for this call only
        clearLastError();
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: Error - Office not initialized." << std::endl;
            setLastError(BridgeErrCat::Init, "LibreOffice engine not initialized");
            return 0;
        }
        if (!checkOutputProtection(format_filter)) {   // FG-021: refused before any work
            report_conversion_progress("EXPORT_FAILED", 0);
            return 0;
        }

        std::cout << "wasm_bridge: convert_spreadsheet_with_options called" << std::endl;
        std::cout << "wasm_bridge:   input: " << input_path << std::endl;
        std::cout << "wasm_bridge:   output: " << output_path << std::endl;
        std::cout << "wasm_bridge:   format: " << format_filter << std::endl;
        std::cout << "wasm_bridge:   sheet_index: " << sheet_index << std::endl;
        std::cout << "wasm_bridge:   print_area: " << (print_area ? print_area : "(null)") << std::endl;

        // Check if file exists
        FILE* checkFile = fopen(input_path, "rb");
        if (!checkFile) {
            std::cerr << "wasm_bridge: File does NOT exist in VFS: " << input_path << std::endl;
            setLastError(BridgeErrCat::InputMissing,
                         std::string("Input file not found in VFS: ") + input_path);
            return 0;
        }
        fseek(checkFile, 0, SEEK_END);
        long fileSize = ftell(checkFile);
        fclose(checkFile);
        std::cout << "wasm_bridge: File exists, size: " << fileSize << " bytes" << std::endl;

        engine_progress_begin();   // BUG-38

        report_conversion_progress("LOADING", 0);

        // Convert to a properly percent-encoded file:// URL (H1)
        std::string fileUrl;
        if (!makeFileUrl(input_path, fileUrl)) {
            report_conversion_progress("LOAD_FAILED", 0);
            return 0;
        }

        // Determine the import filter from the true file suffix (M15: shared table).
        std::string filterOptions = importFilterOptionsForInput(input_path, format_filter);

        ScopedLokDocument doc;
        try {
            // Load the document
            std::cerr << "[BRIDGE] Loading spreadsheet..." << std::endl << std::flush;
            doc.reset(loadDocument(fileUrl, filterOptions.c_str(), input_path));

            if (!doc) {
                report_conversion_progress("LOAD_FAILED", 0);
                std::cerr << "[BRIDGE] Failed to load spreadsheet." << std::endl;
                reportLoadFailure();   // FG-021: password categories
                return 0;
            }

            engine_progress_loaded();   // BUG-38

            report_conversion_progress("LOADED", 50);
            std::cerr << "[BRIDGE] Spreadsheet loaded successfully." << std::endl << std::flush;

            // Convert formulas to values before export
            // This prevents add-in formula errors (e.g., DATE function) during PDF rendering
            report_conversion_progress("PROCESSING", 55);
            if (!convert_formulas_to_values(doc.get())) {
                std::cerr << "[BRIDGE] Warning: formula-to-value conversion failed, continuing anyway" << std::endl << std::flush;
            }

            // Get sheet count
            int numParts = doc->getParts();
            std::cout << "wasm_bridge: Document has " << numParts << " sheets" << std::endl;

            // Handle sheet selection
            if (sheet_index >= 0) {
                if (sheet_index >= numParts) {
                    std::cerr << "wasm_bridge: Sheet index " << sheet_index << " out of range (0-" << (numParts-1) << ")" << std::endl;
                    report_conversion_progress("EXPORT_FAILED", 0);
                    setLastError(BridgeErrCat::InvalidParam,
                                 "Sheet index " + std::to_string(sheet_index) +
                                 " out of range (0.." + std::to_string(numParts - 1) + ")");
                    return 0;  // doc closed/deleted by ScopedLokDocument destructor
                }

                // Get sheet name for logging
                char* partName = doc->getPartName(sheet_index);
                std::cout << "wasm_bridge: Selecting sheet " << sheet_index << ": " << (partName ? partName : "unknown") << std::endl;
                if (partName) free(partName);

                // Set active sheet
                doc->setPart(sheet_index);
                std::cout << "wasm_bridge: Active sheet set to " << sheet_index << std::endl;
            }

            // Build a properly percent-encoded output file:// URL (H1)
            std::string outputUrl;
            if (!makeFileUrl(output_path, outputUrl)) {
                report_conversion_progress("EXPORT_FAILED", 0);
                return 0;
            }

            // For PDF export with specific sheet, we need to use filter options
            // The PDF export filter supports "PageRange", "Selection", "SinglePageSheets" options
            std::vector<std::string> optionsList;

            std::string ef(format_filter);
            if (ef == "pdf" || ef == "calc_pdf_Export") {
                // Always use SinglePageSheets for PDF export — ensures all sheets are included
                // Without this, headless WASM only renders the active sheet (no SfxViewShell)
                optionsList.push_back("SinglePageSheets=true");
                if (ef == "pdf") {
                    optionsList.push_back("FilterName=calc_pdf_Export");
                }
                if (sheet_index >= 0) {
                    std::cout << "wasm_bridge: Using SinglePageSheets for sheet " << sheet_index << std::endl;
                } else {
                    std::cout << "wasm_bridge: Using SinglePageSheets for all " << numParts << " sheets" << std::endl;
                }
            }

            // Handle print area / page range if specified
            // Format: "A1:M50" for cell range, or "1-5" for page range
            if (print_area && strlen(print_area) > 0) {
                // M14: reject anything outside a cell range / page range so it can
                // never inject extra saveAs options.
                if (!isValidPrintArea(print_area)) {
                    setLastError(BridgeErrCat::InvalidParam,
                                 std::string("Invalid print area: ") + print_area);
                    report_conversion_progress("EXPORT_FAILED", 0);
                    return 0;
                }
                std::string pa(print_area);

                // Check if it's a page range (contains dash and digits) or cell range (contains colon)
                if (pa.find(':') != std::string::npos) {
                    // Cell range like A1:M50 or Sheet1.A1:B2 -- applied on the UNO
                    // MODEL (XPrintAreas::setPrintAreas), never through
                    // .uno:DefinePrintArea. See getSpreadsheetModel() above for
                    // why the dispatch route is dead in headless WASM and how the
                    // model is reached. Every failure below is LOUD: this branch
                    // was a silent no-op twice already, and a third silent
                    // no-op is not an acceptable outcome.
                    //
                    // SYNTAX: Calc addresses sheets with a DOT (Sheet1.A1:B2); the
                    // spreadsheet world at large, and our own UI, use Excel's BANG
                    // (Sheet1!A1:B2). Accept both and normalise here, so the user
                    // is not required to know which engine is underneath.
                    std::string unoRange(pa);
                    std::replace(unoRange.begin(), unoRange.end(), '!', '.');

                    std::string sheetName, cellRange;
                    splitPrintArea(unoRange, sheetName, cellRange);
                    std::cout << "wasm_bridge: Setting print area " << pa
                              << " (sheet='" << sheetName << "', range='"
                              << cellRange << "')" << std::endl;

                    auto failPrintArea = [&](const std::string& why) {
                        std::cerr << "wasm_bridge: print area failed: " << why << std::endl;
                        setLastError(BridgeErrCat::InvalidParam,
                                     std::string("Could not apply print area '") + pa + "': " + why);
                        report_conversion_progress("EXPORT_FAILED", 0);
                    };

                    try {
                        css::uno::Reference<css::sheet::XSpreadsheetDocument> xSheetDoc =
                            getSpreadsheetModel(doc.get());
                        if (!xSheetDoc.is()) {
                            failPrintArea("document does not expose a spreadsheet model");
                            return 0;  // doc closed by ScopedLokDocument destructor
                        }

                        css::uno::Reference<css::container::XIndexAccess> xSheetsIdx(
                            xSheetDoc->getSheets(), css::uno::UNO_QUERY);
                        if (!xSheetsIdx.is()) {
                            failPrintArea("sheet collection is not index-accessible");
                            return 0;
                        }
                        const sal_Int32 nSheets = xSheetsIdx->getCount();

                        // Resolve which sheet the range belongs to.
                        sal_Int32 nTargetSheet = (sheet_index >= 0) ? sheet_index : 0;
                        if (!sheetName.empty()) {
                            const OUString aWanted = utf8ToOUString(sheetName);
                            sal_Int32 nFound = -1;
                            for (sal_Int32 i = 0; i < nSheets; ++i) {
                                css::uno::Reference<css::container::XNamed> xNamed(
                                    xSheetsIdx->getByIndex(i), css::uno::UNO_QUERY);
                                if (xNamed.is() && xNamed->getName().equalsIgnoreAsciiCase(aWanted)) {
                                    nFound = i;
                                    break;
                                }
                            }
                            if (nFound < 0) {
                                failPrintArea("no sheet named '" + sheetName + "' in this document");
                                return 0;
                            }
                            // A sheet-qualified range plus a different explicit
                            // sheet selection is a contradiction. Exporting one
                            // sheet while restricting the print area of another
                            // would hand back a PDF that honours neither request,
                            // so refuse instead of guessing.
                            if (sheet_index >= 0 && sheet_index != nFound) {
                                failPrintArea("range names sheet '" + sheetName + "' (index " +
                                              std::to_string(nFound) + ") but sheet " +
                                              std::to_string(sheet_index) + " was selected for export");
                                return 0;
                            }
                            nTargetSheet = nFound;
                        }

                        if (nTargetSheet < 0 || nTargetSheet >= nSheets) {
                            failPrintArea("sheet index " + std::to_string(nTargetSheet) +
                                          " out of range (0.." + std::to_string(nSheets - 1) + ")");
                            return 0;
                        }

                        css::uno::Reference<css::sheet::XSpreadsheet> xSheet(
                            xSheetsIdx->getByIndex(nTargetSheet), css::uno::UNO_QUERY);
                        if (!xSheet.is()) {
                            failPrintArea("could not obtain sheet " + std::to_string(nTargetSheet));
                            return 0;
                        }

                        css::uno::Reference<css::table::XCellRange> xRange =
                            xSheet->getCellRangeByName(utf8ToOUString(cellRange));
                        if (!xRange.is()) {
                            failPrintArea("'" + cellRange + "' is not a valid cell range");
                            return 0;
                        }

                        css::uno::Reference<css::sheet::XCellRangeAddressable> xAddressable(
                            xRange, css::uno::UNO_QUERY);
                        if (!xAddressable.is()) {
                            failPrintArea("cell range '" + cellRange + "' has no address");
                            return 0;
                        }
                        const css::table::CellRangeAddress aAddr = xAddressable->getRangeAddress();

                        css::uno::Reference<css::sheet::XPrintAreas> xPrintAreas(
                            xSheet, css::uno::UNO_QUERY);
                        if (!xPrintAreas.is()) {
                            failPrintArea("sheet does not support print areas");
                            return 0;
                        }
                        xPrintAreas->setPrintAreas(
                            css::uno::Sequence<css::table::CellRangeAddress>{ aAddr });

                        // Verify it stuck. setPrintAreas() returns void and
                        // ScTableSheetObj::setPrintAreas silently returns when it
                        // has no ScDocShell, so a read-back is the only way to
                        // know the value was actually stored.
                        const css::uno::Sequence<css::table::CellRangeAddress> aReadBack =
                            xPrintAreas->getPrintAreas();
                        if (aReadBack.getLength() != 1 ||
                            aReadBack[0].Sheet       != aAddr.Sheet ||
                            aReadBack[0].StartColumn != aAddr.StartColumn ||
                            aReadBack[0].StartRow    != aAddr.StartRow ||
                            aReadBack[0].EndColumn   != aAddr.EndColumn ||
                            aReadBack[0].EndRow      != aAddr.EndRow) {
                            failPrintArea("print area was not stored on the document "
                                          "(read-back returned " +
                                          std::to_string(aReadBack.getLength()) + " area(s))");
                            return 0;
                        }

                        std::cout << "wasm_bridge: Print area set on sheet " << nTargetSheet
                                  << " -> [" << aAddr.StartColumn << "," << aAddr.StartRow
                                  << " .. " << aAddr.EndColumn << "," << aAddr.EndRow << "]"
                                  << std::endl;

                        // Make the export follow the sheet the print area is on.
                        // Without SinglePageSheets (dropped just below) headless
                        // WASM renders the active sheet only, so a print area on
                        // a non-active sheet would otherwise be invisible.
                        if (sheet_index < 0 && nTargetSheet != 0) {
                            doc->setPart(static_cast<int>(nTargetSheet));
                            std::cout << "wasm_bridge: Active sheet set to " << nTargetSheet
                                      << " to match the print area" << std::endl;
                        }
                    } catch (const css::uno::Exception& e) {
                        failPrintArea(std::string("UNO exception: ") + ouStringToUtf8(e.Message));
                        return 0;
                    }

                    // A print area and SinglePageSheets are contradictory requests:
                    // the latter forces every sheet onto one page and overrides the
                    // area we just defined. It is added unconditionally above
                    // because headless WASM otherwise renders only the active
                    // sheet, so drop it here rather than there -- only when the
                    // user actually asked for a specific range.
                    optionsList.erase(
                        std::remove(optionsList.begin(), optionsList.end(),
                                    std::string("SinglePageSheets=true")),
                        optionsList.end());
                } else if (pa.find('-') != std::string::npos || std::isdigit(static_cast<unsigned char>(pa[0]))) {
                    // Page range like "1-5" or "1"
                    optionsList.push_back("PageRange=" + pa);
                    std::cout << "wasm_bridge: Using PageRange=" << pa << std::endl;
                } else {
                    // Neither a cell range nor a page range: e.g. "A1" or
                    // "Sheet1.A1". isValidPrintArea() lets these through, and
                    // until now they fell off the end of this if/else and were
                    // silently discarded -- the whole sheet came out and the
                    // conversion reported success. Same silent-wrong-answer class
                    // as the cell-range bug above, so refuse it out loud.
                    setLastError(BridgeErrCat::InvalidParam,
                                 std::string("Print area '") + pa +
                                 "' is neither a cell range (A1:B5, Sheet1!A1:B5) "
                                 "nor a page range (1-5)");
                    report_conversion_progress("EXPORT_FAILED", 0);
                    return 0;  // doc closed by ScopedLokDocument destructor
                }
            }

            // Build final options string
            std::string exportOptions;
            if (isPdfTarget(ef)) {
                // BUG-36 / FG-021: JSON FilterOptions, the one channel that reaches the
                // PDF filter's FilterData. None of the plain tokens above ever did
                // (FilterName is ignored by doc_saveAs; SinglePageSheets and PageRange
                // are read only from FilterData), so leaving them out keeps today's
                // output. A page-range print area is therefore still not applied:
                // gate 7.5 records it for the owner.
                exportOptions = calcPdfOptionsJson();
                for (const std::string& o : optionsList)
                    if (o.rfind("PageRange=", 0) == 0)
                        std::cerr << "[BRIDGE] Page-range print area " << o.substr(10)
                                  << " is not applied to the PDF (as before; gate 7.5)" << std::endl << std::flush;
            } else {
                for (size_t i = 0; i < optionsList.size(); i++) {
                    if (i > 0) exportOptions += ",";
                    exportOptions += optionsList[i];
                }
                appendOdfPassword(exportOptions);   // FG-021 (refused at entry for non-ODF/OOXML)
            }
            if (!exportOptions.empty()) {
                std::cout << "wasm_bridge: Export options: " << redactOptions(exportOptions) << std::endl;
            }

            report_conversion_progress("EXPORTING", 60);
            std::cerr << "[BRIDGE] Calling saveAs() for " << format_filter << " export..." << std::endl << std::flush;

            double t_save_start = emscripten_get_now();
            bool success;
            {
                SaveProgressScope saveScope;   // FG-173
                if (!exportOptions.empty()) {
                    success = doc->saveAs(outputUrl.c_str(), format_filter, exportOptions.c_str());
                } else {
                    success = doc->saveAs(outputUrl.c_str(), format_filter, nullptr);
                }
            }
            double t_save_end = emscripten_get_now();

            std::cerr << "[BRIDGE] saveAs() returned: " << (success ? "SUCCESS" : "FAILURE")
                      << " (took " << (t_save_end - t_save_start) << "ms)" << std::endl << std::flush;

            if (success) {
                report_conversion_progress("COMPLETE", 100);
                std::cerr << "[BRIDGE] Conversion complete!" << std::endl << std::flush;
            } else {
                report_conversion_progress("EXPORT_FAILED", 0);
                std::cerr << "[BRIDGE] Conversion failed." << std::endl;
                logAndCaptureLokError(BridgeErrCat::Export,
                                      std::string("Export to ") + format_filter + " failed");
            }

            // Properly close document via UNO to release internal caches.
            doc.reset();
            return success ? 1 : 0;

        } catch (const std::exception& e) {
            std::cerr << "wasm_bridge: Exception: " << e.what() << std::endl;
            setLastError(BridgeErrCat::Internal, std::string("Exception during spreadsheet conversion: ") + e.what());
            return 0;  // doc closed/deleted by ScopedLokDocument destructor
        } catch (...) {
            std::cerr << "wasm_bridge: Unknown exception." << std::endl;
            setLastError(BridgeErrCat::Internal, "Unknown exception during spreadsheet conversion");
            return 0;  // doc closed/deleted by ScopedLokDocument destructor
        }
    }

    /**
     * Get number of sheets in a spreadsheet document.
     * @param input_path: VFS path to source file
     * @return Number of sheets, or -1 on error.
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    int get_sheet_count(const char* input_path) {
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: Error - Office not initialized." << std::endl;
            return -1;
        }

        std::string fileUrl = "file://";
        fileUrl += input_path;

        Document* pDoc = loadDocument(fileUrl, nullptr, input_path);   // FG-021: keyed for the password callback
        if (!pDoc) {
            std::cerr << "wasm_bridge: Failed to load document for sheet count." << std::endl;
            return -1;
        }

        int numParts = pDoc->getParts();
        delete pDoc;
        return numParts;
    }
#endif

    /**
     * Get sheet names from a spreadsheet document (WASM_DEBUG only).
     *
     * Gated to WASM_DEBUG (M12): production sheet-name enumeration is done
     * JS-side (JSZip over xl/workbook.xml) to avoid a full documentLoad of the
     * ~27 MB spreadsheets module on every file drop. This remains as a debug tool.
     *
     * OWNERSHIP: the returned buffer is malloc'd; the caller MUST free it via
     * Module._free (cwrap as 'number', never 'string' — cwrap 'string' copies and
     * drops the pointer, leaking it, which is the trap that caused this finding).
     * @return JSON array of sheet names, or nullptr on error.
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    char* get_sheet_names(const char* input_path) {
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: Error - Office not initialized." << std::endl;
            return nullptr;
        }

        std::string fileUrl;
        if (!makeFileUrl(input_path, fileUrl)) {
            return nullptr;
        }

        ScopedLokDocument doc(loadDocument(fileUrl, nullptr, input_path));   // FG-021: keyed for the password callback
        if (!doc) {
            logAndCaptureLokError(BridgeErrCat::Load, "Failed to load document for sheet names");
            return nullptr;
        }

        int numParts = doc->getParts();
        std::string json = "[";
        for (int i = 0; i < numParts; i++) {
            char* partName = doc->getPartName(i);
            if (i > 0) json += ",";
            json += "\"";
            if (partName && strlen(partName) > 0) {
                json += jsonEscape(partName);
            } else {
                json += "Sheet" + std::to_string(i + 1);
            }
            if (partName) free(partName);
            json += "\"";
        }
        json += "]";

        doc.reset();

        char* result = static_cast<char*>(malloc(json.length() + 1));
        if (!result) {
            setLastError(BridgeErrCat::Internal, "OOM building sheet-name JSON");
            return nullptr;
        }
        memcpy(result, json.c_str(), json.length() + 1);
        return result;
    }
#endif

    /**
     * Return the most recent bridge error, or "" if none has occurred since the
     * last exported bridge call's entry (each exported convert/init function
     * calls clearLastError() on entry).
     *
     * Format: "<CATEGORY>: <message>" where <CATEGORY> is exactly one of the
     * stable identifiers INIT_FAILED, INPUT_MISSING, LOAD_FAILED, EXPORT_FAILED,
     * INVALID_PARAM, INTERNAL_ERROR. Only the category prefix is a stable
     * programmatic contract; the message text after the colon is human-readable,
     * free-form, may embed "(LOK: ...)" detail, and may change between builds.
     *
     * OWNERSHIP: the returned pointer is owned by the bridge and is valid only
     * until the next exported bridge call on the same Module instance. JS must
     * copy it immediately (cwrap/ccall 'string' does) and must NEVER free it.
     */
    EMSCRIPTEN_KEEPALIVE
    const char* get_last_error() {
        return g_lastError.c_str();
    }

    /**
     * Cleanup function to release global resources (optional, usually process exit handles this)
     * Enhanced with debug logging for page-refresh hang investigation.
     * See bugs/wasm_static_state_investigation.md
     */
    EMSCRIPTEN_KEEPALIVE
    void shutdown_office() {
        std::cerr << "[SHUTDOWN] ========================================" << std::endl << std::flush;
        std::cerr << "[SHUTDOWN] shutdown_office() called" << std::endl << std::flush;
        std::cerr << "[SHUTDOWN] g_pOffice: " << (g_pOffice ? "EXISTS" : "nullptr") << std::endl << std::flush;

        if (g_pOffice) {
            // Check for any pending errors before shutdown
            char* pendingError = g_pOffice->getError();
            if (pendingError && strlen(pendingError) > 0) {
                std::cerr << "[SHUTDOWN] Pending LOK error: " << pendingError << std::endl << std::flush;
                g_pOffice->freeError(pendingError);
            }

            std::cerr << "[SHUTDOWN] Step 1: About to delete g_pOffice..." << std::endl << std::flush;
            delete g_pOffice;
            std::cerr << "[SHUTDOWN] Step 2: g_pOffice deleted" << std::endl << std::flush;
            g_pOffice = nullptr;
            std::cerr << "[SHUTDOWN] Step 3: g_pOffice set to nullptr" << std::endl << std::flush;
        } else {
            std::cerr << "[SHUTDOWN] Nothing to do - g_pOffice already nullptr" << std::endl << std::flush;
        }

        std::cerr << "[SHUTDOWN] shutdown_office() COMPLETE" << std::endl << std::flush;
        std::cerr << "[SHUTDOWN] ========================================" << std::endl << std::flush;
    }

    /**
     * Get available filter types from LOK.
     * Returns: JSON string with filter types, or nullptr if LOK not initialized.
     * Caller must free the returned string.
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    char* get_filter_types() {
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: get_filter_types - Office not initialized." << std::endl;
            return nullptr;
        }

        char* filters = g_pOffice->getFilterTypes();
        if (filters) {
            std::cout << "wasm_bridge: Filter types retrieved successfully." << std::endl;
        } else {
            std::cerr << "wasm_bridge: getFilterTypes() returned null." << std::endl;
        }
        return filters;
    }
#endif

    /**
     * Test function to check if a URL can be resolved by UCB
     * Returns: 1 if URL can be accessed, 0 otherwise
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    int test_url_access(const char* url_path) {
        std::cout << "wasm_bridge: Testing URL access for: " << url_path << std::endl;

        // First check if file exists via fopen
        FILE* testFile = fopen(url_path, "rb");
        if (testFile) {
            fseek(testFile, 0, SEEK_END);
            long size = ftell(testFile);
            fclose(testFile);
            std::cout << "wasm_bridge: File exists via fopen, size: " << size << std::endl;
        } else {
            std::cerr << "wasm_bridge: File NOT accessible via fopen: " << url_path << std::endl;
            std::cerr << "wasm_bridge: errno = " << errno << std::endl;
            return 0;
        }

        // If LOK is initialized, we can test the internal URL handling
        if (g_pOffice) {
            // Convert to file:// URL format that LOK expects
            std::string fileUrl = "file://";
            fileUrl += url_path;
            std::cout << "wasm_bridge: LOK URL format: " << fileUrl << std::endl;

            // Try to get info about available filter types
            char* info = g_pOffice->getFilterTypes();
            if (info) {
                std::cout << "wasm_bridge: Available filter types: " << std::string(info).substr(0, 500) << "..." << std::endl;
                g_pOffice->freeError(info);
            } else {
                std::cerr << "wasm_bridge: getFilterTypes() returned null" << std::endl;
            }
        }

        return 1;
    }
#endif

    /**
     * Debug function to get current working directory
     * Returns: The cwd as a string
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    char* get_cwd() {
        char buffer[4096];
        if (getcwd(buffer, sizeof(buffer)) != nullptr) {
            std::cout << "wasm_bridge: getcwd() = " << buffer << std::endl;
            char* result = static_cast<char*>(malloc(strlen(buffer) + 1));
            strcpy(result, buffer);
            return result;
        } else {
            std::cerr << "wasm_bridge: getcwd() failed, errno = " << errno << std::endl;
            return nullptr;
        }
    }
#endif

    /**
     * Debug function to try loading a document with extra verbose logging
     * This mimics the LOK internal load process for debugging
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    int debug_document_load(const char* input_path) {
        if (!g_pOffice) {
            std::cerr << "wasm_bridge: debug_document_load - Office not initialized." << std::endl;
            return 0;
        }

        std::cout << "wasm_bridge: === DEBUG DOCUMENT LOAD ===" << std::endl;
        std::cout << "wasm_bridge: Input path: " << input_path << std::endl;

        // 1. Check file via fopen
        FILE* checkFile = fopen(input_path, "rb");
        if (!checkFile) {
            std::cerr << "wasm_bridge: File does NOT exist: " << input_path << std::endl;
            return 0;
        }
        fseek(checkFile, 0, SEEK_END);
        long fileSize = ftell(checkFile);
        fseek(checkFile, 0, SEEK_SET);

        // Read first bytes
        unsigned char header[16];
        size_t readBytes = fread(header, 1, 16, checkFile);
        fclose(checkFile);

        std::cout << "wasm_bridge: File size: " << fileSize << " bytes" << std::endl;
        std::cout << "wasm_bridge: Header (" << readBytes << " bytes): ";
        for (size_t i = 0; i < readBytes && i < 8; i++) {
            printf("%02X ", header[i]);
        }
        std::cout << std::endl;

        // 2. Get current working directory
        char cwdBuffer[4096];
        if (getcwd(cwdBuffer, sizeof(cwdBuffer))) {
            std::cout << "wasm_bridge: Current working dir: " << cwdBuffer << std::endl;
        } else {
            std::cout << "wasm_bridge: getcwd failed" << std::endl;
        }

        // 3. Try different URL formats
        std::vector<std::string> urlFormats = {
            std::string("file://") + input_path,  // file:///tmp/test.docx
            std::string("file:") + input_path,    // file:/tmp/test.docx
            input_path                            // /tmp/test.docx (plain path)
        };

        for (const auto& url : urlFormats) {
            std::cout << "wasm_bridge: Trying URL format: " << url << std::endl;

            Document* pDoc = loadDocument(url, nullptr, input_path);   // FG-021: keyed for the password callback
            if (pDoc) {
                std::cout << "wasm_bridge: SUCCESS with URL: " << url << std::endl;
                delete pDoc;
                return 1;
            } else {
                char* errMsg = g_pOffice->getError();
                std::cout << "wasm_bridge: Failed with: " << (errMsg ? errMsg : "no error") << std::endl;
                if (errMsg) g_pOffice->freeError(errMsg);
            }
        }

        std::cout << "wasm_bridge: All URL formats failed" << std::endl;
        return 0;
    }
#endif

    /**
     * Debug function to test OSL file URL conversion
     * This tests if osl_getSystemPathFromFileURL works correctly
     */
#ifdef WASM_DEBUG
    EMSCRIPTEN_KEEPALIVE
    int test_osl_url_conversion(const char* file_url) {
        std::cout << "wasm_bridge: Testing OSL URL conversion for: " << file_url << std::endl;

        OUString fileUrlStr = OUString::createFromAscii(file_url);
        OUString systemPath;

        osl::FileBase::RC result = osl::FileBase::getSystemPathFromFileURL(fileUrlStr, systemPath);

        if (result == osl::FileBase::E_None) {
            OString pathAscii = OUStringToOString(systemPath, RTL_TEXTENCODING_UTF8);
            std::cout << "wasm_bridge: URL conversion SUCCESS" << std::endl;
            std::cout << "wasm_bridge: System path: " << pathAscii.getStr() << std::endl;

            // Also test if the file exists at the converted path
            OString testPath = pathAscii;
            FILE* f = fopen(testPath.getStr(), "rb");
            if (f) {
                std::cout << "wasm_bridge: File EXISTS at converted path" << std::endl;
                fclose(f);
            } else {
                std::cout << "wasm_bridge: File NOT FOUND at converted path, errno=" << errno << std::endl;
            }
            return 1;
        } else {
            std::cout << "wasm_bridge: URL conversion FAILED with error: " << static_cast<int>(result) << std::endl;
            return 0;
        }
    }
#endif
}
