# Probably Fine Document Converter — Corresponding Source

This repository is the Corresponding Source for the LibreOffice-derived WebAssembly modules that Probably Fine Document Converter (https://docconverter.probablyfine.click) sends to your browser.

## What is here
| Path | What it is |
|---|---|
| `engine/upstream.json` | The exact upstream LibreOffice commit every build starts from |
| `engine/patches/` | Every change made to LibreOffice, applied in order by `engine/scripts/apply_patches.sh` |
| `engine/bridge/` | This project's own C++ that is linked into the WebAssembly modules |
| `engine/modules/`, `engine/build/`, `engine/scripts/`, `engine/tools/`, `docker/Dockerfile.builder`, `pipeline/config/modules.json` | The build recipe: configuration per module, the build driver and the build environment |
| `NOTICE`, `web/licenses/` | The licence of each component, and the full licence texts |
| `MANIFEST.sha256` | Every file in this repository with its SHA-256, and the commit it was assembled from |
| `LICENSE` | The Mozilla Public License 2.0, which governs the files in the first row of the Licensing table |

## Licensing
| Path | Terms |
|---|---|
| `engine/bridge/`, `engine/build/`, `engine/scripts/`, `engine/tools/`, `engine/modules/`, `pipeline/`, `docker/Dockerfile.builder`, `engine/upstream.json`, `README.md`, `MANIFEST.sha256` (as they appear in this repository) | Copyright (c) 2025-2026 Franklin Softworks LLC. Mozilla Public License 2.0 — see `LICENSE` |
| `engine/patches/` | Modifications to LibreOffice, under LibreOffice's licence terms — see `NOTICE` |
| `NOTICE`, `web/licenses/` | Notices and licence texts |

## Which source matches which release
Each release is built from one commit. Its source is the immutable tag `cs-<first 12 characters of that commit>`; the commit is the `git_commit` field of the website's `/manifest.json`. This copy is tag `cs-9c234eb515b8` (commit `9c234eb515b8`).
