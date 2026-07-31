/**
 * PostgreSQL query harness — executes the real repository and handler queries
 * against a live PostgreSQL server.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A change that was green on the full 774-test suite returned HTTP 500 on the
 * PostgreSQL-backed instance for GET /api/stats:
 *
 *   column "requests.account_used" must appear in the GROUP BY clause
 *   or be used in an aggregate function          (SQLSTATE 42803)
 *
 * The query repeated the same expression — COALESCE(account_used, ?) — in both
 * SELECT and GROUP BY. BunSqlAdapter.convertPlaceholders() renumbers every bare
 * `?` sequentially and independently, so the two occurrences rendered as
 * COALESCE(..., $1) and COALESCE(..., $N). PostgreSQL compares GROUP BY entries
 * to select-list entries by parse tree, saw two different nodes, and rejected
 * the statement. SQLite enforces neither the functional-dependency rule nor
 * parameter typing, so it accepted every form.
 *
 * The suite could not have caught this: before this file, the repo had zero
 * PostgreSQL coverage of any repository or handler *query*. Only migrations
 * touched the PG path (see migrations-pg.test.ts). Every query test ran on
 * SQLite, which is structurally incapable of catching this defect class.
 *
 * WHAT THIS FILE COVERS
 * ---------------------
 * 1. A static block that always runs (no server needed) and fails if the
 *    dialect-hazard shapes reappear anywhere in packages/http-api or
 *    packages/database source: a placeholder inside GROUP BY, a bind parameter
 *    on the left of IN, a `?` inside a `--` SQL comment, or a jsonb `?|`/`?&`
 *    operator that convertPlaceholders would mangle.
 * 2. A live block, gated on DATABASE_URL exactly like migrations-pg.test.ts,
 *    which runs the real StatsRepository / DatabaseOperations / handler code
 *    against a real server inside a throwaway schema.
 *
 * HOW TO RUN
 * ----------
 *   # static gates only (this is what plain `bun test` does today)
 *   bun test packages/http-api/src/__tests__/pg-live-queries.test.ts
 *
 *   # full harness against a real server
 *   DATABASE_URL=postgres://user:pass@host:5432/db \
 *     bun test packages/http-api/src/__tests__/pg-live-queries.test.ts
 *
 * ISOLATION
 * ---------
 * migrations-pg.test.ts runs against the target database's default search_path
 * and never cleans up. That is tolerable for a migration smoke test and not
 * tolerable here, because these tests seed rows and assert exact counts. This
 * harness therefore creates a throwaway schema, pins the connection to it, and
 * drops it in afterAll. The pin is verified with current_schema() before any
 * migration runs and again before every test — if the pool ever hands back an
 * unpinned connection the harness fails loudly rather than writing into the
 * target database's public schema.
 *
 * The pin relies on the pool being a single connection, so the harness forces
 * BETTER_CCFLARE_DB_POOL_MAX=1 before constructing DatabaseOperations.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
// Side-effect import: load @better-ccflare/core before @better-ccflare/types.
// types/agent.ts runtime-imports core while core/strategy.ts imports types, a
// pre-existing cycle that crashes when types is the first module evaluated.
import "@better-ccflare/core";
import type { Config } from "@better-ccflare/config";
import type { BunSqlAdapter, DatabaseOperations } from "@better-ccflare/database";
import { NO_ACCOUNT_ID } from "@better-ccflare/types";
import { createAnalyticsHandler } from "../handlers/analytics";
import {
	createCombosListHandler,
	createFamiliesListHandler,
} from "../handlers/combos";
import {
	createAnomalyInsightsHandler,
	createCacheInsightsHandler,
	createContextInsightsHandler,
} from "../handlers/insights";
import { createCleanupHandler } from "../handlers/maintenance";
import {
	createRequestPayloadHandler,
	createRequestsDetailHandler,
	createRequestsSummaryHandler,
} from "../handlers/requests";
import { createStatsHandler, createStatsResetHandler } from "../handlers/stats";
import { createUsageHistoryHandler } from "../handlers/usage-history";
import { AlertService } from "../services/alerts";
import type { APIContext } from "../types";

// ---------------------------------------------------------------------------
// Static dialect-hazard gates — always run, no server required.
//
// These are the regression gates for the shapes that broke production. They
// scan real source text rather than asserting on a single hand-picked query,
// so a *new* query with the same shape fails the gate too. That is the point:
// the defect class is what recurs, not the individual statement.
// ---------------------------------------------------------------------------

const HTTP_API_SRC = `${import.meta.dir}/..`;
const DATABASE_SRC = `${import.meta.dir}/../../../database/src`;

interface SourceFile {
	path: string;
	text: string;
}

/** Read every non-test .ts file under the two packages that own SQL. */
async function collectSqlSources(): Promise<SourceFile[]> {
	const files: SourceFile[] = [];
	for (const root of [HTTP_API_SRC, DATABASE_SRC]) {
		const glob = new Bun.Glob("**/*.ts");
		for await (const rel of glob.scan({ cwd: root })) {
			if (rel.includes("__tests__")) continue;
			if (rel.endsWith(".test.ts")) continue;
			const abs = `${root}/${rel}`;
			files.push({ path: abs, text: await Bun.file(abs).text() });
		}
	}
	return files;
}

/**
 * Remove the parts of a TypeScript line that legitimately contain `?` but are
 * not SQL bind placeholders: JSDoc continuations, `//` comments, `${...}`
 * template interpolations (which hold TS ternaries), `??` and `?.`.
 *
 * Interpolated fragments are dropped rather than inspected because they are
 * built elsewhere — buildRequestFilters is itself scanned, so a placeholder
 * hazard inside a fragment is caught at the site that emits it.
 */
function stripNonSql(line: string): string {
	return line
		.replace(/^\s*\*.*$/, "")
		.replace(/\/\/.*$/, "")
		.replace(/\$\{[^}]*\}/g, "")
		.replace(/\?\?/g, "")
		.replace(/\?\./g, "");
}

/** Report `path:line — text` for every line matching `re`. */
function offendingLines(
	files: SourceFile[],
	re: RegExp,
	{ raw = false }: { raw?: boolean } = {},
): string[] {
	const hits: string[] = [];
	for (const file of files) {
		const lines = file.text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const subject = raw ? lines[i] : stripNonSql(lines[i]);
			if (re.test(subject)) {
				hits.push(`${file.path}:${i + 1} — ${lines[i].trim()}`);
			}
		}
	}
	return hits;
}

