#!/bin/bash
# Copyright (c) 2025-2026 Franklin Softworks LLC
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# common.sh - Shared utilities for the build pipeline
# Provides logging, timestamps, and common functions

# Colors for terminal output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly NC='\033[0m' # No Color
readonly BOLD='\033[1m'

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $(timestamp) $*"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $(timestamp) $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $(timestamp) $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(timestamp) $*" >&2
}

log_debug() {
    if [[ "${VERBOSE:-false}" == "true" ]]; then
        echo -e "${CYAN}[DEBUG]${NC} $(timestamp) $*" >&2
    fi
}

log_header() {
    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD} $*${NC}"
    echo -e "${BOLD}========================================${NC}"
}

log_step() {
    echo -e "${CYAN}>>>${NC} $*"
}

# Timestamp in ISO 8601 format
timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

# Timestamp for filenames (no colons)
timestamp_filename() {
    date '+%Y%m%d_%H%M%S'
}

# ISO 8601 timestamp for JSON
timestamp_iso() {
    date -u '+%Y-%m-%dT%H:%M:%SZ'
}

# Convert bytes to human-readable size
human_size() {
    local bytes=$1
    if [[ $bytes -lt 1024 ]]; then
        echo "${bytes} B"
    elif [[ $bytes -lt 1048576 ]]; then
        echo "$(( bytes / 1024 )) KB"
    elif [[ $bytes -lt 1073741824 ]]; then
        printf "%.2f MB" "$(echo "scale=2; $bytes / 1048576" | bc)"
    else
        printf "%.2f GB" "$(echo "scale=2; $bytes / 1073741824" | bc)"
    fi
}

# Check if a command exists
ensure_command() {
    local cmd=$1
    if ! command -v "$cmd" &> /dev/null; then
        log_error "Required command '$cmd' not found"
        return 1
    fi
    return 0
}

# Check all required commands exist
check_requirements() {
    local missing=()
    local required_commands=(
        "sha256sum"
        "jq"
        "node"
        "docker"
        "git"
        "bc"
    )

    for cmd in "${required_commands[@]}"; do
        if ! command -v "$cmd" &> /dev/null; then
            missing+=("$cmd")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required commands: ${missing[*]}"
        return 1
    fi

    return 0
}

# Get duration in human-readable format
format_duration() {
    local seconds=$1
    if [[ $seconds -lt 60 ]]; then
        echo "${seconds}s"
    elif [[ $seconds -lt 3600 ]]; then
        local mins=$((seconds / 60))
        local secs=$((seconds % 60))
        echo "${mins}m ${secs}s"
    else
        local hours=$((seconds / 3600))
        local mins=$(( (seconds % 3600) / 60 ))
        echo "${hours}h ${mins}m"
    fi
}

# Decide whether this run may become latest_successful (finding C1).
# Only a fully tested, genuinely completed, exit-0 run whose status is
# "success" qualifies. Dry runs, skipped-test runs, package-only runs, and
# runs with failing gating tests must never bless latest_successful, because
# deployment/human-in-the-loop scripts trust it to serve shippable artifacts.
# Usage: should_update_latest_successful <exit_code> <completed> <status>
should_update_latest_successful() {
    local exit_code=$1
    local completed=$2   # PIPELINE_COMPLETED
    local status=$3      # PIPELINE_RUN_STATUS
    [[ "$exit_code" -eq 0 && "$completed" == "true" && "$status" == "success" ]]
}

