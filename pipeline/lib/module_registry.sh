#!/bin/bash
# module_registry.sh - Module definitions and metadata
# Loads and provides access to module configuration

# Path to the modules configuration file
MODULES_CONFIG="${MODULES_CONFIG:-$(dirname "${BASH_SOURCE[0]}")/../config/modules.json}"

# module_registry.sh is sourced BOTH by pipeline scripts that load common.sh first
# (build_and_deploy.sh) and by standalone ones that deliberately do not --
# package.sh and deploy.sh define their own colors, and sourcing common.sh would
# make those readonly under them. Provide the one logging function _load_config
# needs, without clobbering common.sh's richer version when it is already present.
if ! declare -F log_error >/dev/null 2>&1; then
    log_error() { echo "[ERROR] $*" >&2; }
fi

# Cache for loaded config
_MODULES_CONFIG_CACHE=""

# Load the modules configuration
_load_config() {
    if [[ -z "$_MODULES_CONFIG_CACHE" ]]; then
        if [[ ! -f "$MODULES_CONFIG" ]]; then
            log_error "Modules config not found: $MODULES_CONFIG"
            return 1
        fi
        _MODULES_CONFIG_CACHE=$(cat "$MODULES_CONFIG")
    fi
    echo "$_MODULES_CONFIG_CACHE"
}

# Get list of all available modules
get_available_modules() {
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r '.modules | keys[]'
}

# Get default modules to build
get_default_modules() {
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r '.default_modules[]'
}

# Get the config file path for a module
get_module_config() {
    local module=$1
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r ".modules[\"$module\"].config // empty"
}

# Get the build command for a module
get_module_build_command() {
    local module=$1
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r ".modules[\"$module\"].build_command // empty"
}

# Get the patch suffix for a module (for filtering module-specific patches)
get_module_patch_suffix() {
    local module=$1
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r ".modules[\"$module\"].patch_suffix // empty"
}

# Get the artifact prefix for a module.
#
# This names the SHIPPED artifacts only: <prefix>.wasm / <prefix>.data /
# <prefix>.js as they land in web/modules/<module>/ and in the release tarball --
# the names a browser actually fetches.
#
# It deliberately does NOT name the BUILD-OUTPUT artifacts in finished_packages/,
# which are minted as soffice-<module>.wasm by engine/build/orchestrator.sh. Those
# are two different concepts that both happen to start with "soffice": one answers
# "what does the browser fetch", the other "which module's build output is this".
# See the header of tests/gates/test_artifact_prefix_wiring.sh for the reasoning.
#
# Defaults to "soffice" when the key is absent or null, so a module stanza that
# omits it keeps today's names.
get_module_artifact_prefix() {
    local module=$1
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r ".modules[\"$module\"].artifact_prefix // \"soffice\""
}

# Get supported formats for a module
get_module_formats() {
    local module=$1
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r ".modules[\"$module\"].formats[]"
}

# Get module description
get_module_description() {
    local module=$1
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r ".modules[\"$module\"].description // empty"
}

# Get the web module directory
get_module_web_dir() {
    local module=$1
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r ".modules[\"$module\"].web_module_dir // empty"
}

# Get test fixtures directory for a module
get_module_fixtures_dir() {
    local module=$1
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r ".modules[\"$module\"].test_fixtures_dir // empty"
}

# Check if a module is valid
is_valid_module() {
    local module=$1
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -e ".modules[\"$module\"]" > /dev/null 2>&1
}

# Get a path from config
get_config_path() {
    local path_key=$1
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r ".paths[\"$path_key\"] // empty"
}

# Get build scripts list
get_build_scripts() {
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r '.build_scripts[]'
}

# Get retention config
get_retention_count() {
    local type=$1  # "successful_builds" or "failed_builds"
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r ".retention[\"$type\"] // 10"
}

# Get test server port
get_test_server_port() {
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r '.test_config.server_port // 8080'
}

# Get test server root
get_test_server_root() {
    local config
    config=$(_load_config) || return 1
    echo "$config" | jq -r '.test_config.server_root // "web"'
}

# Validate module list (checks all modules are valid)
validate_modules() {
    local modules=("$@")
    local invalid=()

    for module in "${modules[@]}"; do
        if ! is_valid_module "$module"; then
            invalid+=("$module")
        fi
    done

    if [[ ${#invalid[@]} -gt 0 ]]; then
        log_error "Invalid module(s): ${invalid[*]}"
        log_info "Available modules: $(get_available_modules | tr '\n' ' ')"
        return 1
    fi

    return 0
}

# Print module info
print_module_info() {
    local module=$1

    if ! is_valid_module "$module"; then
        log_error "Unknown module: $module"
        return 1
    fi

    echo "Module: $module"
    echo "  Description: $(get_module_description "$module")"
    echo "  Config:      $(get_module_config "$module")"
    echo "  Build cmd:   $(get_module_build_command "$module")"
    echo "  Formats:     $(get_module_formats "$module" | tr '\n' ' ')"
    echo "  Web dir:     $(get_module_web_dir "$module")"
}

# List all modules with their info
list_all_modules() {
    log_header "Available Modules"
    for module in $(get_available_modules); do
        echo ""
        print_module_info "$module"
    done
}
