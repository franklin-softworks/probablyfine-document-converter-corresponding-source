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
| `LICENSE` | The Mozilla Public License 2.0, which governs the files in the first row of the Licensing table |

## Licensing
| Path | Terms |
|---|---|
| `engine/bridge/`, `engine/build/`, `engine/scripts/`, `engine/tools/`, `engine/modules/`, `pipeline/`, `docker/Dockerfile.builder`, `engine/upstream.json`, `engine/linked_libraries.txt`, `engine/third_party_libraries.json`, `engine/LIBRARY_SOURCE_INDEX.tsv`, `README.md`, `MANIFEST.sha256` (as they appear in this repository) | Copyright (c) 2025-2026 Franklin Softworks LLC. Mozilla Public License 2.0 — see `LICENSE` |
| `engine/patches/` | Modifications to LibreOffice, under LibreOffice's licence terms — see `NOTICE` |
| `web/js/conversion_worker.js`, `web/js/conversion_protocol.js`, `web/js/format_registry.js` | Copyright (c) 2025-2026 Franklin Softworks LLC. Apache License 2.0 — see `web/licenses/COPYING.APACHE-2.0` |
| `web/fonts/source/liberation-sans-narrow/` | Source of Liberation Sans Narrow, GPL v2 with the Liberation font exception — see `web/fonts/LICENSE-LiberationSansNarrow-GPLv2-with-font-exception.txt` |
| `NOTICE`, `web/licenses/` | Notices and licence texts |

## Library sources
The source archive of every third-party library built into the modules is kept in this repository's `library-sources` release, one asset per archive, named `lib-src-<sha256>` (no extension). `engine/LIBRARY_SOURCE_INDEX.tsv` in a tag lists the archives that release was built from: find a library's row, take its `sha256`, and download the asset of that name. An asset is never replaced or deleted. The upstream URL in the same row is where the archive was first obtained.

## Which source matches which release
Each release is built from one commit. Its source is the immutable tag `cs-<first 12 characters of that commit>`; the commit is the `git_commit` field of the website's `/manifest.json`. This copy is tag `cs-28cab7b75ef5` (commit `28cab7b75ef5`).
