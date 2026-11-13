// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

// The legacy conversion, with no WebAssembly in it, so the same code is compiled into the module (bridge.cpp) and into the native fuzz target.
// 0 ok | 1 not a supported word-processor file | 2 password-protected (declined by design) | 3 parse failed. `out` receives the flat ODT, `family` "wpd" | "wps" | "mwaw".
#pragma once
#include <string>
int legacy_convert_core(const unsigned char *data, unsigned size, std::string &out, std::string &family);