# Cleanup trap handler
# Usage: trap cleanup_trap EXIT
cleanup_trap() {
    local exit_code=$?

    # Kill any background processes we started
    if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        log_debug "Stopping demo server (PID: $SERVER_PID)"
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi

    # The Phase 4 early half (build_and_deploy.sh start_early_gating) runs in its
    # own session while the modules build. A pipeline that exits before Phase 4
    # collects it must not leave it running: it would keep the test suite's
    # one-run-at-a-time guard held and keep writing into this run dir.
    if declare -F kill_early_gating >/dev/null; then
        kill_early_gating || true
    fi

    # Clean up temp files if any
    if [[ -n "${TEMP_DIR:-}" && -d "$TEMP_DIR" ]]; then
        log_debug "Cleaning up temp directory: $TEMP_DIR"
        rm -rf "$TEMP_DIR"
    fi

    # Write run summary if run directory exists
    if [[ -n "${RUN_DIR:-}" && -d "${RUN_DIR:-}" ]]; then
        write_run_summary "$exit_code"

        # Update latest_successful symlink only on genuine completion of a
        # fully tested run (finding C1). Deployment and human-in-the-loop
        # scripts should always use latest_successful (not latest) to avoid
        # serving broken/untested artifacts. PIPELINE_COMPLETED is only set
        # right before intentional exit 0, so signal-killed or interrupted runs
        # won't update the symlink; PIPELINE_RUN_STATUS must be "success"
        # (not dry_run/untested/package_only/tests_failed).
        if should_update_latest_successful "$exit_code" "${PIPELINE_COMPLETED:-false}" "${PIPELINE_RUN_STATUS:-}"; then
            local run_basename
            run_basename=$(basename "$RUN_DIR")
            local runs_dir
            runs_dir=$(dirname "$RUN_DIR")
            ln -sfn "$run_basename" "$runs_dir/latest_successful"
            log_success "Updated latest_successful -> $run_basename"
        else
            log_info "latest_successful NOT updated (status: ${PIPELINE_RUN_STATUS:-none}, exit: $exit_code)"
        fi
    fi

    if [[ $exit_code -ne 0 ]]; then
        log_error "Pipeline exited with code $exit_code"
    fi

    exit $exit_code
}

# Create a temp directory that will be cleaned up on exit
create_temp_dir() {
    TEMP_DIR=$(mktemp -d -t pipeline_XXXXXX)
    log_debug "Created temp directory: $TEMP_DIR"
    echo "$TEMP_DIR"
}

# Wait for a server to be ready
# Handles both HTTP and HTTPS (self-signed certs) URLs.
# Accepts HTTP 200 or 301 (redirect) as "server is up".
wait_for_server() {
    local url=$1
    local timeout=${2:-30}
    local start_time=$(date +%s)

    log_debug "Waiting for server at $url (timeout: ${timeout}s)"

    while true; do
        local http_code
        http_code=$(curl -sk -o /dev/null -w "%{http_code}" "$url" 2>/dev/null) || true
        if [[ "$http_code" == "200" || "$http_code" == "301" ]]; then
            log_debug "Server is ready (HTTP $http_code)"
            return 0
        fi

        local elapsed=$(($(date +%s) - start_time))
        if [[ $elapsed -ge $timeout ]]; then
            log_error "Server did not respond within ${timeout}s"
            return 1
        fi

        sleep 1
    done
}

# Get the workspace root directory
get_workspace_root() {
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # Go up from pipeline/lib to workspace root
    echo "$(cd "$script_dir/../.." && pwd)"
}

# Check if running in dry-run mode
is_dry_run() {
    [[ "${DRY_RUN:-false}" == "true" ]]
}

# Execute or print command based on dry-run mode
run_or_print() {
    if is_dry_run; then
        log_info "[DRY-RUN] Would execute: $*"
        return 0
    else
        "$@"
    fi
}

# Initialize a timestamped run directory for this pipeline invocation.
# Creates $releases_dir/runs/run_<timestamp>/ and a "latest" symlink.
# Note: "latest" always points to the most recent run (pass or fail).
# The "latest_successful" symlink is updated by cleanup_trap only on success.
# Deployment scripts should always use latest_successful.
# Prints the run directory path to stdout.
init_run_dir() {
    local releases_dir=$1
    local runs_dir="$releases_dir/runs"
    local ts
    ts=$(timestamp_filename)
    local run_dir="$runs_dir/run_${ts}"

    mkdir -p "$run_dir"

    # Update "latest" symlink (relative so it works if tree is moved)
    ln -sfn "run_${ts}" "$runs_dir/latest"

    echo "$run_dir"
}

# Redirect all stdout+stderr to a master log via tee.
# Requires RUN_DIR to be set.
setup_master_log() {
    exec > >(tee -a "$RUN_DIR/pipeline.log") 2>&1
}

# Remove the oldest run_* directories beyond the retention limit.
# Usage: prune_run_dirs <runs_dir> [keep]
prune_run_dirs() {
    local runs_dir=$1
    local keep=${2:-20}

    [[ -d "$runs_dir" ]] || return 0

    local dirs=()
    while IFS= read -r d; do
        dirs+=("$d")
    done < <(find "$runs_dir" -maxdepth 1 -type d -name 'run_*' | sort)

    local total=${#dirs[@]}
    if [[ $total -le $keep ]]; then
        return 0
    fi

    local to_remove=$(( total - keep ))
    for (( i=0; i<to_remove; i++ )); do
        log_debug "Pruning old run directory: ${dirs[$i]}"
        rm -rf "${dirs[$i]}"
    done
}
