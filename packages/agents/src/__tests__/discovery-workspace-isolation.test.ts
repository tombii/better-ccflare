import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../discovery";
import { WorkspacePersistence } from "../workspace-persistence";

/**
 * Proves `AgentRegistry` actually uses an injected `WorkspacePersistence`
 * instance for its save/load calls, rather than silently falling back to
 * the shared singleton that targets the real
 * `~/.better-ccflare/workspaces.json` file. This is the mechanism
 * `discovery.test.ts` (and every other test that constructs its own
 * `AgentRegistry`) relies on for isolation.
 */
describe("AgentRegistry — injected workspace persistence", () => {
	let tmpDir: string;
	let workspacesFile: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "bcf-registry-persistence-test-"),
		);
		workspacesFile = path.join(tmpDir, "workspaces.json");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("registerWorkspace() saves to the injected persistence path, not the real one", async () => {
		const persistence = new WorkspacePersistence({ workspacesFile });
		const registry = new AgentRegistry(undefined, persistence);

		await registry.registerWorkspace(tmpDir);

		expect(fs.existsSync(workspacesFile)).toBe(true);
		const written = JSON.parse(fs.readFileSync(workspacesFile, "utf-8"));
		expect(written.workspaces).toHaveLength(1);
		expect(written.workspaces[0].path).toBe(fs.realpathSync(tmpDir));
	});

	it("initialize() loads saved workspaces back from the injected persistence path", async () => {
		const persistence = new WorkspacePersistence({ workspacesFile });
		const first = new AgentRegistry(undefined, persistence);
		await first.registerWorkspace(tmpDir);

		// A brand-new registry sharing the same injected persistence instance
		// must pick up what the first one saved.
		const second = new AgentRegistry(undefined, persistence);
		await second.initialize();

		expect(second.getWorkspaces()).toHaveLength(1);
		expect(second.getWorkspaces()[0].path).toBe(fs.realpathSync(tmpDir));
	});

	it("setWorkspacePersistenceForTests() redirects an already-constructed registry", async () => {
		// Mirrors how tests must redirect the production `agentRegistry`
		// singleton, which is already constructed with the default
		// persistence before any test file can inject a constructor arg.
		const registry = new AgentRegistry();
		const persistence = new WorkspacePersistence({ workspacesFile });

		registry.setWorkspacePersistenceForTests(persistence);
		await registry.registerWorkspace(tmpDir);

		expect(fs.existsSync(workspacesFile)).toBe(true);
		const written = JSON.parse(fs.readFileSync(workspacesFile, "utf-8"));
		expect(written.workspaces).toHaveLength(1);
	});

	it("never touches the real workspaces file when constructed with injected persistence", async () => {
		const realHome = path.join(
			os.homedir(),
			".better-ccflare",
			"workspaces.json",
		);
		const realFileExistedBefore = fs.existsSync(realHome);
		const realContentBefore = realFileExistedBefore
			? fs.readFileSync(realHome, "utf-8")
			: null;

		const persistence = new WorkspacePersistence({ workspacesFile });
		const registry = new AgentRegistry(undefined, persistence);
		await registry.registerWorkspace(tmpDir);
		await registry.clearWorkspaces();

		if (realFileExistedBefore) {
			expect(fs.readFileSync(realHome, "utf-8")).toBe(realContentBefore);
		} else {
			expect(fs.existsSync(realHome)).toBe(false);
		}
	});
});
