import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("AgentPaths");

export function getAgentsDirectory(): string {
	return join(homedir(), ".claude", "agents");
}

/** Returns the path to the Claude Code plugin manifest file. */
export function getPluginManifestPath(): string {
	return join(homedir(), ".claude", "plugins", "installed_plugins.json");
}

/**
 * Parses the Claude Code plugin manifest to enumerate active plugin agent directories.
 * Returns an empty array when the manifest is missing, malformed, or has no valid entries.
 * Each returned entry has pluginName (derived from manifest key before "@") and agentsDir (installPath/agents).
 */
export function parsePluginManifest(
	manifestPath: string,
): Array<{ pluginName: string; agentsDir: string }> {
	if (!existsSync(manifestPath)) {
		return [];
	}

	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
	} catch {
		log.warn(
			`Plugin manifest at ${manifestPath} is not valid JSON — skipping plugin discovery`,
		);
		return [];
	}

	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("plugins" in manifest) ||
		typeof (manifest as Record<string, unknown>).plugins !== "object" ||
		(manifest as Record<string, unknown>).plugins === null
	) {
		return [];
	}

	const plugins = (
		manifest as {
			plugins: Record<string, Array<{ installPath?: string }>>;
		}
	).plugins;

	const result: Array<{ pluginName: string; agentsDir: string }> = [];

	for (const [key, entries] of Object.entries(plugins)) {
		const pluginName = key.split("@")[0];
		if (!pluginName || !Array.isArray(entries)) continue;

		// Reject names containing ":" — the agent ID format pluginName:basename
		// uses ":" as a delimiter, so embedded colons would corrupt downstream parsing
		// and could collide with workspace-prefixed IDs.
		if (pluginName.includes(":")) {
			log.warn(
				`Plugin manifest key "${key}" produces a name with ":" — skipping`,
			);
			continue;
		}

		for (const entry of entries) {
			if (!entry?.installPath || typeof entry.installPath !== "string")
				continue;

			// Defer existsSync probe to the caller after path validation —
			// running existsSync on unvalidated user-controlled paths leaks a
			// filesystem oracle for arbitrary locations.
			const agentsDir = join(entry.installPath, "agents");
			result.push({ pluginName, agentsDir });
		}
	}

	return result;
}
