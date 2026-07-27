/**
 * SQLite ↔ PostgreSQL schema parity tests.
 *
 * This repo maintains two independent migration implementations —
 * `migrations.ts` (SQLite) and `migrations-pg.ts` (PostgreSQL) — that must
 * stay in lockstep (see repo CLAUDE.md, "Database Migrations — Port to
 * PostgreSQL"). A column or table added to one and forgotten on the other
 * silently breaks whichever backend was missed (e.g. the `strategies` table
 * gap found in a manual audit). This file closes that gap with an automated
 * check that runs everywhere (no live database required) plus an optional
 * live-PostgreSQL smoke test.
 *
 * Approach:
 *  - SQLite inventory: ground truth, obtained by running `ensureSchema()` +
 *    `runMigrations()` against a real in-memory `bun:sqlite` database and
 *    introspecting `sqlite_master` / `PRAGMA table_info`.
 *  - PostgreSQL inventory: no live PG server is available in this dev/CI
 *    environment, so `migrations-pg.ts` is read as source text and its
 *    `CREATE TABLE IF NOT EXISTS` blocks (from both `ensureSchemaPg` and the
 *    upgrade-safety re-creates inside `runMigrationsPg`) plus the
 *    `columnsToAdd` array are parsed for table/column names. This mirrors
 *    the existing static-parity pattern already used for the attribution
 *    source columns at the bottom of `migrations.test.ts`.
 *
 * Only column *names* are compared, never types — SQLite is dynamically
 * typed and PostgreSQL isn't, so e.g. `INTEGER` vs `BIGINT` is an expected,
 * intentional divergence, not a parity bug.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureSchema, runMigrations } from "./migrations";

const PG_SOURCE_PATH = path.join(__dirname, "migrations-pg.ts");

/**
 * Tables that are intentionally present on one backend only, or whose
 * columns are known/justified to diverge. Empty by design — parity should
 * be exact after the audit that motivated this test. Add an entry here
 * (with a comment explaining why) only if a genuine, deliberate divergence
 * is discovered; do not use this as an escape hatch for an accidental gap.
 */
const KNOWN_TABLE_EXCEPTIONS: ReadonlySet<string> = new Set();

/** table -> set of column names known/justified to exist on one side only. */
const KNOWN_COLUMN_EXCEPTIONS: Readonly<Record<string, ReadonlySet<string>>> =
	{};

// ---------------------------------------------------------------------------
// SQLite inventory (ground truth via real execution)
// ---------------------------------------------------------------------------

interface SchemaInventory {
	/** table name -> set of column names */
	tables: Map<string, Set<string>>;
}

function buildSqliteInventory(): SchemaInventory {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		runMigrations(db);

		const tableRows = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
			)
			.all() as Array<{ name: string }>;

		const tables = new Map<string, Set<string>>();
		for (const { name } of tableRows) {
			const columns = (
				db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
					name: string;
				}>
			).map((c) => c.name);
			tables.set(name, new Set(columns));
		}
		return { tables };
	} finally {
		db.close();
	}
}

// ---------------------------------------------------------------------------
// PostgreSQL inventory (static source-text extraction)
// ---------------------------------------------------------------------------

/**
 * Given source text and the index right after an opening `(`, find the
 * index of its matching closing `)` — balances nested parens so a
 * `FOREIGN KEY (col) REFERENCES other(id)` inside the body doesn't
 * terminate the scan early.
 */
function findMatchingParen(source: string, openParenIndex: number): number {
	let depth = 1;
	let i = openParenIndex + 1;
	while (i < source.length && depth > 0) {
		if (source[i] === "(") depth++;
		else if (source[i] === ")") depth--;
		i++;
	}
	return i - 1;
}

/**
 * Extract column names from a `CREATE TABLE (...)` body. Splits on
 * top-level commas (depth 0, outside parens) and takes the first
 * whitespace-delimited token of each clause as the column name, skipping
 * clauses that are table-level constraints (FOREIGN KEY, PRIMARY KEY,
 * UNIQUE, CHECK) rather than column definitions.
 */
function extractColumnNames(body: string): string[] {
	const clauses: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of body) {
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			clauses.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	if (current.trim()) clauses.push(current);

	const tableLevelKeywords = new Set([
		"FOREIGN",
		"PRIMARY",
		"UNIQUE",
		"CHECK",
		"CONSTRAINT",
	]);

	const columns: string[] = [];
	for (const clause of clauses) {
		const trimmed = clause.trim();
		if (!trimmed) continue;
		const firstToken = trimmed.split(/\s+/)[0];
		if (tableLevelKeywords.has(firstToken.toUpperCase())) continue;
		columns.push(firstToken);
	}
	return columns;
}

