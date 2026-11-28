// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

// The legacy conversion, with no WebAssembly in it, so the same code is compiled into the module (bridge.cpp) and into the native fuzz target.
// 0 ok | 1 not a supported word-processor file | 2 password-protected (declined by design) | 3 parse failed. `out` receives the flat ODT, `family` "wpd" | "wps" | "mwaw" | "awp" (Apple II AppleWorks).
#pragma once
#include <string>
// `kind`: 0 = a word-processor name (or none), 1 = a name that routes to the Apple II spreadsheet/database readers (.asp, .adb: ConversionProtocol.legacyKindOf is "sheet").
// The structure-only detectors (awp, adb, asp) run only for their own kind and never when the file has the WordPerfect magic, so a real WordPerfect, Works or MacWrite
// file is never taken for an Apple II file by a shape that happens to match (WAF F1, #775).
int legacy_convert_core(const unsigned char *data, unsigned size, std::string &out, std::string &family, unsigned kind = 0);
