import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	isValidClaudeModel,
	LATEST_FABLE_MODEL,
	LATEST_HAIKU_MODEL,
	LATEST_OPUS_MODEL,
	LATEST_SONNET_MODEL,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { validatePathOrThrow } from "@better-ccflare/security";
import type {
	Agent,
	AgentTool,
	AgentWorkspace,
	AllowedModel,
} from "@better-ccflare/types";
import {
	getAgentsDirectory,
	getPluginManifestPath,
	parsePluginManifest,
} from "./paths";
import {
	type WorkspacePersistence,
	workspacePersistence,
} from "./workspace-persistence";

interface AgentCache {
	agents: Agent[];
	timestamp: number;
}

const CACHE_TTL_MS = 30 * 1000; // 30 seconds
const DEFAULT_COLOR = "gray";
const PLUGIN_AGENT_DISCOVERY_ENV = "BETTER_CCFLARE_DISCOVER_PLUGIN_AGENTS";

const log = new Logger("AgentRegistry");

/**
 * Strips a single layer of matching surrounding quotes (single or double)
 * from a frontmatter value and trims it. YAML-style quoting is common in
 * hand-written agent files (e.g. `model: "sonnet"`) but the line-based
 * frontmatter parser here doesn't understand YAML quoting — without this,
 * the quotes end up embedded in the value itself.
 */
