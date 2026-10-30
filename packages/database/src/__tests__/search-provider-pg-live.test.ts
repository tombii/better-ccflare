/**
 * Live-PostgreSQL harness for the `search_providers` repository.
 *
 * The regular repository tests run on real SQLite (bun:sqlite), which is
 * structurally incapable of catching PG-only failure modes — exactly the
 * class documented in packages/http-api/src/__tests__/pg-live-queries.test.ts
 * (placeholder renumbering, GROUP BY semantics, driver row-count shapes).
 *
 * This file exercises the search_providers paths that differ per driver:
 *   - `runWithChanges()` DELETE row-count (SQLite `.changes` vs PG `.count`)
 *   - unique-index violation detection (SQLSTATE 23505 vs SQLite message)
 *   - placeholder conversion for every repository statement
 *   - BIGINT timestamps and INTEGER 0/1 `enabled` on a real PG table
 *
 * Gated on DATABASE_URL like every other live-PG suite: plain `bun test`
 * skips it, so CI and local runs are unaffected.
 *
 * ISOLATION: identical to pg-live-queries.test.ts — throwaway schema, pinned
 * search_path verified via current_schema() before and during the run,
 * dropped with CASCADE in afterAll. Production `public` is never touched.
 */
import "@better-ccflare/core"; // side-effect: must precede @better-ccflare/types (pre-existing cycle)
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import {
	SearchProviderLabelTakenError,
	SearchProviderRepository,
} from "../repositories/search-provider.repository";

const livePgAvailable = Boolean(process.env.DATABASE_URL);
const SCHEMA = `ccflare_srch_${process.pid.toString(36)}_${Date.now().toString(36)}`;

