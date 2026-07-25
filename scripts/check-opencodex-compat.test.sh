#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() {
	find "$TMP_DIR" -type f -delete
	rmdir "$TMP_DIR"
}
trap cleanup EXIT

write_config() {
	cat >"$TMP_DIR/opencodex-config.json" <<'JSON'
{
  "defaultProvider": "openai",
  "providers": {
    "anthropic-ccflare": {
      "adapter": "openai-responses",
      "baseUrl": "http://better.test",
      "responsesPath": "/v1/responses",
      "hasClaudeCodeCompat": false
    }
  }
}
JSON
}

write_mock_curl() {
	local mode="$1"
	cat >"$TMP_DIR/mock-curl" <<MOCK
#!/usr/bin/env bash
set -euo pipefail
url="\${@: -1}"
case "\$url" in
  http://opencodex.test/healthz)
    printf '%s\n' '{"status":"ok"}'
    ;;
  http://opencodex.test/v1/models)
    if [[ "$mode" == "split" ]]; then
      printf '%s\n' '{"data":[{"owned_by":"openai","id":"anthropic-ccflare/claude-sonnet-5"},{"owned_by":"anthropic-ccflare","id":"openai/gpt-5"}]}'
    else
      printf '%s\n' '{"data":[{"owned_by":"anthropic-ccflare","id":"anthropic-ccflare/claude-sonnet-5"}]}'
    fi
    ;;
  http://better.test/health)
    printf '%s\n' '{"status":"ok"}'
    ;;
  http://better.test/api/config/strategy)
    printf '%s\n' '{"strategy":"session"}'
    ;;
  http://better.test/api/accounts)
    printf '%s\n' '[{"provider":"anthropic","modelMappings":{"fable":["claude-fable-5","claude-sonnet-5","claude-opus-5"]}}]'
    ;;
  *)
    echo "unexpected URL: \$url" >&2
    exit 22
    ;;
esac
MOCK
	chmod +x "$TMP_DIR/mock-curl"
}

run_checker() {
	CURL_BIN="$TMP_DIR/mock-curl" \
	OPENCODEX_BASE_URL=http://opencodex.test \
	BETTER_CCFLARE_BASE_URL=http://better.test \
	OPENCODEX_CONFIG="$TMP_DIR/opencodex-config.json" \
	RUN_LIVE_SMOKE=0 \
	"$SCRIPT_DIR/check-opencodex-compat.sh"
}

write_config

write_mock_curl split
if run_checker >"$TMP_DIR/split.out" 2>"$TMP_DIR/split.err"; then
	echo "not ok - split catalog unexpectedly passed" >&2
	cat "$TMP_DIR/split.out" >&2
	exit 1
fi
grep -F "OpenCodex catalog does not expose anthropic-ccflare models" \
	"$TMP_DIR/split.err" >/dev/null
printf 'ok - split catalog fails\n'

write_mock_curl good
run_checker >"$TMP_DIR/good.out"
grep -F "ok - OpenCodex catalog exposes anthropic-ccflare models" \
	"$TMP_DIR/good.out" >/dev/null
printf 'ok - correlated catalog passes\n'
