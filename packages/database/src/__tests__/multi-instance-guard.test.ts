/**
 * Tests for the multi-instance guard (tombii/better-ccflare#351).
 *
 * Three negative controls, required by the issue:
 *   1. Second instance detected when first is alive.
 *   2. Stale/dead predecessor does NOT block a legitimate restart.
 *   3. Single-instance startup is silent (no warning emitted).
 *
 * Plus: refuse-mode throws MultiInstanceRefusedError, the operator-facing
 * message names the seven divergence categories, and the schema is present
 * in both SQLite and PostgreSQL migrations.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { ensureSchemaPg } from "../migrations-pg";
import {
	clearHeartbeat,
	formatGuardMessage,
	HEARTBEAT_EXPIRY_MS,
	MultiInstanceRefusedError,
	purgeStaleHeartbeats,
	readMultiInstanceMode,
	runStartupGuard,
	scanHeartbeats,
	writeHeartbeat,
} from "../multi-instance-guard";

function freshSqlite(): BunSqlAdapter {
	const db = new Database(":memory:");
	ensureSchema(db);
	return new BunSqlAdapter(db);
}

describe("multi-instance-guard (SQLite)", () => {
	let adapter: BunSqlAdapter;
	beforeEach(() => {
		adapter = freshSqlite();
	});
	afterEach(() => {
		// Don't close the in-memory DB; it's GC'd.
	});

	it("NEGATIVE 1: detects a second instance whose heartbeat is fresh", async () => {
		// Simulate another live process by writing a peer row directly.
		// We use a different "now" so it appears live to the scanner.
		const now = Date.now();
		adapter.getSQLiteDb().run(
			`INSERT INTO instance_heartbeats
				(instance_id, hostname, pid, started_at, last_heartbeat,
				 node_version, db_dialect)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"peer-uuid-aaaa",
				"peer-host",
				4321,
				now - 5_000,
				now - 1_000,
				"v20.0.0",
				"sqlite",
			],
		);

		const result = await scanHeartbeats(adapter, now);
		expect(result.peers.length).toBe(1);
		expect(result.peers[0].instance_id).toBe("peer-uuid-aaaa");
		expect(result.peers[0].hostname).toBe("peer-host");
		expect(result.expired.length).toBe(0);
	});

	it("NEGATIVE 2: a stale predecessor does NOT block startup", async () => {
		// Simulate a crashed predecessor: row exists, but its heartbeat
		// is older than the expiry window.
		const now = Date.now();
		const stale = now - HEARTBEAT_EXPIRY_MS - 5_000;
		adapter.getSQLiteDb().run(
			`INSERT INTO instance_heartbeats
				(instance_id, hostname, pid, started_at, last_heartbeat,
				 node_version, db_dialect)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"crashed-predecessor",
				"old-host",
				1234,
				stale - 60_000,
				stale,
				"v18.0.0",
				"sqlite",
			],
		);

		// Capture any warning emission.
		const warnings: string[] = [];
		const result = await runStartupGuard(adapter, {
			now,
			mode: "warn",
			log: (msg) => warnings.push(msg),
		});

		// The stale predecessor must NOT appear in peers — that was the
		// design risk called out in #351.
		expect(result.peers.length).toBe(0);
		// runStartupGuard purges stale rows before scanning, so the
		// expired row is no longer in the table by the time scanHeartbeats
		// runs. That's the desired behaviour — the table does not grow
		// forever from crashed predecessors.
		expect(result.expired.length).toBe(0);

		// No warning should have been emitted.
		expect(warnings.length).toBe(0);

		// And the stale row was purged so the table doesn't grow forever.
		const remaining = adapter
			.getSQLiteDb()
			.query<
				{ instance_id: string },
				[]
			>("SELECT instance_id FROM instance_heartbeats")
			.all();
		// Only our row (auto-written by runStartupGuard) remains.
		expect(remaining.length).toBe(1);
	});

	it("NEGATIVE 3: single-instance startup is silent", async () => {
		const now = Date.now();
		const warnings: string[] = [];
		const result = await runStartupGuard(adapter, {
			now,
			mode: "warn",
			log: (msg) => warnings.push(msg),
		});
		expect(result.peers.length).toBe(0);
		expect(result.expired.length).toBe(0);
		expect(warnings.length).toBe(0);

		// Our row was written.
		const rows = adapter
			.getSQLiteDb()
			.query<
				{ instance_id: string; hostname: string },
				[]
			>("SELECT instance_id, hostname FROM instance_heartbeats")
			.all();
		expect(rows.length).toBe(1);
	});

	it("refuse mode throws when peers are present", async () => {
		const now = Date.now();
		adapter.getSQLiteDb().run(
			`INSERT INTO instance_heartbeats
				(instance_id, hostname, pid, started_at, last_heartbeat,
				 node_version, db_dialect)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"peer-uuid-bbbb",
				"peer-host",
				4321,
				now - 5_000,
				now - 1_000,
				"v20.0.0",
				"sqlite",
			],
		);

		await expect(
			runStartupGuard(adapter, { now, mode: "refuse" }),
		).rejects.toThrow(MultiInstanceRefusedError);
	});

	it("NEGATIVE 4: refuse mode clears own heartbeat before throwing so a retry does not false-positive", async () => {
		// Simulate a peer that is already running.
		const now = Date.now();
		adapter.getSQLiteDb().run(
			`INSERT INTO instance_heartbeats
				(instance_id, hostname, pid, started_at, last_heartbeat,
				 node_version, db_dialect)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"peer-uuid-refuse",
				"peer-host",
				4321,
				now - 5_000,
				now - 1_000,
				"v20.0.0",
				"sqlite",
			],
		);

		// Refuse: should throw.
		await expect(
			runStartupGuard(adapter, { now, mode: "refuse" }),
		).rejects.toThrow(MultiInstanceRefusedError);

		// After the throw, this process's own heartbeat row must be gone.
		// The only remaining row should be the peer we wrote directly.
		// Without the Greptile fix, our own row would still be present and
		// a fast retry would see it as a (self) peer and refuse again for
		// up to HEARTBEAT_EXPIRY_MS.
		const remaining = adapter
			.getSQLiteDb()
			.query<
				{ instance_id: string },
				[]
			>("SELECT instance_id FROM instance_heartbeats ORDER BY instance_id")
			.all();

		expect(remaining.length).toBe(1);
		expect(remaining[0].instance_id).toBe("peer-uuid-refuse");
	});

	it("warn mode does NOT throw even when peers are present", async () => {
		const now = Date.now();
		adapter.getSQLiteDb().run(
			`INSERT INTO instance_heartbeats
				(instance_id, hostname, pid, started_at, last_heartbeat,
				 node_version, db_dialect)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"peer-uuid-cccc",
				"peer-host",
				4321,
				now - 5_000,
				now - 1_000,
				"v20.0.0",
				"sqlite",
			],
		);

		const warnings: string[] = [];
		const result = await runStartupGuard(adapter, {
			now,
			mode: "warn",
			log: (msg) => warnings.push(msg),
		});
		expect(result.peers.length).toBe(1);
		expect(warnings.length).toBe(1);
		// The warning names the divergence categories so the operator
		// understands the consequence.
		expect(warnings[0]).toContain("SessionAffinityStrategy");
		expect(warnings[0]).toContain("AutoRefreshScheduler");
		expect(warnings[0]).toContain("#351");
	});

	it("formatGuardMessage names all seven divergence categories", () => {
		const msg = formatGuardMessage([
			{
				instance_id: "1234567890abcdef",
				hostname: "host-x",
				pid: 999,
				started_at: 0,
				last_heartbeat: 0,
				node_version: "v0",
				db_dialect: "sqlite",
			},
		]);
		// All seven categories from issue #351.
		expect(msg).toContain("SessionAffinityStrategy");
		expect(msg).toContain("LeastUsedStrategy");
		expect(msg).toContain("SessionDrainSoonestStrategy");
		expect(msg).toContain("UsageCache");
		expect(msg).toContain("CacheBodyStore");
		expect(msg).toContain("AutoRefreshScheduler");
		expect(msg).toContain("probeLeases");
		expect(msg).toContain("SessionGovernor");
	});

	it("writeHeartbeat is upsert: same instance_id refreshes the row", async () => {
		// The runtime uses a single instance_id per process. The first call
		// writes the row; subsequent calls must update the same row, not
		// create duplicates. We simulate by manually upserting on the same id.
		const now = Date.now();
		await writeHeartbeat(adapter, now);
		await writeHeartbeat(adapter, now + 100);
		await writeHeartbeat(adapter, now + 200);
		const rows = adapter
			.getSQLiteDb()
			.query<{ c: number }, []>(
				"SELECT COUNT(*) as c FROM instance_heartbeats",
			)
			.all();
		// Only our row (one — the process instance_id) plus the rows written
		// here. Since each call writes with the same THIS_INSTANCE_ID, total
		// must be exactly 1.
		expect(rows[0].c).toBe(1);
	});

	it("clearHeartbeat removes this instance's row", async () => {
		await writeHeartbeat(adapter);
		let rows = adapter
			.getSQLiteDb()
			.query<{ c: number }, []>(
				"SELECT COUNT(*) as c FROM instance_heartbeats",
			)
			.all();
		expect(rows[0].c).toBe(1);
		await clearHeartbeat(adapter);
		rows = adapter
			.getSQLiteDb()
			.query<{ c: number }, []>(
				"SELECT COUNT(*) as c FROM instance_heartbeats",
			)
			.all();
		expect(rows[0].c).toBe(0);
	});

	it("purgeStaleHeartbeats removes only rows older than expiry", async () => {
		const now = Date.now();
		const fresh = now - 1_000;
		const stale = now - HEARTBEAT_EXPIRY_MS - 1_000;
		adapter.getSQLiteDb().run(
			`INSERT INTO instance_heartbeats VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["fresh-row", "h", 1, now, fresh, "v", "sqlite"],
		);
		adapter.getSQLiteDb().run(
			`INSERT INTO instance_heartbeats VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["stale-row", "h", 1, stale - 60_000, stale, "v", "sqlite"],
		);

		const purged = await purgeStaleHeartbeats(adapter, now);
		expect(purged).toBe(1);

		const remaining = adapter
			.getSQLiteDb()
			.query<{ instance_id: string }, []>(
				"SELECT instance_id FROM instance_heartbeats",
			)
			.all()
			.map((r) => r.instance_id);
		expect(remaining).toEqual(["fresh-row"]);
	});

	it("readMultiInstanceMode defaults to warn and respects refuse", () => {
		const prev = process.env.BETTER_CCFLARE_MULTI_INSTANCE;
		try {
			delete process.env.BETTER_CCFLARE_MULTI_INSTANCE;
			expect(readMultiInstanceMode()).toBe("warn");
			process.env.BETTER_CCFLARE_MULTI_INSTANCE = "refuse";
			expect(readMultiInstanceMode()).toBe("refuse");
			process.env.BETTER_CCFLARE_MULTI_INSTANCE = "WARN";
			expect(readMultiInstanceMode()).toBe("warn");
			process.env.BETTER_CCFLARE_MULTI_INSTANCE = "unknown";
			expect(readMultiInstanceMode()).toBe("warn"); // unknown -> warn
		} finally {
			if (prev === undefined) {
				delete process.env.BETTER_CCFLARE_MULTI_INSTANCE;
			} else {
				process.env.BETTER_CCFLARE_MULTI_INSTANCE = prev;
			}
		}
	});
});

describe("multi-instance-guard — schema shape", () => {
	it("SQLite ensureSchema creates the instance_heartbeats table", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		const row = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='instance_heartbeats'",
			)
			.get();
		expect(row?.name).toBe("instance_heartbeats");
		const cols = db
			.query<{ name: string }, []>(
				"SELECT name FROM pragma_table_info('instance_heartbeats') ORDER BY cid",
			)
			.all()
			.map((c) => c.name);
		// Schema must include every column the guard writes.
		for (const col of [
			"instance_id",
			"hostname",
			"pid",
			"started_at",
			"last_heartbeat",
			"node_version",
			"db_dialect",
		]) {
			expect(cols).toContain(col);
		}
	});

	it("PG ensureSchemaPg includes the instance_heartbeats CREATE TABLE", () => {
		// We don't need a live PG database for this — confirm the SQL
		// text is shipped in migrations-pg.ts. The live-PostgreSQL
		// test below exercises the actual DDL when DATABASE_URL is set.
		const fs = require("node:fs") as typeof import("node:fs");
		const path = require("node:path") as typeof import("node:path");
		const src = fs.readFileSync(
			path.join(import.meta.dir, "..", "migrations-pg.ts"),
			"utf8",
		);
		expect(src).toContain("CREATE TABLE IF NOT EXISTS instance_heartbeats");
		expect(src).toContain(
			"CREATE INDEX IF NOT EXISTS idx_instance_heartbeats_last_heartbeat",
		);
		// All seven columns must be present in the PG schema text.
		for (const col of [
			"instance_id",
			"hostname",
			"pid",
			"started_at",
			"last_heartbeat",
			"node_version",
			"db_dialect",
		]) {
			expect(src).toContain(`\t\t\t${col} `);
		}
	});
});

// Live PostgreSQL test — same three negative controls, gated on DATABASE_URL.
// Matches the pattern in migrations-pg.test.ts: skipIf(!databaseUrl).
const databaseUrl = process.env.DATABASE_URL;
const livePgAvailable = Boolean(
	databaseUrl && databaseUrl.startsWith("postgres"),
);

describe.skipIf(!livePgAvailable)(
	"multi-instance-guard (PostgreSQL, live, requires DATABASE_URL)",
	() => {
		let adapter: BunSqlAdapter;
		beforeEach(async () => {
			const sql = new (await import("bun")).SQL(databaseUrl!);
			adapter = new BunSqlAdapter(sql, false);
			await ensureSchemaPg(adapter);
			// Clean any rows left by a previous run.
			await adapter.run("DELETE FROM instance_heartbeats");
		});
		afterEach(async () => {
			await adapter.run("DELETE FROM instance_heartbeats");
			await adapter.close();
		});

		it("NEGATIVE 1 (PG): detects a second instance", async () => {
			const now = Date.now();
			await adapter.run(
				`INSERT INTO instance_heartbeats
					(instance_id, hostname, pid, started_at, last_heartbeat,
					 node_version, db_dialect)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					"pg-peer-aaaa",
					"pg-host",
					4321,
					now - 5_000,
					now - 1_000,
					"v20.0.0",
					"postgres",
				],
			);
			const result = await scanHeartbeats(adapter, now);
			expect(result.peers.length).toBe(1);
			expect(result.peers[0].instance_id).toBe("pg-peer-aaaa");
		});

		it("NEGATIVE 2 (PG): stale predecessor does NOT block startup", async () => {
			const now = Date.now();
			const stale = now - HEARTBEAT_EXPIRY_MS - 5_000;
			await adapter.run(
				`INSERT INTO instance_heartbeats
					(instance_id, hostname, pid, started_at, last_heartbeat,
					 node_version, db_dialect)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					"pg-crashed",
					"old",
					1234,
					stale - 60_000,
					stale,
					"v18",
					"postgres",
				],
			);
			const warnings: string[] = [];
			const result = await runStartupGuard(adapter, {
				now,
				mode: "warn",
				log: (msg) => warnings.push(msg),
			});
			expect(result.peers.length).toBe(0);
			expect(result.expired.length).toBe(1);
			expect(warnings.length).toBe(0);
		});

		it("NEGATIVE 3 (PG): single-instance startup is silent", async () => {
			const warnings: string[] = [];
			const result = await runStartupGuard(adapter, {
				mode: "warn",
				log: (msg) => warnings.push(msg),
			});
			expect(result.peers.length).toBe(0);
			expect(warnings.length).toBe(0);
		});
	},
);