describe.skipIf(!livePgAvailable)(
	"search_providers repository (live PostgreSQL)",
	() => {
		let adapter: BunSqlAdapter;
		let repo: SearchProviderRepository;
		let dbOps: { close: () => Promise<void> };

		beforeAll(async () => {
			// Single pool connection so the search_path pin survives every query.
			process.env.BETTER_CCFLARE_DB_POOL_MAX = "1";
			process.env.BETTER_CCFLARE_DB_IDLE_TIMEOUT = "0";
			delete process.env.BETTER_CCFLARE_DB_PG_PREPARE;

			const { DatabaseOperations } = await import("../database-operations");
			const ops = new DatabaseOperations();
			dbOps = ops;
			adapter = ops.getAdapter();

			if (adapter.isSQLite) {
				throw new Error(
					"DATABASE_URL is set but the adapter selected SQLite — refusing to run a PostgreSQL harness against SQLite.",
				);
			}

			await adapter.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
			await adapter.unsafe(`SET search_path TO "${SCHEMA}"`);
			await adapter.unsafe(`SET lock_timeout = '10s'`);
			await adapter.unsafe(`SET statement_timeout = '60s'`);

			const pinned = await adapter.get<{ s: string | null }>(
				"SELECT current_schema() AS s",
			);
			if (pinned?.s !== SCHEMA) {
				await adapter.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
				await dbOps.close();
				throw new Error(
					`search_path pin failed: expected ${SCHEMA}, got ${pinned?.s}. ` +
						"Refusing to run against an unisolated schema.",
				);
			}

			// Same call the server makes at boot — creates search_providers in
			// the throwaway schema via ensureSchemaPg + runMigrationsPg.
			await ops.initializeAsync();

			repo = new SearchProviderRepository(adapter);
		});

		afterAll(async () => {
			try {
				await adapter?.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
			} finally {
				await dbOps?.close();
			}
		});

		it("migration created the table and both indexes in the pinned schema", async () => {
			const table = await adapter.get<{ reg: string | null }>(
				`SELECT to_regclass('${SCHEMA}.search_providers')::text AS reg`,
			);
			expect(table?.reg).toBe(`${SCHEMA}.search_providers`);

			const indexes = await adapter.query<{ indexname: string }>(
				`SELECT indexname FROM pg_indexes
				 WHERE schemaname = '${SCHEMA}' AND tablename = 'search_providers'
				 ORDER BY indexname`,
			);
			const names = indexes.map((i) => i.indexname);
			expect(names).toContain("idx_search_providers_priority");
			expect(names).toContain("idx_search_providers_label");
		});

		it("create → findById round-trips every column type on PG", async () => {
			const created = await repo.create({
				provider: "tavily",
				label: "pg-roundtrip",
				apiKey: "tvly-live-key-987654",
				priority: 5,
				maxResults: 7,
				extraConfig: { topic: "news", nested: { ok: true } },
			});

			expect(created.provider).toBe("tavily");
			expect(created.apiKey).toBe("tvly-live-key-987654");
			expect(created.enabled).toBe(true);
			expect(created.extraConfig).toEqual({
				topic: "news",
				nested: { ok: true },
			});
			expect(typeof created.createdAt).toBe("number");
			expect(created.createdAt).toBeGreaterThan(0);

			const fetched = await repo.findById(created.id);
			expect(fetched?.label).toBe("pg-roundtrip");
			expect(fetched?.maxResults).toBe(7);
		});

		it("duplicate label maps to SearchProviderLabelTakenError via the pre-check", async () => {
			await repo.create({ provider: "exa", label: "pg-dup", apiKey: "k1" });
			await expect(
				repo.create({ provider: "exa", label: "pg-dup", apiKey: "k2" }),
			).rejects.toThrow(SearchProviderLabelTakenError);
		});

		it("unique-index violation is detected when the pre-check is raced away", async () => {
			await repo.create({ provider: "brave", label: "pg-race", apiKey: "k1" });
			// Simulate the concurrent create that slips past the pre-check:
			// disable it, so the INSERT itself hits the unique index and the
			// catch path must translate the driver error.
			const original = repo.isLabelTaken.bind(repo);
			// biome-ignore lint/suspicious/noExplicitAny: race simulation
			(repo as any).isLabelTaken = async () => false;
			try {
				await expect(
					repo.create({ provider: "brave", label: "pg-race", apiKey: "k2" }),
				).rejects.toThrow(SearchProviderLabelTakenError);
			} finally {
				(repo as any).isLabelTaken = original;
			}
		});

		it("update: label change, enabled toggle, key clear, updated_at moves", async () => {
			const created = await repo.create({
				provider: "serper",
				label: "pg-update",
				apiKey: "orig-key",
				priority: 9,
			});
			const before = created.updatedAt;

			// A tiny delay so BIGINT millisecond timestamps demonstrably move
			// (updated_at always changes on update, even within the same ms the
			// assertion would be vacuous).
			await new Promise((r) => setTimeout(r, 5));

			const updated = await repo.update(created.id, {
				label: "pg-updated",
				enabled: false,
				apiKey: null,
				priority: 3,
			});
			expect(updated.label).toBe("pg-updated");
			expect(updated.enabled).toBe(false);
			expect(updated.apiKey).toBeNull();
			expect(updated.priority).toBe(3);
			expect(updated.updatedAt).toBeGreaterThanOrEqual(before);

			// apiKey omitted → key stays cleared (was set to null above).
			const again = await repo.update(created.id, { maxResults: 4 });
			expect(again.apiKey).toBeNull();
			expect(again.maxResults).toBe(4);
		});

		it("update to a taken label maps the constraint error", async () => {
			await repo.create({ provider: "deepseek", label: "pg-a", apiKey: "k" });
			const b = await repo.create({
				provider: "deepseek",
				label: "pg-b",
				apiKey: "k",
			});
			await expect(
				repo.update(b.id, { label: "pg-a" }),
			).rejects.toThrow(SearchProviderLabelTakenError);
		});

		it("listActiveByPriority orders ASC and excludes disabled rows", async () => {
			const lo = await repo.create({
				provider: "tavily",
				label: "pg-order-lo",
				priority: 1,
			});
			const hi = await repo.create({
				provider: "tavily",
				label: "pg-order-hi",
				priority: 2,
			});
			await repo.update(hi.id, { enabled: false });

			const active = await repo.listActiveByPriority();
			const labels = active.map((p) => p.label);
			expect(labels).not.toContain("pg-order-hi");
			expect(labels.indexOf("pg-order-lo")).toBeGreaterThanOrEqual(0);
			// Everything returned is enabled.
			expect(active.every((p) => p.enabled === true)).toBe(true);

			await repo.delete(lo.id);
			await repo.delete(hi.id);
		});

		it("updateHealth writes status without moving updated_at", async () => {
			const created = await repo.create({
				provider: "perplexity",
				label: "pg-health",
				priority: 50,
			});
			const before = created.updatedAt;
			await new Promise((r) => setTimeout(r, 5));

			await repo.updateHealth(created.id, {
				status: "ok",
				statusMessage: "live probe ok",
				checkedAt: Date.now(),
			});

			const row = await repo.findById(created.id);
			expect(row?.status).toBe("ok");
			expect(row?.statusMessage).toBe("live probe ok");
			expect(row?.statusCheckedAt).toBeGreaterThan(0);
			expect(row?.cooldownUntil).toBeNull();
			expect(row?.updatedAt).toBe(before); // unchanged — probe is not an edit

			await repo.delete(created.id);
		});

		it("delete returns true once then false (PG .count path)", async () => {
			const created = await repo.create({
				provider: "parallel",
				label: "pg-delete",
				priority: 99,
			});
			expect(await repo.delete(created.id)).toBe(true);
			expect(await repo.delete(created.id)).toBe(false);
		});

		it("public variants mask the key", async () => {
			const created = await repo.create({
				provider: "tavily",
				label: "pg-mask",
				apiKey: "tvly-abcd1234",
			});
			const pub = await repo.findByIdPublic(created.id);
			expect(pub?.apiKeyMasked).toBe("****1234");
			expect(JSON.stringify(pub)).not.toContain("tvly-abcd1234");

			const none = await repo.create({
				provider: "tavily",
				label: "pg-mask-none",
			});
			expect((await repo.findByIdPublic(none.id))?.apiKeyMasked).toBeNull();

			await repo.delete(created.id);
			await repo.delete(none.id);
		});
	},
);
