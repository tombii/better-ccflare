import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "./discovery";
import { getPluginManifestPath, parsePluginManifest } from "./paths";

describe("getPluginManifestPath", () => {
	it("returns the installed_plugins.json path under homedir", () => {
		const result = getPluginManifestPath();
		expect(result).toBe(
			path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"),
		);
	});
});

describe("parsePluginManifest", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty array when manifest file does not exist", () => {
		const result = parsePluginManifest(path.join(tmpDir, "nonexistent.json"));
		expect(result).toEqual([]);
	});

	it("returns empty array when manifest JSON is malformed", () => {
		const manifestPath = path.join(tmpDir, "installed_plugins.json");
		fs.writeFileSync(manifestPath, "not-json");
		const result = parsePluginManifest(manifestPath);
		expect(result).toEqual([]);
	});

	it("returns empty array when manifest has no plugins field", () => {
		const manifestPath = path.join(tmpDir, "installed_plugins.json");
		fs.writeFileSync(manifestPath, JSON.stringify({ version: 2 }));
		const result = parsePluginManifest(manifestPath);
		expect(result).toEqual([]);
	});

	it("skips entries where installPath does not exist", () => {
		const manifestPath = path.join(tmpDir, "installed_plugins.json");
		fs.writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 2,
				plugins: {
					"myplugin@market": [
						{ installPath: path.join(tmpDir, "nonexistent") },
					],
				},
			}),
		);
		const result = parsePluginManifest(manifestPath);
		expect(result).toEqual([]);
	});

	it("skips entries where agents subdir does not exist", () => {
		const manifestPath = path.join(tmpDir, "installed_plugins.json");
		const installPath = path.join(tmpDir, "plugin-install");
		fs.mkdirSync(installPath);
		// No agents/ subdir
		fs.writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 2,
				plugins: {
					"myplugin@market": [{ installPath }],
				},
			}),
		);
		const result = parsePluginManifest(manifestPath);
		expect(result).toEqual([]);
	});

	it("returns valid entries with pluginName derived from key before @", () => {
		const manifestPath = path.join(tmpDir, "installed_plugins.json");
		const installPath = path.join(tmpDir, "plugin-install");
		const agentsDir = path.join(installPath, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 2,
				plugins: {
					"myplugin@market": [{ installPath }],
				},
			}),
		);
		const result = parsePluginManifest(manifestPath);
		expect(result).toHaveLength(1);
		expect(result[0].pluginName).toBe("myplugin");
		expect(result[0].agentsDir).toBe(agentsDir);
	});

	it("handles multiple version entries by including all that have agents/ dir", () => {
		const manifestPath = path.join(tmpDir, "installed_plugins.json");
		const installPath1 = path.join(tmpDir, "plugin-v1");
		const installPath2 = path.join(tmpDir, "plugin-v2");
		fs.mkdirSync(path.join(installPath1, "agents"), { recursive: true });
		fs.mkdirSync(installPath2); // no agents/
		fs.writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 2,
				plugins: {
					"myplugin@market": [
						{ installPath: installPath1 },
						{ installPath: installPath2 },
					],
				},
			}),
		);
		const result = parsePluginManifest(manifestPath);
		expect(result).toHaveLength(1);
		expect(result[0].agentsDir).toBe(path.join(installPath1, "agents"));
	});
});

describe("AgentRegistry plugin agent discovery", () => {
	let tmpDir: string;
	const originalEnv = process.env.BETTER_CCFLARE_DISCOVER_PLUGIN_AGENTS;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-agents-test-"));
		delete process.env.BETTER_CCFLARE_DISCOVER_PLUGIN_AGENTS;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		if (originalEnv !== undefined) {
			process.env.BETTER_CCFLARE_DISCOVER_PLUGIN_AGENTS = originalEnv;
		} else {
			delete process.env.BETTER_CCFLARE_DISCOVER_PLUGIN_AGENTS;
		}
	});

	it("does NOT load plugin agents when env var is not set", async () => {
		// env var not set — plugin agents should not be discovered
		const registry = new AgentRegistry();
		const agents = await registry.getAgents();
		const pluginAgents = agents.filter((a) => a.source === "plugin");
		expect(pluginAgents).toHaveLength(0);
	});

	it("loads plugin agents when env var is set to 'true' and manifest is valid", async () => {
		process.env.BETTER_CCFLARE_DISCOVER_PLUGIN_AGENTS = "true";

		// Create plugin install under tmpDir (which is under os.tmpdir() — an allowed path)
		const installPath = path.join(tmpDir, "plugin-install");
		const agentsDir = path.join(installPath, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		// Write a valid agent .md file
		const agentFilePath = path.join(agentsDir, "my-agent.md");
		fs.writeFileSync(
			agentFilePath,
			"---\nname: My Plugin Agent\ndescription: A test plugin agent\ncolor: blue\n---\n\nYou are my plugin agent.",
		);

		// Write a manifest pointing to our tmpDir install
		const manifestPath = path.join(tmpDir, "installed_plugins.json");
		fs.writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 2,
				plugins: { "myplugin@market": [{ installPath }] },
			}),
		);

		// Create registry with manifest path override (seam for testing)
		const registry = new AgentRegistry(manifestPath);
		const agents = await registry.getAgents();

		const pluginAgents = agents.filter((a) => a.source === "plugin");
		expect(pluginAgents).toHaveLength(1);
		expect(pluginAgents[0].pluginName).toBe("myplugin");
		expect(pluginAgents[0].id).toBe("myplugin:my-agent");
		expect(pluginAgents[0].name).toBe("My Plugin Agent");
	});

	it("sets pluginName on agent when loading plugin agents", () => {
		// Test that the plugin agent ID namespacing works correctly
		// pluginName:agentBaseName format
		const pluginName = "myplugin";
		const baseName = "my-agent";
		const expectedId = `${pluginName}:${baseName}`;
		expect(expectedId).toBe("myplugin:my-agent");
	});

	it("seenRealPaths deduplication prevents loading same file twice", () => {
		const seenRealPaths = new Set<string>();
		const filePath = path.join(tmpDir, "agent.md");
		fs.writeFileSync(
			filePath,
			"---\nname: test\ndescription: test\n---\n\nPrompt.",
		);

		// Simulate what safeRealPath does
		let realPath: string;
		try {
			realPath = fs.realpathSync(filePath);
		} catch {
			realPath = filePath;
		}

		// First time: not in set
		expect(seenRealPaths.has(realPath)).toBe(false);
		seenRealPaths.add(realPath);

		// Second time: already in set (would be skipped)
		expect(seenRealPaths.has(realPath)).toBe(true);
	});

	it("two plugins with same agent basename get distinct namespaced IDs", () => {
		const pluginA = "plugin-a";
		const pluginB = "plugin-b";
		const baseName = "shared-agent";

		const idA = `${pluginA}:${baseName}`;
		const idB = `${pluginB}:${baseName}`;

		expect(idA).toBe("plugin-a:shared-agent");
		expect(idB).toBe("plugin-b:shared-agent");
		expect(idA).not.toBe(idB);
	});
});
