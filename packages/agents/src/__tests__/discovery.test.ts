import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	LATEST_FABLE_MODEL,
	LATEST_HAIKU_MODEL,
	LATEST_OPUS_MODEL,
	LATEST_SONNET_MODEL,
} from "@better-ccflare/core";
import { AgentRegistry } from "../discovery";
import { WorkspacePersistence } from "../workspace-persistence";

/**
 * Hardening tests for AgentRegistry.loadAgentFromFile / findAgentByPrompt.
 * Agents are exercised through the public API by registering a temp
 * workspace (under os.tmpdir(), an allowed path per path-validator's
 * default allowlist) with a `.claude/agents` directory containing
 * hand-written fixture files.
 */
describe("AgentRegistry — model parsing and empty-prompt guard", () => {
	let tmpDir: string;
	let agentsDir: string;

	function writeAgent(fileName: string, frontmatter: string, body: string) {
		fs.writeFileSync(
			path.join(agentsDir, fileName),
			`---\n${frontmatter}\n---\n\n${body}`,
		);
	}

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcf-discovery-test-"));
		agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function loadAgents(): Promise<
		Awaited<ReturnType<AgentRegistry["getAgents"]>>
	> {
		const registry = new AgentRegistry(
			undefined,
			// Never touch the real ~/.better-ccflare/workspaces.json from tests.
			new WorkspacePersistence({
				workspacesFile: path.join(tmpDir, "test-workspaces.json"),
			}),
		);
		await registry.registerWorkspace(tmpDir);
		return registry.getAgents();
	}

	async function findAgentById(id: string) {
		const agents = await loadAgents();
		const agent = agents.find((a) => a.id.endsWith(`:${id}`) || a.id === id);
		if (!agent) throw new Error(`Agent ${id} not found among loaded agents`);
		return agent;
	}

	describe("model shorthand aliases resolve to LATEST_* constants", () => {
		const cases: Array<{ shorthand: string; expected: string }> = [
			{ shorthand: "sonnet", expected: LATEST_SONNET_MODEL },
			{ shorthand: "opus", expected: LATEST_OPUS_MODEL },
			{ shorthand: "fable", expected: LATEST_FABLE_MODEL },
			{ shorthand: "haiku", expected: LATEST_HAIKU_MODEL },
		];

		for (const { shorthand, expected } of cases) {
			it(`model: ${shorthand} → ${expected}`, async () => {
				writeAgent(
					`agent-${shorthand}.md`,
					`name: Agent ${shorthand}\ndescription: test agent\nmodel: ${shorthand}`,
					"You are a test agent.",
				);
				const agent = await findAgentById(`agent-${shorthand}`);
				expect(agent.model).toBe(expected);
			});
		}
	});

	it("model: inherit → null", async () => {
		writeAgent(
			"agent-inherit.md",
			"name: Inherit Agent\ndescription: test agent\nmodel: inherit",
			"You are a test agent.",
		);
		const agent = await findAgentById("agent-inherit");
		expect(agent.model).toBeNull();
	});

	it("missing model key → null", async () => {
		writeAgent(
			"agent-nomodel.md",
			"name: No Model Agent\ndescription: test agent",
			"You are a test agent.",
		);
		const agent = await findAgentById("agent-nomodel");
		expect(agent.model).toBeNull();
	});

	it("full model ID is passed through unchanged", async () => {
		writeAgent(
			"agent-fullid.md",
			"name: Full ID Agent\ndescription: test agent\nmodel: claude-sonnet-4-5-20250929",
			"You are a test agent.",
		);
		const agent = await findAgentById("agent-fullid");
		expect(agent.model).toBe("claude-sonnet-4-5-20250929");
	});

	it('quoted model: "sonnet" is dequoted before alias resolution', async () => {
		writeAgent(
			"agent-quoted.md",
			'name: Quoted Agent\ndescription: test agent\nmodel: "sonnet"',
			"You are a test agent.",
		);
		const agent = await findAgentById("agent-quoted");
		expect(agent.model).toBe(LATEST_SONNET_MODEL);
	});

	it("single-quoted model value is also dequoted", async () => {
		writeAgent(
			"agent-single-quoted.md",
			"name: Single Quoted Agent\ndescription: test agent\nmodel: 'opus'",
			"You are a test agent.",
		);
		const agent = await findAgentById("agent-single-quoted");
		expect(agent.model).toBe(LATEST_OPUS_MODEL);
	});

	it("invalid/garbage model value → null, no throw", async () => {
		writeAgent(
			"agent-garbage.md",
			"name: Garbage Agent\ndescription: test agent\nmodel: foo-bar",
			"You are a test agent.",
		);
		const agent = await findAgentById("agent-garbage");
		expect(agent.model).toBeNull();
	});

	describe("findAgentByPrompt", () => {
		it("never matches an agent with an empty system prompt body", async () => {
			writeAgent(
				"agent-empty-body.md",
				"name: Empty Body Agent\ndescription: test agent",
				"",
			);
			const registry = new AgentRegistry(
				undefined,
				// Never touch the real ~/.better-ccflare/workspaces.json from tests.
				new WorkspacePersistence({
					workspacesFile: path.join(tmpDir, "test-workspaces.json"),
				}),
			);
			await registry.registerWorkspace(tmpDir);

			// Sanity: the agent was actually loaded.
			const agents = await registry.getAgents();
			const loaded = agents.find((a) => a.id.endsWith(":agent-empty-body"));
			expect(loaded).toBeDefined();
			expect(loaded?.systemPrompt).toBe("");

			// It must not match any prompt, including an empty one.
			expect(await registry.findAgentByPrompt("")).toBeUndefined();
			expect(
				await registry.findAgentByPrompt("Some arbitrary system prompt text"),
			).toBeUndefined();
		});

		it("matches a normal agent via containment", async () => {
			writeAgent(
				"agent-normal.md",
				"name: Normal Agent\ndescription: test agent",
				"You are a specialized code reviewer.",
			);
			const registry = new AgentRegistry(
				undefined,
				// Never touch the real ~/.better-ccflare/workspaces.json from tests.
				new WorkspacePersistence({
					workspacesFile: path.join(tmpDir, "test-workspaces.json"),
				}),
			);
			await registry.registerWorkspace(tmpDir);

			const largerPrompt =
				"Some preamble.\n\nYou are a specialized code reviewer.\n\nMore trailing content.";
			const found = await registry.findAgentByPrompt(largerPrompt);
			expect(found).toBeDefined();
			expect(found?.id.endsWith(":agent-normal")).toBe(true);
		});
	});
});
