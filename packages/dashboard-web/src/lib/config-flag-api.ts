import { api } from "../api";

/**
 * Adapter for the on/off config settings that share one contract:
 *
 *   GET  <path>                  -> { enabled: boolean, source: "env"|"file"|"default" }
 *   POST <path>  { enabled }     -> { success, enabled, source, effective }
 *
 * `source` is what lets the UI be honest: when an environment variable is
 * setting the value, writing the config file has no effect, so the switch is
 * shown locked with the reason instead of silently doing nothing.
 *
 * `effective` on the POST response is the value in force AFTER the write —
 * which differs from the requested one exactly in the env-locked case.
 *
 * Authentication comes for free from the shared `api` client, which injects
 * `x-api-key` into every request and opens the auth dialog on 401.
 */

export type ConfigFlagSource = "env" | "file" | "default";

export interface ConfigFlag {
	enabled: boolean;
	source: ConfigFlagSource;
}

function asRecord(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function asSource(raw: unknown): ConfigFlagSource {
	return raw === "env" || raw === "file" ? raw : "default";
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
 * Writes a flag and returns what is in force afterwards, so the caller can
 * tell the difference between "saved" and "saved but an env var still wins".
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
