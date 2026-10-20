#!/usr/bin/env bun
/**
 * Copy a better-ccflare SQLite database into an existing PostgreSQL database.
 *
 * The PostgreSQL schema is NOT created here — better-ccflare creates it itself
 * on first start (set DATABASE_URL and boot the app once, then stop it). This
 * script only moves rows.
 *
 * The SQLite and PostgreSQL schemas are not identical (PostgreSQL has extra
 * columns added by migrations-pg.ts, INTEGER vs BIGINT, BOOLEAN vs INTEGER),
 * so rows are copied column-by-column by NAME: only columns that exist in
 * both schemas are copied, PostgreSQL-only columns keep their defaults.
 *
 * Usage:
 *   DATABASE_URL=postgresql://ccflare:pw@postgres:5432/ccflare \
 *     bun scripts/sqlite-to-pg-migrate.ts --sqlite /data/better-ccflare.db
 *
 * Flags:
 *   --with-history    also copy the `requests` table (request history/stats)
 *   --with-payloads   also copy `request_payloads` (large: ~90% of the DB)
 *   --dry-run         print what would be copied, write nothing
 *   --sqlite <path>   source SQLite file (default /data/better-ccflare.db)
 *
 * The copy is idempotent: every INSERT uses ON CONFLICT DO NOTHING, so a
 * re-run fills in whatever is missing without duplicating rows. Stop the
 * better-ccflare container before running this so the source is quiescent.
 */
import { Database } from "bun:sqlite";
import { SQL } from "bun";

const argv = process.argv.slice(2);
const hasFlag = (name: string) => argv.includes(name);
const opt = (name: string, fallback?: string): string | undefined => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : fallback;
};

const sqlitePath = opt("--sqlite", "/data/better-ccflare.db") as string;
const databaseUrl = opt("--url") ?? process.env.DATABASE_URL;
const withHistory = hasFlag("--with-history");
const withPayloads = hasFlag("--with-payloads");
const dryRun = hasFlag("--dry-run");
const PAGE = 2000;
/** Flush an INSERT once its serialized values reach this many bytes. */
const MAX_STATEMENT_BYTES = 16 * 1024 * 1024;

if (!databaseUrl) {
	console.error("DATABASE_URL is required (or pass --url)");
	process.exit(1);
}

/** Small tables that must be copied: accounts (incl. OAuth tokens), config, usage state. */
const CORE_TABLES = [
	"accounts",
	"api_keys",
	"model_translations",
	"agent_preferences",
	"strategies",
	"usage_snapshots",
	"oauth_sessions",
	"combos",
	"combo_slots",
	"combo_family_assignments",
	"alerts",
];

/** History tables: large, only copied when explicitly requested. */
const HISTORY_TABLES = ["requests"];
if (withPayloads) HISTORY_TABLES.push("request_payloads");

/**
 * Natural keys for tables that have no primary key, used to dedupe rows
 * against what the running app has already written.
 *
 * usage_snapshots is an append-only time series with no surrogate key; the
 * app's own retention code (UsageHistoryRepository.deleteOlderThan) treats
 * (account_id, timestamp, window_key) as its natural key.
 */
const NATURAL_KEYS: Record<string, string[]> = {
	usage_snapshots: ["account_id", "timestamp", "window_key"],
};

const tables = [...CORE_TABLES];
if (withHistory) tables.push(...HISTORY_TABLES);

/** Coerce a SQLite value to what the PostgreSQL column expects. */
function coerce(value: unknown, dataType: string): unknown {
	if (value === null || value === undefined) return null;
	switch (dataType) {
		case "boolean":
			if (typeof value === "number") return value !== 0;
			if (typeof value === "bigint") return value !== 0n;
			const s = String(value).toLowerCase();
			return s === "true" || s === "1" || s === "t";
		case "bytea":
			return value instanceof Uint8Array ? value : new Uint8Array(0);
		case "double precision":
		case "real":
		case "numeric":
		case "integer":
		case "bigint":
		case "smallint":
			return typeof value === "string" ? Number(value) : Number(value);
		default:
			return value;
	}
}

/**
 * Map a PostgreSQL `information_schema` data type to a type usable in a cast.
 * Used so a CTE's VALUES list carries the target column's type instead of
 * being inferred as text/unknown.
 */
function pgCast(dataType: string): string {
	switch (dataType) {
		case "text":
		case "character varying":
		case "character":
			return "text";
		case "bigint":
			return "bigint";
		case "integer":
			return "integer";
		case "smallint":
			return "smallint";
		case "boolean":
			return "boolean";
		case "real":
			return "real";
		case "double precision":
			return "double precision";
		case "numeric":
			return "numeric";
		case "bytea":
			return "bytea";
		case "json":
			return "json";
		case "jsonb":
			return "jsonb";
		case "timestamp with time zone":
			return "timestamptz";
		case "timestamp without time zone":
			return "timestamp";
		case "date":
			return "date";
		case "uuid":
			return "uuid";
		default:
			return "text";
	}
}

