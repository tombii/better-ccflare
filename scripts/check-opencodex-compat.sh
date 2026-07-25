#!/usr/bin/env bash
set -euo pipefail

OPENCODEX_BASE_URL="${OPENCODEX_BASE_URL:-http://127.0.0.1:10100}"
BETTER_CCFLARE_BASE_URL="${BETTER_CCFLARE_BASE_URL:-http://127.0.0.1:8088}"
OPENCODEX_CONFIG="${OPENCODEX_CONFIG:-$HOME/.opencodex/config.json}"
EXPECTED_PROVIDER="${EXPECTED_PROVIDER:-anthropic-ccflare}"
EXPECTED_BETTER_CCFLARE_CONFIG_BASE_URL="${EXPECTED_BETTER_CCFLARE_CONFIG_BASE_URL:-$BETTER_CCFLARE_BASE_URL}"
EXPECTED_COMPAT_MODE="${EXPECTED_COMPAT_MODE:-claude-code-compat}"
EXPECTED_STRATEGY="${EXPECTED_STRATEGY:-session}"
CHECK_FABLE_FALLBACK="${CHECK_FABLE_FALLBACK:-1}"
RUN_LIVE_SMOKE="${RUN_LIVE_SMOKE:-0}"
LIVE_SMOKE_MODEL="${LIVE_SMOKE_MODEL:-anthropic-ccflare/claude-sonnet-5}"
CURL_BIN="${CURL_BIN:-curl}"
SSH_BIN="${SSH_BIN:-ssh}"

need() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "missing required command: $1" >&2
		exit 2
	fi
}

pass() {
	printf 'ok - %s\n' "$1"
}

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

need "$CURL_BIN"
need jq

opencodex_health="$("$CURL_BIN" -fsS "$OPENCODEX_BASE_URL/healthz")"
jq -e '.status == "ok"' >/dev/null <<<"$opencodex_health" \
	|| fail "OpenCodex healthz is not ok"
pass "OpenCodex healthz is ok"

opencodex_models="$("$CURL_BIN" -fsS "$OPENCODEX_BASE_URL/v1/models")"
jq -e --arg provider "$EXPECTED_PROVIDER" \
	'.data | any(.owned_by == $provider and ((.id // "") | startswith($provider + "/")))' \
	>/dev/null <<<"$opencodex_models" \
	|| fail "OpenCodex catalog does not expose $EXPECTED_PROVIDER models"
pass "OpenCodex catalog exposes $EXPECTED_PROVIDER models"

[[ -f "$OPENCODEX_CONFIG" ]] || fail "OpenCodex config missing: $OPENCODEX_CONFIG"
jq -e --arg provider "$EXPECTED_PROVIDER" \
	--arg betterBaseUrl "$EXPECTED_BETTER_CCFLARE_CONFIG_BASE_URL" '
	.defaultProvider == "openai"
	and .providers[$provider].adapter == "openai-responses"
	and .providers[$provider].baseUrl == $betterBaseUrl
	and .providers[$provider].responsesPath == "/v1/responses"
	and (.providers[$provider] | has("claudeCodeCompat") | not)
	and ((.providers[$provider] | has("hasClaudeCodeCompat") | not) or .providers[$provider].hasClaudeCodeCompat == false)
' "$OPENCODEX_CONFIG" >/dev/null \
	|| fail "OpenCodex config is not the blessed native-default + /v1/responses shape"
pass "OpenCodex config keeps native default and delegates $EXPECTED_PROVIDER to /v1/responses"

better_health="$("$CURL_BIN" -fsS "$BETTER_CCFLARE_BASE_URL/health")"
jq -e '.status == "ok"' >/dev/null <<<"$better_health" \
	|| fail "better-ccflare health is not ok"
pass "better-ccflare health is ok"

strategy_payload="$("$CURL_BIN" -fsS "$BETTER_CCFLARE_BASE_URL/api/config/strategy")"
jq -e --arg strategy "$EXPECTED_STRATEGY" '.strategy == $strategy' >/dev/null <<<"$strategy_payload" \
	|| fail "better-ccflare strategy is not $EXPECTED_STRATEGY"
pass "better-ccflare strategy is $EXPECTED_STRATEGY"

if [[ -n "${BETTER_CCFLARE_SSH_HOST:-}" && -n "${BETTER_CCFLARE_CONTAINER:-}" ]]; then
	need "$SSH_BIN"
	remote_env="$(
		"$SSH_BIN" ${BETTER_CCFLARE_SSH_OPTS:-} "$BETTER_CCFLARE_SSH_HOST" \
			"docker inspect '$BETTER_CCFLARE_CONTAINER' --format '{{range .Config.Env}}{{println .}}{{end}}'"
	)"
	grep -Fx "CODEX_CLAUDE_OAUTH_MODE=$EXPECTED_COMPAT_MODE" >/dev/null <<<"$remote_env" \
		|| fail "container env missing CODEX_CLAUDE_OAUTH_MODE=$EXPECTED_COMPAT_MODE"
	grep -E '^CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST=.+$' >/dev/null <<<"$remote_env" \
		|| fail "container env missing CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST"
	pass "remote container has explicit Claude OAuth compat mode and allowlist"
else
	pass "remote container env check skipped; set BETTER_CCFLARE_SSH_HOST and BETTER_CCFLARE_CONTAINER to enable"
fi

if [[ "$CHECK_FABLE_FALLBACK" == "1" ]]; then
	accounts_payload="$("$CURL_BIN" -fsS "$BETTER_CCFLARE_BASE_URL/api/accounts")"
	jq -e '
		[.[] | select(.provider == "anthropic")] as $accounts
		| ($accounts | length) > 0
		and all($accounts[];
			.modelMappings.fable == ["claude-fable-5", "claude-sonnet-5", "claude-opus-5"]
		)
	' >/dev/null <<<"$accounts_payload" \
		|| fail "Anthropic accounts do not all have the blessed Fable fallback chain"
	pass "Anthropic accounts have Fable fallback chain"
fi

if [[ "$RUN_LIVE_SMOKE" == "1" ]]; then
	need codex
	smoke_output="$(codex exec -m "$LIVE_SMOKE_MODEL" 'Return exactly OPENCODEX_COMPAT_GREEN_CHECK_OK' 2>&1)"
	grep -F 'OPENCODEX_COMPAT_GREEN_CHECK_OK' >/dev/null <<<"$smoke_output" \
		|| fail "live OpenCodex smoke did not return the marker"
	pass "live OpenCodex smoke returned expected marker"
else
	pass "live smoke skipped; set RUN_LIVE_SMOKE=1 to spend quota on a real request"
fi
