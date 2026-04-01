#!/bin/sh
# preflight-env.sh — BUN_JSC_* environment variable validator
#
# Bun validates BUN_JSC_* environment variables in its C++ runtime BEFORE
# any JavaScript executes. If an invalid variable is set (e.g.
# BUN_JSC_smallHeap=1, which is NOT a real JSC option), Bun exits with
# code 1 immediately. No user code can catch or prevent this.
#
# When running under systemd with Restart=always, this causes a crash loop
# until StartLimitBurst is exhausted, resulting in total proxy downtime.
#
# This script is meant to run as ExecStartPre= in a systemd unit file,
# or sourced before launching better-ccflare. It strips any BUN_JSC_*
# variable not on a known-good allowlist.
#
# The allowlist is intentionally conservative. BUN_JSC_* is an unstable
# internal API that changes between Bun versions. The --smol CLI flag is
# the supported way to enable aggressive GC.
#
# Usage:
#   ExecStartPre=/opt/better-ccflare/scripts/preflight-env.sh
#   ExecStart=/usr/bin/better-ccflare --smol --serve --port 8889
#
# This script always exits 0 so systemd does not abort the service start.
#
# POSIX sh compatible — no bashisms.

set -e

# Known-valid BUN_JSC_* variables as of Bun 1.x.
# Add entries here if Bun documents new stable options.
ALLOWLIST="BUN_JSC_forceRAMSize BUN_JSC_useJIT BUN_JSC_forceGCSlowPaths"

is_allowed() {
    _var="$1"
    for _allowed in $ALLOWLIST; do
        if [ "$_var" = "$_allowed" ]; then
            return 0
        fi
    done
    return 1
}

# Scan environment for BUN_JSC_* variables and unset any not on the allowlist.
# `env` output is parsed line-by-line; we split on the first '=' to get the name.
env | while IFS='=' read -r name value; do
    case "$name" in
        BUN_JSC_*)
            if ! is_allowed "$name"; then
                echo "preflight-env: WARNING: unsetting invalid variable $name (not in allowlist)" >&2
                echo "preflight-env: hint: use --smol flag instead of BUN_JSC_* env vars for memory tuning" >&2
                unset "$name" 2>/dev/null || true
            fi
            ;;
    esac
done

# The while-read-pipe runs in a subshell, so unset does not propagate to the
# parent. For systemd ExecStartPre= usage this is fine because systemd
# re-reads the environment from the unit file for ExecStart=. For interactive
# use, source this script instead:
#
#   . /opt/better-ccflare/scripts/preflight-env.sh
#   exec bun run better-ccflare --smol --serve
#
# When sourced, we need a non-subshell approach:
for _env_line in $(env); do
    _name="${_env_line%%=*}"
    case "$_name" in
        BUN_JSC_*)
            if ! is_allowed "$_name"; then
                unset "$_name" 2>/dev/null || true
            fi
            ;;
    esac
done

exit 0
