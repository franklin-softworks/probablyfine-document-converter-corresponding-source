// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

// FF-6 option C (owner decision 2026-11-08): the legacy word-processor module. A legacy file in, flat ODT out, with NO LibreOffice:
// libwpd + libmwaw + libwps -> libodfgen's OdtGenerator. The documents module then renders the flat ODT like any other input.
// It mirrors what writerperfect's three Writer import filters do (same libraries, same generator), minus the dialogs and the embedded WPG graphics.
//
// Contract (read by the worker's pre-step):
//   legacy_convert(data, size) -> 0 ok | 1 not a supported word-processor file | 2 password-protected (declined by design) | 3 parse failed
//   legacy_output()/legacy_output_size() the flat ODT (valid until the next call); legacy_family() "wpd" | "wps" | "mwaw".
// RULES: create a FRESH module instance for every conversion (a hostile file must not be able to leave state behind); the library parsers
// are untrusted-input code, so the caller bounds the time and the memory of an instance.
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <emscripten.h>
#include "legacy_core.hpp"

namespace
{
std::string g_out;
std::string g_family;
}

extern "C"
{
EMSCRIPTEN_KEEPALIVE int legacy_convert(const unsigned char *data, unsigned size)
{
    g_out.clear();
    g_family.clear();
    return legacy_convert_core(data, size, g_out, g_family);
}
EMSCRIPTEN_KEEPALIVE const char *legacy_output() { return g_out.data(); }
EMSCRIPTEN_KEEPALIVE unsigned legacy_output_size() { return unsigned(g_out.size()); }
EMSCRIPTEN_KEEPALIVE const char *legacy_family() { return g_family.c_str(); }
EMSCRIPTEN_KEEPALIVE unsigned char *legacy_alloc(unsigned n) { return static_cast<unsigned char *>(malloc(n)); }
EMSCRIPTEN_KEEPALIVE void legacy_free(unsigned char *p) { free(p); }
}
