// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

// Apple II AppleWorks spreadsheet (ASP, ProDOS type $1B) and database (ADB, $19) files -> flat ODS (FF-6, owner decision 2026-11-08 and 2026-11-13).
// A port of the file-format knowledge of CiderPress (reformat/AppleWorks.cpp, Copyright (c) 2007 faddenSoft, LLC, BSD-3-Clause; NOTICE section 2e,
// web/licenses/COPYING.CIDERPRESS), which writes CSV; this writes OpenDocument flat XML and checks every length it reads. Formats: Apple's AppleWorks file type
// notes FTN.19 (database) and FTN.1B (spreadsheet).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

// These files have no magic. Detection is by the STRUCTURE of the header only, never a name or one byte.
// ASP: at least 302 bytes and the header's fixed fields (recalc order 'R'/'C', frequency 'A'/'M', window 'S'/'T'/'1', minimum version 0 or 0x1E).
// ADB: the header counts in range, the data offset inside the file, and every category name at most 20 printable characters (the first not empty).
// A random file passes with probability far below 10^-8. A file that passes but cannot be read to its $FFFF end marker (every row or record chain checked) is a
// DAMAGED AppleWorks file: *_convert answers 3, never a partial conversion and never "something else".
bool asp_detect(const uint8_t *data, size_t size);
bool adb_detect(const uint8_t *data, size_t size);
// 0 ok (flat ODS in `out`) | 3 damaged: not readable to its end marker (never a partial conversion)
int asp_convert(const uint8_t *data, size_t size, std::string &out);
int adb_convert(const uint8_t *data, size_t size, std::string &out);
