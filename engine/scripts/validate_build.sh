#!/bin/bash
# Post-build validation script for LibreOffice WASM builds
# This script verifies that critical components are correctly linked

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"   # engine/scripts -> repo root

# Default paths
WASM_PATH="${1:-$ROOT_DIR/libreoffice/instdir/program/soffice.wasm}"
VFS_METADATA="${2:-$ROOT_DIR/libreoffice/instdir/program/soffice.data.js.metadata}"
MODULE_TYPE="${3:-writer}"  # a pipeline module name (documents, spreadsheets, ...) or a family

# ---------------------------------------------------------------------------
# Module name -> check family.
#
# WHY THIS EXISTS. This script's checks were keyed on writer/calc/universal,
# but orchestrator.sh calls it with the PIPELINE module names — documents,
# spreadsheets, presentations, csv, pdf-docx, pdf-xlsx, pdf-pptx — which are the
# keys in pipeline/config/modules.json and the vocabulary used everywhere else.
# Only "universal" ever matched. For the other seven the case statements fell
# through to no branch at all, so the module-specific symbol and .xcd checks
# never ran, and the script still printed "VALIDATION PASSED".
#
# That is the worst failure shape available to a validator: a documents build
# genuinely missing writerfilter/OOXMLDocumentImpl validated clean. The gate
# meant to catch a module built without its filter engine was inert for every
# module it was called on.
#
# Unknown names now FAIL rather than passing silently — a validator that cannot
# tell what it is validating must not report success.
# ---------------------------------------------------------------------------
case "$MODULE_TYPE" in
    documents|writer)             MODULE_FAMILY="writer" ;;
    spreadsheets|csv|calc)        MODULE_FAMILY="calc" ;;
    presentations)                MODULE_FAMILY="impress" ;;
    universal)                    MODULE_FAMILY="universal" ;;
    # PDF-input modules: the import side is poppler/pdfimport, and the export
    # side is the corresponding editor engine. No verified required-symbol set
    # exists for these yet, so they get the family-agnostic checks only and say
    # so out loud rather than pretending to have validated something.
    pdf-docx)                     MODULE_FAMILY="pdf-writer" ;;
    pdf-pptx)                     MODULE_FAMILY="pdf-impress" ;;
    pdf-xlsx)                     MODULE_FAMILY="pdf-calc" ;;
    spreadsheets-charts)          MODULE_FAMILY="calc" ;;
    *)
        echo "ERROR: validate_build.sh does not know module '$MODULE_TYPE'."
        echo "       Add it to the module->family map in this script."
        echo "       Refusing to report PASSED for a module whose checks are undefined."
        exit 1
        ;;
esac

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0
WARNINGS=0

echo "========================================"
echo "LibreOffice WASM Build Validation"
echo "========================================"
echo "WASM Path: $WASM_PATH"
echo "VFS Metadata: $VFS_METADATA"
echo "Module Type: $MODULE_TYPE"
echo ""

# Check if files exist
if [ ! -f "$WASM_PATH" ]; then
    echo -e "${RED}ERROR: WASM binary not found: $WASM_PATH${NC}"
    exit 1
fi

# Get WASM size
WASM_SIZE=$(stat -c%s "$WASM_PATH" 2>/dev/null || stat -f%z "$WASM_PATH" 2>/dev/null)
WASM_SIZE_MB=$(echo "scale=2; $WASM_SIZE / 1048576" | bc)
echo "WASM Size: ${WASM_SIZE_MB} MB"
echo ""

# ========================================
# Section 1: Critical Symbol Verification
# ========================================
echo "--- Section 1: Symbol Verification ---"

