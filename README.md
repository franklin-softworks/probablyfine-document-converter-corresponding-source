# Probably Fine Document Converter — Corresponding Source

This repository is the Corresponding Source for the LibreOffice-derived WebAssembly modules that Probably Fine Document Converter (https://docconverter.probablyfine.click) sends to your browser.

## What is here
| Path | What it is |
|---|---|
| `engine/upstream.json` | The exact upstream LibreOffice commit every build starts from |
| `engine/LIBRARY_SOURCE_INDEX.tsv` | Every upstream source archive built into the modules, by SHA-256, with its upstream URL, name, library and version; generated for this tag from LibreOffice's `download.lst` at the commit above and `engine/linked_libraries.txt`. The archives themselves are in this repository's `library-sources` release (see below) |
| `engine/linked_libraries.txt`, `engine/third_party_libraries.json` | Which libraries are built into the modules, and for each the licence terms and the licence used (the licence texts are `web/licenses/THIRD-PARTY-LIBRARIES.txt`) |
| `engine/patches/` | Every change made to LibreOffice, applied in order by `engine/scripts/apply_patches.sh` |
| `engine/bridge/` | This project's own C++ that is linked into the WebAssembly modules |
| `engine/modules/`, `engine/build/`, `engine/scripts/`, `engine/tools/`, `docker/Dockerfile.builder`, `pipeline/config/modules.json` | The build recipe: configuration per module, the build driver and the build environment |
| `web/js/conversion_worker.js`, `web/js/conversion_protocol.js`, `web/js/format_registry.js` | The worker that loads and calls the engine, the message and settings contract it speaks, and the format table, as shipped (unminified) |
| `web/fonts/source/liberation-sans-narrow/` | The complete source of the one GPLv2 font served with the site (Liberation Sans Narrow), with checksums and the build steps |
| `NOTICE`, `web/licenses/` | The licence of each component, and the full licence texts |
| `MANIFEST.sha256` | Every file in this repository with its SHA-256, and the commit it was assembled from |
| `LICENSE`, `LICENSES/`, `REUSE.toml` | The GNU General Public License 3 (the licence of the first-party files), the Mozilla Public License 2.0 (the licence of most LibreOffice files the patches modify), and the REUSE annotations for first-party files that cannot carry a header |
| `CONTRIBUTING.md` | How to contribute |

## Licensing
| What | Licence | Where |
|---|---|---|
| **Franklin Softworks' own files:** build scripts and tools (`engine/build/`, `engine/scripts/`, `engine/tools/`, `pipeline/lib/`), the generator tools, the C++ bridge (`engine/bridge/`), the converter scripts (`conversion_worker.js`, `conversion_protocol.js`, `format_registry.js`), and first-party configuration and data (`engine/modules/`, `docker/Dockerfile.builder`, `engine/upstream.json`, `engine/linked_libraries.txt`, `engine/third_party_libraries.json`, `engine/LIBRARY_SOURCE_INDEX.tsv`), including files without a header unless listed below | **GPL-3.0-only.** Copyright (C) 2025-2026 Franklin Softworks LLC. Franklin Softworks LLC may also license these files under separate terms. | `LICENSES/GPL-3.0-only.txt`; `REUSE.toml` |
| **Franklin Softworks' patches to LibreOffice** (the 181 patches in `engine/patches/`) | The licence of the file each patch modifies (MPL-2.0, or LGPLv3+ where the patched file says so), as LibreOffice's terms require | `LICENSES/` |
| LibreOffice, Poppler and the other third-party sources | Their own licences (see `web/licenses/THIRD-PARTY-LIBRARIES.txt`) | `LICENSES/` |
| Fonts | Their own licences (OFL-1.1, UFL-1.0, Bitstream Vera, Apache-2.0, GPL-2.0 with the font exception) | `web/fonts/` |

**Earlier releases.** Releases up to and including tag `cs-6dbb6cac4748` provided Franklin Softworks' build scripts and tools under the Mozilla Public License 2.0. Those copies remain under MPL-2.0. Later releases provide them under GPL-3.0-only.

**The converter scripts on our websites.** From this release, `conversion_worker.js`, `conversion_protocol.js` and `format_registry.js` are licensed under GPL-3.0-only (dual-licensed by Franklin Softworks LLC). We also grant GPL-3.0-only for all copies of these three scripts that our websites served before this release (which carried an 'All rights reserved' header). Versions of these three scripts published in Corresponding Source tags after `cs-6dbb6cac4748` up to and including `cs-a54d7f57cf9b` were provided under Apache-2.0, and those copies also remain available under Apache-2.0.

## Library sources
The source archive of every third-party library built into the modules is kept in this repository's `library-sources` release, one asset per archive, named `lib-src-<sha256>` (no extension). `engine/LIBRARY_SOURCE_INDEX.tsv` in a tag lists the archives that release was built from: find a library's row, take its `sha256`, and download the asset of that name. An asset is never replaced or deleted. The upstream URL in the same row is where the archive was first obtained.

## Which source matches which release
Each release is built from one commit. Its source is the immutable tag `cs-<first 12 characters of that commit>`; the commit is the `git_commit` field of the website's `/manifest.json`. This copy is tag `cs-fbf90a9871ba` (commit `fbf90a9871ba`).
