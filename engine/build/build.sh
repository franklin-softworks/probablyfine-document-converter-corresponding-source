#!/bin/bash
# set -e # Disabled to allow error handling

# This script is designed to be run inside the LibreOffice WASM builder container.
# It performs the configuration, compilation, optimization, and size validation steps.

# IMPORTANT: ROOT_DIR is passed as an environment variable from orchestrator.sh
# CONTAINER MOUNT POINTS. These are paths INSIDE the container and are fixed by
# engine/build/orchestrator.sh's -v flags. They are NOT repo paths and must not
# be rewritten when the repo is restructured — only the HOST side of each mount
# moves. (The 2026-07 restructure did rewrite them, and the build failed
# instantly on `cp /src/wasm_bridge.cpp`; tests/gates/test_repo_paths.sh now
# guards this.)
#   /build_scripts <- engine/build/    (this script, config/)
#   /modules       <- engine/modules/  (per-capability autogen.input)
#   /src           <- engine/bridge/   (wasm_bridge.cpp)
#   /web           <- web/             (index.html, js/, css/, fonts/)
#   /tools         <- engine/tools/    (agents/, size_gate.py, slim_soffice_data.py)
#   /build/core    <- libreoffice/     (the source tree)

cd /build/core || { echo "Error: /build/core not found. Ensure LibreOffice source is mounted correctly."; exit 1; }

# ---------------------------------------------------------------------------
# TUNABLES
#
# Every one of these was a bare literal inline. They are collected here because
# this file is listed in pipeline/config/modules.json's `build_scripts` and is
# SHA256-hashed into the rebuild fingerprint: editing it AT ALL — comments
# included — invalidates every module and forces a full WASM rebuild. So the
# values a person might reasonably want to change must be reachable WITHOUT
# editing this file, or the next tuning experiment costs hours.
#
# All are `${VAR:-default}`, so orchestrator.sh can pass -e VAR=... and nothing
# needs re-fingerprinting. Defaults reproduce the previous behaviour exactly.
# ---------------------------------------------------------------------------

# Size gate, in MB, applied to the BROTLI-COMPRESSED wasm. Not the same
# threshold as engine/scripts/validate_build.sh's, which measures the
# UNCOMPRESSED file and only warns — see the comment there before "unifying".
MAX_COMPRESSED_WASM_MB="${MAX_COMPRESSED_WASM_MB:-50}"

# Brotli quality. 11 is the maximum and the only value that has ever shipped;
# lower values build faster and serve worse.
BROTLI_QUALITY="${BROTLI_QUALITY:-11}"

# Data-segment merge gap. Measured on documents: -285,553 B on the wire at 1024.
SEGMENT_MERGE_GAP_MAX="${SEGMENT_MERGE_GAP_MAX:-1024}"

# wasm-opt lives in the emsdk inside the builder image. A variable so a new
# image layout does not require a rebuild-forcing edit.
WASM_OPT_BIN="${WASM_OPT_BIN:-/emsdk/upstream/bin/wasm-opt}"

# Version stamped into the (opt-in) artifact bundle's filename. Was the literal
# "1.0.0" with the comment "Placeholder for dynamic versioning".
ARTIFACT_VERSION="${ARTIFACT_VERSION:-0.0.0-dev}"

# Build the /build/core/artifacts/*.tar.gz bundle? Default OFF.
# Nothing consumes it: orchestrator.sh reads soffice_optimized.wasm{,.br} and
# instdir/program/* straight off the bind mount, and release packaging is
# pipeline/package.sh. Producing it gzipped an already-Brotli-compressed binary
# on every build of every module for no reader. Set to 1 to restore it.
BUILD_ARTIFACT_BUNDLE="${BUILD_ARTIFACT_BUNDLE:-0}"

DB_FILE="/build/core/pipeline_state.db"

initialize_db() {
    sqlite3 "$DB_FILE" "CREATE TABLE IF NOT EXISTS build_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state TEXT,
        message TEXT,
        exit_code INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );"
}

