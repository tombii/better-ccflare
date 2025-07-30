import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Logger } from "@claudeflare/logger";
import type { Agent, AllowedModel } from "@claudeflare/types";
import { getAgentsDirectory } from "./paths";

interface AgentCache {
	agents: Agent[];
	timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_COLOR = "gray";
const DEFAULT_MODEL: AllowedModel = "claude-sonnet-4-20250514";

const log = new Logger("AgentRegistry");

export class AgentRegistry {
	private cache: AgentCache | null = null;

	private isValidModel(model: string): model is AllowedModel {
		const allowedModels: AllowedModel[] = [
			"claude-opus-4-20250514",
			"claude-sonnet-4-20250514",
		];
		return allowedModels.includes(model as AllowedModel);
	}

	private async loadAgentFromFile(filePath: string): Promise<Agent | null> {
		try {
			const content = await readFile(filePath, "utf-8");

			// Extract frontmatter manually using regex
			const frontmatterMatch = content.match(
				/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/,
			);
			if (!frontmatterMatch) {
				log.error(`No valid frontmatter found in ${filePath}`);
				return null;
			}

			const frontmatterContent = frontmatterMatch[1];
			const systemPrompt = frontmatterMatch[2];

			// Parse frontmatter line by line for simple key-value pairs
			const data: {
				name?: string;
				description?: string;
				color?: string;
				model?: string;
				[key: string]: string | undefined;
			} = {};

			const lines = frontmatterContent.split("\n");
			for (const line of lines) {
				const match = line.match(/^(\w+):\s*(.*)$/);
				if (match) {
					const [, key, value] = match;
					// Handle quoted strings and trim
					data[key] = value.replace(/^["']|["']$/g, "").trim();
				}
			}

			// Validate required fields
			if (!data.name || !data.description) {
				log.warn(
					`Agent file ${filePath} missing required fields (name, description)`,
				);
				return null;
			}

			// Extract and validate model (now optional - will use UI preference)
			const model = data.model || DEFAULT_MODEL;
			if (data.model && !this.isValidModel(model)) {
				log.warn(
					`Agent file ${filePath} has invalid model: ${model}. Using default.`,
				);
			}

			const id = basename(filePath, ".md");

			return {
				id,
				name: data.name,
				description: data.description,
				color: data.color || DEFAULT_COLOR,
				model: DEFAULT_MODEL, // Always use default, UI will override
				systemPrompt: systemPrompt.trim(),
			};
		} catch (error) {
			log.error(`Error loading agent from ${filePath}:`, error);
			return null;
		}
	}

	async loadAgents(): Promise<void> {
		const agentsDir = getAgentsDirectory();

		if (!existsSync(agentsDir)) {
			log.info(`Agents directory does not exist: ${agentsDir}`);
			this.cache = { agents: [], timestamp: Date.now() };
			return;
		}

		try {
			const files = await readdir(agentsDir);
			const mdFiles = files.filter((file) => file.endsWith(".md"));

			const agents: Agent[] = [];

			for (const file of mdFiles) {
				const filePath = join(agentsDir, file);
				const agent = await this.loadAgentFromFile(filePath);
				if (agent) {
					agents.push(agent);
				}
			}

			this.cache = { agents, timestamp: Date.now() };
			log.info(`Loaded ${agents.length} agents from ${agentsDir}`);
		} catch (error) {
			log.error("Error loading agents:", error);
			this.cache = { agents: [], timestamp: Date.now() };
		}
	}

	async getAgents(): Promise<Agent[]> {
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
			// Check if the agent's system prompt is contained within the provided prompt
			// This handles cases where the agent prompt is part of a larger system prompt
			return normalizedPrompt.includes(agent.systemPrompt);
		});
	}

	// Force reload agents (useful for testing or manual refresh)
	async refresh(): Promise<void> {
		this.cache = null;
		await this.loadAgents();
	}
}
