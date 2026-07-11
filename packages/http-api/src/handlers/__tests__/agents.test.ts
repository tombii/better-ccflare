import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	agentRegistry,
	WorkspacePersistence,
	workspacePersistence,
} from "@better-ccflare/agents";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { Agent, APIContext } from "@better-ccflare/types";
import {
	createAgentPreferenceDeleteHandler,
	createAgentPreferenceUpdateHandler,
	createAgentsListHandler,
	createBulkAgentPreferenceUpdateHandler,
} from "../agents";
import { createAgentUpdateHandler } from "../agents-update";

// The `agentRegistry` singleton used below defaults to persisting workspace
// state to the real `~/.better-ccflare/workspaces.json`. Redirect it to an
// isolated tmp-dir file for the lifetime of this test file so no test here
// can ever touch the developer's real file.
let workspacePersistenceTmpDir: string;

beforeAll(() => {
	workspacePersistenceTmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "bcf-agents-handler-workspace-persistence-"),
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

function makeDbOps(): DatabaseOperations {
	return {
		setAgentPreference: mock(() => {}),
		setBulkAgentPreferences: mock(() => {}),
	} as unknown as DatabaseOperations;
}

function makeCatalog(
	models: string[],
	source: "live" | "fallback" = "live",
): APIContext["modelCatalog"] {
	return {
		get: async () => ({
			models: models.map((id) => ({ id, displayName: id, createdAt: null })),
			fetchedAt: Date.now(),
			source,
		}),
		refresh: async () => ({ success: true }),
	};
}

describe("createAgentPreferenceUpdateHandler - live catalog warning", () => {
	// This handler never consults agentRegistry (it writes the preference
	// directly by agentId), so no workspace setup is needed here.
	it("includes a warning when the live catalog doesn't list the model", async () => {
		const dbOps = makeDbOps();
		const handler = createAgentPreferenceUpdateHandler(
			dbOps,
			makeCatalog(["claude-3-5-sonnet-20241022"]),
		);
		const response = await handler(
			new Request("http://localhost/api/agents/agent-1/preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-opus-model" }),
			}),
			"agent-1",
		);
		const body = (await response.json()) as {
			success: boolean;
			warning?: string;
		};

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.warning).toContain("claude-opus-model");
		expect(dbOps.setAgentPreference).toHaveBeenCalledWith(
			"agent-1",
			"claude-opus-model",
		);
	});

	it("omits the warning when the live catalog lists the model", async () => {
		const dbOps = makeDbOps();
		const handler = createAgentPreferenceUpdateHandler(
			dbOps,
			makeCatalog(["claude-opus-model"]),
		);
		const response = await handler(
			new Request("http://localhost/api/agents/agent-1/preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-opus-model" }),
			}),
			"agent-1",
		);
		const body = (await response.json()) as { warning?: string };

		expect(body.warning).toBeUndefined();
	});

	it("omits the warning when the catalog source is 'fallback'", async () => {
		const dbOps = makeDbOps();
		const handler = createAgentPreferenceUpdateHandler(
			dbOps,
			makeCatalog(["claude-3-5-sonnet-20241022"], "fallback"),
		);
		const response = await handler(
			new Request("http://localhost/api/agents/agent-1/preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-opus-model" }),
			}),
			"agent-1",
		);
		const body = (await response.json()) as { warning?: string };

		expect(body.warning).toBeUndefined();
	});

	it("omits the warning when no modelCatalog is injected", async () => {
		const dbOps = makeDbOps();
		const handler = createAgentPreferenceUpdateHandler(dbOps, undefined);
		const response = await handler(
			new Request("http://localhost/api/agents/agent-1/preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-opus-model" }),
			}),
			"agent-1",
		);
		const body = (await response.json()) as { warning?: string };

		expect(body.warning).toBeUndefined();
	});

	it("still rejects a garbage model with 400 before any catalog check", async () => {
		const dbOps = makeDbOps();
		const handler = createAgentPreferenceUpdateHandler(
			dbOps,
			makeCatalog(["claude-3-5-sonnet-20241022"]),
		);
		const response = await handler(
			new Request("http://localhost/api/agents/agent-1/preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "totally-not-a-claude-model" }),
			}),
			"agent-1",
		);

		expect(response.status).toBe(400);
		expect(dbOps.setAgentPreference).not.toHaveBeenCalled();
	});

	it("accepts a non-pattern model id present in a live catalog", async () => {
		const dbOps = makeDbOps();
		const handler = createAgentPreferenceUpdateHandler(
			dbOps,
			makeCatalog(["claude-nova-9"]),
		);
		const response = await handler(
			new Request("http://localhost/api/agents/agent-1/preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
			"agent-1",
		);

		expect(response.status).toBe(200);
		expect(dbOps.setAgentPreference).toHaveBeenCalledWith(
			"agent-1",
			"claude-nova-9",
		);
	});

	it("rejects a non-pattern model id absent from a fallback catalog with 400", async () => {
		const dbOps = makeDbOps();
		const handler = createAgentPreferenceUpdateHandler(
			dbOps,
			makeCatalog(["claude-nova-9"], "fallback"),
		);
		const response = await handler(
			new Request("http://localhost/api/agents/agent-1/preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
			"agent-1",
		);

		expect(response.status).toBe(400);
		expect(dbOps.setAgentPreference).not.toHaveBeenCalled();
	});

	it("rejects a non-pattern model id with 400 when no catalog is injected", async () => {
		const dbOps = makeDbOps();
		const handler = createAgentPreferenceUpdateHandler(dbOps, undefined);
		const response = await handler(
			new Request("http://localhost/api/agents/agent-1/preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
			"agent-1",
		);

		expect(response.status).toBe(400);
		expect(dbOps.setAgentPreference).not.toHaveBeenCalled();
	});
});

describe("createAgentPreferenceDeleteHandler - revert to agent default", () => {
	it("deletes the preference and reports deleted: true", async () => {
		const deleteAgentPreference = mock(async () => true);
		const dbOps = {
			deleteAgentPreference,
		} as unknown as DatabaseOperations;
		const handler = createAgentPreferenceDeleteHandler(dbOps);

		const response = await handler(
			new Request("http://localhost/api/agents/agent-1/preference", {
				method: "DELETE",
			}),
			"agent-1",
		);
		const body = (await response.json()) as {
			success: boolean;
			agentId: string;
			deleted: boolean;
		};

		expect(response.status).toBe(200);
		expect(body).toEqual({ success: true, agentId: "agent-1", deleted: true });
		expect(deleteAgentPreference).toHaveBeenCalledWith("agent-1");
	});

	it("reports deleted: false when no preference row existed", async () => {
		const dbOps = {
			deleteAgentPreference: mock(async () => false),
		} as unknown as DatabaseOperations;
		const handler = createAgentPreferenceDeleteHandler(dbOps);

		const response = await handler(
			new Request("http://localhost/api/agents/agent-1/preference", {
				method: "DELETE",
			}),
			"agent-1",
		);
		const body = (await response.json()) as { deleted: boolean };

		expect(response.status).toBe(200);
		expect(body.deleted).toBe(false);
	});

	it("returns 500 when the delete operation throws", async () => {
		const dbOps = {
			deleteAgentPreference: mock(async () => {
				throw new Error("db unavailable");
			}),
		} as unknown as DatabaseOperations;
		const handler = createAgentPreferenceDeleteHandler(dbOps);

		const response = await handler(
			new Request("http://localhost/api/agents/agent-1/preference", {
				method: "DELETE",
			}),
			"agent-1",
		);

		expect(response.status).toBe(500);
	});
});

describe("createBulkAgentPreferenceUpdateHandler - live catalog warning", () => {
	let tmpDir: string;
	let agentsDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "bcf-bulk-preference-warning-test-"),
		);
		agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "bulk-warning-agent.md"),
			"---\nname: Bulk Warning Agent\ndescription: test agent\nmodel: inherit\n---\n\nYou are the bulk warning test agent.",
		);
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		agentRegistry.clearWorkspaces();
	});

	afterEach(() => {
		agentRegistry.clearWorkspaces();
	});

	it("includes a warning when the live catalog doesn't list the model", async () => {
		await agentRegistry.registerWorkspace(tmpDir);
		const dbOps = makeDbOps();
		const handler = createBulkAgentPreferenceUpdateHandler(
			dbOps,
			makeCatalog(["claude-3-5-sonnet-20241022"]),
		);
		const response = await handler(
			new Request("http://localhost/api/agents/bulk-preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-opus-model" }),
			}),
		);
		const body = (await response.json()) as {
			success: boolean;
			warning?: string;
		};

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.warning).toContain("claude-opus-model");
	});

	it("omits the warning when the live catalog lists the model", async () => {
		await agentRegistry.registerWorkspace(tmpDir);
		const dbOps = makeDbOps();
		const handler = createBulkAgentPreferenceUpdateHandler(
			dbOps,
			makeCatalog(["claude-opus-model"]),
		);
		const response = await handler(
			new Request("http://localhost/api/agents/bulk-preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-opus-model" }),
			}),
		);
		const body = (await response.json()) as { warning?: string };

		expect(body.warning).toBeUndefined();
	});

	it("accepts a non-pattern model id present in a live catalog", async () => {
		await agentRegistry.registerWorkspace(tmpDir);
		const dbOps = makeDbOps();
		const handler = createBulkAgentPreferenceUpdateHandler(
			dbOps,
			makeCatalog(["claude-nova-9"]),
		);
		const response = await handler(
			new Request("http://localhost/api/agents/bulk-preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
		);

		expect(response.status).toBe(200);
		expect(dbOps.setBulkAgentPreferences).toHaveBeenCalled();
	});

	it("rejects a non-pattern model id absent from a fallback catalog with 400", async () => {
		await agentRegistry.registerWorkspace(tmpDir);
		const dbOps = makeDbOps();
		const handler = createBulkAgentPreferenceUpdateHandler(
			dbOps,
			makeCatalog(["claude-nova-9"], "fallback"),
		);
		const response = await handler(
			new Request("http://localhost/api/agents/bulk-preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
		);

		expect(response.status).toBe(400);
		expect(dbOps.setBulkAgentPreferences).not.toHaveBeenCalled();
	});

	it("rejects a non-pattern model id with 400 when no catalog is injected", async () => {
		await agentRegistry.registerWorkspace(tmpDir);
		const dbOps = makeDbOps();
		const handler = createBulkAgentPreferenceUpdateHandler(dbOps, undefined);
		const response = await handler(
			new Request("http://localhost/api/agents/bulk-preference", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
		);

		expect(response.status).toBe(400);
		expect(dbOps.setBulkAgentPreferences).not.toHaveBeenCalled();
	});
});

describe("createAgentsListHandler - model provenance", () => {
	let tmpDir: string;
	let agentsDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "bcf-agents-list-provenance-test-"),
		);
		agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "preference-agent.md"),
			"---\nname: Preference Agent\ndescription: has a DB preference\nmodel: claude-sonnet-5\n---\n\nYou are the preference test agent.",
		);
		fs.writeFileSync(
			path.join(agentsDir, "frontmatter-agent.md"),
			"---\nname: Frontmatter Agent\ndescription: uses its frontmatter model\nmodel: claude-opus-4-8\n---\n\nYou are the frontmatter test agent.",
		);
		fs.writeFileSync(
			path.join(agentsDir, "inherit-agent.md"),
			"---\nname: Inherit Agent\ndescription: inherits the session model\nmodel: inherit\n---\n\nYou are the inherit test agent.",
		);
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		agentRegistry.clearWorkspaces();
	});

	afterEach(() => {
		agentRegistry.clearWorkspaces();
	});

	function makeListDbOps(
		preferences: Array<{ agent_id: string; model: string }>,
	): DatabaseOperations {
		return {
			getAllAgentPreferences: mock(async () => preferences),
		} as unknown as DatabaseOperations;
	}

	it("marks an agent with a DB preference as modelSource: 'preference'", async () => {
		await agentRegistry.registerWorkspace(tmpDir);
		// Workspace agent ids are prefixed with the (possibly realpath-resolved)
		// workspace name, so discover the actual id instead of assuming it
		// equals the file basename.
		const preferenceAgentId = (await agentRegistry.getAgents()).find(
			(a) => a.name === "Preference Agent",
		)?.id;
		const dbOps = makeListDbOps([
			{ agent_id: preferenceAgentId ?? "", model: "claude-opus-4-8" },
		]);
		const handler = createAgentsListHandler(dbOps);
		const response = await handler();
		const body = (await response.json()) as { agents: Agent[] };
		// Workspace agent ids are prefixed with the workspace dir name
		// (`<workspace>:<file-basename>`), so match by name instead.
		const agent = body.agents.find((a) => a.name === "Preference Agent");

		expect(agent?.modelSource).toBe("preference");
		expect(agent?.model).toBe("claude-opus-4-8");
		expect(agent?.frontmatterModel).toBe("claude-sonnet-5");
	});

	it("marks an agent with a frontmatter model and no preference as modelSource: 'frontmatter'", async () => {
		await agentRegistry.registerWorkspace(tmpDir);
		const dbOps = makeListDbOps([]);
		const handler = createAgentsListHandler(dbOps);
		const response = await handler();
		const body = (await response.json()) as { agents: Agent[] };
		const agent = body.agents.find((a) => a.name === "Frontmatter Agent");

		expect(agent?.modelSource).toBe("frontmatter");
		expect(agent?.model).toBe("claude-opus-4-8");
		expect(agent?.frontmatterModel).toBe("claude-opus-4-8");
	});

	it("marks an agent with model: inherit and no preference as modelSource: 'inherit'", async () => {
		await agentRegistry.registerWorkspace(tmpDir);
		const dbOps = makeListDbOps([]);
		const handler = createAgentsListHandler(dbOps);
		const response = await handler();
		const body = (await response.json()) as { agents: Agent[] };
		const agent = body.agents.find((a) => a.name === "Inherit Agent");

		expect(agent?.modelSource).toBe("inherit");
		expect(agent?.model).toBeNull();
		expect(agent?.frontmatterModel).toBeNull();
	});
});