check_symbol() {
    local symbol="$1"
    local required="$2"
    # `grep -c` PRINTS "0" and EXITS 1 when it finds nothing, so the old
    # `|| echo "0"` appended a SECOND zero and count became the two-line string
    # "0\n0". That made `[ "$count" -ge 1 ]` abort with "integer expression
    # expected" on every absent symbol. The verdict happened to land on FAIL
    # anyway (a failed test takes the else branch), so the bug was invisible —
    # and doubly so because these checks never executed at all until the
    # module-family fix above. Two defects hid each other.
    local count
    count=$(strings "$WASM_PATH" | grep -c "$symbol" 2>/dev/null || true)
    [[ "$count" =~ ^[0-9]+$ ]] || count=0

    if [ "$count" -ge 1 ]; then
        echo -e "${GREEN}[PASS]${NC} $symbol found ($count occurrences)"
        return 0
    else
        if [ "$required" = "required" ]; then
            echo -e "${RED}[FAIL]${NC} $symbol NOT found (REQUIRED)"
            ERRORS=$((ERRORS + 1))
            return 1
        else
            echo -e "${YELLOW}[WARN]${NC} $symbol NOT found (optional)"
            WARNINGS=$((WARNINGS + 1))
            return 0
        fi
    fi
}

# Core LOK symbols (always required)
echo ""
echo "Core LibreOfficeKit symbols:"
check_symbol "libreofficekit_hook" "required"
check_symbol "lo_documentLoad" "required"
check_symbol "init_office" "required"
check_symbol "convert_document" "required"

# Module-specific symbols
echo ""
echo "Module-specific symbols ($MODULE_TYPE -> family: $MODULE_FAMILY):"
case "$MODULE_FAMILY" in
    writer)
        # Writer/DOCX requires OOX and WriterFilter
        check_symbol "oox" "required"
        check_symbol "writerfilter" "required"
        check_symbol "OOXMLDocumentImpl" "optional"
        ;;
    calc)
        # Calc requires liborcus for XLSX import
        check_symbol "orcus" "required"
        check_symbol "sc_filter" "optional"
        ;;
    impress)
        # PPTX import/export goes through OOX. Kept "optional" deliberately:
        # this expectation has not yet been confirmed against a real
        # presentations build, and a validator should not invent a hard
        # requirement it has never seen hold. Promote to "required" once a
        # green presentations build confirms the symbol is present.
        check_symbol "oox" "optional"
        ;;
    universal)
        # Universal should have everything
        check_symbol "oox" "required"
        check_symbol "writerfilter" "required"
        check_symbol "orcus" "required"
        ;;
    pdf-writer|pdf-impress|pdf-calc)
        # See the family map: no verified required-symbol set for PDF-input
        # modules yet. Say so rather than silently checking nothing.
        echo "  (no module-specific symbol checks defined for $MODULE_FAMILY yet)"
        ;;
esac

# ========================================
# Section 2: VFS Content Verification
# ========================================
echo ""
echo "--- Section 2: VFS Content Verification ---"

if [ -f "$VFS_METADATA" ]; then
    check_vfs_file() {
        local filename="$1"
        local required="$2"

        if grep -q "$filename" "$VFS_METADATA" 2>/dev/null; then
            local size=$(grep -A1 "\"$filename\"" "$VFS_METADATA" | grep -o '"end":[0-9]*' | head -1 | cut -d: -f2)
            echo -e "${GREEN}[PASS]${NC} $filename present in VFS"
            return 0
        else
            if [ "$required" = "required" ]; then
                echo -e "${RED}[FAIL]${NC} $filename NOT in VFS (REQUIRED)"
                ERRORS=$((ERRORS + 1))
                return 1
            else
                echo -e "${YELLOW}[WARN]${NC} $filename NOT in VFS (optional)"
                WARNINGS=$((WARNINGS + 1))
                return 0
            fi
        fi
    }

    echo ""
    echo "Core configuration files:"
    check_vfs_file "main.xcd" "required"
    check_vfs_file "registry" "optional"

    echo ""
    echo "Module-specific XCD files ($MODULE_TYPE -> family: $MODULE_FAMILY):"
    case "$MODULE_FAMILY" in
        writer)
            check_vfs_file "writer.xcd" "required"
            check_vfs_file "oox.xcd" "optional"
            ;;
        calc)
            check_vfs_file "calc.xcd" "required"
            ;;
        impress)
            # Optional for the same reason as the impress symbol check above:
            # unverified against a real build, so it warns rather than fails.
            check_vfs_file "impress.xcd" "optional"
            ;;
        universal)
            check_vfs_file "writer.xcd" "required"
            check_vfs_file "calc.xcd" "required"
            ;;
        pdf-writer)
            check_vfs_file "writer.xcd" "optional"
            ;;
        pdf-impress)
            check_vfs_file "impress.xcd" "optional"
            ;;
        pdf-calc)
            check_vfs_file "calc.xcd" "optional"
            ;;
    esac