describe("SQL dialect hazards (static, always runs)", () => {
	let sources: SourceFile[];

	beforeAll(async () => {
		sources = await collectSqlSources();
	});

	it("scans a non-empty set of source files", () => {
		// Guards the gate itself: a broken glob would make every check below
		// pass vacuously, which is exactly the silent-skip failure mode that
		// let the original defect through.
		expect(sources.length).toBeGreaterThan(20);
		expect(sources.some((f) => f.path.endsWith("stats.repository.ts"))).toBe(
			true,
		);
		expect(sources.some((f) => f.path.endsWith("query-filters.ts"))).toBe(true);
	});

	it("no GROUP BY clause contains a bind placeholder", () => {
		// PostgreSQL matches GROUP BY entries against select-list entries by
		// parse tree. convertPlaceholders() gives each bare `?` its own $N, so
		// the same source expression becomes two different trees and PG raises
		// SQLSTATE 42803. Use an output-column ordinal (GROUP BY 1) or a
		// literal instead. This is the exact shape that 500'd /api/stats.
		const hits = offendingLines(sources, /\bGROUP\s+BY\b[^\n]*\?/i);
		expect(hits).toEqual([]);
	});

	it("no bind placeholder appears on the left of IN", () => {
		// `? IN (...)` leaves the operand untyped; PostgreSQL can reject it at
		// Parse time with SQLSTATE 42P18 ("could not determine data type of
		// parameter"). SQLite's lack of parameter typing hides it. Branch in
		// TypeScript instead — see buildRequestFilters.
		const hits = offendingLines(sources, /\?\s*IN\s*\(/i);
		expect(hits).toEqual([]);
	});

	it("no SQL line comment contains a `?`", () => {
		// convertPlaceholders() only skips single-quoted string literals. A `?`
		// inside a `--` comment is renumbered like a real placeholder and
		// silently shifts every following $N by one. Matched on the raw line:
		// an SQL comment lives inside a template literal, not a TS comment.
		const hits = offendingLines(sources, /^\s*--\s[^\n]*\?/, { raw: true });
		expect(hits).toEqual([]);
	});

	it("no jsonb existence operator is used", () => {
		// PostgreSQL's `?`, `?|` and `?&` jsonb operators are destroyed by
		// convertPlaceholders(). Use jsonb_exists()/jsonb_exists_any() if this
		// is ever needed.
		const hits = offendingLines(sources, /\?\||\?&/);
		expect(hits).toEqual([]);
	});

	it("does not mix `?` and `?N` placeholder styles in one statement", () => {
		// The bare-`?` counter is independent of the `?N` literals, so mixing
		// them produces colliding $N and a parameter silently reads another
		// parameter's value. Flag any `?N` usage at all — no call site needs it.
		const hits = offendingLines(sources, /\?\d+/);
		expect(hits).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Live PostgreSQL query harness — only runs when a real PG server is reachable.
// Gate copied verbatim from packages/database/src/migrations-pg.test.ts.
// ---------------------------------------------------------------------------

function hasLivePg(): boolean {
	const url = process.env.DATABASE_URL;
	return (
		!!url && (url.startsWith("postgres://") || url.startsWith("postgresql://"))
	);
}

const livePgAvailable = hasLivePg();

/** Throwaway schema, unique per process so parallel runs cannot collide. */
const SCHEMA = `ccflare_pgq_${process.pid.toString(36)}_${Date.now().toString(36)}`;

/** Every table ensureSchemaPg()/runMigrationsPg() create, for TRUNCATE. */
const ALL_TABLES = [
	"requests",
	"request_payloads",
	"accounts",
	"alerts",
	"api_keys",
	"combos",
	"combo_slots",
	"combo_family_assignments",
	"agent_preferences",
	"oauth_sessions",
	"strategies",
	"usage_snapshots",
	"model_translations",
];

describe.skipIf(!livePgAvailable)(
	"PostgreSQL queries (live, requires DATABASE_URL)",
	() => {
		let dbOps: DatabaseOperations;
		let adapter: BunSqlAdapter;
		let context: APIContext;
		let config: Config;

		const now = Date.now();
		const HOUR = 60 * 60 * 1000;

		// Per-test timeout for the live half. The default bun timeout (5s) is
		// too short for a fresh-schema bootstrap followed by an INSERT/UPDATE/
		// SELECT cycle over a network; a hand-set budget makes plain
		// `bun test …` runnable without `--timeout` and prevents a stuck
		// statement from outlasting the harness's own runtime.
		const LIVE_TIMEOUT_MS = 30_000;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const liveIt = (name: string, fn: any): void => {
			// The `it` import was renamed to `liveIt` by the sed pass that
			// wrapped every live-block call site; reach for the real symbol
			// via the alias we keep on globalThis below.
			bunTestIt(name, fn, LIVE_TIMEOUT_MS);
		};
		// Preserve the real `it` reference under a stable name so the wrapper
		// above can call it without recursing into itself.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const bunTestIt = (it as any) as (
			name: string,
			fn: any,
			timeoutMs?: number,
		) => void;

		beforeAll(async () => {
			// Pin the pool to a single backend connection so `SET search_path`
			// persists for the whole run. Without this the pool can hand back a
			// fresh, unpinned connection and the harness would write into the
			// target database's public schema.
			process.env.BETTER_CCFLARE_DB_POOL_MAX = "1";
			process.env.BETTER_CCFLARE_DB_IDLE_TIMEOUT = "0";
			delete process.env.BETTER_CCFLARE_DB_PG_PREPARE;

			const { DatabaseOperations: DbOps } = await import(
				"@better-ccflare/database"
			);
			dbOps = new DbOps();
			adapter = dbOps.getAdapter();

			if (adapter.isSQLite) {
				throw new Error(
					"DATABASE_URL is set but DatabaseOperations selected SQLite — refusing to run a PostgreSQL harness against SQLite.",
				);
			}

			await adapter.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
			await adapter.unsafe(`SET search_path TO "${SCHEMA}"`);
			// Bound the wait time on any lock a later statement might trip over
			// (TRUNCATE on rows held by an open transaction, a metadata lock
			// from a half-finished migration). Without this a stuck hook can
			// outlast the harness's own timeout.
			await adapter.unsafe(`SET lock_timeout = '10s'`);
			await adapter.unsafe(`SET statement_timeout = '60s'`);

			const pinned = await adapter.get<{ s: string | null }>(
				"SELECT current_schema() AS s",
			);
			if (pinned?.s !== SCHEMA) {
				// Fail loud rather than silently migrating the caller's real
				// schema. Drop what we created before giving up.
				await adapter.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
				await dbOps.close();
				throw new Error(
					`search_path pin failed: expected ${SCHEMA}, got ${pinned?.s}. ` +
						"Refusing to run against an unisolated schema.",
				);
			}

			// Real schema + migrations, the same call the server makes at boot.
			await dbOps.initializeAsync();

			config = {
				getRequestRetentionDays: () => 30,
				getDataRetentionDays: () => 7,
				getStorePayloads: () => true,
			} as unknown as Config;

			// AlertService touches no external state until start() is called,
			// so the config stub above is sufficient for its SQL surface.
			const alertService = new AlertService(adapter, config);

			context = {
				db: adapter,
				config,
				dbOps,
				alertService,
			} as unknown as APIContext;
		});

		afterAll(async () => {
			if (!adapter) return;
			// The schema drop is best-effort. If the pool is already wedged the
			// DROP can wait indefinitely, which would hang afterAll for far
			// longer than the harness's own timeout. Skip the schema drop on
			// any error and rely on close() to release the connection — the
			// throwaway schema is harmless to leave behind for one run.
			try {
				await adapter.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
			} catch {
				// swallow
			}
			try {
				await dbOps.close();
			} catch {
				// swallow
			}
		});

		beforeEach(async () => {
			// Re-verify the pin every test: a mid-run reconnect would silently
			// move writes to the default search_path.
			const pinned = await adapter.get<{ s: string | null }>(
				"SELECT current_schema() AS s",
			);
			expect(pinned?.s).toBe(SCHEMA);

			await adapter.unsafe(
				`TRUNCATE TABLE ${ALL_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
			);
		});

		// -------------------------------------------------------------------
		// Seed helpers. Raw INSERTs because the production write paths derive
		// their own timestamps and these tests need controlled time windows.
		// The queries under test are always the real ones.
		// -------------------------------------------------------------------

		async function seedAccount(row: {
			id: string;
			name: string;
			provider?: string;
			requestCount?: number;
			totalRequests?: number;
			sessionStart?: number | null;
			rateLimitedUntil?: number | null;
			paused?: number;
		}): Promise<void> {
			await adapter.run(
				`INSERT INTO accounts
					(id, name, provider, created_at, request_count, total_requests,
					 session_start, rate_limited_until, paused)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					row.id,
					row.name,
					row.provider ?? "anthropic",
					now,
					row.requestCount ?? 0,
					row.totalRequests ?? 0,
					row.sessionStart ?? null,
					row.rateLimitedUntil ?? null,
					row.paused ?? 0,
				],
			);
		}

		async function seedRequest(row: {
			id: string;
			timestamp: number;
			accountUsed: string | null;
			success: boolean;
			model?: string | null;
			errorMessage?: string | null;
			statusCode?: number | null;
			apiKeyId?: string | null;
			apiKeyName?: string | null;
			project?: string | null;
			billingType?: string;
			costUsd?: number;
			inputTokens?: number;
			outputTokens?: number;
			cacheReadInputTokens?: number;
			cacheCreationInputTokens?: number;
			responseTimeMs?: number;
		}): Promise<void> {
			await adapter.run(
				`INSERT INTO requests
					(id, timestamp, method, path, account_used, status_code, success,
					 error_message, response_time_ms, failover_attempts, model,
					 total_tokens, cost_usd, input_tokens, output_tokens,
					 cache_read_input_tokens, cache_creation_input_tokens,
					 api_key_id, api_key_name, project, billing_type)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					row.id,
					row.timestamp,
					"POST",
					"/v1/messages",
					row.accountUsed,
					row.statusCode ?? (row.success ? 200 : 500),
					row.success,
					row.errorMessage ?? null,
					row.responseTimeMs ?? 100,
					0,
					row.model ?? "claude-sonnet-4",
					(row.inputTokens ?? 10) + (row.outputTokens ?? 5),
					row.costUsd ?? 0.01,
					row.inputTokens ?? 10,
					row.outputTokens ?? 5,
					row.cacheReadInputTokens ?? 0,
					row.cacheCreationInputTokens ?? 0,
					row.apiKeyId ?? null,
					row.apiKeyName ?? null,
					row.project ?? null,
					row.billingType ?? "api",
				],
			);
		}

		/**
		 * A representative dataset: one real account, one NULL-account row set,
		 * and legacy literal 'no_account' rows. This is the exact data shape
		 * that produced the production 500.
		 */
		async function seedBaseline(): Promise<void> {
			await seedAccount({
				id: "acct-1",
				name: "primary",
				requestCount: 2,
				totalRequests: 42,
				sessionStart: now - 2 * HOUR,
			});
			await seedAccount({ id: "acct-2", name: "secondary", requestCount: 0 });

			await seedRequest({
				id: "r-real-ok",
				timestamp: now - HOUR,
				accountUsed: "acct-1",
				success: true,
			});
			await seedRequest({
				id: "r-real-err",
				timestamp: now - HOUR,
				accountUsed: "acct-1",
				success: false,
				errorMessage: "upstream 529",
				statusCode: 529,
			});
			// NULL encoding (current)
			await seedRequest({
				id: "r-null-1",
				timestamp: now - HOUR,
				accountUsed: null,
				success: true,
			});
			await seedRequest({
				id: "r-null-2",
				timestamp: now - HOUR,
				accountUsed: null,
				success: true,
			});
			await seedRequest({
				id: "r-null-3",
				timestamp: now - HOUR,
				accountUsed: null,
				success: false,
				errorMessage: "no account available",
				statusCode: 503,
			});
			// Legacy literal encoding (pre-NULL)
			await seedRequest({
				id: "r-legacy-1",
				timestamp: now - HOUR,
				accountUsed: NO_ACCOUNT_ID,
				success: true,
			});
		}

		async function readJson(res: Response): Promise<unknown> {
			expect(res.status).toBe(200);
			return res.json();
		}

		// -------------------------------------------------------------------
		// 1. The regression. This is the commit litmus for 33ef2be9: revert the
		//    GROUP BY collapse and PostgreSQL raises 42803 here.
		// -------------------------------------------------------------------

		describe("StatsRepository.getAccountStats — the /api/stats 500", () => {
			liveIt("executes on PostgreSQL and buckets NULL account_used under NO_ACCOUNT_ID", async () => {
				await seedBaseline();

				const stats = await dbOps.getStatsRepository().getAccountStats(10, true);

				const noAccount = stats.find((r) => r.name === NO_ACCOUNT_ID);
				expect(noAccount).toBeDefined();
				// 3 NULL rows + 1 legacy literal row collapse into one bucket
				expect(noAccount?.requestCount).toBe(4);
				// 3 of 4 succeeded
				expect(noAccount?.successRate).toBe(75);

				const real = stats.find((r) => r.name === "primary");
				expect(real?.requestCount).toBe(2);
				expect(real?.successRate).toBe(50);
			});

			liveIt("executes on PostgreSQL with includeUnauthenticated = false", async () => {
				await seedBaseline();
				const stats = await dbOps
					.getStatsRepository()
					.getAccountStats(10, false);
				expect(stats.map((s) => s.name)).toContain("primary");
				expect(stats.map((s) => s.name)).not.toContain(NO_ACCOUNT_ID);
			});

			liveIt("returns an empty array on PostgreSQL when there are no requests", async () => {
				const stats = await dbOps.getStatsRepository().getAccountStats(10, true);
				expect(stats).toEqual([]);
			});
		});

		// -------------------------------------------------------------------
		// 2. Every other StatsRepository query. getRecentErrorGroups repeats
		//    COALESCE(r.account_used, ?) across three window PARTITION BY
		//    clauses — the same renumbering mechanism, one step from the same
		//    failure.
		// -------------------------------------------------------------------

		describe("StatsRepository — remaining queries", () => {
			liveIt("getAggregatedStats executes and aggregates", async () => {
				await seedBaseline();
				const agg = await dbOps
					.getStatsRepository()
					.getAggregatedStats(now - 24 * HOUR);
				expect(agg.totalRequests).toBe(6);
				expect(agg.successfulRequests).toBe(4);
				expect(agg.totalTokens).toBeGreaterThan(0);
				expect(Number.isFinite(agg.totalCostUsd)).toBe(true);
			});

			liveIt("getActiveAccountCount executes", async () => {
				await seedBaseline();
				expect(await dbOps.getStatsRepository().getActiveAccountCount()).toBe(1);
			});

			liveIt("getRecentErrorGroups executes with three PARTITION BY placeholders", async () => {
				await seedBaseline();
				const groups = await dbOps
					.getStatsRepository()
					.getRecentErrorGroups(now - 24 * HOUR, 10);
				const messages = groups.map((g) => g.errorCode);
				expect(messages).toContain("upstream 529");
				expect(messages).toContain("no account available");
			});

			liveIt("getRecentErrorGroups collapses same-error unattributed rows into one group", async () => {
				await seedRequest({
					id: "e-null-1",
					timestamp: now - HOUR,
					accountUsed: null,
					success: false,
					errorMessage: "same error",
				});
				await seedRequest({
					id: "e-null-2",
					timestamp: now - HOUR + 1,
					accountUsed: null,
					success: false,
					errorMessage: "same error",
				});
				await seedRequest({
					id: "e-legacy-1",
					timestamp: now - HOUR + 2,
					accountUsed: NO_ACCOUNT_ID,
					success: false,
					errorMessage: "same error",
				});

				const groups = await dbOps
					.getStatsRepository()
					.getRecentErrorGroups(now - 24 * HOUR, 10);
				const group = groups.filter((g) => g.errorCode === "same error");
				expect(group).toHaveLength(1);
				expect(group[0].occurrenceCount).toBe(3);
			});

			liveIt("getTopModels executes (ROUND(CAST(... AS NUMERIC)) is dialect-sensitive)", async () => {
				await seedBaseline();
				const models = await dbOps.getStatsRepository().getTopModels(5);
				expect(models.length).toBeGreaterThan(0);
				expect(models[0].model).toBe("claude-sonnet-4");
				expect(Number.isFinite(models[0].percentage)).toBe(true);
			});

			liveIt("getApiKeyStats executes with a dynamic IN placeholder list", async () => {
				await seedRequest({
					id: "k-1",
					timestamp: now - HOUR,
					accountUsed: "acct-1",
					success: true,
					apiKeyId: "key-1",
					apiKeyName: "ci",
				});
				await seedRequest({
					id: "k-2",
					timestamp: now - HOUR,
					accountUsed: "acct-1",
					success: false,
					apiKeyId: "key-1",
					apiKeyName: "ci",
				});
				const stats = await dbOps.getStatsRepository().getApiKeyStats();
				expect(stats).toHaveLength(1);
				expect(stats[0].requests).toBe(2);
				expect(stats[0].successRate).toBe(50);
			});

			liveIt("getSessionStats executes with a repeated OR-clause parameter pair", async () => {
				await seedBaseline();
				const sessions = await dbOps
					.getStatsRepository()
					.getSessionStats([
						{ id: "acct-1", session_start: now - 2 * HOUR },
						{ id: "acct-2", session_start: null },
					]);
				expect(sessions.get("acct-1")?.requests).toBe(2);
				expect(sessions.has("acct-2")).toBe(false);
			});
		});

		// -------------------------------------------------------------------
		// 3. GET /api/stats — the route that 500'd. Handler-level, end to end.
		// -------------------------------------------------------------------

		describe("GET /api/stats handler", () => {
			liveIt("returns 200 with the full response shape", async () => {
				await seedBaseline();
				const handler = createStatsHandler(dbOps);
				const body = (await readJson(
					await handler(new URL("http://x/api/stats")),
				)) as Record<string, unknown>;

				expect(body.totalRequests).toBe(6);
				expect(body.successRate).toBe(67);
				expect(body.activeAccounts).toBe(1);
				expect(Array.isArray(body.accounts)).toBe(true);
				expect(Array.isArray(body.topModels)).toBe(true);
				expect(Array.isArray(body.recentErrors)).toBe(true);
			});

			liveIt("returns 200 with the ?errorsSinceHours= parameter the dashboard sends", async () => {
				await seedBaseline();
				const handler = createStatsHandler(dbOps);
				const body = (await readJson(
					await handler(
						new URL("http://x/api/stats?since=7&errorsSinceHours=24"),
					),
				)) as Record<string, unknown>;
				expect(Array.isArray(body.recentErrors)).toBe(true);
			});

			liveIt("returns 200 against an empty database", async () => {
				const handler = createStatsHandler(dbOps);
				const body = (await readJson(
					await handler(new URL("http://x/api/stats")),
				)) as Record<string, unknown>;
				expect(body.totalRequests).toBe(0);
				expect(body.accounts).toEqual([]);
			});
		});

		// -------------------------------------------------------------------
		// 4. buildRequestFilters — the shared filter builder. Five dashboard
		//    routes reach it. Its own unit tests assert on the generated SQL
		//    string, which cannot catch a defect that only appears when
		//    PostgreSQL parses the statement. These execute it.
		//
		//    The `accounts=no_account` case is the second commit litmus for
		//    33ef2be9: the pre-fix form emitted `? IN (...)` with an untyped
		//    parameter on the left.
		// -------------------------------------------------------------------

		describe("buildRequestFilters via GET /api/analytics", () => {
			const handler = () => createAnalyticsHandler(context);

			async function analytics(qs: string): Promise<Record<string, unknown>> {
				const res = await handler()(new URLSearchParams(qs));
				return (await readJson(res)) as Record<string, unknown>;
			}

			liveIt("executes with no filters", async () => {
				await seedBaseline();
				const body = await analytics("range=24h");
				const totals = body.totals as Record<string, unknown>;
				expect(totals.requests).toBe(6);
				expect(Array.isArray(body.timeSeries)).toBe(true);
				expect(Array.isArray(body.modelDistribution)).toBe(true);
				expect(Array.isArray(body.accountPerformance)).toBe(true);
			});

			liveIt("executes with the NO_ACCOUNT_ID sentinel filter", async () => {
				await seedBaseline();
				const body = await analytics(
					`range=24h&accounts=${encodeURIComponent(NO_ACCOUNT_ID)}`,
				);
				const totals = body.totals as Record<string, unknown>;
				// 3 NULL + 1 legacy literal
				expect(totals.requests).toBe(4);
			});

			liveIt("executes with a named-account filter", async () => {
				await seedBaseline();
				const body = await analytics("range=24h&accounts=primary");
				const totals = body.totals as Record<string, unknown>;
				expect(totals.requests).toBe(2);
			});

			liveIt("executes with a mixed sentinel + named-account filter", async () => {
				await seedBaseline();
				const body = await analytics(
					`range=24h&accounts=primary,${encodeURIComponent(NO_ACCOUNT_ID)}`,
				);
				const totals = body.totals as Record<string, unknown>;
				expect(totals.requests).toBe(6);
			});

			liveIt("executes with model, apiKey and status filters", async () => {
				await seedBaseline();
				await seedRequest({
					id: "f-1",
					timestamp: now - HOUR,
					accountUsed: "acct-1",
					success: true,
					model: "claude-opus-4",
					apiKeyId: "key-9",
					apiKeyName: "ci",
				});

				expect(
					((await analytics("range=24h&models=claude-opus-4"))
						.totals as Record<string, unknown>).requests,
				).toBe(1);
				expect(
					((await analytics("range=24h&apiKeys=ci")).totals as Record<
						string,
						unknown
					>).requests,
				).toBe(1);
				expect(
					((await analytics("range=24h&status=success")).totals as Record<
						string,
						unknown
					>).requests,
				).toBe(5);
				expect(
					((await analytics("range=24h&status=error")).totals as Record<
						string,
						unknown
					>).requests,
				).toBe(2);
			});

			liveIt("executes every range bucket", async () => {
				await seedBaseline();
				for (const range of ["1h", "6h", "24h", "7d", "30d", "bogus"]) {
					const body = await analytics(`range=${range}`);
					expect(body.totals).toBeDefined();
				}
			});

			liveIt("executes the modelBreakdown and cumulative variants", async () => {
				await seedBaseline();
				expect(
					(await analytics("range=24h&modelBreakdown=true")).timeSeries,
				).toBeDefined();
				expect(
					(await analytics("range=24h&mode=cumulative")).timeSeries,
				).toBeDefined();
			});
		});

		// -------------------------------------------------------------------
		// 5. The other buildRequestFilters consumers.
		// -------------------------------------------------------------------

		describe("insights handlers", () => {
			liveIt("GET /api/insights/cache executes", async () => {
				await seedBaseline();
				const res = await createCacheInsightsHandler(context)(
					new URLSearchParams("range=24h"),
				);
				const body = (await readJson(res)) as Record<string, unknown>;
				expect(body.meta).toBeDefined();
			});

			liveIt("GET /api/insights/cache executes with the sentinel account filter", async () => {
				await seedBaseline();
				const res = await createCacheInsightsHandler(context)(
					new URLSearchParams(
						`range=24h&accounts=${encodeURIComponent(NO_ACCOUNT_ID)}&threshold=40`,
					),
				);
				expect(res.status).toBe(200);
			});

			liveIt("GET /api/insights/anomalies executes", async () => {
				await seedBaseline();
				const res = await createAnomalyInsightsHandler(context)(
					new URLSearchParams("range=24h"),
				);
				expect(res.status).toBe(200);
			});

			liveIt("GET /api/insights/context executes", async () => {
				await seedBaseline();
				const res = await createContextInsightsHandler(context)(
					new URLSearchParams("range=24h"),
				);
				expect(res.status).toBe(200);
			});
		});

		describe("GET /api/usage-history", () => {
			liveIt("executes against usage_snapshots", async () => {
				await seedAccount({ id: "acct-1", name: "primary" });
				await dbOps.recordUsageSnapshot(
					"acct-1",
					{ five_hour: { utilization: 12, resets_at: now + HOUR } },
					now - HOUR,
				);
				const res = await createUsageHistoryHandler(context)(
					new URLSearchParams("account=acct-1&range=24h"),
				);
				expect(res.status).toBe(200);
			});

			liveIt("returns 400 without the account parameter", async () => {
				const res = await createUsageHistoryHandler(context)(
					new URLSearchParams("range=24h"),
				);
				expect(res.status).toBe(400);
			});
		});

		// -------------------------------------------------------------------
		// 6. Handlers that bypass the repository layer and issue raw SQL
		//    against the adapter. Repository-level PG tests do not reach these.
		// -------------------------------------------------------------------

		describe("raw-adapter handlers", () => {
			liveIt("GET /api/requests executes (takes a BunSqlAdapter, not dbOps)", async () => {
				await seedBaseline();
				const res = await createRequestsSummaryHandler(adapter)(50);
				const body = (await readJson(res)) as unknown[];
				expect(Array.isArray(body)).toBe(true);
				expect(body).toHaveLength(6);
			});

			liveIt("GET /api/requests/detail executes", async () => {
				await seedBaseline();
				await dbOps.saveRequestPayload("r-real-ok", { hello: "world" });
				const res = await createRequestsDetailHandler(dbOps)(10);
				const body = (await readJson(res)) as unknown[];
				expect(Array.isArray(body)).toBe(true);
			});

			liveIt("GET /api/requests/payload/:id executes", async () => {
				await seedBaseline();
				await dbOps.saveRequestPayload("r-real-ok", { hello: "world" });
				const res = await createRequestPayloadHandler(dbOps)("r-real-ok");
				expect(res.status).toBe(200);
			});

			liveIt("POST /api/stats/reset executes both raw statements", async () => {
				await seedBaseline();
				const res = await createStatsResetHandler(dbOps)();
				expect(res.status).toBe(200);

				const left = await adapter.get<{ c: number }>(
					"SELECT COUNT(*) AS c FROM requests",
				);
				expect(Number(left?.c)).toBe(0);
				const acct = await adapter.get<{ request_count: number }>(
					"SELECT request_count FROM accounts WHERE id = ?",
					["acct-1"],
				);
				expect(Number(acct?.request_count)).toBe(0);
			});

			liveIt("POST /api/maintenance/cleanup executes", async () => {
				await seedBaseline();
				const res = await createCleanupHandler(dbOps, config)();
				const body = (await readJson(res)) as Record<string, unknown>;
				expect(typeof body.removedRequests).toBe("number");
			});
		});

		// -------------------------------------------------------------------
		// 7. Repository CRUD surfaces with zero prior coverage on any dialect:
		//    combos (7 routes), api-keys (7 routes), agent preferences.
		// -------------------------------------------------------------------

		describe("combos repository + handlers", () => {
			liveIt("exercises the full combo lifecycle on PostgreSQL", async () => {
				await seedAccount({ id: "acct-1", name: "primary" });

				const combo = await dbOps.createCombo("test-combo", "desc");
				expect(combo.id).toBeTruthy();

				expect(await dbOps.listCombos()).toHaveLength(1);
				expect((await dbOps.getCombo(combo.id))?.name).toBe("test-combo");

				const updated = await dbOps.updateCombo(combo.id, {
					name: "renamed",
					// Keep the combo enabled — getActiveComboForFamily filters on
					// `combos.enabled = 1`, so flipping it to false here makes the
					// later assertion `expect(getActiveComboForFamily('sonnet')).toBeTruthy()`
					// fail on every dialect, not just PG. The disable/enable path
					// is exercised independently by the updateComboSlot call below.
					enabled: true,
				});
				expect(updated.name).toBe("renamed");

				const slotA = await dbOps.addComboSlot(
					combo.id,
					"acct-1",
					"claude-sonnet-4",
					0,
				);
				const slotB = await dbOps.addComboSlot(
					combo.id,
					"acct-1",
					"claude-opus-4",
					1,
				);
				expect(await dbOps.getComboSlots(combo.id)).toHaveLength(2);

				await dbOps.updateComboSlot(slotA.id, { priority: 5, enabled: false });
				await dbOps.reorderComboSlots(combo.id, [slotB.id, slotA.id]);
				await dbOps.removeComboSlot(slotA.id);
				expect(await dbOps.getComboSlots(combo.id)).toHaveLength(1);

				await dbOps.setFamilyCombo("sonnet", combo.id, true);
				expect(await dbOps.getFamilyAssignments()).toHaveLength(1);
				expect(await dbOps.getActiveComboForFamily("sonnet")).toBeTruthy();

				await dbOps.deleteCombo(combo.id);
				expect(await dbOps.listCombos()).toHaveLength(0);
			});

			liveIt("GET /api/combos and GET /api/families execute", async () => {
				await seedAccount({ id: "acct-1", name: "primary" });
				const combo = await dbOps.createCombo("c", null);
				await dbOps.addComboSlot(combo.id, "acct-1", "claude-sonnet-4", 0);

				const combos = (await readJson(
					await createCombosListHandler(dbOps)(),
				)) as Record<string, unknown>;
				expect(combos.success).toBe(true);
				expect((combos.data as unknown[]).length).toBe(1);

				const families = (await readJson(
					await createFamiliesListHandler(dbOps)(),
				)) as Record<string, unknown>;
				expect(families.success).toBe(true);
			});
		});

		describe("api-keys repository", () => {
			liveIt("exercises the full api-key lifecycle on PostgreSQL", async () => {
				await dbOps.createApiKey({
					id: "key-1",
					name: "ci",
					hashedKey: "hash",
					prefixLast8: "abcdefgh",
					createdAt: now,
					lastUsed: null,
					isActive: true,
					role: "admin",
				});

				expect(await dbOps.countAllApiKeys()).toBe(1);
				expect(await dbOps.countActiveApiKeys()).toBe(1);
				expect(await dbOps.apiKeyNameExists("ci")).toBe(true);
				expect((await dbOps.getApiKeyByName("ci"))?.id).toBe("key-1");
				expect((await dbOps.getApiKeyByHashedKey("hash"))?.id).toBe("key-1");
				expect(await dbOps.getActiveApiKeys()).toHaveLength(1);

				await dbOps.updateApiKeyUsage("key-1", now);
				await dbOps.updateApiKeyRole("key-1", "api-only");
				await dbOps.disableApiKey("key-1");
				expect(await dbOps.countActiveApiKeys()).toBe(0);
				await dbOps.enableApiKey("key-1");
				expect(await dbOps.countActiveApiKeys()).toBe(1);

				await dbOps.deleteApiKey("key-1");
				expect(await dbOps.countAllApiKeys()).toBe(0);
			});
		});

		describe("agent preferences repository", () => {
			liveIt("exercises get/set/bulk/delete on PostgreSQL", async () => {
				await dbOps.setAgentPreference("agent-a", "claude-sonnet-4");
				expect((await dbOps.getAgentPreference("agent-a"))?.model).toBe(
					"claude-sonnet-4",
				);
				await dbOps.setBulkAgentPreferences(
					["agent-b", "agent-c"],
					"claude-opus-4",
				);
				expect(Object.keys(await dbOps.getAllAgentPreferences())).toHaveLength(
					3,
				);
				expect(await dbOps.deleteAgentPreference("agent-a")).toBe(true);
			});
		});

		// -------------------------------------------------------------------
		// 8. Account write path. clearExpiredRateLimits became a
		//    non-transactional SELECT-then-UPDATE, and markAccountRateLimited
		//    gates a guarded 529 write on runWithChanges(), whose PG arm reads
		//    a different result property (`count`) than its SQLite arm
		//    (`changes`). Neither arm has ever executed against PG in CI.
		// -------------------------------------------------------------------

		describe("account repository write path", () => {
			liveIt("markAccountRateLimited returns a truthful applied flag on PostgreSQL", async () => {
				await seedAccount({ id: "acct-1", name: "primary" });
				const result = await dbOps.markAccountRateLimited(
					"acct-1",
					now + HOUR,
					"upstream_429_with_reset",
				);
				expect(result).toBeDefined();

				const row = await adapter.get<{ rate_limited_until: number | null }>(
					"SELECT rate_limited_until FROM accounts WHERE id = ?",
					["acct-1"],
				);
				expect(Number(row?.rate_limited_until)).toBe(now + HOUR);
			});

			liveIt("clearExpiredRateLimits clears only expired benches", async () => {
				await seedAccount({
					id: "acct-expired",
					name: "expired",
					rateLimitedUntil: now - HOUR,
				});
				await seedAccount({
					id: "acct-active",
					name: "active",
					rateLimitedUntil: now + HOUR,
				});

				const cleared = await dbOps.clearExpiredRateLimits(now);
				expect(cleared).toBe(1);

				const still = await adapter.get<{ rate_limited_until: number | null }>(
					"SELECT rate_limited_until FROM accounts WHERE id = ?",
					["acct-active"],
				);
				expect(still?.rate_limited_until).not.toBeNull();
			});

			liveIt("exercises the per-account mutation routes' repository calls", async () => {
				await seedAccount({ id: "acct-1", name: "primary" });
				await dbOps.pauseAccount("acct-1", "manual");
				await dbOps.resumeAccount("acct-1");
				await dbOps.renameAccount("acct-1", "renamed");
				await dbOps.updateAccountPriority("acct-1", 3);
				await dbOps.setAutoFallbackEnabled("acct-1", true);
				await dbOps.setAutoPauseOnOverageEnabled("acct-1", true);
				await dbOps.setPeakHoursPauseEnabled("acct-1", true);
				await dbOps.setAccountBillingType("acct-1", "plan");
				await dbOps.updateAccountRequestCount("acct-1", 7);
				await dbOps.resetAccountSession("acct-1", now);
				await dbOps.setRequiresReauth("acct-1", true);
				await dbOps.resetConsecutiveRateLimits("acct-1");
				await dbOps.forceResetAccountRateLimit("acct-1");
				expect(await dbOps.hasAccountsForProvider("anthropic")).toBe(true);

				const account = await dbOps.getAccount("acct-1");
				expect(account?.name).toBe("renamed");
				expect((await dbOps.getAllAccounts()).length).toBe(1);
			});
		});

		// -------------------------------------------------------------------
		// 9. Request write path, payload storage and retention sweep.
		// -------------------------------------------------------------------

		describe("request repository", () => {
			liveIt("saveRequest / updateRequestUsage execute the real upsert on PostgreSQL", async () => {
				await seedAccount({ id: "acct-1", name: "primary" });
				await dbOps.saveRequest(
					"live-1",
					"POST",
					"/v1/messages",
					"acct-1",
					200,
					true,
					null,
					120,
					0,
					{
						model: "claude-sonnet-4",
						inputTokens: 10,
						outputTokens: 5,
						costUsd: 0.02,
					},
				);
				await dbOps.updateRequestUsage("live-1", {
					model: "claude-sonnet-4",
					inputTokens: 20,
					outputTokens: 10,
					costUsd: 0.05,
				});

				const row = await adapter.get<{ input_tokens: number }>(
					"SELECT input_tokens FROM requests WHERE id = ?",
					["live-1"],
				);
				expect(Number(row?.input_tokens)).toBe(20);
			});

			liveIt("payload storage round-trips on PostgreSQL", async () => {
				await seedBaseline();
				await dbOps.saveRequestPayload("r-real-ok", { a: 1 });
				await dbOps.saveRequestPayloadRaw(
					"r-real-err",
					JSON.stringify({ b: 2 }),
				);
				expect(await dbOps.getRequestPayload("r-real-ok")).toEqual({ a: 1 });
				// INNER-JOIN list: only requests that have a payload row → 2.
				expect((await dbOps.listRequestPayloads(10)).length).toBe(2);
				// LEFT-JOIN list: one row per request, json is null when no
				// payload exists → 6 (baseline has 6 requests, only 2 with payloads).
				// Previously asserted 2, which only holds if the query filters to
				// rows with non-null payloads. It doesn't, and shouldn't — callers
				// use this list to render request rows with the optional payload
				// column, not to enumerate payloads.
				expect(
					(await dbOps.listRequestPayloadsWithAccountNames(10)).length,
				).toBe(6);
			});

			liveIt("read aggregates execute on PostgreSQL", async () => {
				await seedBaseline();
				expect((await dbOps.getRecentRequests(10)).length).toBe(6);
				expect((await dbOps.getRequestStats(now - 24 * HOUR)).totalRequests).toBe(
					6,
				);
				expect(await dbOps.aggregateStats(24 * HOUR)).toBeDefined();
				expect((await dbOps.getTopModels(5)).length).toBeGreaterThan(0);
				expect((await dbOps.getRecentErrors(10)).length).toBeGreaterThan(0);
				// getRequestsByAccount groups by the raw r.account_used value and does
				// NOT apply the NULL→NO_ACCOUNT_ID bucket collapse that getAccountStats
				// uses. The fixture seeds 3 distinct account_used values: 'acct-1'
				// (matched to accounts.id = 'primary'), NULL (3 rows), and the legacy
				// literal 'no_account' (1 row). That returns 3 groups on both
				// dialects; the previous assertion expected 2, which would only hold
				// if the function bucketed NULL and 'no_account' together.
				expect((await dbOps.getRequestsByAccount(now - 24 * HOUR)).length).toBe(
					3,
				);
				// getTableRowCounts short-circuits to [] on PostgreSQL (it queries
				// sqlite_master, which only exists on SQLite). Empty array is still
				// defined, so this remains a non-vacuous smoke check that the path
				// doesn't throw on PG.
				expect(await dbOps.getTableRowCounts()).toBeDefined();
			});

			liveIt("cleanupOldRequests executes both delete statements", async () => {
				await seedRequest({
					id: "old-1",
					timestamp: now - 400 * 24 * HOUR,
					accountUsed: null,
					success: true,
				});
				await dbOps.saveRequestPayload("old-1", { stale: true });
				const result = await dbOps.cleanupOldRequests(HOUR, HOUR);
				expect(result.removedRequests).toBeGreaterThan(0);
			});
		});

		// -------------------------------------------------------------------
		// 10. Alerts. `acknowledged` is INTEGER in both dialects, so
		//     `acknowledged = 0` is portable — this asserts that, and covers
		//     the three alert routes' SQL.
		// -------------------------------------------------------------------

		describe("AlertService queries", () => {
			async function seedAlert(id: string, acknowledged: number) {
				await adapter.run(
					`INSERT INTO alerts
						(id, timestamp, type, severity, title, message, acknowledged)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[id, now, "daily_spend", "warning", "t", "m", acknowledged],
				);
			}

			liveIt("listAlerts / getUnacknowledgedCount / acknowledge execute", async () => {
				await seedAlert("a-1", 0);
				await seedAlert("a-2", 0);
				await seedAlert("a-3", 1);

				const svc = context.alertService;
				expect((await svc.listAlerts(100)).length).toBe(3);
				expect(await svc.getUnacknowledgedCount()).toBe(2);
				expect(await svc.acknowledgeAlert("a-1")).toBe(true);
				expect(await svc.acknowledgeAlert("missing")).toBe(false);
				await svc.acknowledgeAll();
				expect(await svc.getUnacknowledgedCount()).toBe(0);
			});
		});

		// -------------------------------------------------------------------
		// 11. Remaining dbOps surfaces reachable from routes: strategies,
		//     OAuth sessions, usage snapshots, storage metrics.
		// -------------------------------------------------------------------

		describe("remaining repositories", () => {
			liveIt("strategy store executes on PostgreSQL", async () => {
				await dbOps.setStrategy("session", { key: "value" });
				expect(await dbOps.getStrategy("session")).toBeDefined();
				expect((await dbOps.listStrategies()).length).toBe(1);
				await dbOps.deleteStrategy("session");
				expect((await dbOps.listStrategies()).length).toBe(0);
			});

			liveIt("oauth session store executes on PostgreSQL", async () => {
				await dbOps.createOAuthSession(
					"sess-1",
					"acct-new",
					"verifier",
					"console",
					undefined,
					0,
					10,
				);
				expect((await dbOps.getOAuthSession("sess-1"))?.accountName).toBe(
					"acct-new",
				);
				await dbOps.cleanupExpiredOAuthSessions();
				await dbOps.deleteOAuthSession("sess-1");
				expect(await dbOps.getOAuthSession("sess-1")).toBeNull();
			});

			liveIt("usage snapshot store executes on PostgreSQL", async () => {
				await seedAccount({ id: "acct-1", name: "primary" });
				await dbOps.recordUsageSnapshot(
					"acct-1",
					{ five_hour: { utilization: 40, resets_at: now + HOUR } },
					now - HOUR,
				);
				expect(
					(await dbOps.getUsageHistory({ accountId: "acct-1" })).length,
				).toBeGreaterThan(0);
				expect(await dbOps.pruneUsageSnapshots(now + HOUR)).toBeGreaterThan(0);
			});

			liveIt("getStorageMetrics executes on PostgreSQL", async () => {
				// SQLite-only concepts (WAL bytes, freelist pages, a resolved db
				// file path) degrade to 0/null rather than throwing. Asserted so
				// GET /api/storage cannot start 500ing unnoticed on PG.
				await seedBaseline();
				const metrics = await dbOps.getStorageMetrics();
				expect(typeof metrics.dbBytes).toBe("number");
				expect(metrics.walBytes).toBe(0);
				expect(metrics.orphanPages).toBe(0);
			});
		});

		// -------------------------------------------------------------------
		// 12. Adapter contract: runWithChanges reads `count` on PG and
		//     `changes` on SQLite. Nothing else in the repo asserts the PG arm,
		//     and markAccountRateLimited's guarded 529 write depends on it.
		// -------------------------------------------------------------------

		describe("BunSqlAdapter contract on PostgreSQL", () => {
			liveIt("runWithChanges returns the real affected-row count", async () => {
				await seedAccount({ id: "acct-1", name: "a" });
				await seedAccount({ id: "acct-2", name: "b" });

				const updated = await adapter.runWithChanges(
					"UPDATE accounts SET priority = ? WHERE id IN (?, ?)",
					[9, "acct-1", "acct-2"],
				);
				expect(updated).toBe(2);

				const none = await adapter.runWithChanges(
					"UPDATE accounts SET priority = ? WHERE id = ?",
					[9, "nope"],
				);
				expect(none).toBe(0);
			});

			it("renumbers repeated placeholders independently (the defect mechanism)", async () => {
				// Characterizes the adapter behaviour the whole harness exists
				// for: two textual `?` become two distinct bind slots even when
				// the source expression is identical.
				const row = await adapter.get<{ a: string; b: string }>(
					"SELECT COALESCE(NULL, ?) AS a, COALESCE(NULL, ?) AS b",
					["first", "second"],
				);
				expect(row?.a).toBe("first");
				expect(row?.b).toBe("second");
			});
		});
	},
);