function dequoteValue(value: string): string {
	const trimmed = value.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
			(trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

export class AgentRegistry {
	private cache: AgentCache | null = null;
	private workspaces: Map<string, AgentWorkspace> = new Map();
	private initialized = false;
	private readonly manifestPathOverride?: string;
	private workspacePersistence: WorkspacePersistence;

	constructor(
		manifestPathOverride?: string,
		persistence: WorkspacePersistence = workspacePersistence,
	) {
		this.manifestPathOverride = manifestPathOverride;
		this.workspacePersistence = persistence;
	}

	/**
	 * Test-only escape hatch: redirects this registry's workspace persistence
	 * to a different instance. The exported `agentRegistry` singleton (used
	 * directly by `agent-interceptor.ts` and several test files) is
	 * constructed once at module load with the default (real-file)
	 * persistence, before any test can pass a constructor argument — tests
	 * that exercise that singleton must call this first, pointing it at a
	 * tmp-dir-backed `WorkspacePersistence`, so they never write to the real
	 * `~/.better-ccflare/workspaces.json`. Not for production use.
	 */
	setWorkspacePersistenceForTests(persistence: WorkspacePersistence): void {
		this.workspacePersistence = persistence;
	}

	// Initialize the registry (load persisted workspaces)
	async initialize(): Promise<void> {
		if (this.initialized) return;

		try {
			const savedWorkspaces = await this.workspacePersistence.loadWorkspaces();
			for (const workspace of savedWorkspaces) {
				this.workspaces.set(workspace.path, workspace);
			}
			log.info(
				`Initialized with ${savedWorkspaces.length} persisted workspaces`,
			);
			this.initialized = true;

			// Load agents from all workspaces
			if (savedWorkspaces.length > 0) {
				await this.loadAgents();
			}
		} catch (error) {
			log.error("Failed to initialize agent registry:", error);
			this.initialized = true; // Mark as initialized even on error
		}
	}

	private isValidModel(model: string): model is AllowedModel {
		return isValidClaudeModel(model);
	}

	private safeRealPath(filePath: string): string {
		try {
			return realpathSync(filePath);
		} catch {
			return filePath;
		}
	}

	private async loadAgentFromFile(
		filePath: string,
		source: "global" | "workspace" | "plugin",
		workspace?: string,
		additionalAllowedPaths?: string[],
	): Promise<Agent | null> {
		try {
			// Validate file path for security
			const safePath = validatePathOrThrow(filePath, {
				description: "agent file",
				...(additionalAllowedPaths && { additionalAllowedPaths }),
			});
			const content = await readFile(safePath, "utf-8");

			// Extract frontmatter manually
			const frontmatterMatch = content.match(
				/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/,
			);
			if (!frontmatterMatch) {
				log.error(`No valid frontmatter found in ${filePath}`);
				return null;
			}

			const frontmatterContent = frontmatterMatch[1];
			const systemPrompt = frontmatterMatch[2];

			// Parse frontmatter into a data object
			const data: Record<string, string> = {};
			const lines = frontmatterContent.split("\n");
			let currentKey = "";
			let currentValue = "";

			for (const line of lines) {
				// Check if this line starts a new key-value pair
				const keyMatch = line.match(/^(\w+):\s*(.*)$/);
				if (keyMatch) {
					// Save previous key-value pair if exists
					if (currentKey) {
						data[currentKey] = dequoteValue(currentValue.trim());
					}
					// Start new key-value pair
					currentKey = keyMatch[1];
					currentValue = keyMatch[2];
				} else if (currentKey && line.trim()) {
					// This is a continuation of the previous value
					currentValue += ` ${line.trim()}`;
				}
			}
			// Save the last key-value pair
			if (currentKey) {
				data[currentKey] = dequoteValue(currentValue.trim());
			}

			// Validate required fields
			if (!data.name || !data.description) {
				log.warn(
					`Agent file ${filePath} missing required fields (name, description)`,
				);
				return null;
			}

			// Parse and validate model. `null` means "no preference" — the agent
			// inherits whatever model the session/caller is already using. This is
			// the case for a missing `model:` key, Claude Code's `model: inherit`
			// convention, and any value that fails validation.
			let model: AllowedModel | null = null;

			if (data.model) {
				const modelLower = data.model.toLowerCase();
				if (modelLower === "inherit") {
					model = null;
				} else if (modelLower === "fable") {
					model = LATEST_FABLE_MODEL;
				} else if (modelLower === "opus") {
					model = LATEST_OPUS_MODEL;
				} else if (modelLower === "sonnet") {
					model = LATEST_SONNET_MODEL;
				} else if (modelLower === "haiku") {
					model = LATEST_HAIKU_MODEL;
				} else if (this.isValidModel(data.model)) {
					model = data.model as AllowedModel; // Use exact model specified
				} else {
					log.warn(
						`Agent file ${filePath} has invalid model: ${data.model}. Treating as inherit.`,
					);
				}
			}

			// Parse tools from frontmatter
			let tools: AgentTool[] | undefined;
			if (data.tools) {
				tools = data.tools
					.split(",")
					.map((t: string) => t.trim() as AgentTool)
					.filter(Boolean);
			}

			const id = basename(filePath, ".md");

			return {
				id,
				name: data.name,
				description: data.description,
				color: data.color || DEFAULT_COLOR,
				model,
				systemPrompt: systemPrompt.trim(),
				source,
				workspace,
				tools,
				filePath,
			};
		} catch (error) {
			log.error(`Error loading agent from ${filePath}:`, error);
			return null;
		}
	}

	async loadAgents(): Promise<void> {
		const agents: Agent[] = [];
		const seenIds = new Set<string>();
		const seenRealPaths = new Set<string>();

		// Load global agents
		const globalDir = getAgentsDirectory();
		if (existsSync(globalDir)) {
			try {
				const files = await readdir(globalDir);
				const mdFiles = files.filter((file) => file.endsWith(".md"));

				for (const file of mdFiles) {
					const filePath = join(globalDir, file);

					// Symlink dedup
					const realPath = this.safeRealPath(filePath);
					if (seenRealPaths.has(realPath)) {
						log.debug(`Skipping duplicate agent (symlink dedup): ${filePath}`);
						continue;
					}
					seenRealPaths.add(realPath);

					const agent = await this.loadAgentFromFile(filePath, "global");

					if (agent) {
						if (seenIds.has(agent.id)) {
							log.warn(
								`Duplicate agent id ${agent.id} found in ${filePath} - keeping first occurrence`,
							);
							continue;
						}

						seenIds.add(agent.id);
						agents.push(agent);
					}
				}

				log.info(`Loaded ${mdFiles.length} global agents from ${globalDir}`);
			} catch (error) {
				log.error(`Error loading global agents from ${globalDir}:`, error);
			}
		}

		// Load workspace agents
		for (const [workspacePath, workspace] of this.workspaces) {
			const workspaceAgentsDir = join(workspacePath, ".claude", "agents");

			if (!existsSync(workspaceAgentsDir)) {
				log.debug(
					`Workspace agents directory does not exist: ${workspaceAgentsDir}`,
				);
				continue;
			}

			try {
				const files = await readdir(workspaceAgentsDir);
				const mdFiles = files.filter((file) => file.endsWith(".md"));

				for (const file of mdFiles) {
					const filePath = join(workspaceAgentsDir, file);

					// Symlink dedup
					const realPath = this.safeRealPath(filePath);
					if (seenRealPaths.has(realPath)) {
						log.debug(`Skipping duplicate agent (symlink dedup): ${filePath}`);
						continue;
					}
					seenRealPaths.add(realPath);

					const agent = await this.loadAgentFromFile(
						filePath,
						"workspace",
						workspacePath,
					);

					if (agent) {
						// For workspace agents, prefix the ID with workspace path to ensure uniqueness
						const workspaceAgentId = `${workspace.name}:${agent.id}`;

						if (seenIds.has(workspaceAgentId)) {
							log.warn(
								`Duplicate agent id ${workspaceAgentId} found in ${filePath} - keeping first occurrence`,
							);
							continue;
						}

						// Update the agent ID to include workspace prefix
						agent.id = workspaceAgentId;
						seenIds.add(workspaceAgentId);
						agents.push(agent);
					}
				}

				log.info(
					`Loaded ${mdFiles.length} agents from workspace ${workspace.name} (${workspacePath})`,
				);
			} catch (error) {
				log.error(
					`Error loading agents from workspace ${workspacePath}:`,
					error,
				);
			}
		}

		// Load plugin agents (feature-gated)
		await this.loadPluginAgents(agents, seenIds, seenRealPaths);

		this.cache = { agents, timestamp: Date.now() };
		log.info(
			`Total agents loaded: ${agents.length} (${agents.filter((a) => a.source === "global").length} global, ${agents.filter((a) => a.source === "workspace").length} workspace, ${agents.filter((a) => a.source === "plugin").length} plugin)`,
		);
	}

	private async loadPluginAgents(
		agents: Agent[],
		seenIds: Set<string>,
		seenRealPaths: Set<string>,
	): Promise<void> {
		if (process.env[PLUGIN_AGENT_DISCOVERY_ENV] !== "true") return;

		const manifestPath = this.manifestPathOverride ?? getPluginManifestPath();
		const pluginEntries = parsePluginManifest(manifestPath);
		const pluginAllowedPaths = [join(homedir(), ".claude", "plugins")];

		// Plugin-scoped dedup avoids two plugin files with the same final ID.
		// Cross-source collisions against seenIds are handled below with a warn,
		// not a debug — final agent IDs in agents[] must be unique regardless of
		// source, otherwise downstream agents.find() lookups become ambiguous.
		const seenPluginIds = new Set<string>();

		let totalLoaded = 0;
		for (const { pluginName, agentsDir } of pluginEntries) {
			// Validate agentsDir before any filesystem probe to prevent path
			// traversal / existence oracle via manifest installPath.
			try {
				validatePathOrThrow(agentsDir, {
					description: "plugin agents directory",
					additionalAllowedPaths: pluginAllowedPaths,
				});
			} catch {
				log.debug(
					`Plugin agents directory failed path validation: ${agentsDir}`,
				);
				continue;
			}

			let files: string[];
			try {
				files = await readdir(agentsDir);
			} catch {
				continue;
			}

			for (const file of files.filter((f) => f.endsWith(".md"))) {
				const filePath = join(agentsDir, file);

				// Symlink dedup
				const realPath = this.safeRealPath(filePath);
				if (seenRealPaths.has(realPath)) {
					log.debug(
						`Skipping duplicate plugin agent (symlink dedup): ${filePath}`,
					);
					continue;
				}
				seenRealPaths.add(realPath);

				const agent = await this.loadAgentFromFile(
					filePath,
					"plugin",
					undefined,
					pluginAllowedPaths,
				);
				if (!agent) continue;

				const pluginAgentId = `${pluginName}:${agent.id}`;
				if (seenPluginIds.has(pluginAgentId)) {
					log.debug(
						`Duplicate plugin agent id ${pluginAgentId} in ${filePath} — skipping`,
					);
					continue;
				}
				if (seenIds.has(pluginAgentId)) {
					log.warn(
						`Plugin agent id ${pluginAgentId} (from ${filePath}) collides with an already-loaded agent — skipping plugin entry`,
					);
					continue;
				}
				seenPluginIds.add(pluginAgentId);
				seenIds.add(pluginAgentId);

				agent.id = pluginAgentId;
				agent.pluginName = pluginName;
				agents.push(agent);
				totalLoaded++;
			}
		}

		log.info(`Loaded ${totalLoaded} plugin agents`);
	}

	async getAgents(): Promise<Agent[]> {
		// Ensure we're initialized
		await this.initialize();

		// Check if cache is valid
		if (this.cache && Date.now() - this.cache.timestamp < CACHE_TTL_MS) {
			return this.cache.agents;
		}

		// Reload agents
		await this.loadAgents();
		return this.cache?.agents || [];
	}

	async findAgentByPrompt(systemPrompt: string): Promise<Agent | undefined> {
		const agents = await this.getAgents();

		// Normalize the prompt for comparison
		const normalizedPrompt = systemPrompt.trim();

		return agents.find((agent) => {
			const agentPrompt = agent.systemPrompt.trim();
			// An empty agent system prompt would match any request via
			// String.includes("") — exclude it rather than let an empty-body
			// agent silently swallow every request that reaches this point.
			if (!agentPrompt) return false;
			// Check if the agent's system prompt is contained within the provided prompt
			// This handles cases where the agent prompt is part of a larger system prompt
			return normalizedPrompt.includes(agentPrompt);
		});
	}

	// Force reload agents (useful for testing or manual refresh)
	async refresh(): Promise<void> {
		this.cache = null;
		await this.loadAgents();
	}

	// Register a workspace
	async registerWorkspace(workspacePath: string): Promise<void> {
		// Validate and normalize workspace path for security
		const normalizedPath = validatePathOrThrow(workspacePath, {
			description: "workspace path",
		});

		// Check if this workspace is already registered
		if (this.workspaces.has(normalizedPath)) {
			// Update last seen time
			const workspace = this.workspaces.get(normalizedPath);
			if (workspace) {
				workspace.lastSeen = Date.now();
			}
			return;
		}

		// Extract workspace name from path
		const pathParts = normalizedPath.split("/");
		const workspaceName = pathParts[pathParts.length - 1] || "workspace";

		// Create new workspace entry
		const workspace: AgentWorkspace = {
			path: normalizedPath,
			name: workspaceName,
			lastSeen: Date.now(),
		};

		this.workspaces.set(normalizedPath, workspace);
		log.info(`Registered workspace: ${workspaceName} at ${normalizedPath}`);

		// Save workspaces to disk
		await this.saveWorkspaces();

		// Refresh to load agents from the new workspace
		await this.refresh();
	}

	// Get current workspaces
	getWorkspaces(): AgentWorkspace[] {
		return Array.from(this.workspaces.values());
	}

	// Save workspaces to disk
	private async saveWorkspaces(): Promise<void> {
		try {
			await this.workspacePersistence.saveWorkspaces(this.getWorkspaces());
		} catch (error) {
			log.error("Failed to save workspaces:", error);
		}
	}

	// Clear all workspaces (useful for testing)
	async clearWorkspaces(): Promise<void> {
		this.workspaces.clear();
		this.cache = null;
		await this.saveWorkspaces();
		log.info("Cleared all workspaces");
	}

	// Remove old workspaces that haven't been seen recently (e.g., 7 days)
	async pruneOldWorkspaces(
		maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
	): Promise<void> {
		const now = Date.now();
		const toRemove: string[] = [];

		for (const [path, workspace] of this.workspaces) {
			if (now - workspace.lastSeen > maxAgeMs) {
				toRemove.push(path);
			}
		}

		for (const path of toRemove) {
			this.workspaces.delete(path);
			log.info(`Removed stale workspace: ${path}`);
		}

		if (toRemove.length > 0) {
			this.cache = null; // Clear cache to force reload
			await this.saveWorkspaces();
		}
	}

	// Update an agent in the filesystem
	async updateAgent(
		agentId: string,
		updates: Partial<
			Pick<Agent, "description" | "model" | "tools" | "color" | "systemPrompt">
		>,
		dbOps?: {
			deleteAgentPreference: (agentId: string) => boolean | Promise<boolean>;
		},
	): Promise<Agent> {
		// Ensure we're initialized
		await this.initialize();

		// Find the agent
		const agents = await this.getAgents();
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) {
			throw new Error(`Agent with id ${agentId} not found`);
		}

		// Plugin agents are managed by their owning plugin — editing would
		// silently lose changes on the next plugin update.
		if (agent.source === "plugin") {
			throw new Error(
				`Agent ${agentId} is plugin-managed and cannot be edited; modify the source plugin instead`,
			);
		}

		// Reconstruct the agent file
		const currentContent = await readFile(agent.filePath, "utf-8");
		const frontmatterMatch = currentContent.match(
			/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/,
		);

		if (!frontmatterMatch) {
			throw new Error(`Invalid agent file format: ${agent.filePath}`);
		}

		// Parse existing frontmatter
		const existingFrontmatter = frontmatterMatch[1];
		const existingData: Record<string, string> = {};
		const lines = existingFrontmatter.split("\n");
		let currentKey = "";
		let currentValue = "";

		for (const line of lines) {
			const keyMatch = line.match(/^(\w+):\s*(.*)$/);
			if (keyMatch) {
				if (currentKey) {
					existingData[currentKey] = currentValue.trim();
				}
				currentKey = keyMatch[1];
				currentValue = keyMatch[2];
			} else if (currentKey && line.trim()) {
				currentValue += ` ${line.trim()}`;
			}
		}
		if (currentKey) {
			existingData[currentKey] = currentValue.trim();
		}

		// Apply updates to frontmatter
		if (updates.description !== undefined) {
			existingData.description = updates.description;
		}
		if (updates.model !== undefined) {
			if (updates.model === null) {
				// Explicit revert to inherit: remove the model: key entirely so
				// discovery parses this the same as an agent that never had one,
				// mirroring the tools-removal behavior below.
				delete existingData.model;
			} else {
				existingData.model = updates.model;
			}
		}
		if (updates.tools !== undefined) {
			if (updates.tools.length === 0) {
				delete existingData.tools;
			} else {
				existingData.tools = updates.tools.join(", ");
			}
		}
		if (updates.color !== undefined) {
			existingData.color = updates.color;
		}

		// Reconstruct frontmatter with proper formatting
		const newFrontmatter = Object.entries(existingData)
			.map(([key, value]) => `${key}: ${value}`)
			.join("\n");

		// Use updated system prompt or existing one
		const newSystemPrompt =
			updates.systemPrompt !== undefined
				? updates.systemPrompt
				: frontmatterMatch[2].trim();

		// Write the updated file
		const newContent = `---\n${newFrontmatter}\n---\n\n${newSystemPrompt}`;
		await writeFile(agent.filePath, newContent, "utf-8");

		// If model was updated (including an explicit revert to inherit), clear
		// any database preference so it doesn't mask the new frontmatter value.
		if (updates.model !== undefined && dbOps?.deleteAgentPreference) {
			try {
				await dbOps.deleteAgentPreference(agentId);
			} catch (error) {
				log.warn(`Failed to clear agent preference for ${agentId}:`, error);
			}
		}

		// Force cache refresh
		await this.refresh();

		// Return updated agent
		const updatedAgents = await this.getAgents();
		const updatedAgent = updatedAgents.find((a) => a.id === agentId);
		if (!updatedAgent) {
			throw new Error(`Failed to reload updated agent ${agentId}`);
		}

		return updatedAgent;
	}
}

// Create singleton instance
export const agentRegistry = new AgentRegistry();