/**
 * Parse all `CREATE TABLE IF NOT EXISTS <name> (...)` blocks from PG source
 * text, merging columns across repeated definitions of the same table name
 * (runMigrationsPg re-declares a handful of tables for upgrade-safety —
 * their column sets must be a subset of / consistent with ensureSchemaPg's).
 */
function parsePgCreateTables(source: string): Map<string, Set<string>> {
	const tables = new Map<string, Set<string>>();
	const headerRe = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((match = headerRe.exec(source)) !== null) {
		const tableName = match[1];
		const openParenIndex = match.index + match[0].length - 1;
		const closeParenIndex = findMatchingParen(source, openParenIndex);
		const body = source.slice(openParenIndex + 1, closeParenIndex);
		const columns = extractColumnNames(body);

		const existing = tables.get(tableName) ?? new Set<string>();
		for (const col of columns) existing.add(col);
		tables.set(tableName, existing);
	}
	return tables;
}

/**
 * Parse the `columnsToAdd: ColumnToAdd[] = [...]` array in runMigrationsPg
 * and return { table, column } pairs. Extracted from the `table:`/`column:`
 * fields directly rather than the `definition` string, matching the
 * `ColumnToAdd` interface shape used by `addColumnTolerant`.
 */
function parsePgColumnsToAdd(
	source: string,
): Array<{ table: string; column: string }> {
	const arrayMatch = source.match(
		/const columnsToAdd: ColumnToAdd\[\] = \[([\s\S]*?)\n\t\];/,
	);
	expect(arrayMatch).not.toBeNull();
	const arrayBody = arrayMatch?.[1] ?? "";

	const entries: Array<{ table: string; column: string }> = [];
	const entryRe = /table:\s*"([^"]+)",\s*\n\s*column:\s*"([^"]+)"/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((match = entryRe.exec(arrayBody)) !== null) {
		entries.push({ table: match[1], column: match[2] });
	}
	return entries;
}

function buildPgInventory(source: string): SchemaInventory {
	const tables = parsePgCreateTables(source);

	for (const { table, column } of parsePgColumnsToAdd(source)) {
		const existing = tables.get(table) ?? new Set<string>();
		existing.add(column);
		tables.set(table, existing);
	}

	return { tables };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SQLite <-> PostgreSQL migration schema parity (static)", () => {
	const pgSource = fs.readFileSync(PG_SOURCE_PATH, "utf8");
	const sqliteInventory = buildSqliteInventory();
	const pgInventory = buildPgInventory(pgSource);

	it("extracted a non-trivial inventory from both sides (sanity check)", () => {
		// Guards against a regex/extraction regression silently producing an
		// empty inventory, which would make every parity assertion below
		// vacuously true instead of actually checking anything.
		expect(sqliteInventory.tables.size).toBeGreaterThan(10);
		expect(pgInventory.tables.size).toBeGreaterThan(10);
		expect(sqliteInventory.tables.get("accounts")?.size ?? 0).toBeGreaterThan(
			10,
		);
		expect(pgInventory.tables.get("accounts")?.size ?? 0).toBeGreaterThan(10);
	});

	it("every SQLite table has a matching PostgreSQL table", () => {
		const missingOnPg = [...sqliteInventory.tables.keys()].filter(
			(table) =>
				!pgInventory.tables.has(table) && !KNOWN_TABLE_EXCEPTIONS.has(table),
		);
		expect(missingOnPg).toEqual([]);
	});

	it("every PostgreSQL table has a matching SQLite table", () => {
		const missingOnSqlite = [...pgInventory.tables.keys()].filter(
			(table) =>
				!sqliteInventory.tables.has(table) &&
				!KNOWN_TABLE_EXCEPTIONS.has(table),
		);
		expect(missingOnSqlite).toEqual([]);
	});

	it("every SQLite column has a matching PostgreSQL column (per table)", () => {
		const gaps: string[] = [];
		for (const [table, sqliteColumns] of sqliteInventory.tables) {
			if (KNOWN_TABLE_EXCEPTIONS.has(table)) continue;
			const pgColumns = pgInventory.tables.get(table);
			if (!pgColumns) continue; // reported by the table-parity test above
			const exceptions = KNOWN_COLUMN_EXCEPTIONS[table] ?? new Set();
			for (const col of sqliteColumns) {
				if (!pgColumns.has(col) && !exceptions.has(col)) {
					gaps.push(
						`${table}.${col} exists in SQLite but not in migrations-pg.ts`,
					);
				}
			}
		}
		expect(gaps).toEqual([]);
	});

	it("every PostgreSQL column has a matching SQLite column (per table)", () => {
		const gaps: string[] = [];
		for (const [table, pgColumns] of pgInventory.tables) {
			if (KNOWN_TABLE_EXCEPTIONS.has(table)) continue;
			const sqliteColumns = sqliteInventory.tables.get(table);
			if (!sqliteColumns) continue; // reported by the table-parity test above
			const exceptions = KNOWN_COLUMN_EXCEPTIONS[table] ?? new Set();
			for (const col of pgColumns) {
				if (!sqliteColumns.has(col) && !exceptions.has(col)) {
					gaps.push(
						`${table}.${col} exists in migrations-pg.ts but not in SQLite`,
					);
				}
			}
		}
		expect(gaps).toEqual([]);
	});

	it("spot check: strategies table is present on both backends", () => {
		expect(sqliteInventory.tables.has("strategies")).toBe(true);
		expect(pgInventory.tables.has("strategies")).toBe(true);
		expect(sqliteInventory.tables.get("strategies")).toEqual(
			new Set(["name", "config", "updated_at"]),
		);
		expect(pgInventory.tables.get("strategies")).toEqual(
			new Set(["name", "config", "updated_at"]),
		);
	});

	it("spot check: newly-ported performance indexes exist in migrations-pg.ts", () => {
		expect(pgSource).toContain("idx_requests_cleanup");
		expect(pgSource).toContain("idx_request_payloads_cleanup");
		expect(pgSource).toContain("idx_requests_summary_covering");
		expect(pgSource).toContain("idx_requests_analytics_covering");
	});
});

