# Probably Fine Document Converter — Corresponding Source

This repository is the Corresponding Source for the LibreOffice-derived WebAssembly modules that Probably Fine Document Converter (https://docconverter.probablyfine.click) sends to your browser.

## What is here
| Path | What it is |
|---|---|
| `engine/upstream.json` | The exact upstream LibreOffice commit every build starts from |
| `engine/LIBRARY_SOURCE_INDEX.tsv` | Every upstream source archive built into the modules, by SHA-256 and size; the archives themselves are the assets `lib-src-<sha256>` of this repository's `library-sources` release |
| `engine/third_party_libraries.json` | The third-party libraries built into the modules: version, upstream archive, SHA-256 and licence terms (the licence texts are `web/licenses/THIRD-PARTY-LIBRARIES.txt`) |
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
| `engine/bridge/`, `engine/build/`, `engine/scripts/`, `engine/tools/`, `engine/modules/`, `pipeline/`, `docker/Dockerfile.builder`, `engine/upstream.json`, `engine/third_party_libraries.json`, `engine/LIBRARY_SOURCE_INDEX.tsv`, `README.md`, `MANIFEST.sha256` (as they appear in this repository) | Copyright (c) 2025-2026 Franklin Softworks LLC. Mozilla Public License 2.0 — see `LICENSE` |
| `engine/patches/` | Modifications to LibreOffice, under LibreOffice's licence terms — see `NOTICE` |
| `web/js/conversion_worker.js`, `web/js/conversion_protocol.js`, `web/js/format_registry.js` | Copyright (c) 2025-2026 Franklin Softworks LLC. Apache License 2.0 — see `web/licenses/COPYING.APACHE-2.0` |
| `web/fonts/source/liberation-sans-narrow/` | Source of Liberation Sans Narrow, GPL v2 with the Liberation font exception — see `web/fonts/LICENSE-LiberationSansNarrow-GPLv2-with-font-exception.txt` |
| `NOTICE`, `web/licenses/` | Notices and licence texts |

## Which source matches which release
Each release is built from one commit. Its source is the immutable tag `cs-<first 12 characters of that commit>`; the commit is the `git_commit` field of the website's `/manifest.json`. This copy is tag `cs-0511286464b5` (commit `0511286464b5`).
