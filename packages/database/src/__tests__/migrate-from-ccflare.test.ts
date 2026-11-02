/**
 * Regression tests for the one-time legacy migration.
 *
 * The guard used to be "copy the legacy ccflare.db whenever the target file
 * does not exist", which ignores WHY the target is absent. Pointing
 * `BETTER_CCFLARE_DB_PATH` at a fresh file — an isolated test instance, a
 * container, a new deployment — therefore silently copied an operator's old
 * database (accounts and stored tokens included) into it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrateFromCcflare } from "../migrate-from-ccflare";
import { getLegacyDbPath, resolveDbPath } from "../paths";

const ENV_KEYS = [
	"BETTER_CCFLARE_DB_PATH",
	"ccflare_DB_PATH",
	// Every config-directory input the platform branches read. Redirecting
	// only XDG_CONFIG_HOME would leave the Windows branches pointing at the
	// real home directory, so the assertions below would escape `root`.
	"XDG_CONFIG_HOME",
	"LOCALAPPDATA",
	"APPDATA",
] as const;

describe("migrateFromCcflare", () => {
	let root: string;
	let legacyDb: string;
	let targetDb: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) saved[key] = process.env[key];

		root = mkdtempSync(join(tmpdir(), "ccflare-legacy-"));
		// Point every platform's config root at the temp dir, so both the
		// Linux/macOS (XDG) and Windows (LOCALAPPDATA/APPDATA) branches of
		// getPlatformConfigDir()/getLegacyConfigDir() resolve inside `root`.
		process.env.XDG_CONFIG_HOME = root;
		process.env.LOCALAPPDATA = root;
		process.env.APPDATA = root;
		legacyDb = join(root, "ccflare", "ccflare.db");
		targetDb = join(root, "target", "better-ccflare.db");

		// Keep a pre-existing override out of the way; each test sets what it
		// needs.
		delete process.env.BETTER_CCFLARE_DB_PATH;
		delete process.env.ccflare_DB_PATH;
	}, 1);

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		rmSync(root, { recursive: true, force: true });
	});

	/** Create a legacy DB with recognisable content. */
	function seedLegacy(): void {
		rmSync(join(root, "ccflare"), { recursive: true, force: true });
		mkdirSync(join(root, "ccflare"), { recursive: true });
		writeFileSync(legacyDb, "legacy-database-contents");
	}

	it("does not import the legacy database when the target is explicitly set", () => {
		seedLegacy();
		process.env.BETTER_CCFLARE_DB_PATH = targetDb;

		// An explicit path is a deliberate choice of database; silently
		// importing old accounts into it is never what the caller wants.
		expect(migrateFromCcflare()).toBe(false);
		expect(existsSync(targetDb)).toBe(false);
	});

	it("does not import for the lowercase env var either", () => {
		seedLegacy();
		process.env.ccflare_DB_PATH = targetDb;

		expect(migrateFromCcflare()).toBe(false);
		expect(existsSync(targetDb)).toBe(false);
	});

	it("still imports for a default-path install with no target and no explicit setting", () => {
		seedLegacy();
		// No env override: the target resolves under the platform config dir,
		// which XDG_CONFIG_HOME points at for this test.
		const expected = resolveDbPath();
		expect(expected).toBe(join(root, "better-ccflare", "better-ccflare.db"));

		expect(migrateFromCcflare()).toBe(true);
		expect(existsSync(expected)).toBe(true);
	});

	it("never overwrites an existing default database", () => {
		seedLegacy();
		// No env override, so the explicit-path guard does NOT fire and the
		// existing-file check is the only thing protecting the target.
		const existing = resolveDbPath();
		mkdirSync(dirname(existing), { recursive: true });
		writeFileSync(existing, "existing");

		expect(migrateFromCcflare()).toBe(false);
		// Left untouched rather than overwritten by the legacy copy.
		expect(readFileSync(existing, "utf8")).toBe("existing");
	});

	it("never overwrites an existing database at an explicit path", () => {
		seedLegacy();
		process.env.BETTER_CCFLARE_DB_PATH = targetDb;
		mkdirSync(dirname(targetDb), { recursive: true });
		writeFileSync(targetDb, "existing");

		expect(migrateFromCcflare()).toBe(false);
		expect(readFileSync(targetDb, "utf8")).toBe("existing");
	});

	it("is a no-op when no legacy database exists", () => {
		expect(getLegacyDbPath()).toBe(legacyDb);
		expect(migrateFromCcflare()).toBe(false);
		expect(existsSync(targetDb)).toBe(false);
	});
});
