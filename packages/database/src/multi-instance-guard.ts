/**
 * Multi-instance guard — startup-time detection that warns the operator
 * when more than one live process shares this database.
 *
 * Background: ccflare is designed for single-instance ownership of its
 * database. A second instance pointing at the same DB will share durable
 * state (accounts, requests, oauth_sessions) but NOT seven categories of
 * in-process coordination state that diverge silently across instances:
 *
 *   1. SessionAffinityStrategy — sticky client→account map.
 *   2. LeastUsedStrategy / SessionDrainSoonestStrategy — recency-penalty Map
 *      (`RECENT_PICK_PENALTY` / `RECENT_PICK_WINDOW_MS`).
 *   3. UsageCache — utilisation view Maps; routing decisions diverge.
 *   4. CacheBodyStore — keepalive replay cache.
 *   5. AutoRefreshScheduler — refresh mutex & failure counters. A second
 *      instance refreshes the same OAuth token concurrently — a race
 *      against the provider, not just a duplicate request.
 *   6. Rate-limit single-flight recovery probe lease map (`probeLeases`).
 *   7. SessionGovernor — session-volume circuit breaker.
 *
 * See tombii/better-ccflare#351 for the maintainer's analysis.
 *
 * Design:
 *   - Each instance writes a row to `instance_heartbeats` and refreshes
 *     `last_heartbeat` on a fixed tick.
 *   - A row older than HEARTBEAT_EXPIRY_MS is considered dead; we do not
 *     hold a bare lock row that would block legitimate restarts after a
 *     crash. This is the main design risk called out in #351.
 *   - Detection at startup scans for other rows whose `last_heartbeat` is
 *     within the expiry window.
 *   - Default behaviour is WARN (log + continue). The operator may opt
 *     into hard-failure with the BETTER_CCFLARE_MULTI_INSTANCE=refuse env
 *     var, matching ccflare's existing pattern of opt-in strictness.
 *
 * Schema: the `instance_heartbeats` table is added in both
 * `migrations.ts` (SQLite) and `migrations-pg.ts` (PostgreSQL).
 */
import { hostname as osHostname } from "node:os";
import { randomUUID } from "node:crypto";
import { Logger } from "@better-ccflare/logger";
import type { BunSqlAdapter } from "./adapters/bun-sql-adapter";

const log = new Logger("multi-instance-guard");

/**
 * How often this instance refreshes its `last_heartbeat` row (ms).
 * Picked at 5s so a missed tick does not leave us stale for long.
 */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * A row older than this is treated as a dead predecessor and ignored.
 * 30s = 6 missed ticks at HEARTBEAT_INTERVAL_MS, which tolerates GC
 * pauses, container freezes, and short network blips while still
 * surfacing a real concurrent instance within ~30s of its start.
 */
export const HEARTBEAT_EXPIRY_MS = 30_000;

export interface HeartbeatRecord {
	instance_id: string;
	hostname: string;
	pid: number;
	started_at: number;
	last_heartbeat: number;
	node_version: string;
	db_dialect: "sqlite" | "postgres";
}

/** Result of a startup scan: peers with a fresh heartbeat, plus the
 *  caller's own instance row. */
export interface MultiInstanceScanResult {
	/** Rows written by OTHER live instances, excluding this one. */
	peers: HeartbeatRecord[];
	/** Rows already expired (older than HEARTBEAT_EXPIRY_MS). Useful for
	 *  logging but not used to block startup. */
	expired: HeartbeatRecord[];
}

/**
 * How the guard should react when peers are found.
 *  - "warn" (default): log a warning and continue startup.
 *  - "refuse": throw MultiInstanceRefusedError to abort startup.
 *
 * Driven by the env var BETTER_CCFLARE_MULTI_INSTANCE.
 */
export type MultiInstanceMode = "warn" | "refuse";

export class MultiInstanceRefusedError extends Error {
	readonly peers: HeartbeatRecord[];
	constructor(peers: HeartbeatRecord[]) {
		super(
			`ccflare startup refused: ${peers.length} other live instance(s) ` +
				`share this database (set BETTER_CCFLARE_MULTI_INSTANCE=warn to override)`,
		);
		this.name = "MultiInstanceRefusedError";
		this.peers = peers;
	}
}

/**
 * Read the operator's mode preference. Defaults to "warn" so an
 * upgrade does not break existing deployments.
 */
export function readMultiInstanceMode(): MultiInstanceMode {
	const raw = (process.env.BETTER_CCFLARE_MULTI_INSTANCE ?? "warn")
		.trim()
		.toLowerCase();
	if (raw === "refuse") return "refuse";
	if (raw === "warn" || raw === "") return "warn";
	// Unknown values: be loud but don't refuse.
	log.warn(
		`Unknown BETTER_CCFLARE_MULTI_INSTANCE value "${raw}"; defaulting to "warn"`,
	);
	return "warn";
}

