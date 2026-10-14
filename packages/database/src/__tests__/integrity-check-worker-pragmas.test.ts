/**
 * Verifies that `integrity-check-worker.ts` puts its own connection into the
 * same low-memory mode as `vacuum-worker.ts` (`mmap_size = 0`,
 * `cache_size = -2000`, `temp_store = FILE`) before running a check.
 *
 * The worker opens a fresh `bun:sqlite` handle, so the main connection's
 * `configureSqlite` PRAGMAs don't apply to it. Without these settings the
 * handle falls back to bun:sqlite's built-in mmap default, and a
 * `quick_check` / `integrity_check` (which reads every page) maps most of a
 * multi-GB file into the process — enough to OOM a memory-limited container.
 *
 * Two layers:
 *  - in-process: load the worker module on the main thread, spy on
 *    `Database.prototype.exec`, dispatch a message to its `onmessage`
 *    handler and assert the PRAGMAs were issued before the check ran.
 *  - real worker: spawn the worker file and check `quick` and `full` still
 *    report `ok` on a healthy WAL-mode DB, i.e. the PRAGMAs are accepted on
 *    a `readonly` handle.
 */
import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	spyOn,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	IntegrityCheckKind,
	IntegrityCheckRequest,
	IntegrityCheckResult,
} from "../integrity-check-worker";

const LOW_MEMORY_PRAGMAS = [
	"PRAGMA mmap_size = 0",
	"PRAGMA cache_size = -2000",
	"PRAGMA temp_store = FILE",
];

function seedDb(dbPath: string): void {
	const db = new Database(dbPath, { create: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
	db.exec("CREATE INDEX idx_items_name ON items(name)");
	const insert = db.prepare("INSERT INTO items (name) VALUES (?)");
	for (let i = 0; i < 100; i++) insert.run(`item-${i}`);
	db.close();
}

function runRealWorker(
	dbPath: string,
	kind: IntegrityCheckKind,
): Promise<IntegrityCheckResult> {
	const worker = new Worker(
		new URL("../integrity-check-worker.ts", import.meta.url).href,
	);
	return new Promise<IntegrityCheckResult>((resolve, reject) => {
		worker.onmessage = (event: MessageEvent) => resolve(event.data);
		worker.onerror = (event: ErrorEvent) =>
			reject(new Error(event.message ?? "integrity worker error"));
		worker.postMessage({
			dbPath,
			busyTimeoutMs: 1000,
			kind,
		} satisfies IntegrityCheckRequest);
	}).finally(() => worker.terminate());
}

describe("integrity-check worker: low-memory PRAGMAs", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-integrity-mem-"));
		dbPath = path.join(tmpDir, "test.db");
		seedDb(dbPath);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("in-process handler", () => {
		let execSpy: Mock<(sql: string) => unknown>;
		let querySpy: Mock<(sql: string) => unknown>;
		let originalOnMessage: typeof globalThis.onmessage;
		let originalPostMessage: typeof globalThis.postMessage;
		let posted: IntegrityCheckResult[];
		let calls: string[];

		beforeEach(async () => {
			calls = [];
			posted = [];
			const realExec = Database.prototype.exec;
			const realQuery = Database.prototype.query;
			execSpy = spyOn(Database.prototype, "exec").mockImplementation(function (
				this: Database,
				sql: string,
				...rest: unknown[]
			) {
				calls.push(sql);
				// biome-ignore lint/suspicious/noExplicitAny: forwarding to the real method
				return (realExec as any).call(this, sql, ...rest);
			}) as unknown as Mock<(sql: string) => unknown>;
			querySpy = spyOn(Database.prototype, "query").mockImplementation(
				function (this: Database, sql: string) {
					calls.push(sql);
					return realQuery.call(this, sql);
				},
			) as unknown as Mock<(sql: string) => unknown>;

			originalOnMessage = globalThis.onmessage;
			originalPostMessage = globalThis.postMessage;
			globalThis.postMessage = ((msg: IntegrityCheckResult) => {
				posted.push(msg);
			}) as typeof globalThis.postMessage;
			// Importing the worker installs its handler on `self.onmessage`
			// (== globalThis on the main thread). Re-import with a cache-busting
			// query so each test gets a fresh assignment.
			await import(`../integrity-check-worker.ts?t=${Date.now()}`);
		});

		afterEach(() => {
			execSpy.mockRestore();
			querySpy.mockRestore();
			globalThis.onmessage = originalOnMessage;
			globalThis.postMessage = originalPostMessage;
		});

		for (const kind of ["quick", "full"] as const) {
			it(`issues the PRAGMAs before the ${kind} check`, () => {
				const handler = globalThis.onmessage as unknown as (
					event: MessageEvent<IntegrityCheckRequest>,
				) => void;
				handler({
					data: { dbPath, busyTimeoutMs: 1000, kind },
				} as MessageEvent<IntegrityCheckRequest>);

				expect(posted).toEqual([{ ok: true }]);

				const checkPragma =
					kind === "quick" ? "PRAGMA quick_check" : "PRAGMA integrity_check";
				const checkIdx = calls.indexOf(checkPragma);
				expect(checkIdx).toBeGreaterThan(-1);
				for (const pragma of LOW_MEMORY_PRAGMAS) {
					const idx = calls.indexOf(pragma);
					expect(idx).toBeGreaterThan(-1);
					expect(idx).toBeLessThan(checkIdx);
				}
			});
		}
	});

	describe("real worker", () => {
		it("quick check still passes on a healthy DB", async () => {
			expect(await runRealWorker(dbPath, "quick")).toEqual({ ok: true });
		});

		it("full check still passes on a healthy DB", async () => {
			expect(await runRealWorker(dbPath, "full")).toEqual({ ok: true });
		});
	});
});
