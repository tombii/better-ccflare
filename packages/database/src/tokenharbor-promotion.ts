/**
 * Helpers shared by the SQLite and PostgreSQL TokenHarbor promotion
 * migrations, so the two backends cannot drift.
 *
 * TokenHarbor became a first-class provider. Rows created before that are
 * `anthropic-compatible` with a TokenHarbor endpoint, and API keys may
 * allowlist that shared provider string. Promotion rewrites both.
 */
const TOKENHARBOR_HOST = "tokenharbor.ai";
const LEGACY_PROVIDER = "anthropic-compatible";
const TOKENHARBOR_PROVIDER = "tokenharbor";

/**
 * True when `custom_endpoint` resolves to TokenHarbor's host. The column holds
 * either a plain URL string or a JSON object carrying `endpoint`; invalid JSON
 * is not TokenHarbor. `URL.hostname` strips the port and normalises case, and
 * an exact match keeps lookalikes such as `evil.example//tokenharbor.ai` out.
 */
export function isTokenHarborCustomEndpoint(customEndpoint: unknown): boolean {
	if (typeof customEndpoint !== "string") return false;
	const raw = customEndpoint.trim();
	if (!raw) return false;

	let endpoint = raw;
	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw) as { endpoint?: unknown };
			if (typeof parsed?.endpoint !== "string") return false;
			endpoint = parsed.endpoint;
		} catch {
			return false;
		}
	}

	try {
		return new URL(endpoint).hostname.toLowerCase() === TOKENHARBOR_HOST;
	} catch {
		return false;
	}
}

/**
 * Append `"tokenharbor"` to a JSON `allowed_providers` array that names
 * `anthropic-compatible`, preserving every other entry and their order.
 *
 * Returns the new JSON text, or null when the row must stay untouched: NULL,
 * `[]`, invalid JSON, a non-array, or an array with no legacy entry or that
 * already names TokenHarbor (which keeps re-runs idempotent).
 */
export function addTokenHarborToAllowedProviders(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw) return null;

	let entries: unknown;
	try {
		entries = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(entries)) return null;

	const lowered = entries.map((entry) =>
		typeof entry === "string" ? entry.toLowerCase() : null,
	);
	if (!lowered.includes(LEGACY_PROVIDER)) return null;
	if (lowered.includes(TOKENHARBOR_PROVIDER)) return null;

	return JSON.stringify([...entries, TOKENHARBOR_PROVIDER]);
}
