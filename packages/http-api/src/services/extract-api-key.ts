/**
 * Extract API key from request headers.
 * Supports x-api-key (Vercel AI SDK / Opencode) and Authorization: Bearer.
 */
export function extractApiKey(req: Request): string | null {
	const apiKey = req.headers.get("x-api-key");
	if (apiKey) return apiKey;

	const authHeader = req.headers.get("authorization");
	if (authHeader) {
		const parts = authHeader.trim().split(/\s+/);
		if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
			return parts[1];
		}
	}
	return null;
}
