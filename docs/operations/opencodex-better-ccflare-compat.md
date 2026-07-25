# OpenCodex to better-ccflare Claude OAuth Compat Runbook

This runbook locks the supported lane for Codex-style OpenCodex traffic that
must use Claude OAuth accounts through better-ccflare.

## Blessed Architecture

```text
Codex Desktop/native Codex OAuth
  -> OpenCodex default provider: openai
  -> ChatGPT/Codex native backend

OpenCodex anthropic-ccflare provider
  -> http://127.0.0.1:8088/v1/responses
  -> better-ccflare /v1/responses adapter
  -> explicit claude-code-compat shaping
  -> allowlisted Anthropic OAuth accounts
```

The Claude-Code compatibility layer belongs in better-ccflare. OpenCodex should
not carry a local `claudeCodeCompat` provider flag or synthesize Claude Code
headers itself for this lane.

## Operator Contract

OpenCodex:

- `defaultProvider` stays `openai`.
- The `anthropic-ccflare` provider uses `adapter: "openai-responses"`.
- The `anthropic-ccflare` provider points to `http://127.0.0.1:8088`.
- The `anthropic-ccflare` provider uses `responsesPath: "/v1/responses"`.
- The `anthropic-ccflare` provider must not include `claudeCodeCompat`.

better-ccflare:

- `/v1/responses` excludes Anthropic OAuth accounts by default.
- `CODEX_CLAUDE_OAUTH_MODE=claude-code-compat` is the explicit opt-in.
- `CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST` must be non-empty in compat mode.
- Manual pauses, rate limits, reauth requirements, and model-scoped capacity
  still apply to allowlisted accounts.
- Compat traffic logs include
  `source=openai-responses-adapter mode=claude-code-compat`.

Fallback smoothing:

- Fable remains primary.
- The blessed Fable family mapping is:
  `claude-fable-5 -> claude-sonnet-5 -> claude-opus-5`.
- This mapping is only incident smoothing. It is not proof that fallback was
  exercised; forced fallback drills are quota-spending incident tests.

## Green Check

Run the no-quota health/config check:

```bash
bun run check:opencodex-compat
```

To include the remote container environment check:

```bash
BETTER_CCFLARE_SSH_HOST=root@178.156.223.148 \
BETTER_CCFLARE_CONTAINER=better-ccflare-test \
bun run check:opencodex-compat
```

To spend quota on a real OpenCodex smoke:

```bash
RUN_LIVE_SMOKE=1 bun run check:opencodex-compat
```

Do not enable live smoke in cron or broad automated loops.

## Production Pin

For this local stack, do not run `latest`. Keep the running container pinned to
the known-good image tag and retain rollback containers/images until the patch is
merged upstream and redeployed from a release artifact.

Current known-good local image:

```text
better-ccflare:opencodex-compat-20260725T055936Z
```

## Rollback

Rollback handles for the local stack:

- OpenCodex config backup:
  `/Users/danielalberttis/.opencodex/config.json.backup-responses-ccflare-20260725T052401Z`
- OpenCodex launchd plist backup:
  `/Users/danielalberttis/Library/LaunchAgents/com.opencodex.proxy.plist.backup-20260725T0058-tool-search-output-fix`
- better-ccflare DB backup before fallback mappings:
  `/opt/better-ccflare-test/backups/better-ccflare.20260725T060239Z.before-fable-model-mapping.db`
- previous container image:
  `better-ccflare:opencodex-compat-20260725T054744Z`

Rollback outline:

```bash
docker rm -f better-ccflare-test
docker rename better-ccflare-test-rollback-20260725T055936Z better-ccflare-test
docker start better-ccflare-test
```

Restore OpenCodex config/plist only if the local proxy path itself is broken.

## What This Does Not Prove

- It does not prove every Claude account has fresh quota.
- It does not prove forced Fable fallback unless a deliberate drill is run.
- It does not make OpenCodex the default route for native Codex Desktop work.
- It does not make vector retrieval or request history rows proof of account
  selection; use service logs and source-backed checks.
