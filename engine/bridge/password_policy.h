// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

/*
 * password_policy.h
 *
 * FG-021: the decision the bridge makes when LibreOfficeKit asks for a document
 * password (LOK_CALLBACK_DOCUMENT_PASSWORD). Pure and header-only, standard library
 * only, so that tests/gates/test_password_callback_policy.sh can compile and run it
 * natively. wasm_bridge.cpp includes it; engine/build/build.sh copies it next to
 * wasm_bridge.cxx.
 *
 * Why a policy at all. The request names the document it is for in `Name`
 * (task::DocumentPasswordRequest). Which form that name takes depends on the import
 * filter, and the bridge must give the password only to the load it started:
 *   - DOCX, XLSX, XLS, ODF: the full URL, byte-equal to the key lo_documentLoadWithOptions
 *     put in mInteractionMap (measured, FG-021 build #1);
 *   - Word 97 (.doc): only the file name, the last path segment of the URL decoded
 *     (sw/source/filter/ww8/ww8par.cxx:5468, GetLastName; measured on build #1);
 *   - PDF import's request is also built from the file name only (sdext/source/pdfimport/
 *     filterdet.cxx:368,810), but build #1 measured no request at all for any encrypted PDF.
 *
 * The rule (WAF, 2026-10-26, amending plans/fg-021-bug-36-password-and-calc-notes.md 4.2):
 *   1. EXACT equality only, never a suffix, substring, prefix or case fold. The payload
 *      must equal the bridge's own load key, or the STORED staged file name saved when
 *      this load began (compared as stored, not re-decoded from a URL).
 *   2. The stored name is accepted only if it is made of [A-Za-z0-9._-] (the worker
 *      sanitises every staged name to that set, ConversionProtocol.sanitizeBaseName).
 *      If it ever is not, only the full key is accepted.
 *   3. The password is given only while a load is in progress and only to the FIRST
 *      request of that load. Any other request is aborted (the caller answers nullptr).
 *   4. The caller always answers with its own key, never with the payload.
 */

#ifndef INCLUDED_ENGINE_BRIDGE_PASSWORD_POLICY_H
#define INCLUDED_ENGINE_BRIDGE_PASSWORD_POLICY_H

#include <cstddef>
#include <string>

namespace pwpolicy {

// Which form the request's payload took.
enum class Form {
    Unknown,      // neither the load key nor the stored staged name
    FullKey,      // byte-equal to the bridge's load key
    StagedName,   // byte-equal to the stored staged file name
};

inline const char* formName(Form f) {
    switch (f) {
        case Form::FullKey:    return "full-key";
        case Form::StagedName: return "staged-name";
        case Form::Unknown:
        default:               return "unknown";
    }
}

// [A-Za-z0-9._-], at least one character, at most 255 (a file name's limit).
inline bool isSafeStagedName(const std::string& s) {
    if (s.empty() || s.size() > 255)
        return false;
    for (char c : s) {
        const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                        (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
        if (!ok)
            return false;
    }
    return true;
}

// The last path segment of a staged input path ("/tmp/in/a.doc" -> "a.doc"). No decoding:
// the staged path is a plain VFS path, not a URL.
inline std::string stagedBaseName(const std::string& path) {
    const std::size_t slash = path.find_last_of('/');
    return slash == std::string::npos ? path : path.substr(slash + 1);
}

inline Form classify(const std::string& loadKey, const std::string& stagedName, const char* payload) {
    if (!payload)
        return Form::Unknown;
    const std::string p(payload);
    if (!loadKey.empty() && p == loadKey)
        return Form::FullKey;
    if (isSafeStagedName(stagedName) && p == stagedName)
        return Form::StagedName;
    return Form::Unknown;
}

struct Decision {
    Form form = Form::Unknown;
    bool givePassword = false;   // answer with the input password (else answer nullptr = abort)
    bool mismatch = false;       // a request during a load whose payload was in no known form
};

// requestNumber is 1 for the first password request of the load, 2 for the next, ...
inline Decision decide(bool loadInProgress, int requestNumber, bool havePassword,
                       const std::string& loadKey, const std::string& stagedName,
                       const char* payload) {
    Decision d;
    if (!loadInProgress)
        return d;   // nothing to give a password to, and nothing to classify
    d.form = classify(loadKey, stagedName, payload);
    d.mismatch = d.form == Form::Unknown;
    d.givePassword = requestNumber == 1 && havePassword && d.form != Form::Unknown;
    return d;
}

} // namespace pwpolicy

#endif
