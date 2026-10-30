import { api } from "../api";
import type { WebSearchSettings } from "./search-provider-types";

/**
 * Adapter for the web-search master settings:
 *
 *   GET   /api/web-search/settings   -> { success, data: { enabled, maxResultChars, bypassHeader } }
 *   PATCH /api/web-search/settings   -> updated settings (same envelope)
 *
 * `enabled` defaults to false: a malformed body means interception is off,
 * which is the safe reading — search requests pass through untouched.
 *
 * Authentication comes from the shared `api` client, which injects
 * `x-api-key` and opens the auth dialog on 401.
 */

function asRecord(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function normalize(raw: unknown): WebSearchSettings {
	const body = asRecord(raw);
	const source =
		body.data && typeof body.data === "object" ? asRecord(body.data) : body;
	return {
		enabled: source.enabled === true,
		maxResultChars:
			typeof source.maxResultChars === "number" &&
			Number.isFinite(source.maxResultChars)
				? source.maxResultChars
				: 0,
		bypassHeader: source.bypassHeader === true,
	};
}

export async function fetchWebSearchSettings(): Promise<WebSearchSettings> {
	return normalize(await api.get<unknown>("/api/web-search/settings"));
}

export async function saveWebSearchSettings(
	patch: Partial<WebSearchSettings>,
): Promise<WebSearchSettings> {
	return normalize(await api.patch<unknown>("/api/web-search/settings", patch));
}