const sqlite = new Database(sqlitePath);
// `prepare: false` matches the app's own default (BETTER_CCFLARE_DB_PG_PREPARE
// is off by default): Bun's native PG driver can collide cached prepared
// statement names when the same connection runs many different query texts.
const sql = new SQL({ url: databaseUrl, max: 4, prepare: false });

async function pgColumns(table: string): Promise<
	{ column_name: string; data_type: string; is_nullable: string }[]
> {
	const rows = (await sql`
		SELECT column_name, data_type, is_nullable
		FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = ${table}
		ORDER BY ordinal_position
	`) as unknown as {
		column_name: string;
		data_type: string;
		is_nullable: string;
	}[];
	return rows;
}

function sqliteColumns(table: string): string[] {
	const rows = sqlite
		.query(`PRAGMA table_info(${JSON.stringify(table)})`)
		.all() as { name: string }[];
	return rows.map((r) => r.name);
}

async function hasPrimaryKey(table: string): Promise<boolean> {
	const rows = (await sql.unsafe(
		`SELECT COUNT(*)::int AS n
		 FROM information_schema.table_constraints
		 WHERE table_schema = 'public' AND table_name = $1
		   AND constraint_type = 'PRIMARY KEY'`,
		[table],
	)) as unknown as { n: number }[];
	return (rows[0]?.n ?? 0) > 0;
}

