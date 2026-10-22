/**
 * Qoder's two hosts.
 *
 * Qoder runs the account surface (token exchange, userinfo, quota) on
 * `openapi.qoder.sh` and the inference gateway on `api3.qoder.sh`; the CN
 * region uses `openapi.qoder.com.cn` and `gateway.qoder.com.cn`. An account's
 * `custom_endpoint` therefore names the **gateway** — the host that serves
 * chat — and the OpenAPI host is derived from it.
 *
 * The two resolvers are the ONLY place that decides which host is which: the
 * provider, the auth flow and the usage fetcher all go through them, so a
 * CN-region account works without an operator having to configure two hosts.
 */

export const QODER_DEFAULT_GATEWAY_ENDPOINT = "https://api3.qoder.sh";
export const QODER_DEFAULT_OPENAPI_ENDPOINT = "https://openapi.qoder.sh";
export const QODER_OPENAPI_ENDPOINT_ENV = "CCFLARE_QODER_OPENAPI_ENDPOINT";

/**
 * What the resolvers read: an account row, or the bare `custom_endpoint`
 * string (callers that only have the string, e.g. the CLI's account prompt).
 */
export type QoderEndpointSource =
	| { custom_endpoint?: string | null }
	| string
	| null
	| undefined;

interface ParsedCustomEndpoint {
	endpoint?: unknown;
	openapiEndpoint?: unknown;
}

function trimTrailingSlashes(url: string): string {
	let end = url.length;
	while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
	return url.slice(0, end);
}

function parseCustomEndpoint(raw: string): ParsedCustomEndpoint | null {
	if (!raw.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as ParsedCustomEndpoint;
	} catch {
		return null;
	}
}

function customEndpointOf(source: QoderEndpointSource): string {
	if (!source) return "";
	if (typeof source === "string") return source.trim();
	return source.custom_endpoint?.trim() ?? "";
}

/**
 * The gateway host: the one that serves chat and the model list.
 *
 * A plain URL `custom_endpoint` IS the gateway host; a JSON one names it in
 * its `endpoint` member (the same shape every other provider accepts).
 */
export function resolveQoderGatewayEndpoint(
	source?: QoderEndpointSource,
): string {
	const raw = customEndpointOf(source);
	if (!raw) return QODER_DEFAULT_GATEWAY_ENDPOINT;

	let candidate = raw;
	if (raw.startsWith("{")) {
		const parsed = parseCustomEndpoint(raw);
		candidate =
			typeof parsed?.endpoint === "string" ? parsed.endpoint.trim() : "";
	}
	candidate = trimTrailingSlashes(candidate);
	return candidate || QODER_DEFAULT_GATEWAY_ENDPOINT;
}

/**
 * The OpenAPI host: the one that serves the token exchange, userinfo and the
 * quota. Resolved in this order:
 *
 *   1. a JSON `custom_endpoint`'s `openapiEndpoint` member;
 *   2. the `CCFLARE_QODER_OPENAPI_ENDPOINT` environment override;
 *   3. the documented CN pair — a `gateway.` host with `openapi.`;
 *   4. the international default.
 *
 * A host that already begins with `openapi.` is taken as it is: that is what
 * an account configured before the gateway/OpenAPI split stored, and the
 * OpenAPI host is the one thing such an account still needs.
 */
export function resolveQoderOpenApiEndpoint(
	source?: QoderEndpointSource,
): string {
	const raw = customEndpointOf(source);

	if (raw.startsWith("{")) {
		const parsed = parseCustomEndpoint(raw);
		const explicit =
			typeof parsed?.openapiEndpoint === "string"
				? parsed.openapiEndpoint.trim()
				: "";
		if (explicit) return trimTrailingSlashes(explicit);
	}

	const env = process.env[QODER_OPENAPI_ENDPOINT_ENV]?.trim();
	if (env) return trimTrailingSlashes(env);

	const paired = openApiHostForGateway(resolveQoderGatewayEndpoint(source));
	if (paired) return paired;

	return QODER_DEFAULT_OPENAPI_ENDPOINT;
}

/**
 * The OpenAPI host that belongs to a gateway host: `gateway.x` pairs with
 * `openapi.x`, and an `openapi.` host is already the OpenAPI one.
 */
function openApiHostForGateway(gateway: string): string | null {
	try {
		const url = new URL(gateway);
		const host = url.hostname;
		if (host.startsWith("gateway.")) {
			url.hostname = `openapi.${host.slice("gateway.".length)}`;
			return trimTrailingSlashes(url.toString());
		}
		if (host.startsWith("openapi.")) {
			return trimTrailingSlashes(url.toString());
		}
		return null;
	} catch {
		return null;
	}
}
