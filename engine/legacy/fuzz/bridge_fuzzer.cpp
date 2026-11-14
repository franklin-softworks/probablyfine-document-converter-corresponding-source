// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

// libFuzzer target for the legacy bridge (FF-6 option C): the SAME conversion code the shipped module runs (legacy_core.cpp), natively, under ASan+UBSan.
// Build and run: engine/legacy/fuzz/build_fuzzer.sh, engine/legacy/fuzz/run_fuzzer.sh. LEGACY_FUZZ_PLANT builds a copy with a planted crash on an
// 8-byte marker: the gate runs it as a sabotage control (a harness that cannot find a planted bug proves nothing).
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include "../legacy_core.hpp"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    if (size > (1u << 20)) return 0;   // the module's own inputs are small; bound the run time per input
#ifdef LEGACY_FUZZ_PLANT
    if (size >= 8 && std::memcmp(data, "PLANTBUG", 8) == 0) __builtin_trap();
#endif
    std::string out, family;
    legacy_convert_core(data, static_cast<unsigned>(size), out, family);
    return 0;
}
