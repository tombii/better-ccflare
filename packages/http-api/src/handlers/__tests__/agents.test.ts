import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentRegistry } from "@better-ccflare/agents";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { APIContext } from "@better-ccflare/types";
import {
	createAgentPreferenceDeleteHandler,
	createAgentPreferenceUpdateHandler,
	createBulkAgentPreferenceUpdateHandler,
} from "../agents";

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
});
