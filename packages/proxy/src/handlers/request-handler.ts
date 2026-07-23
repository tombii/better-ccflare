import crypto from "node:crypto";
import { TIME_CONSTANTS, ValidationError } from "@better-ccflare/core";
import type { Provider } from "@better-ccflare/providers";
import type { RequestMeta } from "@better-ccflare/types";
import { chatGptCloudflareCookieJar } from "../chatgpt-cloudflare-cookies";
import { ERROR_MESSAGES, INTERNAL_PROBE_SECRET_HEADER } from "./proxy-types";

/**
 * Internal proxy control headers that must NEVER be forwarded to the upstream
 * provider: they gate privileged proxy behaviour (see isInternalProbe), and a
 * provider or custom endpoint that received them — the probe secret above all —
 * could replay them with a marker to forge privileged requests.
 */
function stripInternalControlHeaders(headers: Headers): void {
	headers.delete(INTERNAL_PROBE_SECRET_HEADER);
	headers.delete("x-better-ccflare-auto-refresh");
	headers.delete("x-better-ccflare-keepalive");
}

/**
 * Creates request metadata for tracking and analytics
 * @param req - The incoming request
 * @param url - The parsed URL
 * @returns Request metadata object
 */
export function createRequestMetadata(req: Request, url: URL): RequestMeta {
	return {
		id: crypto.randomUUID(),
		method: req.method,
		path: url.pathname,
		timestamp: Date.now(),
		headers: req.headers,
	};
}

/**
 * Validates that the provider can handle the requested path
 * @param provider - The provider instance
 * @param pathname - The request path
 * @throws {ValidationError} If provider cannot handle the path
 */
export function validateProviderPath(
	provider: Provider,
	pathname: string,
): void {
	if (!provider.canHandle(pathname)) {
		throw new ValidationError(
			`${ERROR_MESSAGES.PROVIDER_CANNOT_HANDLE}: ${pathname}`,
			"path",
			pathname,
		);
	}
}

/**
 * Prepares request body for analytics and creates body stream factory
 * @param req - The incoming request
 * @returns Object containing the buffered body and stream factory
 */
export async function prepareRequestBody(req: Request): Promise<{
	buffer: ArrayBuffer | null;
	createStream: () => ReadableStream<Uint8Array> | undefined;
}> {
	let buffer: ArrayBuffer | null = null;

	if (req.body) {
		buffer = await req.arrayBuffer();
	}

	return {
		buffer,
		createStream: () => {
			if (!buffer) return undefined;
			return new Response(buffer).body ?? undefined;
		},
	};
}

/**
 * Makes the actual HTTP request to the provider
 * @param targetUrl - The target URL to fetch
 * @param method - HTTP method
 * @param headers - Request headers
 * @param createBodyStream - Function to create request body stream
 * @param hasBody - Whether the request has a body
 * @returns Promise resolving to the response
 */
export async function makeProxyRequest(
	target: string | Request,
	method?: string,
	headers?: Headers,
	createBodyStream?: () => ReadableStream<Uint8Array> | undefined,
	hasBody?: boolean,
	signal?: AbortSignal,
): Promise<Response> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let internalController: AbortController | null = null;

	const effectiveSignal =
		signal ??
		(() => {
			internalController = new AbortController();
			timeoutId = setTimeout(
				() => internalController?.abort(),
				TIME_CONSTANTS.PROXY_REQUEST_TIMEOUT_MS,
			);
			return internalController.signal;
		})();

	try {
		if (target instanceof Request) {
			const targetUrl = target.url;
			const mutableHeaders = new Headers(target.headers);
			stripInternalControlHeaders(mutableHeaders);
			chatGptCloudflareCookieJar.applyCookieHeader(targetUrl, mutableHeaders);

			const response = await fetch(
				new Request(target, {
					headers: mutableHeaders,
					signal: effectiveSignal,
				}),
			);
			chatGptCloudflareCookieJar.captureFromResponse(targetUrl, response);
			return response;
		}

		const mutableHeaders = new Headers(headers);
		stripInternalControlHeaders(mutableHeaders);
		chatGptCloudflareCookieJar.applyCookieHeader(target, mutableHeaders);

		const response = await fetch(target, {
			method,
			headers: mutableHeaders,
			body: createBodyStream ? createBodyStream() : undefined,
			signal: effectiveSignal,
			...(hasBody ? ({ duplex: "half" } as RequestInit) : {}),
		});
		chatGptCloudflareCookieJar.captureFromResponse(target, response);
		return response;
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