describe("createAgentUpdateHandler - model inherit support", () => {
	let tmpDir: string;
	let agentsDir: string;
	let filePath: string;
	let agentId: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "bcf-agent-update-inherit-test-"),
		);
		agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		filePath = path.join(agentsDir, "update-inherit-agent.md");
		fs.writeFileSync(
			filePath,
			"---\nname: Update Inherit Agent\ndescription: test agent\nmodel: claude-opus-4-8\n---\n\nYou are the update-inherit test agent.",
		);
		await agentRegistry.registerWorkspace(tmpDir);
		const agent = (await agentRegistry.getAgents()).find(
			(a) => a.name === "Update Inherit Agent",
		);
		if (!agent) throw new Error("fixture agent not found");
		agentId = agent.id;
	});

	afterEach(() => {
		agentRegistry.clearWorkspaces();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeUpdateDbOps(): DatabaseOperations {
		return {
			deleteAgentPreference: mock(async () => true),
		} as unknown as DatabaseOperations;
	}

	it("removes the model: key and clears the DB preference when model is null", async () => {
		const dbOps = makeUpdateDbOps();
		const handler = createAgentUpdateHandler(dbOps);
		const response = await handler(
			new Request(`http://localhost/api/agents/${agentId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: null }),
			}),
			agentId,
		);
		const body = (await response.json()) as {
			success: boolean;
			agent: Agent;
		};

		expect(response.status).toBe(200);
		expect(body.agent.model).toBeNull();
		const fileContent = fs.readFileSync(filePath, "utf-8");
		expect(fileContent).not.toMatch(/^model:/m);
		expect(dbOps.deleteAgentPreference).toHaveBeenCalledWith(agentId);
	});

	it('treats model: "INHERIT" (case-insensitive) the same as null', async () => {
		const dbOps = makeUpdateDbOps();
		const handler = createAgentUpdateHandler(dbOps);
		const response = await handler(
			new Request(`http://localhost/api/agents/${agentId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "INHERIT" }),
			}),
			agentId,
		);
		const body = (await response.json()) as {
			success: boolean;
			agent: Agent;
		};

		expect(response.status).toBe(200);
		expect(body.agent.model).toBeNull();
		const fileContent = fs.readFileSync(filePath, "utf-8");
		expect(fileContent).not.toMatch(/^model:/m);
	});

	it("rejects an invalid non-null model string without writing it to the file", async () => {
		const dbOps = makeUpdateDbOps();
		const handler = createAgentUpdateHandler(dbOps);
		const response = await handler(
			new Request(`http://localhost/api/agents/${agentId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "totally-not-a-claude-model" }),
			}),
			agentId,
		);

		expect(response.status).toBe(400);
		expect(dbOps.deleteAgentPreference).not.toHaveBeenCalled();
		const fileContent = fs.readFileSync(filePath, "utf-8");
		expect(fileContent).toMatch(/^model: claude-opus-4-8$/m);
	});

	it("accepts a non-pattern model id present in a live catalog", async () => {
		const dbOps = makeUpdateDbOps();
		const handler = createAgentUpdateHandler(
			dbOps,
			makeCatalog(["claude-nova-9"]),
		);
		const response = await handler(
			new Request(`http://localhost/api/agents/${agentId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
			agentId,
		);

		// The write itself is accepted (not rejected with 400) and the raw
		// value lands in the frontmatter file. Note the round-tripped
		// `agent.model` on the response is null: `agentRegistry.updateAgent`
		// re-reads the file through discovery.ts's frontmatter parser, which
		// stays pattern-only by design (out of scope for this validator —
		// see model-validation.ts) and treats a non-pattern id as `inherit`.
		expect(response.status).toBe(200);
		const fileContent = fs.readFileSync(filePath, "utf-8");
		expect(fileContent).toMatch(/^model: claude-nova-9$/m);
	});

	it("rejects a non-pattern model id absent from a fallback catalog with 400", async () => {
		const dbOps = makeUpdateDbOps();
		const handler = createAgentUpdateHandler(
			dbOps,
			makeCatalog(["claude-nova-9"], "fallback"),
		);
		const response = await handler(
			new Request(`http://localhost/api/agents/${agentId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
			agentId,
		);

		expect(response.status).toBe(400);
	});

	it("rejects a non-pattern model id with 400 when no catalog is injected", async () => {
		const dbOps = makeUpdateDbOps();
		const handler = createAgentUpdateHandler(dbOps);
		const response = await handler(
			new Request(`http://localhost/api/agents/${agentId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
			agentId,
		);

		expect(response.status).toBe(400);
	});

	it("still writes a concrete model value normally", async () => {
		const dbOps = makeUpdateDbOps();
		const handler = createAgentUpdateHandler(dbOps);
		const response = await handler(
			new Request(`http://localhost/api/agents/${agentId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-sonnet-5" }),
			}),
			agentId,
		);
		const body = (await response.json()) as {
			success: boolean;
			agent: Agent;
		};

		expect(response.status).toBe(200);
		expect(body.agent.model).toBe("claude-sonnet-5");
		const fileContent = fs.readFileSync(filePath, "utf-8");
		expect(fileContent).toMatch(/^model: claude-sonnet-5$/m);
		expect(dbOps.deleteAgentPreference).toHaveBeenCalledWith(agentId);
	});
});
