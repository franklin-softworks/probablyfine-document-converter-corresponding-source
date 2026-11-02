#!/usr/bin/env python3
# Copyright (c) 2025-2026 Franklin Softworks LLC
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Generate the third-party library notices from a built LibreOffice tree.

  gen_third_party_licences.py --lo-tree libreoffice --json engine/third_party_libraries.json \
                              --txt web/licenses/THIRD-PARTY-LIBRARIES.txt

Reads the externals the build unpacked (workdir/UnpackedTarball) and copies each project's licence files verbatim.
Versions, archives and SHA-256s are NOT recorded here: they live in the generated library source index.
FAIL CLOSED: an unpacked external that is in neither LIBRARIES nor SKIP stops the run, so a
new library cannot enter the build without a notice (or a recorded reason for none).

The terms strings below restate what each project says about itself; where a project offers
a choice of licences, the ELECTIONS table says which one this distribution uses.
Everything else (poppler, poppler-data, libeot) already has its own section in NOTICE.
"""
import argparse, hashlib, json, os, re, sys

# name -> (display name, terms as the project states them, extra text files [(path, first, last)])
LIBRARIES = {
    "argon2": ("Argon2 reference implementation", "CC0 1.0 or Apache License 2.0, at the recipient's option", []),
    "boost": ("Boost C++ Libraries", "Boost Software License 1.0", []),
    "box2d": ("Box2D", "MIT License", []),
    "cairo": ("cairo", "GNU LGPL 2.1 or Mozilla Public License 1.1, at the recipient's option", []),
    "dragonbox": ("Dragonbox", "Apache License 2.0 with LLVM exception, or Boost Software License 1.0", []),
    "dtoa": ("dtoa.c (David M. Gay)", "permissive notice at the head of dtoa.c, reproduced below", [("src/dtoa.c", 1, 17)]),
    "expat": ("Expat", "MIT License", []),
    "fontconfig": ("Fontconfig", "permissive licence in COPYING (MIT-style)", []),
    "freetype": ("FreeType", "FreeType License (FTL) or GNU GPL 2, mutually exclusive alternatives", []),
    "frozen": ("Frozen", "Apache License 2.0", []),
    "glm": ("OpenGL Mathematics (GLM)", "Happy Bunny License or MIT License", []),
    "graphite": ("Graphite2", "GNU LGPL 2.1 or later, Mozilla Public License or GNU GPL 2 or later", []),
    "harfbuzz": ("HarfBuzz", "the \"Old MIT\" license", []),
    "hunspell": ("Hunspell", "GNU GPL 2 or later, GNU LGPL 2.1 or later, or Mozilla Public License 1.1 or later", []),
    "hyphen": ("Hyphen", "GNU GPL 2 or later, GNU LGPL 2.1 or later, or Mozilla Public License 1.1 or later", []),
    "icu": ("ICU4C", "Unicode License v3", []),
    "lcms2": ("Little CMS 2", "MIT License", []),
    "libabw": ("libabw", "Mozilla Public License 2.0", []),
    "libcdr": ("libcdr", "Mozilla Public License 2.0", []),
    "libebook": ("libe-book", "Mozilla Public License 2.0", []),
    "libetonyek": ("libetonyek", "Mozilla Public License 2.0", []),
    "libexttextcat": ("libexttextcat", "BSD 3-clause licence", []),
    "libfreehand": ("libfreehand", "Mozilla Public License 2.0", []),
    "libjpeg-turbo": ("libjpeg-turbo", "IJG License, Modified (3-clause) BSD License and zlib License", []),
    "liblangtag": ("liblangtag", "GNU LGPL 3 or Mozilla Public License 2.0", []),
    "libmspub": ("libmspub", "Mozilla Public License 2.0", []),
    "libmwaw": ("libmwaw", "GNU LGPL 2.1 or later, or Mozilla Public License 2.0", []),
    "libnumbertext": ("libnumbertext", "BSD 2-clause licence", []),
    "libodfgen": ("libodfgen", "GNU LGPL 2.1 or later, or Mozilla Public License 2.0", []),
    "liborcus": ("liborcus", "Mozilla Public License 2.0", []),
    "libpagemaker": ("libpagemaker", "Mozilla Public License 2.0", []),
    "libpng": ("libpng", "PNG Reference Library License version 2", []),
    "libqxp": ("libqxp", "Mozilla Public License 2.0", []),
    "librevenge": ("librevenge", "GNU LGPL 2.1 or later, or Mozilla Public License 2.0", []),
    "libstaroffice": ("libstaroffice", "GNU LGPL 2.1 or later, or Mozilla Public License 2.0", []),
    "libtiff": ("LibTIFF", "libtiff licence (BSD-style)", []),
    "libvisio": ("libvisio", "Mozilla Public License 2.0", []),
    "libwebp": ("libwebp", "BSD 3-clause licence", []),
    "libwpd": ("libwpd", "GNU LGPL 2.1 or later, or Mozilla Public License 2.0", []),
    "libwpg": ("libwpg", "GNU LGPL 2.1 or later, or Mozilla Public License 2.0", []),
    "libwps": ("libwps", "GNU LGPL 2.1 or later, or Mozilla Public License 2.0", []),
    "libxml2": ("libxml2", "MIT License", []),
    "libxslt": ("libxslt (with libexslt)", "MIT License", []),
    "libzmf": ("libzmf", "Mozilla Public License 2.0", []),
    "mdds": ("mdds", "MIT License", []),
    "mythes": ("MyThes", "BSD-style licence in COPYING", []),
    "openssl": ("OpenSSL", "Apache License 2.0", []),
    "pixman": ("Pixman", "MIT License", []),
    "raptor": ("Raptor RDF Syntax Library", "GNU LGPL 2.1 or later, GNU GPL 2 or later, or Apache License 2.0", []),
    "rasqal": ("Rasqal RDF Query Library", "GNU LGPL 2.1 or later, GNU GPL 2 or later, or Apache License 2.0", []),
    "redland": ("Redland RDF Application Framework", "GNU LGPL 2.1 or later, GNU GPL 2 or later, or Apache License 2.0", []),
    "xmlsec": ("XML Security Library", "MIT License", []),
    "zlib": ("zlib", "zlib License", []),
    "zstd": ("Zstandard", "BSD License or GNU GPL 2, at the recipient's option", []),
    "zxcvbn-c": ("zxcvbn-c", "MIT License", []),
}
# Unpacked by the build but not part of what ships, or covered by a section of NOTICE of its own.
BUILD_ONLY = ("cppunit", "meson", "pdfium")   # unpacked, but built into no module
SKIP = {
    "cppunit": "unit-test framework; not linked into a module",
    "meson": "build tool",
    "pdfium": "unpacked but built into no module (no archive is produced for it)",
    "poppler": "NOTICE section 2",
    "poppler_data": "NOTICE section 2",
    "libeot": "NOTICE section 1a",
}
# The Emscripten system libraries linked into every module (musl libc, LLVM libc++, libc++abi,
# libunwind, compiler-rt, dlmalloc). They are taken from the Emscripten release the build image
# pins (docker/Dockerfile.builder), read out of that release's source archive, whose SHA-256 is
# pinned here. Not linked, so not listed: mimalloc (only with -sMALLOC=mimalloc), SDL, webgpu.
# The Emscripten-authored runtime (embind, emmalloc, the JS glue) is MIT/NCSA: COPYING.EMSCRIPTEN.
EMSCRIPTEN_VERSION = "3.1.51"
EMSCRIPTEN_ARCHIVE = "emscripten-3.1.51.tar.gz"
EMSCRIPTEN_URL = "https://github.com/emscripten-core/emscripten/archive/refs/tags/3.1.51.tar.gz"
EMSCRIPTEN_SHA256 = "2f198b8529d2940aac07fe4007f9a47bee9ad03332bb64226ebd33ebf17d4d63"
# name -> (display, terms, [(path inside the archive, first line, last line) or (path, None, None)])
EMSCRIPTEN_SYSTEM = {
    "musl": ("musl libc", "MIT License, with the further notices in its COPYRIGHT file",
             [("system/lib/libc/musl/COPYRIGHT", None, None)]),
    "libcxx": ("LLVM libc++", "Apache License 2.0 with LLVM Exceptions (some files under the UIUC licence); see CREDITS",
               [("system/lib/libcxx/LICENSE.TXT", None, None), ("system/lib/libcxx/CREDITS.TXT", None, None)]),
    "libcxxabi": ("LLVM libc++abi", "Apache License 2.0 with LLVM Exceptions (some files under the UIUC licence); see CREDITS",
                  [("system/lib/libcxxabi/LICENSE.TXT", None, None), ("system/lib/libcxxabi/CREDITS.TXT", None, None)]),
    "libunwind": ("LLVM libunwind", "Apache License 2.0 with LLVM Exceptions (some files under the UIUC licence)",
                  [("system/lib/libunwind/LICENSE.TXT", None, None)]),
    "compiler-rt": ("LLVM compiler-rt", "Apache License 2.0 with LLVM Exceptions (some files under the UIUC licence); see CREDITS",
                    [("system/lib/compiler-rt/LICENSE.TXT", None, None), ("system/lib/compiler-rt/CREDITS.TXT", None, None)]),
    "dlmalloc": ("dlmalloc (Doug Lea)", "released to the public domain (CC0 1.0), as the notice at the head of dlmalloc.c says",
                 [("system/lib/dlmalloc.c", 50, 60)]),
}
# Where a project offers a choice of licences, the one this distribution uses (owner decision 2026-11-02, from the
# legal review of 2026-11-01: elect MPL-2.0 or a permissive licence wherever one is offered). name -> (offered, elected,
# elected_id). The pdf-docx and pdf-pptx modules are conveyed as a whole under the GNU GPL version 3, so every elected
# licence must be compatible with it (checked by tests/gates/test_third_party_libraries.py).
ELECTIONS = {
    "argon2": ("CC0 1.0 / Apache License 2.0", "Apache License 2.0", "Apache-2.0"),
    "cairo": ("GNU LGPL 2.1 / MPL 1.1", "GNU LGPL 2.1", "LGPL-2.1-only"),
    "dragonbox": ("Apache License 2.0 with LLVM exception / Boost Software License 1.0", "Boost Software License 1.0", "BSL-1.0"),
    "freetype": ("FreeType License (FTL) / GNU GPL 2", "FreeType License (FTL)", "FTL"),
    "glm": ("Happy Bunny License / MIT License", "MIT License", "MIT"),
    "graphite": ("GNU LGPL 2.1 or later / Mozilla Public License (version not stated) / GNU GPL 2 or later", "GNU LGPL 2.1 or later", "LGPL-2.1-or-later"),
    "hunspell": ("MPL 1.1 / GNU GPL 2 or later / GNU LGPL 2.1 or later", "GNU LGPL 2.1 or later", "LGPL-2.1-or-later"),
    "hyphen": ("GNU GPL 2 or later / GNU LGPL 2.1 or later / MPL 1.1 or later", "Mozilla Public License 2.0 (through \"MPL 1.1 or later\")", "MPL-2.0"),
    "liblangtag": ("GNU LGPL 3 / Mozilla Public License 2.0", "Mozilla Public License 2.0", "MPL-2.0"),
    "libmwaw": ("GNU LGPL 2.1 or later / Mozilla Public License 2.0", "Mozilla Public License 2.0", "MPL-2.0"),
    "libodfgen": ("GNU LGPL 2.1 or later / Mozilla Public License 2.0", "Mozilla Public License 2.0", "MPL-2.0"),
    "librevenge": ("GNU LGPL 2.1 or later / Mozilla Public License 2.0", "Mozilla Public License 2.0", "MPL-2.0"),
    "libstaroffice": ("GNU LGPL 2.1 or later / Mozilla Public License 2.0", "Mozilla Public License 2.0", "MPL-2.0"),
    "libwpd": ("GNU LGPL 2.1 or later / Mozilla Public License 2.0", "Mozilla Public License 2.0", "MPL-2.0"),
    "libwpg": ("GNU LGPL 2.1 or later / Mozilla Public License 2.0", "Mozilla Public License 2.0", "MPL-2.0"),
    "libwps": ("GNU LGPL 2.1 or later / Mozilla Public License 2.0", "Mozilla Public License 2.0", "MPL-2.0"),
    "raptor": ("GNU LGPL 2.1 or later / GNU GPL 2 or later / Apache License 2.0", "Apache License 2.0", "Apache-2.0"),
    "rasqal": ("GNU LGPL 2.1 or later / GNU GPL 2 or later / Apache License 2.0", "Apache License 2.0", "Apache-2.0"),
    "redland": ("GNU LGPL 2.1 or later / GNU GPL 2 or later / Apache License 2.0", "Apache License 2.0", "Apache-2.0"),
    "zstd": ("BSD License / GNU GPL 2", "BSD License (BSD-3-Clause)", "BSD-3-Clause"),
}
LICENCE_RE = re.compile(r"(?i)^(license|licence|copying|copyright|notice|unlicense)")
HEADER = """THIRD-PARTY LIBRARIES
=====================