/** A locally-generated identifier for this process. Generated once at
 *  module load so the same value is used across calls in a single run. */
const THIS_INSTANCE_ID = randomUUID();

/** Cached values for `started_at` etc. Avoid re-fetching os.hostname() on
 *  every tick. */
const THIS_HOSTNAME = safeHostname();
const THIS_PID = process.pid ?? -1;
const THIS_NODE_VERSION = process.versions.node ?? "unknown";

function safeHostname(): string {
	try {
		return osHostname();
	} catch {
		return "unknown";
	}
}

/** Returns this process's instance_id. Stable for the lifetime of the
 *  process. */
export function getInstanceId(): string {
	return THIS_INSTANCE_ID;
}

/**
 * Insert (or update) this instance's heartbeat row. Safe to call at
 * startup and on every tick — uses UPSERT semantics.
 */
export async function writeHeartbeat(
	adapter: BunSqlAdapter,
	now: number = Date.now(),
): Promise<void> {
	const dialect = adapter.isSQLite ? "sqlite" : "postgres";
	if (adapter.isSQLite) {
		const db = adapter.getSQLiteDb();
		db.run(
			`INSERT INTO instance_heartbeats (
				instance_id, hostname, pid, started_at, last_heartbeat,
				node_version, db_dialect
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(instance_id) DO UPDATE SET
				last_heartbeat = excluded.last_heartbeat,
				hostname = excluded.hostname,
				pid = excluded.pid,
				node_version = excluded.node_version,
				db_dialect = excluded.db_dialect`,
			[
				THIS_INSTANCE_ID,
				THIS_HOSTNAME,
				THIS_PID,
				now,
				now,
				THIS_NODE_VERSION,
				dialect,
			],
		);
	} else {
		await adapter.run(
			`INSERT INTO instance_heartbeats (
				instance_id, hostname, pid, started_at, last_heartbeat,
				node_version, db_dialect
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (instance_id) DO UPDATE SET
				last_heartbeat = EXCLUDED.last_heartbeat,
				hostname = EXCLUDED.hostname,
				pid = EXCLUDED.pid,
				node_version = EXCLUDED.node_version,
				db_dialect = EXCLUDED.db_dialect`,
			[
				THIS_INSTANCE_ID,
				THIS_HOSTNAME,
				THIS_PID,
				now,
				now,
				THIS_NODE_VERSION,
				dialect,
			],
		);
	}
}

/**
 * Scan for other live instances. Returns rows written by other processes
 * (never this one) whose `last_heartbeat` is within `expiryMs` of `now`.
 * Also returns stale rows so the caller can log them.
 */
export async function scanHeartbeats(
	adapter: BunSqlAdapter,
	now: number = Date.now(),
	expiryMs: number = HEARTBEAT_EXPIRY_MS,
): Promise<MultiInstanceScanResult> {
	const cutoffFresh = now - expiryMs;
	const rows = adapter.isSQLite
		? (adapter
				.getSQLiteDb()
				.query<
					HeartbeatRecord,
					[string]
				>(
					"SELECT instance_id, hostname, pid, started_at, last_heartbeat, node_version, db_dialect FROM instance_heartbeats WHERE instance_id != ? ORDER BY last_heartbeat DESC",
				)
				.all(THIS_INSTANCE_ID) as HeartbeatRecord[])
		: ((await adapter.query<HeartbeatRecord>(
				"SELECT instance_id, hostname, pid, started_at, last_heartbeat, node_version, db_dialect FROM instance_heartbeats WHERE instance_id != ? ORDER BY last_heartbeat DESC",
				[THIS_INSTANCE_ID],
			)) as HeartbeatRecord[]);

	const peers: HeartbeatRecord[] = [];
	const expired: HeartbeatRecord[] = [];
	for (const row of rows) {
		if (row.last_heartbeat >= cutoffFresh) peers.push(row);
		else expired.push(row);
	}
	return { peers, expired };
}

/**
 * Delete this instance's heartbeat row. Called on graceful shutdown.
 * Idempotent; safe to call multiple times.
 */
export async function clearHeartbeat(adapter: BunSqlAdapter): Promise<void> {
	if (adapter.isSQLite) {
		adapter.getSQLiteDb().run("DELETE FROM instance_heartbeats WHERE instance_id = ?", [
			THIS_INSTANCE_ID,
		]);
	} else {
		await adapter.run("DELETE FROM instance_heartbeats WHERE instance_id = ?", [
			THIS_INSTANCE_ID,
		]);
	}
}

/**
 * Periodic cleanup of stale rows from crashed predecessors. Called on
 * every startup so the table does not grow forever. Returns the number
 * of rows removed.
 */
