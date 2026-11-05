#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Franklin Softworks LLC
# Part of the BurnerDocs conversion engine. Licensed under the GNU General Public
# License version 3 only (see LICENSES/GPL-3.0-only.txt). Franklin Softworks LLC
# may also license this file under separate terms.

"""Generate the library source index: one row per upstream source archive of every library built into the modules.

  gen_library_source_index.py --download-lst download.lst --names engine/linked_libraries.txt \
                              --patches-dir engine/patches --out LIBRARY_SOURCE_INDEX.tsv [--lo-tree libreoffice]

The index is a PURE FUNCTION OF THE COMMIT: engine/upstream.json pins the LibreOffice commit, download.lst at that
commit pins every library's archive name and SHA-256, and engine/linked_libraries.txt (committed) names the entries that
are built in. A LibreOffice library bump therefore changes the index with no edit anywhere; a NEW library is the one
thing that needs an edit (and a licence review), and --lo-tree makes the build fail until it is made.

Checks, all fatal, and the output is written to a temp file and renamed only when every one passed (never a partial index):
  - every name in linked_libraries.txt has its TARBALL and SHA256SUM entry in download.lst, with a 64-hex SHA-256;
  - no patch in --patches-dir touches download.lst (the upstream file at the pinned commit would then not be the
    EFFECTIVE one);
  - with --lo-tree: the externals the build unpacked are exactly the names listed (minus the build-only ones);
  - the Emscripten row is the pin in gen_third_party_licences.py (its archive is not in download.lst).
See docs/provenance/library-source-archive.md.
"""
import argparse, os, re, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_third_party_licences as G   # noqa: E402

LO_SRC = "https://dev-www.libreoffice.org/src/"
HEADER = "# library-source-index v2\n"
COLUMNS = ["sha256", "upstream_url", "filename", "library", "version", "modules", "required", "status"]
MODULES = {"documents", "spreadsheets", "presentations", "pdf-docx", "pdf-pptx"}
FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")   # same rule as infra/cicd/library_sources_release.py


def parse_download_lst(text):
    var = {}
    for m in re.finditer(r"^(\w+) := ?(.*)$", text, re.M):
        var[m.group(1)] = m.group(2).strip()
    return var


def parse_names(text):
    rows = []
    for n, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        f = line.split()
        if len(f) != 3 or not re.fullmatch(r"[A-Z0-9_]+_TARBALL", f[1]):
            raise SystemExit(f"ERROR: linked_libraries.txt:{n}: expected '<library> <X_TARBALL> <modules>', got {line!r}")
        mods = f[2]
        if mods != "*" and not set(mods.split(",")) <= MODULES:
            raise SystemExit(f"ERROR: linked_libraries.txt:{n}: unknown module in {mods!r}")
        rows.append((f[0], f[1], mods))
    if not rows:
        raise SystemExit("ERROR: linked_libraries.txt names no library")
    if len({r[0] for r in rows}) != len(rows):
        raise SystemExit("ERROR: linked_libraries.txt names a library twice")
    return rows


def version_of(tarball):
    bare = re.sub(r"^[0-9a-f]{32}-", "", tarball)
    m = re.search(r"[-_](\d[\d._]*\d)(?:-src)?\.(?:tar\.\w+|tgz|zip)$", bare)
    return m.group(1).replace("_", ".") if m else "unknown"


