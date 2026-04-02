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
# POSIX sh compatible — no bash-only constructs (no process substitution, no read -d '').

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

# Collect invalid BUN_JSC_* variable names.
# Prefer `env -0` (NUL-delimited) to handle values containing spaces/newlines.
# We convert NUL bytes to newlines with `tr` so we can use POSIX `read`.
# Falls back to plain `env` for systems without `-0` support (rare).
_invalid_vars=""
if env -0 >/dev/null 2>&1; then
    # env -0 available — convert NUL separators to newlines and parse.
    # This avoids process substitution (<(...)) and bash-only `read -d ''`.
    _tmpfile="$(mktemp)"
    env -0 | tr '\0' '\n' > "$_tmpfile"
    while IFS='=' read -r _varname _rest; do
        case "$_varname" in
            BUN_JSC_*)
                if ! is_allowed "$_varname"; then
                    _invalid_vars="$_invalid_vars $_varname"
                fi
                ;;
        esac
    done < "$_tmpfile"
    rm -f "$_tmpfile"
else
    # Fallback: parse env line-by-line. Handles the common case where values
    # don't contain embedded newlines (rare for BUN_JSC_* vars).
    while IFS='=' read -r _varname _rest; do
        case "$_varname" in
            BUN_JSC_*)
                if ! is_allowed "$_varname"; then
                    _invalid_vars="$_invalid_vars $_varname"
                fi
                ;;
        esac
    done <<EOF
$(env)
EOF
fi

# Unset invalid variables and emit warnings.
# This works whether the script is executed directly (ExecStartPre=) or sourced.
# For ExecStartPre= usage, systemd re-reads the environment from the unit file
# for ExecStart=, so invalid vars set in the unit file itself won't be unset
# here — remove them from the unit file directly.
for _varname in $_invalid_vars; do
    echo "preflight-env: WARNING: unsetting invalid BUN_JSC_* variable: $_varname" >&2
    echo "preflight-env: hint: use --smol flag instead of BUN_JSC_* env vars for memory tuning" >&2
    unset "$_varname" 2>/dev/null || true
done

exit 0
