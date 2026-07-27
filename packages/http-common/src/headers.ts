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
 * Removes hop-by-hop + compression negotiation headers and sensitive auth
 * headers from the ORIGINAL client request before it is persisted for
 * analytics.
 *
 * Removes: accept-encoding, content-encoding, transfer-encoding, content-length,
 * authorization, x-api-key, cookie
 */
export function sanitizeRequestHeaders(original: Headers): Headers {
	const h = new Headers(original);
	h.delete("accept-encoding");
	h.delete("content-encoding");
	h.delete("content-length");
	h.delete("transfer-encoding");
	// Strip sensitive auth headers from persisted payloads
	h.delete("authorization");
	h.delete("x-api-key");
	h.delete("cookie");
	// keep in sync with INTERNAL_PROBE_SECRET_HEADER
	// (@better-ccflare/proxy already depends on http-common, so importing the
	// proxy package's constant here would create an import cycle)
	h.delete("x-better-ccflare-internal-probe-secret");
	return h;
}

/**
 * Return a new Response with hop-by-hop / compression headers stripped.
 * Body & status are preserved.
 */
export function withSanitizedProxyHeaders(res: Response): Response {
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: sanitizeProxyHeaders(res.headers),
	});
}
