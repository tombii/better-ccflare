# Codex VS Code client

The Codex extension and CLI share `config.toml`. Open the extension's settings and select **Open config.toml** to edit the configuration used by its agent. For Remote SSH or containers, use the file on the host where that agent runs. See [official OpenAI documentation](https://learn.chatgpt.com/docs/developer-settings?surface=ide).

Define a custom provider in the user-level configuration:

```toml
model = "gpt-6-astra"
model_provider = "better_ccflare"

[model_providers.better_ccflare]
name = "better-ccflare"
base_url = "https://YOUR-PROXY-HOST/v1"
wire_api = "responses"
env_key = "BETTER_CCFLARE_API_KEY"
requires_openai_auth = false
```

Make `BETTER_CCFLARE_API_KEY` available in the environment of the extension's agent process. Setting it only in an already-open integrated terminal does not update the extension host's environment. Use a better-ccflare API key, then restart the extension host and start a new chat. Select a model available to the intended upstream account; the example model is not a guarantee of account access.

The `/v1` suffix is required. Use an HTTP Responses connection; better-ccflare rejects WebSocket upgrades so clients can fall back to HTTP streaming. Do not enable a provider capability that requires WebSockets.

## Routing and compatibility

- A native Codex upstream preserves the requested Responses model, tools, input, and client fields, subject to explicit server-side model mappings. `stream_options`, `client_metadata`, and `access_programs` are forwarded on this trusted native route.
- Codex upstream requests remove ingress Cloudflare/forwarding headers and client cookies. These describe the connection to the proxy, not the separate connection to OpenAI; forwarding them can cause upstream `403` responses. The proxy adds its own upstream authentication and host-scoped cookies afterward.
- Anthropic routes translate the conversation and map GPT model names to configured Claude families. Function tools are forwarded. Freeform custom tools, including `apply_patch`, use an Anthropic `{input: string}` schema and are converted back to Responses custom tool calls and outputs. Grammar constraints are included as instructions but cannot be enforced by Anthropic.
- Tool definitions supplied inside Responses Lite `additional_tools` items are also supported. Namespaced tools, including `functions.exec` in Codex code mode, are given Anthropic-compatible names and restored to their original namespace in Responses output.
- Anthropic routes do not implement OpenAI hosted tools such as web search, file search, or code interpreter. Use an upstream supporting native Responses when these are required.
- Claude subscription OAuth accounts are excluded from Responses traffic by the existing account policy. Configure an eligible API-key or other supported upstream account.
- New or unsupported top-level request fields still receive a `400`; this change supports specific current client fields without silently discarding unknown controls.

## Diagnosing a connection

`GET /health` checks the running proxy version and health. `GET /v1/models` is not a reliable Responses compatibility check: it can be forwarded to an Anthropic endpoint requiring Anthropic-specific headers.

Test `POST /v1/responses` with a short prompt. A working connection must complete the response stream, not merely return HTTP 200. A client-side compatibility patch cannot fix upstream account entitlement, quota, or access-denial errors.

The Responses adapter preserves structured upstream error messages, including native Codex `detail` errors and provider error codes. Unrecognized error bodies return the upstream HTTP status and direct the operator to request logs. HTML error pages are not echoed to the client. Use a dashboard-authorized key or server logs to inspect the selected account and original error; an API-only key cannot read dashboard endpoints.

## Local regression checks

```sh
bun install --frozen-lockfile
bun test packages/openai-responses-adapter/src/__tests__ packages/providers/src/providers/codex/provider.test.ts packages/providers/src/providers/codex/provider.responses.test.ts packages/providers/src/providers/codex/provider.fidelity.test.ts
```

These tests use mocked upstream responses. They establish protocol behavior without proving a particular deployed account can serve a model.

To exercise the actual app-server bundled with the VS Code extension:

```sh
bun scripts/smoke-codex-vscode.ts /path/to/extension/bin/codex
```

The smoke test uses a loopback server, a temporary workspace, and isolated Codex configuration. It drives the same `initialize`, `thread/start`, and `turn/start` RPC flow used by the editor and supplies deterministic Anthropic streaming responses. It checks a file edit and the following tool-result request without contacting an inference service or using production credentials.

Validated with the VS Code extension's Codex 0.153.4 app-server requesting `gpt-6-astra`: namespaced `functions.exec` ran `tools.apply_patch`, the tool result was replayed, and the final assistant message completed. The same client against unmodified v3.5.78 failed with `400 Unsupported Responses request field(s): client_metadata`.
