import { Logger } from "@better-ccflare/logger";

const log = new Logger("ProviderServing");

/**
 * Which backend the provider itself says served a request.
 *
 * This is a FACT read straight out of the provider's response body — never
 * inferred from cost, model, or anything else. Providers that do not state it
 * yield null, and the dashboard then shows no "Served by" row at all.
 *
 * Only body fields with observed evidence are listed. Do not guess:
 *
 * - openrouter: body `provider` (a trimmed non-empty string, e.g. "Morph").
 *   Captured live 2026-10-29: POST https://openrouter.ai/api/v1/messages with
 *   `provider: {"only":["morph"]}` returned 200 with
 *   `"provider":"Morph"`, `"model":"deepseek/deepseek-v4.1-flash-1017"`,
 *   `"usage":{"cost":0.0000078,...}`. The body `id` is the message id, not a
 *   serving label, and is ignored. Only non-streaming bodies are consulted:
 *   the SSE `message_start` frame does not carry `provider`.
 * - nanogpt: deliberately absent. NanoGPT returns pricing but no field naming
 *   the serving backend.
 *
 * Keyed by provider CLASS, not by serving host: an account with a
 * `custom_endpoint` reports whatever that endpoint's body says.
 */
const SERVED_PROVIDER_BODY_FIELDS: Record<string, string> = {
	openrouter: "provider",
};

const MAX_SERVED_PROVIDER_LENGTH = 512;

/** Body field naming the serving backend for `providerName`, if known. */
export function servedProviderBodyField(providerName: string): string | null {
	return SERVED_PROVIDER_BODY_FIELDS[providerName] ?? null;
}

/**
 * Read the provider-named serving backend out of a parsed response body.
 * Returns null for providers that do not state it, for a missing field, a
 * non-string value, a whitespace-only value, and for values longer than 512
 * chars.
 */
export function servedProviderFromBody(
	providerName: string,
	body: unknown,
): string | null {
	const field = servedProviderBodyField(providerName);
	if (!field) return null;
	if (typeof body !== "object" || body === null) return null;
	const raw = (body as Record<string, unknown>)[field];
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	if (!value) return null;
	if (value.length > MAX_SERVED_PROVIDER_LENGTH) {
		// Never log the value itself — it comes from the upstream wire.
		log.debug(
			`Rejected body ${field} from ${providerName}: ${value.length} chars exceeds ${MAX_SERVED_PROVIDER_LENGTH}`,
		);
		return null;
	}
	return value;
}
