import { Logger } from "@better-ccflare/logger";

const log = new Logger("ProviderRequestId");

/**
 * Per-request id that the upstream provider itself assigns to a request.
 *
 * This is shown in the dashboard so an operator can look the exact request up
 * in the provider's own web UI logs. It says nothing about which upstream
 * provider (or backend) served the request — the providers do not expose
 * that on the API path.
 *
 * Only header names with observed evidence are listed. Do not guess:
 *
 * - nanogpt: `x-request-id`. Captured live 2026-10-29, POST
 *   https://nano-gpt.com/api/v1/messages (model
 *   deepseek/deepseek-v4.1-flash-1017, non-streaming, HTTP 200):
 *   `x-request-id: req_bdd860d4-ed1a-4d4b-8aea-ceb30aa24faf` (two other
 *   requests that day: `req_e042b8f6-ec36-453c-9ec7-b88188881d9b`,
 *   `req_f0dd54f8-53d3-40eb-bb05-91873fbe7fe7`). A bare `request-id`
 *   (no `x-` prefix, which Codex upstream sends) was NOT present.
 * - openrouter: deliberately absent. On the Anthropic `/v1/messages`
 *   endpoint OpenRouter returns a body `id` (the message id, not a routing
 *   id) and a legacy `provider` body field; neither is a request id we could
 *   look up in its logs, and no OpenRouter-specific id header has been
 *   confirmed. Returns null until one is.
 *
 * The map is keyed by provider CLASS, not by serving host: NanoGPTProvider
 * honours `account.custom_endpoint`, so an account pointed at a third-party
 * endpoint stores whatever id that endpoint sends. The value is surfaced as
 * "Provider request ID", never as a claim about which backend served the
 * request.
 */
const PROVIDER_REQUEST_ID_HEADERS: Record<string, string> = {
	nanogpt: "x-request-id",
};

const MAX_PROVIDER_REQUEST_ID_LENGTH = 512;

/** Header name carrying the upstream per-request id for `providerName`, if known. */
export function providerRequestIdHeader(providerName: string): string | null {
	return PROVIDER_REQUEST_ID_HEADERS[providerName] ?? null;
}

/**
 * Extract the upstream provider's per-request id from response headers.
 * Returns null for providers with no known id header, for a missing or empty
 * header, and for values longer than 512 chars (an id we cannot verify as an
 * id should not be surfaced as one).
 */
export function providerRequestIdFromHeaders(
	providerName: string,
	headers: Headers,
): string | null {
	const header = providerRequestIdHeader(providerName);
	if (!header) return null;
	const value = headers.get(header)?.trim();
	if (!value) return null;
	if (value.length > MAX_PROVIDER_REQUEST_ID_LENGTH) {
		// Never log the value itself — it comes from the upstream wire.
		log.debug(
			`Rejected ${header} from ${providerName}: ${value.length} chars exceeds ${MAX_PROVIDER_REQUEST_ID_LENGTH}`,
		);
		return null;
	}
	return value;
}
