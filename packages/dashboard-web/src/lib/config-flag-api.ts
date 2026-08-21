import { api } from "../api";

/**
 * Adapter for the on/off config settings that share one contract:
 *
 *   GET  <path>                  -> { enabled: boolean, source: "file"|"default" }
 *   POST <path>  { enabled }     -> { success, enabled, source, effective }
 *
 * `source` says whether anyone has set the value yet ("file") or it is still
 * the built-in default. These settings are read from the config file only —
 * no environment variable overrides them — so a write always takes effect.
 *
 * `effective` on the POST response is the value in force AFTER the write. It
 * is what the cache is updated with, so the UI never shows a value the server
 * did not confirm.
 *
 * Authentication comes for free from the shared `api` client, which injects
 * `x-api-key` into every request and opens the auth dialog on 401.
 */

export type ConfigFlagSource = "file" | "default";

export interface ConfigFlag {
	enabled: boolean;
	source: ConfigFlagSource;
}

function asRecord(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function asSource(raw: unknown): ConfigFlagSource {
	return raw === "file" ? "file" : "default";
}

/** Reads a flag. A malformed body degrades to "off, by default". */
export async function fetchConfigFlag(path: string): Promise<ConfigFlag> {
	const body = asRecord(await api.get<unknown>(path));
	return {
		enabled: body.enabled === true,
		source: asSource(body.source),
	};
}

/**
 * Writes a flag and returns the value confirmed by the server afterwards.
 */
export async function saveConfigFlag(
	path: string,
	enabled: boolean,
): Promise<ConfigFlag> {
	const body = asRecord(await api.post<unknown>(path, { enabled }));
	return {
		// `effective` is authoritative; `enabled` echoes the request.
		enabled: body.effective === true,
		source: asSource(body.source),
	};
}