// ---------------------------------------------------------------------------
// Live PostgreSQL smoke test — only runs when a real PG server is reachable.
// ---------------------------------------------------------------------------

function hasLivePg(): boolean {
	const url = process.env.DATABASE_URL;
	return (
		!!url && (url.startsWith("postgres://") || url.startsWith("postgresql://"))
	);
}

const livePgAvailable = hasLivePg();

describe.skipIf(!livePgAvailable)(
	"PostgreSQL migrations (live, requires DATABASE_URL)",
	() => {
		it("ensureSchemaPg + runMigrationsPg complete without throwing and create expected objects", async () => {
			const { SQL } = await import("bun");
			const { BunSqlAdapter } = await import("./adapters/bun-sql-adapter");
			const { ensureSchemaPg, runMigrationsPg } = await import(
				"./migrations-pg"
			);

			// biome-ignore lint/style/noNonNullAssertion: guarded by describe.skipIf(!livePgAvailable)
			const databaseUrl = process.env.DATABASE_URL!;
			const sqlClient = new SQL({ url: databaseUrl });
			const adapter = new BunSqlAdapter(sqlClient, false);

			try {
				await expect(ensureSchemaPg(adapter)).resolves.toBeUndefined();
				await expect(runMigrationsPg(adapter)).resolves.toBeUndefined();

				// Spot check: strategies table (the audit fix under test) exists
				// with the expected columns.
				const strategiesCols = await adapter.query<{ column_name: string }>(
					`SELECT column_name FROM information_schema.columns WHERE table_name = 'strategies'`,
				);
				const strategiesColNames = strategiesCols.map((c) => c.column_name);
				expect(strategiesColNames).toContain("name");
				expect(strategiesColNames).toContain("config");
				expect(strategiesColNames).toContain("updated_at");

				// Spot check: newly-ported performance indexes exist.
				const cleanupIndex = await adapter.get<{ exists: number }>(
					`SELECT COUNT(*) AS exists FROM pg_indexes WHERE indexname = 'idx_requests_cleanup'`,
				);
				expect(cleanupIndex?.exists ?? 0).toBeGreaterThan(0);

				const analyticsCoveringIndex = await adapter.get<{ exists: number }>(
					`SELECT COUNT(*) AS exists FROM pg_indexes WHERE indexname = 'idx_requests_analytics_covering'`,
				);
				expect(analyticsCoveringIndex?.exists ?? 0).toBeGreaterThan(0);

				// Spot check: the account-name-sanitization / API-key-storage
				// migrations ran without throwing (already asserted above via
				// runMigrationsPg resolving) — seed a bad-name account and a
				// legacy-key account beforehand isn't needed for this smoke
				// test since a fresh schema has no rows to sanitize/migrate;
				// this just confirms the full migration path completes clean
				// against a real server.
			} finally {
				await adapter.close();
			}
		});
	},
);
