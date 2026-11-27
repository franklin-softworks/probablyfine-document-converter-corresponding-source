// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

// Apple II AppleWorks word processor (AWP) files -> flat ODT (FF-6, owner decision 2026-11-08: Apple II AppleWorks is part of the legacy module).
// A port of the AWP reader of CiderPress (reformat/AppleWorks.cpp, Copyright (c) 2007 faddenSoft, LLC, BSD-3-Clause; see NOTICE section 2e and
// web/licenses/COPYING.CIDERPRESS), which writes RTF; this writes OpenDocument flat XML and checks every length it reads. The format is FTN.1A of Apple's
// AppleWorks file type notes.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

// True only for a file that has the AWP header STRUCTURE, never by a name or one byte: at least 302 bytes, 0x4F at offset 4, at least 76 of the 80 tab-stop
// bytes at 5..84 one of "=<^>.|" and any others 0x00 or 0x01 (real files have a few), and a minimum-version byte at 183 of 0 or 30. (Random data passes
// with probability well below 10^-100.)
bool awp_detect(const uint8_t *data, size_t size);
// 0 ok (flat ODT in `out`) | 3 the file could not be read to its end marker (truncated or damaged; never a partial conversion)
int awp_convert(const uint8_t *data, size_t size, std::string &out);