async function copyTable(table: string): Promise<void> {
	const target = await pgColumns(table);
	if (target.length === 0) {
		console.error(
			`  ! table "${table}" does not exist in PostgreSQL — start the app once with DATABASE_URL so it creates the schema`,
		);
		return;
	}
	const sourceCols = new Set(sqliteColumns(table));
	const cols = target.filter((c) => sourceCols.has(c.column_name));
	const dropped = target
		.filter((c) => !sourceCols.has(c.column_name))
		.map((c) => c.column_name);

	const total = sqliteCount(table);
	if (total === 0) {
		console.log(`  - ${table}: empty in SQLite, skipped`);
		return;
	}

	const colList = cols.map((c) => c.column_name);
	const columnsSql = colList.map((c) => JSON.stringify(c)).join(", ");
	const types = new Map(target.map((c) => [c.column_name, c.data_type]));
	const selectSql = `SELECT ${colList.map((c) => JSON.stringify(c)).join(", ")} FROM ${JSON.stringify(table)} LIMIT ? OFFSET ?`;

	if (dryRun) {
		console.log(
			`  - ${table}: ${total} rows, ${colList.length} copied columns${
				dropped.length ? `, ${dropped.length} PG-only (defaulted): ${dropped.join(", ")}` : ""
			}`,
		);
		return;
	}

	// Tables without a primary key (usage_snapshots) can't rely on
	// ON CONFLICT DO NOTHING to stay idempotent — a re-run would duplicate
	// every row.
	//
	// They also must NOT be cleared first: usage_snapshots is an append-only
	// time series that the running app keeps writing to, so DELETE + re-insert
	// would throw away the rows written since the previous run.
	//
	// Instead: stage the incoming rows in a regular (not TEMP — the SQL pool
	// spans connections) staging table, then copy across with a set-based
	// anti-join. The anti-join is what makes this a set operation rather than
	// a per-row correlated subquery, which is quadratic on a table this size.
	//
	// The natural key is the table's full column set unless a narrower key is
	// known — for usage_snapshots the app's own retention code treats
	// (account_id, timestamp, window_key) as the natural key.
	const pk = await hasPrimaryKey(table);
	const keyCols = NATURAL_KEYS[table] ?? colList;
	const antiJoin = !pk;
	const stageTable = `ccflare_migrate_stage_${table}`;
	if (antiJoin) {
		console.log(
			`    (no primary key — copying only rows not already present in ${table}, keyed on ${keyCols.join(", ")})`,
		);
		await sql.unsafe(`DROP TABLE IF EXISTS ${JSON.stringify(stageTable)}`);
		await sql.unsafe(
			`CREATE TABLE ${JSON.stringify(stageTable)} AS ` +
				`SELECT ${columnsSql} FROM ${JSON.stringify(table)} WITH NO DATA`,
		);
		// Unique index over the natural key: the staging table holds each
		// candidate row at most once, and the final copy can dedupe against
		// the target with a single anti-join.
		await sql.unsafe(
			`CREATE UNIQUE INDEX ON ${JSON.stringify(stageTable)} (${keyCols
				.map((c) => JSON.stringify(c))
				.join(", ")})`,
		);
	}

	let copied = 0;
	let offset = 0;
	let lastLogged = Date.now();
	// The PostgreSQL wire protocol caps a statement at 65535 parameters, and
	// each row contributes one parameter per column. `requests` has 43
	// columns, so a 2000-row batch would need 86000 parameters. Size the
	// batch from the column count instead of using a fixed page size.
	const batchSize = Math.max(
		1,
		Math.min(PAGE, Math.floor(60000 / Math.max(colList.length, 1))),
	);
	/** One INSERT for `rows`, or several if their values exceed the byte budget. */
	const insertRows = async (rows: Record<string, unknown>[]) => {
		const tuples: string[] = [];
		const params: unknown[] = [];
		let chunkBytes = 0;
		const flush = async () => {
			if (tuples.length === 0) return;
			await sql.unsafe(
				antiJoin
					? `INSERT INTO ${JSON.stringify(stageTable)} (${columnsSql}) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`
					: `INSERT INTO ${JSON.stringify(table)} (${columnsSql}) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`,
				params,
			);
			tuples.length = 0;
			params.length = 0;
			chunkBytes = 0;
		};
		for (const row of rows) {
			const placeholders: string[] = [];
			for (const c of colList) {
				const value = coerce(row[c], types.get(c) as string);
				params.push(value);
				placeholders.push(
					`$${params.length}::${pgCast(types.get(c) as string)}`,
				);
				chunkBytes +=
					typeof value === "string" ? value.length : value ? 64 : 0;
			}
			tuples.push(`(${placeholders.join(", ")})`);
			// Keep each statement well under Bun's 1 GB default max_allowed
			// message size (and PostgreSQL's own limits).
			if (chunkBytes >= MAX_STATEMENT_BYTES) await flush();
		}
		await flush();
	};
	while (offset < total) {
		const rows = sqlite.query(selectSql).all(batchSize, offset) as Record<
			string,
			unknown
		>[];
		if (rows.length === 0) break;
		await insertRows(rows);
		copied += rows.length;
		offset += rows.length;
		if (!dryRun && Date.now() - lastLogged > 5000) {
			console.log(`    ... ${table}: ${copied}/${total}`);
			lastLogged = Date.now();
		}
	}
	if (antiJoin) {
		// Copy the staged rows that are not already in the target.
		//
		// The comparison uses `=` for NOT NULL columns and IS NOT DISTINCT FROM
		// for nullable ones. That matters: IS NOT DISTINCT FROM cannot use a
		// btree index, so using it on the key columns turns this into a
		// sequential scan per row — quadratic on a table this size. Every
		// natural key column of usage_snapshots is NOT NULL, so `=` is both
		// equivalent and indexable, letting the join drive off
		// idx_usage_snapshots_acct_win_time.
		const nullable = new Set(
			target.filter((c) => c.is_nullable === "YES").map((c) => c.column_name),
		);
		const match = keyCols
			.map((c) =>
				nullable.has(c)
					? `t.${JSON.stringify(c)} IS NOT DISTINCT FROM s.${JSON.stringify(c)}`
					: `t.${JSON.stringify(c)} = s.${JSON.stringify(c)}`,
			)
			.join(" AND ");
		const inserted = (await sql.unsafe(
			`INSERT INTO ${JSON.stringify(table)} (${columnsSql}) ` +
				`SELECT ${colList.map((c) => `s.${JSON.stringify(c)}`).join(", ")} ` +
				`FROM ${JSON.stringify(stageTable)} s ` +
				`WHERE NOT EXISTS (SELECT 1 FROM ${JSON.stringify(table)} t WHERE ${match})`,
		)) as unknown as { count?: number };
		await sql.unsafe(`DROP TABLE IF EXISTS ${JSON.stringify(stageTable)}`);
		copied = inserted?.count ?? copied;
	}
	console.log(
		`  + ${table}: ${copied} rows copied${dropped.length ? ` (${dropped.length} PG-only columns defaulted)` : ""}`,
	);
}

function sqliteCount(table: string): number {
	const row = sqlite
		.query(`SELECT COUNT(*) AS n FROM ${JSON.stringify(table)}`)
		.get() as { n: number };
	return row?.n ?? 0;
}

console.log(
	`SQLite : ${sqlitePath}\nPostgres: ${databaseUrl.replace(/:[^:@/]*@/, ":***@")}\n`,
);
console.log("Copying tables:");
for (const table of tables) {
	try {
		await copyTable(table);
	} catch (err) {
		console.error(`  ! ${table}: ${(err as Error).message}`);
	}
}

console.log("\nDone. Row counts in PostgreSQL:");
for (const table of tables) {
	const rows = (await sql.unsafe(
		`SELECT COUNT(*)::bigint AS n FROM ${JSON.stringify(table)}`,
	)) as unknown as { n: string }[];
	console.log(`  ${table}: ${rows[0]?.n ?? "?"}`);
}

await sql.close();
sqlite.close();