# Function for updating pipeline state in a SQLite database
update_pipeline_state() {
    local state="$1"
    local message="$2"
    local exit_code="${3:-0}"
    
    # Initialize on first call (or ensure it exists)
    initialize_db

    # Escape single quotes in message
    local safe_message=$(echo "$message" | sed "s/'/''/g")

    sqlite3 "$DB_FILE" "INSERT INTO build_status (state, message, exit_code) VALUES ('$state', '$safe_message', '$exit_code');"
    echo "DB_UPDATE: State=$state Message='$message' ExitCode=$exit_code"
}

    echo "LibreOffice WebAssembly Micro-Kernel Build Process Started."
    update_pipeline_state "INIT" "Build process started" "0"

    # --- Phase 8: Asset Injection ---
    echo "Injecting wasm_bridge.cxx to desktop/source/app/..."
    cp /src/wasm_bridge.cpp /build/core/desktop/source/app/wasm_bridge.cxx || { echo "Failed to copy wasm_bridge.cxx"; exit 1; }
    
    # echo "Running make clean (if applicable)..."
    # /usr/bin/make clean > build_clean.log 2>&1 || true

    echo "Configuring LibreOffice with emconfigure/configure... This may take a few minutes."

    # Check for custom CC/CXX in autogen.input (used for WASM exceptions)
    # These need to be exported as environment variables, not passed as arguments
    if grep -q '^CC=' autogen.input; then
        # Extract the full CC value (everything after CC=, with quotes handled)
        CUSTOM_CC=$(grep '^CC=' autogen.input | sed 's/^CC=//' | sed 's/^"//' | sed 's/"$//')
        export CC="$CUSTOM_CC"
        echo "Using custom CC from autogen.input: $CC"
    else
        export CC=emcc
    fi

    if grep -q '^CXX=' autogen.input; then
        # Extract the full CXX value (everything after CXX=, with quotes handled)
        CUSTOM_CXX=$(grep '^CXX=' autogen.input | sed 's/^CXX=//' | sed 's/^"//' | sed 's/"$//')
        export CXX="$CUSTOM_CXX"
        echo "Using custom CXX from autogen.input: $CXX"
    else
        export CXX=em++
    fi

    # Explicitly set compilers for the BUILD platform (tools running on the host)
    # LibreOffice requires GCC 12+ for these tools. Overridable so a builder-image
    # toolchain bump does not require editing this fingerprinted file.
    export CC_FOR_BUILD="${CC_FOR_BUILD:-gcc-12}"
    export CXX_FOR_BUILD="${CXX_FOR_BUILD:-g++-12}"

    # Construct the arguments for configure directly from autogen.input and LibreOfficeWASM32.conf
    # Filter out CC= and CXX= lines since they're handled as environment variables
    CONFIGURE_ARGS_FROM_AUTOGEN_INPUT=$(grep -v '^CC=\|^CXX=' autogen.input | xargs)

    # Read distro config if it exists
    if [ -f "distro-configs/LibreOfficeWASM32.conf" ]; then
        CONFIGURE_ARGS_FROM_DISTRO_CONF=$(cat distro-configs/LibreOfficeWASM32.conf | xargs)
    else
        echo "Warning: distro-configs/LibreOfficeWASM32.conf not found, using autogen.input only"
        CONFIGURE_ARGS_FROM_DISTRO_CONF=""
    fi

    # Combine all arguments
    # Note: Using --enable-option-checking=warn instead of fatal to allow for version differences
    FULL_CONFIGURE_COMMAND="./configure $CONFIGURE_ARGS_FROM_DISTRO_CONF $CONFIGURE_ARGS_FROM_AUTOGEN_INPUT --srcdir=/build/core --enable-option-checking=warn"

    # Regenerate configure if missing or if configure.ac is newer (e.g. patched)
    need_autoconf=false
    if [ ! -f "./configure" ]; then
        echo "Configure script not found. Generating with aclocal/autoconf..."
        need_autoconf=true
    elif [ "./configure.ac" -nt "./configure" ]; then
        echo "configure.ac is newer than configure (likely patched). Regenerating..."
        need_autoconf=true
    fi
    if [ "$need_autoconf" = true ]; then
        # We run aclocal and autoconf directly instead of autogen.sh
        # This avoids autogen.sh trying to run configure with incompatible options

        # Setup symlink if building out of tree
        if [ ! -f "configure.ac" ] && [ -f "/build/core/configure.ac" ]; then
            ln -sf /build/core/configure.ac configure.ac
        fi

        # Run aclocal with the correct m4 paths
        ACLOCAL_FLAGS="-I /build/core/m4"
        echo "Running: aclocal $ACLOCAL_FLAGS"
        aclocal $ACLOCAL_FLAGS > build_aclocal.log 2>&1
        ACLOCAL_EXIT_CODE=$?
        if [ $ACLOCAL_EXIT_CODE -ne 0 ]; then
            echo "aclocal failed. See build_aclocal.log:"
            cat build_aclocal.log
            update_pipeline_state "FAILURE" "aclocal failed" "$ACLOCAL_EXIT_CODE"
            exit $ACLOCAL_EXIT_CODE
        fi
        echo "aclocal completed successfully."

        # Run autoconf
        echo "Running: autoconf -I /build/core"
        autoconf -I /build/core > build_autoconf.log 2>&1
        AUTOCONF_EXIT_CODE=$?
        if [ $AUTOCONF_EXIT_CODE -ne 0 ]; then
            echo "autoconf failed. See build_autoconf.log:"
            cat build_autoconf.log
            update_pipeline_state "FAILURE" "autoconf failed" "$AUTOCONF_EXIT_CODE"
            exit $AUTOCONF_EXIT_CODE
        fi

        if [ -f "./configure" ]; then
            echo "Configure script generated successfully."
        else
            echo "ERROR: Configure script was not generated"
            update_pipeline_state "FAILURE" "configure not generated" "1"
            exit 1
        fi
    fi

    echo "Executing: emconfigure $FULL_CONFIGURE_COMMAND"

    update_pipeline_state "CONFIGURE" "Starting configure step"
    emconfigure $FULL_CONFIGURE_COMMAND > build_configure.log 2>&1
    CONFIGURE_EXIT_CODE=$?
    
    # Dump debug info to stdout
    echo "--- Debug Info from build_lo.sh (emconfigure direct call) ---"
    echo "emconfigure exited with $CONFIGURE_EXIT_CODE"
    echo "--- End Debug Info ---"

    if [ $CONFIGURE_EXIT_CODE -ne 0 ]; then
        echo "LibreOffice configuration failed. Printing build_configure.log below:"
        cat build_configure.log
        echo "--- END build_configure.log ---"
        
        if [ -f CONF-FOR-BUILD/config.log ]; then
            echo "Printing CONF-FOR-BUILD/config.log below:"
            cat CONF-FOR-BUILD/config.log
            echo "--- END CONF-FOR-BUILD/config.log ---"
        else
            echo "CONF-FOR-BUILD/config.log not found."
        fi
        
        update_pipeline_state "FAILURE" "Configure failed" "$CONFIGURE_EXIT_CODE"
        exit $CONFIGURE_EXIT_CODE
    fi
    update_pipeline_state "CONFIGURE_SUCCESS" "Configure step completed successfully" "0"

    # Fix config_folders.h for WASM cross-compile
    # The configure script doesn't properly populate config_host/config_folders.h for WASM targets
    # Copy values from config_build which has the correct folder definitions
    if [ -f /build/core/config_build/config_folders.h ] && [ -f /build/core/config_host/config_folders.h ]; then
        echo "Fixing config_host/config_folders.h for WASM build..."
        # Check if config_host has undefined values (indicates the issue)
        if grep -q "^/\* #undef LIBO_ETC_FOLDER \*/$" /build/core/config_host/config_folders.h; then
            cp /build/core/config_build/config_folders.h /build/core/config_host/config_folders.h
            # Fix the paths to point to the correct build directory
            sed -i 's|#define SRC_ROOT "/build/core/CONF-FOR-BUILD"|#define SRC_ROOT "/build/core"|' /build/core/config_host/config_folders.h
            sed -i 's|#define BUILDDIR "/build/core/CONF-FOR-BUILD"|#define BUILDDIR "/build/core"|' /build/core/config_host/config_folders.h
            echo "config_folders.h fixed successfully"
        else
            echo "config_folders.h already has proper values"
        fi
    fi

    # Without pthreads, Emscripten doesn't generate soffice.worker.js.
    # Clear EMSCRIPTEN_WORKERJS to prevent the install step from trying to copy it.
    if ! echo "$CC" | grep -q "\-pthread"; then
        echo "No pthreads detected - clearing EMSCRIPTEN_WORKERJS in config_host.mk"
        sed -i 's/^export EMSCRIPTEN_WORKERJS=TRUE/export EMSCRIPTEN_WORKERJS=/' /build/core/config_host.mk
    fi

    echo "Compiling LibreOffice... This will take a considerable amount of time."
    update_pipeline_state "COMPILE" "Starting compile step"

    # Check if using WASM exceptions (requires full clean on first build)
    # Skip clean if workdir is already empty or doesn't exist
    if echo "$CC" | grep -q "fwasm-exceptions" && [ -d "/build/core/workdir/CxxObject" ]; then
        echo "WASM exceptions detected - but workdir has compiled objects, skipping clean"
        echo "If you have ABI issues, manually run: rm -rf /home/dev/workspace/libreoffice/workdir"
    elif echo "$CC" | grep -q "fwasm-exceptions"; then
        echo "WASM exceptions detected - workdir is empty, no clean needed"
    fi
    # Note: freetype emranlib is handled by the patched ExternalProject_freetype.mk

    # Force regeneration of VFS directory entries in soffice.js.
    # The .data.js.link file is a cached copy used by the linker. Due to a parallel
    # make race condition, it can become stale when build flags change (e.g. adding
    # --enable-cairo-canvas), causing FS_createPath entries in soffice.js to not
    # match the actual files in soffice.data. Deleting it forces make to regenerate.
    rm -f /build/core/workdir/CustomTarget/static/emscripten_fs_image/soffice.data.js.link 2>/dev/null || true

    /usr/bin/make > build_compile.log 2>&1
    MAKE_EXIT_CODE=$?
    if [ $MAKE_EXIT_CODE -ne 0 ]; then
        echo "LibreOffice compilation failed. See build_compile.log for details."
        python3 /tools/agents/claude_build_agent.py "$(tail -n 200 build_compile.log)" "$(cat autogen.input)"
        update_pipeline_state "FAILURE" "Compile failed" "$MAKE_EXIT_CODE"
        exit $MAKE_EXIT_CODE
    fi
    update_pipeline_state "COMPILE_SUCCESS" "Compile step completed successfully" "0"

    # --- VFS Data Slimming ---
    # Remove unnecessary files (icons, gallery, examples) from soffice.data
    # to reduce download size. The .data binary is repackaged in-place.
    # Only slim modules where it's been validated safe. PDF import modules
    # (pdf-docx, pdf-pptx) need full VFS data for fidelity.
    # Whether to slim is a POLICY, and policy does not belong in a file whose
    # every byte forces a full rebuild. VFS_SLIM=1|0 decides; the module-name
    # allowlist below is only the fallback for callers that do not pass it, so
    # behaviour is unchanged until orchestrator.sh starts passing the flag.
    #
    # Getting this wrong is expensive and QUIET: skipping the slim ships a ~28 MB
    # soffice.data instead of ~4 MB. Nothing breaks, every test passes, and the
    # user just waits ~24 MB longer. So an unrecognised module says so loudly
    # rather than sliding into the skip branch unremarked.
    VFS_SLIM_DECIDED="${VFS_SLIM:-}"
    if [ -z "$VFS_SLIM_DECIDED" ]; then
        case "${MODULE_NAME:-}" in
            documents|spreadsheets|presentations)
                VFS_SLIM_DECIDED=1 ;;
            pdf-docx|pdf-pptx)
                # Deliberate: PDF import needs the full VFS for fidelity.
                VFS_SLIM_DECIDED=0 ;;
            "")
                echo "WARNING: MODULE_NAME is empty and VFS_SLIM was not passed."
                echo "WARNING: Defaulting to NO VFS slimming — soffice.data will be ~24 MB larger"
                echo "WARNING: than a slimmed module. If this is a real module build, the caller"
                echo "WARNING: should pass -e MODULE_NAME=<name> or -e VFS_SLIM=1."
                VFS_SLIM_DECIDED=0 ;;
            *)
                echo "WARNING: module '${MODULE_NAME}' has no VFS-slimming policy in build.sh and"
                echo "WARNING: VFS_SLIM was not passed. Defaulting to NO slimming (safe but ~24 MB"
                echo "WARNING: larger). Pass -e VFS_SLIM=1 once slimming is validated for it."
                VFS_SLIM_DECIDED=0 ;;
        esac
    fi

    if [ "$VFS_SLIM_DECIDED" = "1" ]; then
        echo "Slimming VFS data for ${MODULE_NAME:-unknown} (removing unnecessary files from soffice.data)..."
        update_pipeline_state "VFS_SLIM" "Slimming VFS data for ${MODULE_NAME:-unknown}"
        python3 /tools/slim_soffice_data.py /build/core/instdir --repackage
        VFS_SLIM_EXIT_CODE=$?
        if [ $VFS_SLIM_EXIT_CODE -ne 0 ]; then
            echo "Warning: VFS slimming failed (exit code $VFS_SLIM_EXIT_CODE). Continuing with full .data."
            update_pipeline_state "VFS_SLIM_WARN" "VFS slimming failed, using full .data" "$VFS_SLIM_EXIT_CODE"
        else
            update_pipeline_state "VFS_SLIM_SUCCESS" "VFS data slimmed successfully" "0"
        fi
    else
        echo "Skipping VFS slimming for ${MODULE_NAME:-unknown} (VFS_SLIM=0)"
        update_pipeline_state "VFS_SLIM_SKIP" "VFS slimming skipped for ${MODULE_NAME:-unknown}" "0"
    fi

    # Determine output Wasm path as specified in planning documents.
    LO_WASM_PATH="/build/core/instdir/program/soffice.wasm"
    OPTIMIZED_WASM_PATH="/build/core/soffice_optimized.wasm"
    BROTLI_WASM_PATH="/build/core/soffice_optimized.wasm.br"

    # Check if the expected WASM output file exists
    if [ ! -f "$LO_WASM_PATH" ]; then
        echo "Error: Expected LibreOffice WASM output not found at $LO_WASM_PATH"
        update_pipeline_state "FAILURE" "WASM artifact not found after compile" "1"
        exit 1
    fi

    echo "Optimizing WASM binary with wasm-opt..."
    update_pipeline_state "OPTIMIZE" "Starting wasm-opt optimization"
    # Add --enable-exception-handling if using WASM exceptions
    WASM_OPT_FLAGS="--enable-bulk-memory --enable-threads --enable-simd"
    if echo "$CC" | grep -q "fwasm-exceptions"; then
        WASM_OPT_FLAGS="$WASM_OPT_FLAGS --enable-exception-handling"
        echo "Adding --enable-exception-handling for WASM exceptions"
    fi
    "$WASM_OPT_BIN" $WASM_OPT_FLAGS \
        -Oz \
        --strip-debug \
        -Oz \
        -o "$OPTIMIZED_WASM_PATH" "$LO_WASM_PATH" > build_wasm_opt.log 2>&1
    OPTIMIZE_EXIT_CODE=$?
    if [ $OPTIMIZE_EXIT_CODE -ne 0 ]; then
        echo "wasm-opt optimization failed. See build_wasm_opt.log"
        update_pipeline_state "FAILURE" "wasm-opt failed" "$OPTIMIZE_EXIT_CODE"
        exit 1
    fi
    update_pipeline_state "OPTIMIZE_SUCCESS" "wasm-opt completed successfully" "0"

    # Merge adjacent data segments. wasm-opt leaves tens of thousands of them and
    # each costs ~8 bytes of incompressible LEB framing; bridging the gaps with
    # zeros makes the raw file larger but the Brotli file materially smaller.
    # Measured on documents: -285,553 B wire at --gap-max 1024. Semantically a
    # no-op (linear memory is already zero-initialised). Non-fatal: a failure
    # here restores the wasm-opt output and simply forfeits the saving.
    echo "Merging WASM data segments..."
    update_pipeline_state "SEGMERGE" "Merging WASM data segments"
    cp -f "$OPTIMIZED_WASM_PATH" "${OPTIMIZED_WASM_PATH}.presegmerge"
    python3 /tools/merge_wasm_data_segments.py "$OPTIMIZED_WASM_PATH" --gap-max "$SEGMENT_MERGE_GAP_MAX" \
        > build_segmerge.log 2>&1
    SEGMERGE_EXIT_CODE=$?
    if [ $SEGMERGE_EXIT_CODE -ne 0 ]; then
        echo "Warning: data segment merge failed (exit $SEGMERGE_EXIT_CODE). See build_segmerge.log. Using unmerged binary."
        cp -f "${OPTIMIZED_WASM_PATH}.presegmerge" "$OPTIMIZED_WASM_PATH"
        update_pipeline_state "SEGMERGE_WARN" "Data segment merge failed, using unmerged binary" "$SEGMERGE_EXIT_CODE"
    else
        update_pipeline_state "SEGMERGE_SUCCESS" "Data segments merged" "0"
    fi
    rm -f "${OPTIMIZED_WASM_PATH}.presegmerge"


    echo "Compressing WASM binary with Brotli..."
    update_pipeline_state "COMPRESS" "Starting Brotli compression"
    brotli -f -q "$BROTLI_QUALITY" -o "$BROTLI_WASM_PATH" "$OPTIMIZED_WASM_PATH" > build_brotli.log 2>&1
    COMPRESS_EXIT_CODE=$?
    if [ $COMPRESS_EXIT_CODE -ne 0 ]; then
        echo "Brotli compression failed. See build_brotli.log"
        update_pipeline_state "FAILURE" "Brotli compression failed" "$COMPRESS_EXIT_CODE"
        exit 1
    fi
    update_pipeline_state "COMPRESS_SUCCESS" "Brotli compression completed successfully" "0"


    echo "Performing size gate check..."
    update_pipeline_state "SIZE_CHECK" "Performing size gate check"
    python3 /tools/size_gate.py "$BROTLI_WASM_PATH" "$MAX_COMPRESSED_WASM_MB"
    SIZE_CHECK_EXIT_CODE=$?
    if [ $SIZE_CHECK_EXIT_CODE -ne 0 ]; then
        echo "Size gate check failed."
        update_pipeline_state "FAILURE" "Size gate check failed" "$SIZE_CHECK_EXIT_CODE"
        exit 1
    fi
    update_pipeline_state "SUCCESS" "LibreOffice Micro-Kernel build and optimization completed successfully." "0"

    echo "LibreOffice Micro-Kernel build and optimization completed successfully. Output: $BROTLI_WASM_PATH"

    # --- Runtime asset injection ---
    #
    # These land in instdir/program, which orchestrator.sh's run_wasm_test()
    # serves directly (python3 -m http.server --directory instdir/program), so
    # this step has a live consumer and stays unconditional.
    #
    # Each cp is now checked. They were unchecked, which meant a renamed or moved
    # web asset would print one line to a log nobody reads and the build would
    # continue and report SUCCESS. Not fatal — none of these files affects the
    # WASM that ships — so this warns rather than exits, but it warns audibly.
    OUT_DIR="$(dirname "$LO_WASM_PATH")"
    echo "Injecting Runtime Assets..."
    ASSET_WARNINGS=0
    for asset in \
        /web/js/conversion_driver.js \
        /web/js/conversion_worker.js \
        /web/fonts/fonts.json \
        /web/fonts/fonts.conf \
        /web/index.html \
        /web/css/style.css
    do
        if ! cp "$asset" "$OUT_DIR/"; then
            echo "WARNING: could not inject runtime asset '$asset' (moved or renamed?)"
            ASSET_WARNINGS=$((ASSET_WARNINGS + 1))
        fi
    done
    if [ "$ASSET_WARNINGS" -gt 0 ]; then
        update_pipeline_state "ASSET_INJECT_WARN" "$ASSET_WARNINGS runtime asset(s) missing" "0"
    fi

    # Ensure soffice.js is there (should be generated by build)
    if [ ! -f "$OUT_DIR/soffice.js" ]; then
        echo "Warning: soffice.js not found in output. Emscripten might not have generated it yet."
    fi

    # --- Artifact bundle (OPT-IN; see BUILD_ARTIFACT_BUNDLE at the top) ---
    #
    # Off by default because nothing reads it. It also re-gzipped the Brotli file
    # and the optimized wasm on every build of every module.
    #
    # Its `tar` exit code was never checked and the state was recorded as SUCCESS
    # unconditionally, so a bundle that failed to build looked exactly like one
    # that succeeded.
    if [ "$BUILD_ARTIFACT_BUNDLE" = "1" ]; then
        echo "Creating artifact bundle..."
        BUILD_DATE=$(date +%Y%m%d%H%M%S)
        ARTIFACT_NAME="libreoffice-wasm-micro-kernel-$ARTIFACT_VERSION-$BUILD_DATE.tar.gz"
        ARTIFACT_DIR="/build/core/artifacts"
        mkdir -p "$ARTIFACT_DIR"

        tar -czf "$ARTIFACT_DIR/$ARTIFACT_NAME" \
            -C "$OUT_DIR" "$(basename "$LO_WASM_PATH")" \
            -C "$OUT_DIR" "soffice.js" \
            -C "$OUT_DIR" "conversion_driver.js" \
            -C "$OUT_DIR" "conversion_worker.js" \
            -C "$OUT_DIR" "fonts.json" \
            -C "$OUT_DIR" "fonts.conf" \
            -C "$OUT_DIR" "index.html" \
            -C "$OUT_DIR" "style.css" \
            "$OPTIMIZED_WASM_PATH" \
            "$BROTLI_WASM_PATH" \
            build_configure.log \
            build_compile.log \
            build_wasm_opt.log \
            build_brotli.log
        TAR_EXIT_CODE=$?
        if [ $TAR_EXIT_CODE -ne 0 ]; then
            echo "ERROR: artifact bundle creation failed (tar exit $TAR_EXIT_CODE)"
            update_pipeline_state "FAILURE" "Artifact bundling failed" "$TAR_EXIT_CODE"
            exit $TAR_EXIT_CODE
        fi
        echo "Artifact bundle created at $ARTIFACT_DIR/$ARTIFACT_NAME"
        update_pipeline_state "SUCCESS" "Build completed, artifact bundled" "0"
    else
        update_pipeline_state "SUCCESS" "Build completed (artifact bundle skipped; BUILD_ARTIFACT_BUNDLE=0)" "0"
    fi
