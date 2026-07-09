import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import * as fs from "node:fs";
import { existsSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentRegistry } from "@better-ccflare/agents";
import { LATEST_SONNET_MODEL } from "@better-ccflare/core";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import { interceptAndModifyRequest } from "../agent-interceptor";

const TEST_DB_PATH = "/tmp/test-agent-interceptor-precedence.db";

/**
 * Precedence matrix for interceptAndModifyRequest's system-prompt path:
 * an explicit DB preference always wins; the agent's frontmatter `model`
 * is only consulted as a fallback when `options.frontmatterModelFallback`
 * is explicitly set, since Claude Code already resolves frontmatter model
 * aliases client-side and the registry's copy can go stale.
 */
describe("Agent Interceptor - precedence (DB preference vs. frontmatter fallback)", () => {
	let dbOps: DatabaseOperations;
	let tmpDir: string;
	let agentsDir: string;

	function writeAgent(fileName: string, frontmatter: string, body: string) {
		fs.writeFileSync(
			path.join(agentsDir, fileName),
			`---\n${frontmatter}\n---\n\n${body}`,
		);
	}

	function toArrayBuffer(obj: Record<string, unknown>): ArrayBuffer {
		const encoder = new TextEncoder();
		const bytes = encoder.encode(JSON.stringify(obj));
		const buffer = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(buffer).set(bytes);
		return buffer;
	}

	function createMockRequestBody(
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			model: "claude-3-5-sonnet-20241022",
			messages: [{ role: "user", content: "test message" }],
			system: "",
			max_tokens: 1024,
			...overrides,
		};
	}

	beforeAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();

		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "bcf-interceptor-precedence-test-"),
		);
		agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
	});

	afterAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
		DatabaseFactory.reset();
		fs.rmSync(tmpDir, { recursive: true, force: true });
		agentRegistry.clearWorkspaces();
	});

	afterEach(() => {
		agentRegistry.clearWorkspaces();
	});

	/**
	 * The interceptor uses the module-level `agentRegistry` singleton (not an
	 * injectable instance), so each case registers the shared temp workspace
	 * against it directly, mirroring how the interceptor itself calls
	 * `agentRegistry.registerWorkspace()` when it sees a `.claude/agents` path
	 * in the system prompt. `findAgentByPrompt` only needs a registered
	 * workspace, not the system-prompt directory-scanning path.
	 */
	async function registerAndFind(): Promise<void> {
		await agentRegistry.registerWorkspace(tmpDir);
	}

	test("(a) DB preference set => rewrite happens for the system-prompt path", async () => {
		writeAgent(
			"agent-a.md",
			"name: Agent A\ndescription: test agent\nmodel: inherit",
			"You are agent A, a specialized helper.",
		);
		await registerAndFind();
		const agents = await agentRegistry.getAgents();
		const agent = agents.find((a) => a.id.endsWith(":agent-a"));
		expect(agent).toBeDefined();
		expect(agent?.model).toBeNull();

		await dbOps.setAgentPreference(agent?.id ?? "agent-a", "claude-opus-model");

		const buffer = toArrayBuffer(
			createMockRequestBody({
				system: "You are agent A, a specialized helper.",
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps);
		expect(result.agentUsed).toBe(agent?.id);
		expect(result.appliedModel).toBe("claude-opus-model");
		expect(result.originalModel).toBe("claude-3-5-sonnet-20241022");
	});

	test("(a) DB preference set => rewrite happens for the header path too", async () => {
		await dbOps.setAgentPreference("header-agent-a", "claude-opus-model");
		const buffer = toArrayBuffer(createMockRequestBody());
		const result = await interceptAndModifyRequest(
			buffer,
			dbOps,
			new Headers({ "x-anthropic-agent-id": "header-agent-a" }),
		);
		expect(result.agentUsed).toBe("header-agent-a");
		expect(result.appliedModel).toBe("claude-opus-model");
	});

	test("(b) no preference, flag off, frontmatter model present => no rewrite, agentUsed still set", async () => {
		writeAgent(
			"agent-b.md",
			`name: Agent B\ndescription: test agent\nmodel: ${LATEST_SONNET_MODEL}`,
			"You are agent B, a distinctive helper persona.",
		);
		await registerAndFind();
		const agents = await agentRegistry.getAgents();
		const agent = agents.find((a) => a.id.endsWith(":agent-b"));
		expect(agent).toBeDefined();
		expect(agent?.model).toBe(LATEST_SONNET_MODEL);

		const buffer = toArrayBuffer(
			createMockRequestBody({
				system: "You are agent B, a distinctive helper persona.",
			}),
		);
		// No frontmatterModelFallback option passed => defaults to off.
		const result = await interceptAndModifyRequest(buffer, dbOps);
		expect(result.agentUsed).toBe(agent?.id);
		expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.modifiedBody).toBe(buffer);
	});

	test("(c) flag on + frontmatter model present => rewrite", async () => {
		writeAgent(
			"agent-c.md",
			`name: Agent C\ndescription: test agent\nmodel: ${LATEST_SONNET_MODEL}`,
			"You are agent C, an entirely distinct helper voice.",
		);
		await registerAndFind();
		const agents = await agentRegistry.getAgents();
		const agent = agents.find((a) => a.id.endsWith(":agent-c"));
		expect(agent).toBeDefined();

		const buffer = toArrayBuffer(
			createMockRequestBody({
				system: "You are agent C, an entirely distinct helper voice.",
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps, undefined, {
			frontmatterModelFallback: true,
		});
		expect(result.agentUsed).toBe(agent?.id);
		expect(result.appliedModel).toBe(LATEST_SONNET_MODEL);
		expect(result.modifiedBody).not.toBe(buffer);
	});

	test("(d) flag on + agent.model null (inherit) => no rewrite", async () => {
		writeAgent(
			"agent-d.md",
			"name: Agent D\ndescription: test agent\nmodel: inherit",
			"You are agent D, yet another unmistakable helper persona.",
		);
		await registerAndFind();
		const agents = await agentRegistry.getAgents();
		const agent = agents.find((a) => a.id.endsWith(":agent-d"));
		expect(agent).toBeDefined();
		expect(agent?.model).toBeNull();

		const buffer = toArrayBuffer(
			createMockRequestBody({
				system: "You are agent D, yet another unmistakable helper persona.",
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps, undefined, {
			frontmatterModelFallback: true,
		});
		expect(result.agentUsed).toBe(agent?.id);
		expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.modifiedBody).toBe(buffer);
	});

	test("(e) DB preference === originalModel => no-op (body unchanged)", async () => {
		await dbOps.setAgentPreference(
			"same-model-agent-precedence",
			"claude-3-5-sonnet-20241022",
		);
		const buffer = toArrayBuffer(createMockRequestBody());
		const result = await interceptAndModifyRequest(
			buffer,
			dbOps,
			new Headers({ "x-anthropic-agent-id": "same-model-agent-precedence" }),
		);
		expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.modifiedBody).toBe(buffer);
	});

	test("(f) malformed JSON body => originalModel is null (unextractable), no throw", async () => {
		const encoder = new TextEncoder();
		const bytes = encoder.encode("{not valid json");
		const buffer = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(buffer).set(bytes);

		const result = await interceptAndModifyRequest(buffer, dbOps);
		expect(result.agentUsed).toBeNull();
		expect(result.originalModel).toBeNull();
		expect(result.appliedModel).toBeNull();
		expect(result.modifiedBody).toBe(buffer);
	});
});
