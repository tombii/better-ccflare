import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspacePersistence } from "../workspace-persistence";

/**
 * Regression coverage for the workspaces.json isolation fix: every
 * `WorkspacePersistence` instance used to hard-code the real
 * `~/.better-ccflare/workspaces.json` path at module load, so any test that
 * exercised workspace registration silently clobbered the developer's real
 * file. These tests prove the injected-path constructor option is honored
 * and never falls back to the real home-directory path.
 */
describe("WorkspacePersistence — injected path isolation", () => {
	let tmpDir: string;
	let workspacesFile: string;
	let legacyWorkspacesFile: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "bcf-workspace-persistence-test-"),
		);
		workspacesFile = path.join(tmpDir, "workspaces.json");
		legacyWorkspacesFile = path.join(tmpDir, "legacy-workspaces.json");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes to the injected path, not the real home-directory path", async () => {
		const persistence = new WorkspacePersistence({ workspacesFile });
		await persistence.saveWorkspaces([
			{
				path: "/tmp/example-workspace",
				name: "example-workspace",
				lastSeen: 1,
			},
		]);

		expect(fs.existsSync(workspacesFile)).toBe(true);
		const written = JSON.parse(fs.readFileSync(workspacesFile, "utf-8"));
		expect(written.workspaces).toHaveLength(1);
		expect(written.workspaces[0].name).toBe("example-workspace");
	});

	it("round-trips a save/load cycle through the injected path", async () => {
		const persistence = new WorkspacePersistence({ workspacesFile });
		await persistence.saveWorkspaces([
			{ path: "/tmp/round-trip", name: "round-trip", lastSeen: 42 },
		]);

		// A fresh instance pointed at the same injected path must see the
		// same data — proving the path is a real, load-bearing constructor
		// option and not just accepted-and-ignored.
		const reloaded = new WorkspacePersistence({ workspacesFile });
		const workspaces = await reloaded.loadWorkspaces();

		expect(workspaces).toEqual([
			{ path: "/tmp/round-trip", name: "round-trip", lastSeen: 42 },
		]);
	});

	it("does not create or touch the default (real) workspaces file", async () => {
		const realHome = path.join(
			os.homedir(),
			".better-ccflare",
			"workspaces.json",
		);
		const realFileExistedBefore = fs.existsSync(realHome);
		const realContentBefore = realFileExistedBefore
			? fs.readFileSync(realHome, "utf-8")
			: null;

		const persistence = new WorkspacePersistence({
			workspacesFile,
			legacyWorkspacesFile,
		});
		await persistence.saveWorkspaces([
			{ path: "/tmp/isolated", name: "isolated", lastSeen: 1 },
		]);
		await persistence.loadWorkspaces();

		if (realFileExistedBefore) {
			expect(fs.readFileSync(realHome, "utf-8")).toBe(realContentBefore);
		} else {
			expect(fs.existsSync(realHome)).toBe(false);
		}
	});

	it("migrates from an injected legacy path, not the real legacy path", async () => {
		fs.writeFileSync(
			legacyWorkspacesFile,
			JSON.stringify({
				version: 1,
				workspaces: [{ path: "/tmp/legacy", name: "legacy", lastSeen: 7 }],
			}),
		);

		const persistence = new WorkspacePersistence({
			workspacesFile,
			legacyWorkspacesFile,
		});
		const workspaces = await persistence.loadWorkspaces();

		expect(workspaces).toEqual([
			{ path: "/tmp/legacy", name: "legacy", lastSeen: 7 },
		]);
		// Migration should have copied the legacy file to the new path.
		expect(fs.existsSync(workspacesFile)).toBe(true);
	});
});
