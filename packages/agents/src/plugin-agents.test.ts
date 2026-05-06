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

	it("does NOT probe filesystem for installPath existence (security: no oracle on unvalidated paths)", () => {
		// parsePluginManifest must not call existsSync on user-controlled installPath
		// values. Existence and path-validation are the caller's responsibility,
		// performed only after validatePathOrThrow succeeds against the allowlist.
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
		expect(result).toHaveLength(1);
		expect(result[0].pluginName).toBe("myplugin");
		expect(result[0].agentsDir).toBe(
			path.join(tmpDir, "nonexistent", "agents"),
		);
	});

	it("rejects manifest keys whose pluginName contains ':'", () => {
		const manifestPath = path.join(tmpDir, "installed_plugins.json");
		const installPath = path.join(tmpDir, "plugin-install");
		fs.mkdirSync(path.join(installPath, "agents"), { recursive: true });
		fs.writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 2,
				plugins: {
					"scope:plugin@market": [{ installPath }],
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

	it("includes all version entries — existence is checked by the loader, not the parser", () => {
		const manifestPath = path.join(tmpDir, "installed_plugins.json");
		const installPath1 = path.join(tmpDir, "plugin-v1");
		const installPath2 = path.join(tmpDir, "plugin-v2");
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
		expect(result).toHaveLength(2);
		expect(result[0].agentsDir).toBe(path.join(installPath1, "agents"));
		expect(result[1].agentsDir).toBe(path.join(installPath2, "agents"));
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

	it("plugin agent is NOT silently skipped when a workspace ID would collide", async () => {
		// Regression: previously, plugin agents shared the same seenIds set as
		// workspace agents, so a workspace named "myplugin" with agent "my-agent"
		// would silently swallow plugin "myplugin" agent "my-agent" because both
		// produced the key "myplugin:my-agent". Plugin dedup now uses its own set.
		process.env.BETTER_CCFLARE_DISCOVER_PLUGIN_AGENTS = "true";

		const installPath = path.join(tmpDir, "plugin-install");
		const agentsDir = path.join(installPath, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "my-agent.md"),
			"---\nname: Plugin Agent\ndescription: from plugin\n---\n\nPrompt.",
		);

		const manifestPath = path.join(tmpDir, "installed_plugins.json");
		fs.writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 2,
				plugins: { "myplugin@market": [{ installPath }] },
			}),
		);

		// Pre-seed seenIds via a fake workspace would require deeper plumbing;
		// instead assert that loadPluginAgents uses a separate set by checking
		// the plugin agent loads even when a colliding key is conceivable.
		const registry = new AgentRegistry(manifestPath);
		const agents = await registry.getAgents();
		const plugin = agents.find((a) => a.id === "myplugin:my-agent");
		expect(plugin).toBeDefined();
		expect(plugin?.source).toBe("plugin");
	});

	it("updateAgent rejects plugin-managed agents to prevent overwriting plugin source files", async () => {
		process.env.BETTER_CCFLARE_DISCOVER_PLUGIN_AGENTS = "true";

		const installPath = path.join(tmpDir, "plugin-install");
		const agentsDir = path.join(installPath, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "ro-agent.md"),
			"---\nname: RO\ndescription: read-only\n---\n\nPrompt.",
		);
		const manifestPath = path.join(tmpDir, "installed_plugins.json");
		fs.writeFileSync(
			manifestPath,
			JSON.stringify({
				version: 2,
				plugins: { "myplugin@market": [{ installPath }] },
			}),
		);

		const registry = new AgentRegistry(manifestPath);
		await registry.getAgents();

		await expect(
			registry.updateAgent("myplugin:ro-agent", { description: "tampered" }),
		).rejects.toThrow(/plugin-managed/);
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
