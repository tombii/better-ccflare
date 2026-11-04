# Web Search — Serving `web_search` Locally

## Table of Contents

1. [Overview](#overview)
2. [How the Proxy Recognises a Search Request](#how-the-proxy-recognises-a-search-request)
3. [Provider Fallback Chain](#provider-fallback-chain)
4. [The Synthesised Response](#the-synthesised-response)
5. [Setup](#setup)
6. [Configuration](#configuration)
7. [Search Traces](#search-traces)
8. [Limitations](#limitations)
9. [REST API](#rest-api)

## Overview

Claude Code's `WebSearch` tool is a hybrid. The model sees an ordinary client
tool, but Claude Code satisfies it by sending a **separate** `/v1/messages`
request whose `tools` array holds a single Anthropic **server** tool —
`{"type": "web_search_20250305", "name": "web_search", …}` — and a user turn
reading `Perform a web search for the query: <query>`. Anthropic normally runs
that search and bills for it.

When web search is enabled and at least one search provider is configured,
better-ccflare answers that one request itself:

- the request is **never forwarded upstream** and **no account is selected**,
- the query is run against your own search provider (Tavily, Exa, Brave, …),
- the response is replayed in the exact server-tool shape Claude Code expects.

The result is the same experience for the model and the client, but the search
is paid for at your provider's price instead of Anthropic's, and every search
is visible in the dashboard.

### What this is not

This is **not** an agent loop and **not** a client-tool swap. Claude Code
dispatches unknown client tool names to an error, so neither approach can work.
Exactly one request — the helper sub-request — is short-circuited; the rest of
the turn runs normally against whichever account normal routing selects.

### Fall-through is the safety net

Local search is an optimisation, never a requirement. If interception cannot
serve the request — the feature is off, nothing is configured, every provider
fails, or anything inside the interceptor throws — the request is forwarded
upstream **unchanged**, and Anthropic runs the search as it always did.

## How the Proxy Recognises a Search Request

Detection is deliberately conservative. A missed detection only means the
search is paid for at Anthropic; a false positive would swallow a real request,
so every uncertain case bails out and forwards upstream.

A request is served locally only when **all** of these hold:

| Condition | Why |
|-----------|-----|
| Path is `/v1/messages` | The helper is a Messages request; `/v1/responses` and others are untouched |
| `tools` has exactly one entry | A real agent turn carries the model's full toolset |
| That tool's `type` starts with `web_search_` | The version suffix (`web_search_20250305`, `web_search_20260209`, …) moves with Claude Code releases, so it is matched by prefix and never compared to a literal |
| `tool_choice` does not pin another tool | `auto`, `any` and `none` are compatible; `{"type":"tool","name":…}` for any other tool is not |
| The last user message starts with `Perform a web search for the query:` | The prefix is the proof that this is the helper shape — an ordinary request that merely holds a `web_search` tool would otherwise be swallowed |
| The remaining query text is non-empty | Nothing to search for |
| `allowed_domains` and `blocked_domains` are not both set | Anthropic rejects that combination itself; upstream produces the real validation error |

When detection succeeds, the query is extracted with the prefix stripped, and
the tool's `allowed_domains` / `blocked_domains` are carried through to the
provider where supported.

The `max_uses` field on the tool entry defaults to `8` when absent, matching
Anthropic's default. It is currently informational — the proxy runs one search
per helper request.

## Provider Fallback Chain

Detected requests are served by the first provider that succeeds, walking the
enabled `search_providers` rows **in priority order** (lower priority = tried
first).

```text
web_search helper request detected
        │
        ▼
┌─────────────────────────────┐
│ Load enabled providers      │  none → forward upstream (not a failure)
│ (priority order)            │
└──────┬──────────────────────┘
       ▼
┌─────────────────────────────┐
│ Provider 1 (e.g. Tavily)    │── throw ──► record health, next provider
│                             │── [] (no results) ──► return empty result ✔
│                             │── hits ──► return result ✔
└─────────────────────────────┘
```

Rules that matter when reading traces or debugging:

- **An empty result set is a success.** "This provider found nothing" is a
  valid answer and does **not** fall through to the next provider. Only an
  exception (transport error, non-2xx, timeout) triggers fallback.
- **Each attempt gets the remaining budget.** The chain has a 15-second total
  deadline (`CHAIN_DEADLINE_MS` in `packages/proxy/src/web-tools/chain.ts`);
  later providers only get what is left, so one hanging provider cannot stall
  the whole chain.
- **Cooldowns.** Credential and quota failures put a provider on cooldown, and
  it is skipped (not attempted, health left alone) until the cooldown passes:

  | Upstream status | Cooldown |
  |-----------------|----------|
  | `401` | 10 minutes |
  | `402` | 30 minutes |
  | `429` | 5 minutes |

  Other failures (5xx, timeouts, network) record health but do not cool down.
- **Credentials never leak.** Health messages have the provider's API key
  redacted and are capped at 200 characters; the trace row stores only a short
  machine code such as `tavily_401`.
- **Health writes never block a search.** Provider health is dashboard
  telemetry; the write is fired in the background so a slow or busy database
  cannot delay a completed search or the fallback to the next provider.

If every attempted provider throws, the request falls through upstream (still
paid at Anthropic) and the trace records `error`. If nothing was eligible —
feature off, no rows, all disabled or cooling down — the trace records
`fallthrough`.

## The Synthesised Response

The response is a **wire contract with Claude Code's parser**, not a general
Anthropic encoder. It contains three content blocks:

1. `server_tool_use` — the `web_search` call, with `input` written inline
   (Claude Code falls back to the original query when no `input_json_delta`
   arrives).
2. `web_search_tool_result` — `content` is an **array** of results on success.
   Claude Code's parser branches on `Array.isArray(content)`, so a failure is a
   **single error object** (`{type: "web_search_tool_result_error", error_code}`)
   with one of Anthropic's codes: `unavailable`, `too_many_requests`,
   `invalid_tool_input`, `max_uses_exceeded`. Error text is deliberately
   generic — provider names, URLs and keys never reach the client transcript.
3. A `text` block: a numbered, plain-text digest of the results. Each
   snippet is capped at 500 characters, and the whole digest is trimmed to
   `web_search_max_result_chars` (default 4000) with a trailing
   `…[truncated]` marker. An empty result set still produces a sentence
   ("No results were found for this search."), so the block is never empty.

`stop_reason` is `end_turn` and usage reports
`server_tool_use.web_search_requests: 1`.

Both `stream: true` (SSE) and non-streaming requests are answered in the shape
the client asked for.

## Setup

### 1. Turn on web search

In the dashboard, open **Search** in the sidebar (Web search settings card at
the top of the page) and switch it on, or use the API:

```bash
curl -X PATCH http://localhost:8080/api/web-search/settings \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

Web search is **off by default**: the proxy only intercepts once someone has
deliberately configured providers and enabled the feature.

### 2. Add a provider

Each provider needs a label (unique), an API key, and a priority. Priority
controls the fallback order — lower is tried first.

```bash
curl -X POST http://localhost:8080/api/search-providers \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "tavily",
    "label": "tavily-main",
    "apiKey": "tvly-…",
    "priority": 0,
    "maxResults": 10,
    "extraConfig": { "topic": "general" }
  }'
```

The dashboard's **Add provider** dialog renders the same per-provider fields
(`extraConfig`) from the catalog, so the UI and API always agree on options.

### Free tier (keyless providers)

Two providers can run with **no API key at all** by calling their public
keyless endpoints:

| Provider | Keyless endpoint | Needs | Free limits |
|----------|------------------|-------|-------------|
| **Keenable** | `POST https://api.keenable.ai/v1/search/public` | `X-Keenable-Title: better-ccflare` app id (sent automatically) | 1,000 requests/hour, 10/s, **shared per server IP** |
| **Firecrawl** | `POST https://api.firecrawl.dev/v2/search` | nothing | Anonymous calls are **IP-gated** — VPN, proxy and datacenter addresses (which most servers are) get a `403` asking for a key |

Every install is seeded with a **Free tier** row for each of these (`Keenable
(free)`, `Firecrawl (free)`), **disabled** and at last-resort priority (`900`,
`901`) on first start. The free tier is deliberately off until someone asks
for it:

- Flip the **Use free tier** checkbox on the Search page (bulk-enables every
  free-tier row), or
- Enable a row individually.

Priority is plain order: leave a free row at `900` to use it only when keyed
providers fail or are absent, or edit it to `0` to try it first. A free row
and a paid row for the same provider can coexist at different priorities;
they have separate health and cooldowns. With a key stored, a row always
calls the paid endpoint — a stored key never silently drops to the free one.

**Free and paid are a property of the key, not a label.** Every row carries a
`tier` (`free` or `paid`) which the server derives on every write: no key means
`free`, a key means `paid`. The dashboard shows it as a Free/Paid badge, and:

- Adding a key to a free row turns it **paid** — "Use free tier" stops
  touching it.
- Clearing the key on a Keenable or Firecrawl row turns it back into a
  **free** row (the edit dialog has a *Clear the stored key and switch this
  row to Free* checkbox).
- The toggle only ever acts on rows that are `free` **and** have no key, for a
  provider that actually has a keyless endpoint. It can never enable or
  disable a paid search.
- A client may send `tier` for convenience, but a value that contradicts the
  key is rejected (`400`) rather than stored.

The free endpoints accept the same request body and `extraConfig` as the
keyed ones (verified against Keenable: `mode`, `site`, date filters and
`snippet_max_length` all apply). Domain filtering still happens; a keyless
row simply cannot push `blocked_domains` down to the vendor. Deleting a free
row does not stick — it comes back, disabled, on the next start. Renaming a
free row is safe: seeding recognises it by tier, not by label.

### 3. Test it

The **Test** button on each row runs one real, minimal search against the
provider (query `better-ccflare connectivity test`) and reports latency or the
error:

```bash
curl -X POST http://localhost:8080/api/search-providers/<id>/test
```

Then use `WebSearch` in Claude Code as usual. A successful local search logs:

```text
web_search: served by tavily (tavily-main), 8 hit(s) in 412ms, query 46 chars
```

Only the query *length* is logged at info level — queries can be sensitive.

### Supported providers

| Provider | `extraConfig` | Notes |
|----------|---------------|-------|
| **Tavily** | `topic`: `general` (default), `news` | Reference adapter |
| **Exa** | `type`: `auto` (default), `lite`, `deep-lite`, `deep` | Quality/cost tier; the legacy `keyword` / `neural` / `fast` names are not offered (they would silently send `auto`) |
| **Parallel** | `mode`: `turbo`, `fast`, `basic` (default), `advanced`; `objective` (free text) | `source_policy` carries `allowed_domains` / `blocked_domains` |
| **DeepSeek** | — | Domain filtering is applied client-side to the returned hits |
| **Serper** | `gl` (country), `hl` (language) | Google results |
| **Brave Search** | `endpoint`: `llm-context` (default), `web`; `country`, `safesearch`: `off`, `moderate` (default), `strict` | Domain filtering is applied client-side. See [Brave: `web` vs `llm-context`](#brave-web-vs-llm-context) |
| **Keenable** | `mode`: `pro` (default), `realtime`; `site`; `published_after`, `published_before`, `acquired_after` (date, ISO timestamp, or `7d`-style delta); `snippet_max_length`: 180–10000 | A single `allowed_domains` entry is pushed down as `site`; multi-domain lists and blocklists are filtered client-side. Keyless-capable — see [Free tier](#free-tier-keyless-providers) |
| **Firecrawl** | `location`; `tbs` | Uses `/v2/search`. Keyless-capable — see [Free tier](#free-tier-keyless-providers) |
| **Perplexity** | `model` (default `sonar`) | **Listed but not implemented** — rows are accepted but the chain skips them |

`maxResults` accepts 1–50 (default 10). The adapter requests
`min(10, provider maxResults)` per search — the proxy asks for 10 results and
your per-provider `maxResults` is the binding limit.

The provider list and field definitions live in `SEARCH_PROVIDER_CATALOG`
(`packages/types/src/search-provider.ts`); the adapters live in
`packages/proxy/src/web-tools/adapters/`.

#### Brave: `web` vs `llm-context`

Brave's API exposes two search products with the same `/res/v1` base, and the
adapter prefers `llm-context` because a `web_search` tool result is read by a
model, not a person:

| `endpoint` | Brave endpoint | Returns |
|------------|----------------|---------|
| `llm-context` *(default)* | `/res/v1/llm/context` | Pre-extracted, query-relevant page chunks (`grounding.generic[].snippets[]`) |
| `web` | `/res/v1/web/search` | Result pages for humans: URLs and short meta-description snippets |

Any value other than `"web"` is treated as `llm-context`.

**Plans differ, and the adapter handles that itself.** LLM Context is not on
every plan — the legacy **Free AI** plan includes web search but not LLM
Context, and answers `/llm/context` in one of two ways:

```text
HTTP 400 · "The option is not included in the plan." · code: OPTION_NOT_IN_PLAN
```

```text
HTTP 429 · detail: "Request rate limit exceeded for plan" · meta.plan: "Free AI"
```

The 429 is not throttling, despite the status: the plan is not entitled to the
endpoint, so the answer never changes. Both are plan facts, not faults, so the
adapter does **not** surface either as a search failure. It retries the same
query on `web/search` and remembers the answer for that provider row for the
life of the process — subsequent searches go straight to `web/search` with no
wasted call. Any other error (a real 400, a plain 429 from `web/search`, a
5xx) still fails normally and falls through to the next provider.

Consequences:

- Rows on a legacy plan keep working with no configuration, served by
  `web/search` — even though the row is configured for `llm-context`, and
  whether the plan refuses it with the 400 or the 429.
- The **Test** button reports `ok` on such a plan, because it exercises the
  same fallback.
- The memory is scoped to the credential, not just the row: replacing the
  API key starts a fresh answer, so a row whose new key includes LLM Context
  uses it on the next search with no restart.
- Set `"endpoint": "web"` explicitly to skip the probe entirely.

The adapter pins the LLM Context budgets (`maximum_number_of_tokens` = 2048,
and the URL/snippet limits to the request's result count). Brave's defaults
(8,192 tokens, 20 URLs, 50 snippets) would pay for content the responder
truncates to 500 characters per snippet anyway. `freshness` is a `web`-only
parameter and is not sent on `llm-context`.

### Managing providers

In the dashboard: add, edit, enable/disable, reorder (drag), delete, and test.
Via the API, see [REST API](#rest-api).

## Configuration

Three fields in the configuration file (`better-ccflare.json`) or the
dashboard:

| Field | Default | Description |
|-------|---------|-------------|
| `web_search_enabled` | `false` | Master switch. Off means the helper request is forwarded upstream untouched |
| `web_search_max_result_chars` | `4000` | Cap on the plain-text digest returned to the model (clamped 500–100000). Snippets are individually capped at 500 |
| `web_search_bypass_header` | `true` | Whether `x-better-ccflare-web-tools: off` opts a single request out of interception |

These fields are runtime-updatable via `PATCH /api/web-search/settings`; no
restart is needed.

To bypass interception for one request:

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "x-better-ccflare-web-tools: off" \
  …
```

The header is honoured only while `web_search_bypass_header` is on.

### Dashboard vs. upstream search

Because the intercepted request never reaches a provider, no account is
consumed and no token usage is billed — the search does not appear under
requests or analytics. Its only trace is the `web_tool_calls` row (see below).

## Search Traces

Every intercepted helper request writes one row to `web_tool_calls`,
regardless of outcome:

| Column | Meaning |
|--------|---------|
| `timestamp` | When the search ran |
| `tool` | `web_search` |
| `provider_id` | `search_providers.id` of the provider that served (or last failed) |
| `provider_kind` | `tavily`, `exa`, … (null on fall-through) |
| `project`, `account_id` | Request attribution; `account_id` is always null here, since no account is selected |
| `query_text`, `query_chars` | The query, and its length |
| `result_count` | Hits returned (`ok` only) |
| `latency_ms` | Chain latency |
| `status` | `ok`, `error`, or `fallthrough` |
| `error_code` | Short machine code (e.g. `tavily_429`), never a provider message |
| `estimated_cost_usd` | Reserved; always null today |

Status meanings:

- **`ok`** — served locally. `result_count` is set; `0` is a valid "no results".
- **`error`** — at least one provider was tried and every attempt failed; the
  request then went upstream (and was paid for at Anthropic).
- **`fallthrough`** — nothing was eligible (feature off, no providers, all
  cooling down) or the interceptor itself failed; the request went upstream.

The dashboard's **Recent searches** section on the Web search page lists the
most recent traces with a status filter.

**Retention and privacy.** Query text is the one piece of prompt content this
table stores — a trace without its query cannot answer "what search ran". Traces
are pruned on the same window as request metadata (`REQUEST_RETENTION_DAYS`,
default 90 days), **not** the shorter payload window. Lower
`REQUEST_RETENTION_DAYS` if storing queries for that long is not acceptable.

## Limitations

- **Only Claude Code's helper shape is intercepted.** Raw-API callers that send
  a `web_search_*` server tool without the `Perform a web search for the query:`
  prompt are passed upstream, as are `web_search_preview` and other built-in
  tools on other routes.
- **One search per helper request.** `max_uses` is read but not enforced; the
  proxy does one search and returns `end_turn`.
- **`allowed_domains` / `blocked_domains` are best-effort.** Parallel receives
  them as `source_policy`; Serper, Brave, Keenable and DeepSeek filter the
  returned hits client-side; Tavily and Exa do not filter.
- **No cost accounting.** `estimated_cost_usd` is not populated.
- **Provider rows are not re-authenticated.** Replace a key by editing the
  provider (omitting `apiKey` keeps the stored one; `""` clears it). Keys are
  stored in plaintext in `search_providers.api_key`, like account API keys.

## REST API

Full schemas are in [api-http.md](./api-http.md#web-search). Summary:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/web-search/settings` | Read the three web-search settings |
| `PATCH` | `/api/web-search/settings` | Update any of them |
| `GET` | `/api/search-providers` | List providers (API keys masked as `****abcd`) |
| `POST` | `/api/search-providers` | Create a provider |
| `GET` | `/api/search-providers/meta` | Provider catalog and extra-config field definitions |
| `GET` | `/api/search-providers/:id` | Read one provider |
| `PATCH` | `/api/search-providers/:id` | Update; `provider` cannot be changed (an unchanged value is accepted and ignored), omit `apiKey` to keep it, pass `""` to clear it |
| `DELETE` | `/api/search-providers/:id` | Delete |
| `POST` | `/api/search-providers/:id/test` | Run one real test search |
| `POST` | `/api/search-providers/:id/reorder` | Set `priority` |
| `PATCH` | `/api/search-providers/free-tier` | `{"enabled": true\|false}` — bulk enable/disable every free-tier row; returns how many changed |
| `GET` | `/api/web-tool-calls` | Recent traces (`limit`, `status`, `providerKind`, `since`) |
| `GET` | `/api/web-tool-calls/summary` | Per-`(providerKind, status)` counts and latency (`hours`) |

`GET /api/web-tool-calls` accepts `limit` (1–200, default 50), `status`
(`ok` / `error` / `fallthrough`), `providerKind`, and `since` (epoch ms, epoch
seconds, or ISO-8601). `summary` accepts `hours` (1–8760, default 24).