The software below is compiled into one or more of the WebAssembly modules this site sends
to your browser. Each entry gives the library and the licence terms the project states,
followed by the project's own licence files, reproduced verbatim. The version and the upstream
archive of each library, with its SHA-256, are in the library source index of the same release
(libraries/LIBRARY_SOURCE_INDEX.tsv). Where a project offers a choice of licences, this
file reproduces all of them and says which one is used ("Used under:").

The pdf-docx and pdf-pptx modules are distributed as a whole under the GNU GPL version 3.
Each library in them is used under the licence shown, all of which are compatible with GPLv3.

This list is every library the build unpacked for the modules, so a given module may not
contain all of them. The Emscripten system libraries at the end are linked into every module.

Portions of this software are copyright \u00a9 2026 The FreeType Project (https://freetype.org).
All rights reserved. This software is based in part on the work of the FreeType Team.

LibreOffice itself, Poppler, poppler-data, libeot and the fonts are covered in NOTICE.
The machine-readable form of this list is engine/third_party_libraries.json (library names, terms, licence used).
"""


def sha(b):
    return hashlib.sha256(b).hexdigest()


def resolve(var, name):
    return re.sub(r"\$\((\w+)\)", lambda m: var[m.group(1)], name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lo-tree", required=True)
    ap.add_argument("--json", required=True)
    ap.add_argument("--txt", required=True)
    ap.add_argument("--emscripten-archive", required=True,
                    help=f"{EMSCRIPTEN_ARCHIVE} ({EMSCRIPTEN_URL}); its SHA-256 is checked against the pin")
    a = ap.parse_args()
    lo = a.lo_tree
    unpacked = os.path.join(lo, "workdir", "UnpackedTarball")
    names = sorted(d for d in os.listdir(unpacked) if "." not in d and os.path.isdir(os.path.join(unpacked, d)))
    unknown = [n for n in names if n not in LIBRARIES and n not in SKIP]
    if unknown:
        sys.exit("ERROR: unpacked external(s) with no notice entry and no skip reason: " + ", ".join(unknown))
    texts, order, libs = {}, [], []
    for n in names:
        if n not in LIBRARIES:
            continue
        display, terms, extra = LIBRARIES[n]
        src = os.path.join(unpacked, n)
        files = [f for f in sorted(os.listdir(src)) if LICENCE_RE.match(f) and os.path.isfile(os.path.join(src, f))
                 and not f.endswith((".html", ".orig"))]
        entries = []
        for f in files:
            b = open(os.path.join(src, f), "rb").read()
            entries.append((f, b))
        for path, first, last in extra:
            lines = open(os.path.join(src, path), "rb").read().splitlines(keepends=True)
            entries.append((f"{path} (lines {first}-{last})", b"".join(lines[first - 1:last])))
        if not entries:
            sys.exit(f"ERROR: {n} has no licence file")
        rec_files = []
        for f, b in entries:
            h = sha(b)
            if h not in texts:
                texts[h] = {"id": None, "bytes": b, "first_file": f"{n}/{f}"}
                order.append(h)
            rec_files.append({"file": f, "sha256": h})
        libs.append({"name": n, "display": display, "terms": terms, "licence_files": rec_files}
                    | ({"offered": ELECTIONS[n][0], "elected": ELECTIONS[n][1], "elected_id": ELECTIONS[n][2]} if n in ELECTIONS else {}))
    import tarfile
    raw = open(a.emscripten_archive, "rb").read()
    if sha(raw) != EMSCRIPTEN_SHA256:
        sys.exit(f"ERROR: {a.emscripten_archive} is not the pinned {EMSCRIPTEN_ARCHIVE} (sha256 {sha(raw)})")
    tf = tarfile.open(a.emscripten_archive, "r:gz")
    top = f"emscripten-{EMSCRIPTEN_VERSION}/"
    esys = []
    for n, (display, terms, items) in EMSCRIPTEN_SYSTEM.items():
        rec_files = []
        for path, first, last in items:
            member = tf.extractfile(top + path)
            if member is None:
                sys.exit(f"ERROR: {path} is not in the Emscripten archive")
            b = member.read()
            label = os.path.basename(path)
            if first is not None:
                b = b"".join(b.splitlines(keepends=True)[first - 1:last])
                label = f"{label} (lines {first}-{last})"
            h = sha(b)
            if h not in texts:
                texts[h] = {"id": None, "bytes": b, "first_file": f"emscripten/{n}/{label}"}
                order.append(h)
            rec_files.append({"file": label, "sha256": h})
        esys.append({"name": n, "display": display, "version": EMSCRIPTEN_VERSION, "terms": terms,
                     "licence_files": rec_files})
    for i, h in enumerate(order, 1):
        texts[h]["id"] = f"T{i:02d}"
    out = [HEADER]
    for l in libs:
        out.append("-" * 78)
        out.append(f"{l['display']}  [{l['name']}]")
        out.append(f"  terms:   {l['terms']}")
        out.append(f"  Used under: {l['elected']} (offered: {l['offered']})" if "elected" in l else f"  Used under: {l['terms']}")
        out.append("  licence texts: " + ", ".join(f"{texts[f['sha256']]['id']} ({f['file']})" for f in l["licence_files"]))
    out.append("-" * 78)
    out.append(f"\nEMSCRIPTEN SYSTEM LIBRARIES (Emscripten {EMSCRIPTEN_VERSION}, from {EMSCRIPTEN_URL})")
    out.append("These come with the Emscripten toolchain and are linked into every module.\n")
    for l in esys:
        out.append("-" * 78)
        out.append(f"{l['display']}  [{l['name']}]  from Emscripten {l['version']}")
        out.append(f"  terms:   {l['terms']}")
        out.append(f"  Used under: {l['terms']}")
        out.append("  licence texts: " + ", ".join(f"{texts[f['sha256']]['id']} ({f['file']})" for f in l["licence_files"]))
    out.append("-" * 78 + "\n\nLICENCE TEXTS\n==============\n")
    for h in order:
        t = texts[h]
        body = t["bytes"].decode("utf-8", errors="replace").replace("\r\n", "\n")
        out.append(f"[[{t['id']}]] first seen as {t['first_file']}  (sha256 of the file bytes: {h})")
        out.append("=" * 78)
        out.append(body.rstrip("\n"))
        out.append("=" * 78 + f" end {t['id']}\n")
    with open(a.txt, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(out) + "\n")
    rec = {"description": "Third-party libraries built into the engine modules; generated by "
                          "engine/tools/gen_third_party_licences.py from a built tree. See web/licenses/THIRD-PARTY-LIBRARIES.txt.",
           "skipped": SKIP, "libraries": libs,
           "emscripten": {"version": EMSCRIPTEN_VERSION, "archive": EMSCRIPTEN_ARCHIVE, "url": EMSCRIPTEN_URL,
                          "sha256": EMSCRIPTEN_SHA256, "libraries": esys},
           "texts": [{"id": texts[h]["id"], "sha256": h, "bytes": len(texts[h]["bytes"])} for h in order]}
    with open(a.json, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(f"{len(libs)} libraries + {len(esys)} Emscripten system libraries, {len(order)} distinct licence texts")


if __name__ == "__main__":
    main()