else
    echo -e "${YELLOW}[WARN]${NC} VFS metadata not found: $VFS_METADATA"
    WARNINGS=$((WARNINGS + 1))
fi

# ========================================
# Section 3: JavaScript Runtime Verification
# ========================================
echo ""
echo "--- Section 3: Runtime Files Verification ---"

INSTDIR="$(dirname "$WASM_PATH")"

check_runtime_file() {
    local filename="$1"
    local filepath="$INSTDIR/$filename"

    if [ -f "$filepath" ]; then
        local size=$(stat -c%s "$filepath" 2>/dev/null || stat -f%z "$filepath" 2>/dev/null)
        echo -e "${GREEN}[PASS]${NC} $filename present (${size} bytes)"
        return 0
    else
        echo -e "${RED}[FAIL]${NC} $filename NOT found"
        ERRORS=$((ERRORS + 1))
        return 1
    fi
}

check_runtime_file "soffice.js"
check_runtime_file "soffice.data"

# soffice.worker.js only exists when pthreads are enabled
if [ -f "$INSTDIR/soffice.worker.js" ]; then
    check_runtime_file "soffice.worker.js"
else
    echo -e "${GREEN}[PASS]${NC} soffice.worker.js absent (expected without pthreads)"
fi

# ========================================
# Section 4: Size Validation
# ========================================
echo ""
echo "--- Section 4: Size Validation ---"

# NOT the same 50 as engine/build/build.sh's `size_gate.py "$BROTLI_WASM_PATH" 50`,
# despite the identical number. That one measures the BROTLI-COMPRESSED artifact
# and hard-fails the build; this one measures the UNCOMPRESSED .wasm and only
# warns. The shipped modules are ~25-30 MB compressed, so the build gate has
# roughly 2x headroom while this threshold sits near the real value. Do not
# "de-duplicate" them into one constant — they are two different measurements
# that coincide at 50.
#
# The build-side literal is deliberately left in place: engine/build/build.sh is
# listed in modules.json's build_scripts and is SHA256-hashed into the rebuild
# fingerprint, so editing it at all — comments included — invalidates every
# module and forces a full WASM rebuild. Naming a constant is not worth hours of
# build time; naming the distinction here is free.
MAX_UNCOMPRESSED_WASM_MB=50
if (( $(echo "$WASM_SIZE_MB > $MAX_UNCOMPRESSED_WASM_MB" | bc -l) )); then
    echo -e "${YELLOW}[WARN]${NC} Uncompressed WASM size (${WASM_SIZE_MB}MB) exceeds target (${MAX_UNCOMPRESSED_WASM_MB}MB)"
    WARNINGS=$((WARNINGS + 1))
else
    echo -e "${GREEN}[PASS]${NC} Uncompressed WASM size (${WASM_SIZE_MB}MB) within target (${MAX_UNCOMPRESSED_WASM_MB}MB)"
fi

# ========================================
# Summary
# ========================================
echo ""
echo "========================================"
echo "Validation Summary"
echo "========================================"
echo "Errors:   $ERRORS"
echo "Warnings: $WARNINGS"
echo ""

if [ $ERRORS -gt 0 ]; then
    echo -e "${RED}VALIDATION FAILED${NC}"
    echo ""
    echo "The build has critical issues that will cause runtime failures."
    echo "Please review the errors above and rebuild with fixes."
    exit 1
elif [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}VALIDATION PASSED WITH WARNINGS${NC}"
    echo ""
    echo "The build may have issues. Review warnings above."
    exit 0
else
    echo -e "${GREEN}VALIDATION PASSED${NC}"
    echo ""
    echo "All checks passed. The build appears ready for deployment."
    exit 0
fi
