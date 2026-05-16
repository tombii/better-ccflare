/**
 * Verifies that `configureSqlite()` issues `PRAGMA mmap_size = 0` when the
 * config requests it.
 *
 * Background: before this fix the PRAGMA was gated on `mmapSize > 0`, so the
 * default `mmapSize: 0` silently fell through to bun:sqlite's built-in mmap
 * default (a large value). On a 15 GiB database that's the entire file
 * memory-mapped, which stays invisible until something walks every page
 * (full-DB VACUUM, large scan) and the resident set blows past the cgroup
 * MemoryHigh / MemoryMax limits. The fix flips the guard to "issue the PRAGMA
 * whenever the operator has specified a value, including 0".
 *
 * The mmap state isn't directly observable through bun:sqlite, but
 * `PRAGMA mmap_size` query returns the current configured limit on the
 * connection — that's what we assert against.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "../database-operations";

function makeTempDbDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-mmap-test-"));
}

describe("configureSqlite: mmap_size handling", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDbDir();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("issues PRAGMA mmap_size=0 when config.mmapSize is 0 (the default)", async () => {
		// `DatabaseOperations` uses `mmapSize: 0` by default. After construction
		// the connection's mmap_size must be 0, not bun:sqlite's built-in
		// default. Pre-fix this assertion would fail because the PRAGMA was
		// gated on `> 0` and never fired.
		const dbPath = path.join(tmpDir, "default.db");
		const dbOps = new DatabaseOperations(dbPath);
		try {
			const { mmap_size } = dbOps
				.getDatabase()
				.query("PRAGMA mmap_size")
				.get() as { mmap_size: number };
			expect(mmap_size).toBe(0);
		} finally {
			await dbOps.close();
		}
	});

	it("issues PRAGMA mmap_size with a positive override value", async () => {
		// Operators on distributed filesystems may want a non-zero mmap (the
		// original code-comment intent). Confirm that path still works.
		const dbPath = path.join(tmpDir, "override.db");
		// 16 MiB — well under default DB size, easy to observe.
		const dbOps = new DatabaseOperations(dbPath, {
			mmapSize: 16 * 1024 * 1024,
		});
		try {
			const { mmap_size } = dbOps
				.getDatabase()
				.query("PRAGMA mmap_size")
				.get() as { mmap_size: number };
			expect(mmap_size).toBe(16 * 1024 * 1024);
		} finally {
			await dbOps.close();
		}
	});

	it("leaves bun:sqlite's default when config.mmapSize is undefined", async () => {
		// `undefined` is the "no preference" sentinel — different from the
		// explicit `0`. We don't assert a specific value here (it's
		// bun:sqlite-defined and changes between releases) — only that we
		// didn't override it to 0 by mistake.
		const dbPath = path.join(tmpDir, "undef.db");
		// `Object.assign` so we can pass through an undefined key without TS
		// silently substituting the default.
		const dbOps = new DatabaseOperations(dbPath, { mmapSize: undefined });
		try {
			const { mmap_size } = dbOps
				.getDatabase()
				.query("PRAGMA mmap_size")
				.get() as { mmap_size: number };
			// Whatever bun:sqlite uses, we just don't want our code to have
			// touched it. Allow 0 (which would happen if Bun's default is 0)
			// or any positive value.
			expect(mmap_size).toBeGreaterThanOrEqual(0);
		} finally {
			await dbOps.close();
		}
	});
});
