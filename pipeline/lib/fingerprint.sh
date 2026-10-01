#!/bin/bash
# fingerprint.sh - Change detection functions
# Computes SHA256 fingerprints to determine if rebuilds are needed

# Get the workspace root (needed for paths)
_get_root() {
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    echo "$(cd "$script_dir/../.." && pwd)"
}

# Directory where fingerprints are stored
_get_fingerprint_dir() {
    echo "$(_get_root)/.pipeline_state"
}

# Compute SHA256 hash of a file
_file_hash() {
    local file=$1
    if [[ -f "$file" ]]; then
        sha256sum "$file" | cut -d' ' -f1
    else
        echo "missing"
    fi
}

# Get patches that apply to a module
# This function is the single source of truth for patch filtering.
# Both fingerprint computation and apply_patches.sh use this function.
_get_module_patches() {
    local module=$1
    local root=$(_get_root)
    local patches_dir="$root/engine/patches"

    for patch in $(ls "$patches_dir"/*.patch 2>/dev/null | sort); do
        local basename
        basename=$(basename "$patch")

        # A universal *-wasm.patch that must NOT reach one specific module.
        #
        # build-forms-without-dbconnectivity (#155) builds libfrmlo.a into every
        # module. That fixed item 4 (ActiveX shapes in `presentations`, measured),
        # but it REGRESSED Calc: an .ods containing <office:forms> stopped loading
        # entirely, because the form service now exists, gets instantiated, and
        # throws on the dbaccess RowSet that WASM cannot build. Before #155 the
        # service was absent, the elements were skipped, and the document loaded
        # without its controls. See bugs/ods_with_forms_fails_to_load.md.
        #
        # Making the RowSet optional (patch `form-without-rowset`) was tried and
        # is WORSE -- it turns the clean refusal into a WASM trap and spreads that
        # trap to a chart fixture containing no form at all. Rejected with
        # measurements in docs/FORMS_LATENT_WASM_TRAP_DEFERRED.md.
        #
        # So the forms library is withheld from `spreadsheets` alone. Calc regains
        # the pre-#155 behaviour exactly where the regression is; `presentations`
        # keeps item 4. Nothing measured is lost: #155's only demonstrated gain
        # was ActiveX rendering in presentations.
        if [[ "$basename" == *"build-forms-without-dbconnectivity"* && "$module" == "spreadsheets" ]]; then
            continue
        fi

        # Mirror the exact filtering logic from apply_patches.sh
        case "$basename" in
            *-documents.patch)
                [[ "$module" != "documents" ]] && continue
                ;;
            *-spreadsheets-charts.patch)
                [[ "$module" != "spreadsheets-charts" ]] && continue
                ;;
            *-spreadsheets.patch)
                [[ "$module" != "spreadsheets" && "$module" != "spreadsheets-charts" ]] && continue
                ;;
            *-presentations.patch)
                # pdf-pptx uses the Impress engine — apply Impress patches to it too
                # (except ucb-sfx-libraries which has a pdf-pptx-specific version)
                if [[ "$module" == "pdf-pptx" ]]; then
                    [[ "$basename" == *"add-ucb-sfx-libraries"* ]] && continue
                    # ...and except enable-pdfimport, which pdf-pptx ALREADY receives
                    # from the *-pdf-docx.patch arm below. The two files are BYTE-
                    # IDENTICAL apart from their diff headers, so routing both here
                    # made the second one fail to apply and killed the build after
                    # one second, three weeks after the last successful pdf-pptx
                    # build. `presentations` still needs this copy: the pdf-docx one
                    # is not routed there.
                    [[ "$basename" == *"enable-pdfimport"* ]] && continue
                elif [[ "$module" != "presentations" ]]; then
                    continue
                fi
                ;;
            *-pdf-docx.patch)
                case "$basename" in
                    *enable-pdfimport*|*poppler-emscripten*|*pdfimport-inline*)
                        [[ "$module" != "pdf-docx" && "$module" != "pdf-pptx" ]] && continue
                        ;;
                    *formfield*|*exclude-formfieldbutton*)
                        [[ "$module" != "pdf-docx" && "$module" != "pdf-pptx" ]] && continue
                        ;;
                    *add-ucb-sfx-libraries-pdf-docx*)
                        [[ "$module" != "pdf-docx" ]] && continue
                        ;;
                    *)
                        [[ "$module" != "pdf-docx" ]] && continue
                        ;;
                esac
                ;;
            *-pdf-xlsx.patch)
                # pdf-xlsx module is deprecated — skip these patches for all modules
                continue
                ;;
            *-pdf-pptx.patch)
                [[ "$module" != "pdf-pptx" ]] && continue
                ;;
        esac

        echo "$patch"
    done
}

# Report which patches changed compared to the last successful build manifest
report_patch_changes() {
    local module=$1
    local root=$(_get_root)

    # Get current patches for this module
    declare -A current_patches
    for patch in $(_get_module_patches "$module"); do
        local name=$(basename "$patch")
        local hash=$(_file_hash "$patch")
        current_patches[$name]=$hash
    done

    # Get patches from last successful build manifest
    local latest_archive
    latest_archive=$(get_latest_archive "$module" "successful") || return

    local manifest="$latest_archive/manifest.json"
    [[ ! -f "$manifest" ]] && return

    declare -A old_patches
    while IFS= read -r line; do
        local name=$(echo "$line" | jq -r '.filename')
        local hash=$(echo "$line" | jq -r '.sha256')
        old_patches[$name]=$hash
    done < <(jq -c '.patches_applied[]' "$manifest" 2>/dev/null)

    # Diff: new or modified patches
    for name in "${!current_patches[@]}"; do
        if [[ -z "${old_patches[$name]+x}" ]]; then
            log_info "  + NEW patch: $name"
        elif [[ "${current_patches[$name]}" != "${old_patches[$name]}" ]]; then
            log_info "  ~ MODIFIED patch: $name"
        fi
    done

    # Diff: removed patches
    for name in "${!old_patches[@]}"; do
        if [[ -z "${current_patches[$name]+x}" ]]; then
            log_info "  - REMOVED patch: $name"
        fi
    done
}

# Compute fingerprint for a module
# This is a SHA256 of all inputs that affect the build
compute_module_fingerprint() {
    local module=$1
    local root=$(_get_root)
    local fingerprint_input=""

    log_debug "Computing fingerprint for module: $module"

    # 1. Hash all applicable patches (sorted alphabetically)
    log_debug "  Hashing patches..."
    local patch_count=0
    for patch in $(_get_module_patches "$module"); do
        # Include BOTH filename and content hash so renames trigger rebuilds
        fingerprint_input+=$(basename "$patch")
        fingerprint_input+=$(_file_hash "$patch")
        # Note: Use ((++var)) not ((var++)) to avoid exit code 1 when var=0 with set -e
        ((++patch_count))
    done
    log_debug "    $patch_count patches"

    # 2. Hash the module config file
    log_debug "  Hashing config..."
    local config_file="$root/$(get_module_config "$module")"
    fingerprint_input+=$(_file_hash "$config_file")

    # 3. Hash build scripts (from modules.json build_scripts list)
    log_debug "  Hashing build scripts..."
    for script in $(get_build_scripts); do
        fingerprint_input+=$(_file_hash "$root/$script")
    done

    # 4. Hash all C++ bridge sources (catches future additions beyond build_scripts list)
    log_debug "  Hashing engine/bridge/ files..."
    for src_file in $(find "$root/engine/bridge" -type f 2>/dev/null | sort); do
        fingerprint_input+=$(basename "$src_file")
        fingerprint_input+=$(_file_hash "$src_file")
    done

    # 5. Hash post-patch hooks
    log_debug "  Hashing hooks..."
    local hooks_dir="$root/engine/build/hooks"
    if [[ -d "$hooks_dir" ]]; then
        for hook in "$hooks_dir"/*.sh; do
            if [[ -f "$hook" ]]; then
                fingerprint_input+=$(_file_hash "$hook")
            fi
        done
    fi

    # 6. Hash the build-TRANSFORM tools + the toolchain image (audit D5-3).
    # build.sh/orchestrator.sh (hashed above) only INVOKE these; their own bytes
    # determine the shipped soffice.data/soffice.wasm. Without hashing them, editing
    # e.g. slim_soffice_data.py's KEEP_UI_FILES whitelist, or the emsdk Dockerfile,
    # leaves the fingerprint unchanged -> "no changes, skipping rebuild" -> the STALE
    # artifact ships and the change silently never takes effect.
    log_debug "  Hashing build-transform tools + toolchain image..."
    if [[ -d "$root/engine/tools" ]]; then
        # Exclude engine/tools/agents/ — those are dev/debug agents that do NOT
        # transform the shipped bytes; hashing them would force spurious full
        # rebuilds of every module on an unrelated edit (audit D5 F5).
        for tool in $(find "$root/engine/tools" -type f \( -name '*.py' -o -name '*.sh' \) -not -path '*/agents/*' 2>/dev/null | sort); do
            fingerprint_input+=$(basename "$tool")
            fingerprint_input+=$(_file_hash "$tool")
        done
    fi
    # apply_patches.sh APPLIES the patches during the build (invoked by
    # orchestrator.sh), so its application/ordering logic determines the output —
    # editing it must invalidate the fingerprint (audit D5 F4). (The VFS *generators*
    # in engine/scripts are patch-CREATION tools whose output — the patch files — is
    # already hashed above, so they don't need hashing here.)
    [[ -f "$root/engine/scripts/apply_patches.sh" ]] && fingerprint_input+=$(_file_hash "$root/engine/scripts/apply_patches.sh")
    for dfile in "$root/docker/Dockerfile.builder" "$root/docker/Dockerfile.golden-master"; do
        [[ -f "$dfile" ]] && fingerprint_input+=$(_file_hash "$dfile")
    done
    # THE PINNED BUILDER DIGEST, hashed ALONGSIDE the Dockerfile rather than
    # instead of it.
    #
    # The Dockerfile describes how the image WOULD be built; the lock file names
    # the image that will actually COMPILE the module. They can disagree -- an
    # edited Dockerfile with a stale pin means the build still uses the old
    # toolchain -- and change detection must notice either moving. Replacing the
    # Dockerfile hash with the digest would have made the fingerprint strictly
    # LESS sensitive, which is the wrong direction for a check whose failure mode
    # is "No changes detected" on a build that should have run.
    [[ -f "$root/infra/runner/builder-image.lock.json" ]] && \
        fingerprint_input+=$(_file_hash "$root/infra/runner/builder-image.lock.json")

    # 6. Compute final fingerprint
    local fingerprint
    fingerprint=$(echo -n "$fingerprint_input" | sha256sum | cut -d' ' -f1)

    log_debug "  Fingerprint: ${fingerprint:0:16}..."
    echo "$fingerprint"
}

# Get the path to the fingerprint file for a module
_get_fingerprint_file() {
    local module=$1
    echo "$(_get_fingerprint_dir)/${module}.fingerprint"
}

# Get cached fingerprint for a module (if exists)
get_cached_fingerprint() {
    local module=$1
    local fp_file
    fp_file=$(_get_fingerprint_file "$module")

    if [[ -f "$fp_file" ]]; then
        cat "$fp_file"
    else
        echo ""
    fi
}

# Store fingerprint after successful build
store_fingerprint() {
    local module=$1
    local fingerprint=$2
    local fp_dir
    local fp_file

    fp_dir=$(_get_fingerprint_dir)
    fp_file=$(_get_fingerprint_file "$module")

    # Ensure directory exists
    mkdir -p "$fp_dir"

    # Store fingerprint
    echo "$fingerprint" > "$fp_file"
    log_debug "Stored fingerprint for $module: ${fingerprint:0:16}..."

    # Update last_build.json
    _update_last_build "$module" "$fingerprint"
}

# Update the last_build.json metadata
_update_last_build() {
    local module=$1
    local fingerprint=$2
    local fp_dir
    local last_build_file

    fp_dir=$(_get_fingerprint_dir)
    last_build_file="$fp_dir/last_build.json"

    # Create or update the JSON file
    local timestamp
    timestamp=$(timestamp_iso)

    if [[ -f "$last_build_file" ]]; then
        # Update existing file
        local temp_file
        temp_file=$(mktemp)
        jq --arg module_name "$module" \
           --arg fingerprint "$fingerprint" \
           --arg timestamp "$timestamp" \
           '.[$module_name] = {"fingerprint": $fingerprint, "timestamp": $timestamp}' \
           "$last_build_file" > "$temp_file"
        mv "$temp_file" "$last_build_file"
    else
        # Create new file
        jq -n --arg module_name "$module" \
              --arg fingerprint "$fingerprint" \
              --arg timestamp "$timestamp" \
              '{($module_name): {"fingerprint": $fingerprint, "timestamp": $timestamp}}' \
              > "$last_build_file"
    fi
}

# Clear cached fingerprint for a module
clear_fingerprint() {
    local module=$1
    local fp_file
    fp_file=$(_get_fingerprint_file "$module")

    if [[ -f "$fp_file" ]]; then
        rm "$fp_file"
        log_debug "Cleared fingerprint for $module"
    fi
}

# Check if module artifacts exist
_artifacts_exist() {
    local module=$1
    local root=$(_get_root)
    local web_dir="$root/$(get_module_web_dir "$module")"

    # (audit agy-D3 #4) A module needs ALL THREE runtime artifacts to actually
    # run in the browser: the wasm, the VFS .data, and the .js glue. Checking only
    # soffice.wasm meant that if .data (the ~5 MB VFS) or .js was deleted while the
    # wasm remained and fingerprints matched, needs_rebuild() returned false and
    # the pipeline SHIPPED a broken module missing its runtime data. Require each
    # to exist in raw-or-compressed form; a missing one triggers a (safe) rebuild.
    #
    # The stem comes from modules.json's artifact_prefix (get_module_artifact_prefix),
    # which makes a prefix change self-propagating: rename the prefix and the
    # artifacts under the OLD name no longer satisfy this check, so needs_rebuild()
    # reports "Artifacts missing" and the module is rebuilt and redeployed under the
    # NEW name. That matters because Phase 3 only deploys modules Phase 1 selected to
    # build -- without this, a rename would be declared and never take effect.
    local prefix
    prefix=$(get_module_artifact_prefix "$module")
    _fp_has() { [[ -f "$web_dir/$1" || -f "$web_dir/$1.br" || -f "$web_dir/$1.gz" ]]; }
    if _fp_has "$prefix.wasm" && _fp_has "$prefix.data" && _fp_has "$prefix.js"; then
        return 0
    fi

    return 1
}

# Determine if a module needs to be rebuilt
needs_rebuild() {
    local module=$1
    local force=${2:-false}

    # Force rebuild if requested
    if [[ "$force" == "true" ]]; then
        log_info "Force rebuild requested for $module"
        return 0
    fi

    # Compute current fingerprint
    local current_fp
    current_fp=$(compute_module_fingerprint "$module")

    # Get cached fingerprint
    local cached_fp
    cached_fp=$(get_cached_fingerprint "$module")

    # No cached fingerprint = needs rebuild
    if [[ -z "$cached_fp" ]]; then
        log_info "No cached fingerprint for $module - rebuild needed"
        return 0
    fi

    # Fingerprint changed = needs rebuild
    if [[ "$current_fp" != "$cached_fp" ]]; then
        log_info "Fingerprint changed for $module - rebuild needed"
        log_debug "  Cached: ${cached_fp:0:16}..."
        log_debug "  Current: ${current_fp:0:16}..."
        report_patch_changes "$module"
        return 0
    fi

    # Artifacts missing = needs rebuild
    if ! _artifacts_exist "$module"; then
        log_info "Artifacts missing for $module - rebuild needed"
        return 0
    fi

    # No rebuild needed
    log_info "No changes detected for $module - skipping rebuild"
    return 1
}

# Get detailed fingerprint info for a module (for manifests)
get_fingerprint_details() {
    local module=$1
    local root=$(_get_root)

    # Build JSON with all input hashes
    local patches_json="["
    local first=true
    for patch in $(_get_module_patches "$module"); do
        local basename
        basename=$(basename "$patch")
        local hash
        hash=$(_file_hash "$patch")

        if [[ "$first" == "true" ]]; then
            first=false
        else
            patches_json+=","
        fi
        patches_json+="{\"filename\":\"$basename\",\"sha256\":\"$hash\"}"
    done
    patches_json+="]"

    # Config hash
    local config_file="$root/$(get_module_config "$module")"
    local config_hash
    config_hash=$(_file_hash "$config_file")

    # Build scripts hashes
    local scripts_json="["
    first=true
    for script in $(get_build_scripts); do
        local hash
        hash=$(_file_hash "$root/$script")

        if [[ "$first" == "true" ]]; then
            first=false
        else
            scripts_json+=","
        fi
        scripts_json+="{\"filename\":\"$script\",\"sha256\":\"$hash\"}"
    done
    scripts_json+="]"

    # Output JSON
    cat <<EOF
{
  "module": "$module",
  "fingerprint": "$(compute_module_fingerprint "$module")",
  "patches": $patches_json,
  "config": {
    "file": "$(get_module_config "$module")",
    "sha256": "$config_hash"
  },
  "build_scripts": $scripts_json
}
EOF
}

# Print fingerprint status for all modules
print_fingerprint_status() {
    log_header "Module Fingerprint Status"

    for module in $(get_available_modules); do
        local current_fp
        current_fp=$(compute_module_fingerprint "$module")
        local cached_fp
        cached_fp=$(get_cached_fingerprint "$module")
        local artifacts
        if _artifacts_exist "$module"; then
            artifacts="present"
        else
            artifacts="missing"
        fi

        echo ""
        echo "Module: $module"
        echo "  Current fingerprint: ${current_fp:0:32}..."
        if [[ -n "$cached_fp" ]]; then
            echo "  Cached fingerprint:  ${cached_fp:0:32}..."
            if [[ "$current_fp" == "$cached_fp" ]]; then
                echo "  Status: UP TO DATE"
            else
                echo "  Status: NEEDS REBUILD (fingerprint changed)"
            fi
        else
            echo "  Cached fingerprint:  (none)"
            echo "  Status: NEEDS REBUILD (no cache)"
        fi
        echo "  Artifacts: $artifacts"
    done
}