export async function purgeStaleHeartbeats(
	adapter: BunSqlAdapter,
	now: number = Date.now(),
	expiryMs: number = HEARTBEAT_EXPIRY_MS,
): Promise<number> {
	const cutoff = now - expiryMs;
	return adapter.runWithChanges(
		"DELETE FROM instance_heartbeats WHERE last_heartbeat < ?",
		[cutoff],
	);
}

/**
 * Run the startup probe. If peers are found, either warn (default) or
 * throw based on the operator's env-var preference. Returns the scan
 * result so callers may log additional context.
 */
export async function runStartupGuard(
	adapter: BunSqlAdapter,
	options: {
		now?: number;
		expiryMs?: number;
		mode?: MultiInstanceMode;
		log?: (msg: string) => void;
	} = {},
): Promise<MultiInstanceScanResult> {
	const now = options.now ?? Date.now();
	const expiryMs = options.expiryMs ?? HEARTBEAT_EXPIRY_MS;
	const mode = options.mode ?? readMultiInstanceMode();
	const writeLog = options.log ?? ((msg) => log.warn(msg));

	// Purge rows from crashed predecessors so the table does not grow.
	await purgeStaleHeartbeats(adapter, now, expiryMs);

	// Insert (or refresh) this instance's row.
	await writeHeartbeat(adapter, now);

	// Scan for peers.
	const result = await scanHeartbeats(adapter, now, expiryMs);

	if (result.peers.length > 0) {
		const message = formatGuardMessage(result.peers);
		writeLog(message);
		if (mode === "refuse") {
			throw new MultiInstanceRefusedError(result.peers);
		}
	}

	return result;
}

/** Render the operator-facing warning. Names the seven categories of
 *  in-process state so the reader understands the consequence. */
export function formatGuardMessage(peers: HeartbeatRecord[]): string {
	const peerLines = peers
		.map(
			(p) =>
				`  - instance ${p.instance_id.slice(0, 8)}…  host=${p.hostname}  pid=${p.pid}  ` +
				`last_heartbeat=${new Date(p.last_heartbeat).toISOString()}`,
		)
		.join("\n");

	return [
		`Multi-instance guard: ${peers.length} other live ccflare process(es) share this database.`,
		`The database holds durable state, but each instance keeps the following in-process and they DIVERGE silently:`,
		`  1. SessionAffinityStrategy — sticky client→account map`,
		`  2. LeastUsedStrategy / SessionDrainSoonestStrategy — recency-penalty Map`,
		`  3. UsageCache — utilisation view Maps (routing decisions diverge)`,
		`  4. CacheBodyStore — keepalive replay cache`,
		`  5. AutoRefreshScheduler — refresh mutex & failure counters (token-refresh race)`,
		`  6. Rate-limit single-flight recovery probe lease map (probeLeases)`,
		`  7. SessionGovernor — session-volume circuit breaker`,
		``,
		`Other instance(s):`,
		peerLines,
		``,
		`To silence: ensure only one instance owns this database.`,
		`To hard-fail instead of warn: set BETTER_CCFLARE_MULTI_INSTANCE=refuse.`,
		`See tombii/better-ccflare#351 for the full analysis.`,
	].join("\n");
}

/**
 * Run the guard, then start a periodic heartbeat timer that refreshes
 * this instance's row. Returns a stop function that clears the timer
 * and removes this instance's row from the table.
 *
 * Designed to be wired into DatabaseOperations lifecycle: call from
 * `initializeAsync()`, store the returned stopper, and call it from
 * `close()`.
 */
export function startHeartbeatLoop(
	adapter: BunSqlAdapter,
	options: {
		intervalMs?: number;
		now?: () => number;
	} = {},
): () => Promise<void> {
	const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
	const now = options.now ?? Date.now;

	let stopped = false;
	const timer = setInterval(() => {
		if (stopped) return;
		// Fire-and-forget: write errors are logged inside writeHeartbeat
		// callers, but here we surface them as warnings so a transient DB
		// hiccup does not kill the process.
		writeHeartbeat(adapter, now()).catch((err) => {
			log.warn(`heartbeat tick failed: ${(err as Error).message}`);
		});
	}, intervalMs);
	// Don't keep the event loop alive just for the heartbeat. Bun's
	// setInterval return type is `number` under `lib: ["DOM"]` and
	// `Timeout` under `@types/node`; guard for both.
	const maybeTimer = timer as { unref?: () => void };
	if (typeof maybeTimer.unref === "function") maybeTimer.unref();

	return async () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		try {
			await clearHeartbeat(adapter);
		} catch (err) {
			log.warn(`heartbeat cleanup failed: ${(err as Error).message}`);
		}
	};
}