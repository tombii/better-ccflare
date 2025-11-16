/**
 * Sanitizes proxy headers by removing hop-by-hop headers that should not be forwarded
 * after Bun has automatically decompressed the response body.
 *
 * Removes: content-encoding, content-length, transfer-encoding
 */
export function sanitizeProxyHeaders(original: Headers): Headers {
	const sanitized = new Headers(original);

	// Remove headers that are invalidated by automatic decompression
	sanitized.delete("content-encoding");
	sanitized.delete("content-length");
	sanitized.delete("transfer-encoding");

	return sanitized;
}

/**
 * Removes hop-by-hop + compression negotiation headers from the ORIGINAL
 * client request before it is persisted for analytics. Does **not** add /
 * remove auth headers.
 *
 * Removes: accept-encoding, content-encoding, transfer-encoding, content-length
 */
export function sanitizeRequestHeaders(original: Headers): Headers {
	const h = new Headers(original);
	h.delete("accept-encoding");
	h.delete("content-encoding");
	h.delete("content-length");
	h.delete("transfer-encoding");
	return h;
}

/**
 * Return a new Response with hop-by-hop / compression headers stripped.
 * Body & status are preserved.
 * Also preserves the __analyticsStream property if present (for OpenAI providers).
 */
export function withSanitizedProxyHeaders(res: Response): Response {
	const newResponse = new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: sanitizeProxyHeaders(res.headers),
	});

	// Preserve __analyticsStream property if present (used by OpenAI provider)
	const analyticsStream = (res as any).__analyticsStream;
	if (analyticsStream) {
		Object.defineProperty(newResponse, "__analyticsStream", {
			value: analyticsStream,
			writable: false,
			enumerable: false,
			configurable: false,
		});
	}

	return newResponse;
}
