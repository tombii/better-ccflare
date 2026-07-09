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
import {
	agentRegistry,
	WorkspacePersistence,
	workspacePersistence,
} from "@better-ccflare/agents";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type { ModelCatalog } from "../../model-catalog";
import {
	interceptAndModifyRequest,
	isRewriteTargetServable,
} from "../agent-interceptor";

// The `agentRegistry` singleton used below defaults to persisting workspace
// state to the real `~/.better-ccflare/workspaces.json`. Redirect it to an
// isolated tmp-dir file for the lifetime of this test file so no test here
// can ever touch the developer's real file.
let workspacePersistenceTmpDir: string;

beforeAll(() => {
	workspacePersistenceTmpDir = fs.mkdtempSync(
		path.join(
			os.tmpdir(),
			"bcf-interceptor-rewrite-guard-workspace-persistence-",
		),
	);
	agentRegistry.setWorkspacePersistenceForTests(
		new WorkspacePersistence({
			workspacesFile: path.join(workspacePersistenceTmpDir, "workspaces.json"),
		}),
	);
});

afterAll(() => {
	agentRegistry.setWorkspacePersistenceForTests(workspacePersistence);
	fs.rmSync(workspacePersistenceTmpDir, { recursive: true, force: true });
});

describe("isRewriteTargetServable", () => {
	test("live catalog containing the model => servable (no veto)", () => {
		const catalog: ModelCatalog = {
			models: [
				{ id: "claude-opus-model", displayName: "Opus", createdAt: null },
			],
			fetchedAt: Date.now(),
			source: "live",
		};
		expect(isRewriteTargetServable(catalog, "claude-opus-model")).toBe(true);
	});

	test("live catalog missing the model => veto", () => {
		const catalog: ModelCatalog = {
			models: [
				{ id: "claude-sonnet-5", displayName: "Sonnet", createdAt: null },
			],
			fetchedAt: Date.now(),
			source: "live",
		};
		expect(isRewriteTargetServable(catalog, "claude-opus-model")).toBe(false);
	});

	test("fallback source => never vetoes, even if model absent", () => {
		const catalog: ModelCatalog = {
			models: [
				{ id: "claude-sonnet-5", displayName: "Sonnet", createdAt: null },
			],
			fetchedAt: Date.now(),
			source: "fallback",
		};
		expect(isRewriteTargetServable(catalog, "claude-opus-model")).toBe(true);
	});

	test("empty model list (even if source is live) => never vetoes", () => {
		const catalog: ModelCatalog = {
			models: [],
			fetchedAt: Date.now(),
			source: "live",
		};
		expect(isRewriteTargetServable(catalog, "claude-opus-model")).toBe(true);
	});

	test("null/undefined catalog => never vetoes", () => {
		expect(isRewriteTargetServable(null, "claude-opus-model")).toBe(true);
		expect(isRewriteTargetServable(undefined, "claude-opus-model")).toBe(true);
	});
});

const TEST_DB_PATH = "/tmp/test-agent-interceptor-rewrite-guard.db";

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

function liveCatalog(models: string[]): ModelCatalog {
	return {
		models: models.map((id) => ({ id, displayName: id, createdAt: null })),
		fetchedAt: Date.now(),
		source: "live",
	};
}

describe("interceptAndModifyRequest - rewrite guard integration", () => {
	let dbOps: DatabaseOperations;
	let tmpDir: string;
	let agentsDir: string;

	function writeAgent(fileName: string, frontmatter: string, body: string) {
		fs.writeFileSync(
			path.join(agentsDir, fileName),
			`---\n${frontmatter}\n---\n\n${body}`,
		);
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
			path.join(os.tmpdir(), "bcf-interceptor-rewrite-guard-test-"),
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

	test("preference targets a model absent from a live catalog => no rewrite, agentUsed set (header path)", async () => {
		await dbOps.setAgentPreference("guard-header-agent", "claude-opus-model");
		const buffer = toArrayBuffer(createMockRequestBody());
		const result = await interceptAndModifyRequest(
			buffer,
			dbOps,
			new Headers({ "x-anthropic-agent-id": "guard-header-agent" }),
			{
				getModelCatalog: async () =>
					liveCatalog(["claude-3-5-sonnet-20241022"]),
			},
		);
		expect(result.agentUsed).toBe("guard-header-agent");
		expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.originalModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.modifiedBody).toBe(buffer);
	});

	test("preference targets a model present in a live catalog => rewrite proceeds (header path)", async () => {
		await dbOps.setAgentPreference(
			"guard-header-agent-ok",
			"claude-opus-model",
		);
		const buffer = toArrayBuffer(createMockRequestBody());
		const result = await interceptAndModifyRequest(
			buffer,
			dbOps,
			new Headers({ "x-anthropic-agent-id": "guard-header-agent-ok" }),
			{
				getModelCatalog: async () =>
					liveCatalog(["claude-3-5-sonnet-20241022", "claude-opus-model"]),
			},
		);
		expect(result.appliedModel).toBe("claude-opus-model");
		expect(result.modifiedBody).not.toBe(buffer);
	});

	test("preference targets a model absent from a live catalog => no rewrite (system-prompt path)", async () => {
		writeAgent(
			"guard-agent.md",
			"name: Guard Agent\ndescription: test agent\nmodel: inherit",
			"You are the guard agent, a uniquely identifiable helper persona.",
		);
		await agentRegistry.registerWorkspace(tmpDir);
		const agents = await agentRegistry.getAgents();
		const agent = agents.find((a) => a.id.endsWith(":guard-agent"));
		expect(agent).toBeDefined();

		await dbOps.setAgentPreference(
			agent?.id ?? "guard-agent",
			"claude-opus-model",
		);

		const buffer = toArrayBuffer(
			createMockRequestBody({
				system:
					"You are the guard agent, a uniquely identifiable helper persona.",
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps, undefined, {
			getModelCatalog: async () => liveCatalog(["claude-3-5-sonnet-20241022"]),
		});
		expect(result.agentUsed).toBe(agent?.id);
		expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.modifiedBody).toBe(buffer);
	});

	test("fallback-source catalog never vetoes (system-prompt path)", async () => {
		writeAgent(
			"guard-agent-fallback.md",
			"name: Guard Agent Fallback\ndescription: test agent\nmodel: inherit",
			"You are the fallback guard agent, an entirely distinct helper voice.",
		);
		await agentRegistry.registerWorkspace(tmpDir);
		const agents = await agentRegistry.getAgents();
		const agent = agents.find((a) => a.id.endsWith(":guard-agent-fallback"));
		expect(agent).toBeDefined();

		await dbOps.setAgentPreference(
			agent?.id ?? "guard-agent-fallback",
			"claude-opus-model",
		);

		const buffer = toArrayBuffer(
			createMockRequestBody({
				system:
					"You are the fallback guard agent, an entirely distinct helper voice.",
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps, undefined, {
			getModelCatalog: async () => ({
				models: [],
				fetchedAt: Date.now(),
				source: "fallback",
			}),
		});
		expect(result.appliedModel).toBe("claude-opus-model");
		expect(result.modifiedBody).not.toBe(buffer);
	});
});
