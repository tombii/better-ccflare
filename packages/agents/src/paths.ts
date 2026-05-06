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

		for (const entry of entries) {
			if (!entry?.installPath) continue;

			const agentsDir = join(entry.installPath, "agents");
			if (!existsSync(agentsDir)) {
				log.debug(`Plugin agents directory not found: ${agentsDir}`);
				continue;
			}

			result.push({ pluginName, agentsDir });
		}
	}

	return result;
}