def build_index(var, names):
    """-> TSV text. Raises SystemExit on any problem."""
    rows = {}
    for lib, tvar, mods in names:
        svar = tvar.replace("TARBALL", "SHA256SUM")
        if tvar not in var or svar not in var:
            raise SystemExit(f"ERROR: download.lst has no {tvar} / {svar} for {lib}")
        tarball = G.resolve(var, var[tvar])
        digest = var[svar]
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise SystemExit(f"ERROR: download.lst {svar} for {lib} is not a SHA-256: {digest!r}")
        row = [digest, LO_SRC + tarball, tarball, lib, version_of(tarball), mods, "yes", "active"]
        if not FILENAME_RE.match(tarball):
            raise SystemExit(f"ERROR: download.lst names {tarball!r} for {lib}, which is not a plain file name")
        if digest in rows:   # two libraries from one archive: one row, both names, the union of their modules
            rows[digest][3] += "," + lib
            if rows[digest][5] != mods:
                rows[digest][5] = "*" if "*" in (rows[digest][5], mods) else ",".join(sorted(set(rows[digest][5].split(",")) | set(mods.split(","))))
        else:
            rows[digest] = row
    em = [G.EMSCRIPTEN_SHA256, G.EMSCRIPTEN_URL, G.EMSCRIPTEN_ARCHIVE, "emscripten", G.EMSCRIPTEN_VERSION, "*", "yes", "active"]
    rows[em[0]] = em
    return HEADER + "\t".join(COLUMNS) + "\n" + "".join("\t".join(rows[k]) + "\n" for k in sorted(rows))


def patches_touching_download_lst(patches_dir):
    bad = []
    for fn in sorted(os.listdir(patches_dir)):
        if not fn.endswith(".patch"):
            continue
        with open(os.path.join(patches_dir, fn), encoding="utf-8", errors="replace") as fh:
            if re.search(r"^(diff --git a/download\.lst|\+\+\+ b/download\.lst|--- a/download\.lst)", fh.read(), re.M):
                bad.append(fn)
    return bad


def unpacked_externals(lo_tree):
    """The externals the build unpacked: the shared workdir, and the per-module workdirs of a partitioned build
    (<root>/workdirs/<module>/UnpackedTarball, engine/build/orchestrator.sh PARTITIONED_WORKDIR). Refuses when there is none."""
    dirs = [os.path.join(lo_tree, "workdir", "UnpackedTarball")]
    wd = os.path.join(os.path.dirname(os.path.abspath(lo_tree)), "workdirs")
    if os.path.isdir(wd):
        dirs += [os.path.join(wd, m, "UnpackedTarball") for m in sorted(os.listdir(wd))]
    dirs = [d for d in dirs if os.path.isdir(d)]
    if not dirs:
        sys.exit(f"ERROR: --lo-tree {lo_tree} has no workdir/UnpackedTarball and no workdirs/*/UnpackedTarball: the build tree is "
                 f"not there, so a new library could not be noticed. Refusing rather than skipping the check.")
    return {x for d in dirs for x in os.listdir(d) if "." not in x and os.path.isdir(os.path.join(d, x))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--download-lst", required=True)
    ap.add_argument("--names", required=True)
    ap.add_argument("--patches-dir")
    ap.add_argument("--lo-tree")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    text = open(a.download_lst, encoding="utf-8").read()
    if text.count(":=") < 100:
        sys.exit(f"ERROR: {a.download_lst} does not look like LibreOffice's download.lst ({text.count(':=')} entries)")
    names = parse_names(open(a.names, encoding="utf-8").read())
    if a.patches_dir:
        bad = patches_touching_download_lst(a.patches_dir)
        if bad:
            sys.exit("ERROR: these patches touch download.lst, so the upstream file is not the effective one: " + ", ".join(bad))
    if a.lo_tree:
        listed = {n for n, _, _ in names}
        built = unpacked_externals(a.lo_tree) - set(G.BUILD_ONLY)
        if built - listed:
            sys.exit(f"ERROR: the build unpacked externals that linked_libraries.txt does not list: {sorted(built - listed)}. "
                     f"A new library needs a line here, a notice and an election in engine/tools/gen_third_party_licences.py "
                     f"(a licence review).")
        if listed - built:   # a build of fewer modules than all of them unpacks fewer; the index still lists every library
            print(f"note: listed but not unpacked in this tree (fine unless every module was built): {sorted(listed - built)}", file=sys.stderr)
    out = build_index(parse_download_lst(text), names)
    d = os.path.dirname(os.path.abspath(a.out))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".index.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(out)
        os.replace(tmp, a.out)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    print(f"{out.count(chr(10)) - 2} archives")


if __name__ == "__main__":
    main()
