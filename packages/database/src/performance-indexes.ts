import type { Database } from "bun:sqlite";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("PerformanceIndexes");

/**
 * Indexes on `requests` that earlier versions created and that are now
 * dropped. Each was either never usable by any query (partial-index predicate
 * the code never emits, or a leading column nothing filters on) or a strict
 * prefix/subset of a surviving index, while still costing a write on every
 * INSERT/UPDATE/DELETE. Dropped via `DROP INDEX IF EXISTS` on every startup;
 * their CREATE statements must NOT come back (they would be recreated).
 * Mirrored by runMigrationsPg() in migrations-pg.ts.
 */
export const REDUNDANT_REQUEST_INDEXES = [
	"idx_requests_timestamp",
	"idx_requests_account_used",
	"idx_requests_timestamp_account",
	"idx_requests_success_timestamp",
	"idx_requests_cost_model",
	"idx_requests_response_time",
	"idx_requests_tokens",
	"idx_requests_api_key",
	"idx_requests_project_timestamp",
	"idx_requests_cleanup",
	"idx_requests_billing_type_timestamp",
] as const;

/**
 * Drop the redundant `requests` indexes (no-op when already gone).
 */
export function dropRedundantRequestIndexes(db: Database): void {
	for (const name of REDUNDANT_REQUEST_INDEXES) {
		db.run(`DROP INDEX IF EXISTS ${name}`);
	}
	log.info(
		`Dropped ${REDUNDANT_REQUEST_INDEXES.length} redundant requests indexes (if present)`,
	);
}

/**
 * Add performance indexes to improve query performance
 * This migration adds indexes based on common query patterns in the application
 */
export function addPerformanceIndexes(db: Database): void {
	log.info("Adding performance indexes...");

	// 1. Composite index on requests(timestamp, account_used) for time-based account queries
	// Used in analytics for filtering by time range and account
	// 2. Index on requests(model, timestamp) for model analytics
	// Used in model distribution and performance queries
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_requests_model_timestamp 
		ON requests(model, timestamp DESC) 
		WHERE model IS NOT NULL
	`);
	log.info("Added index: idx_requests_model_timestamp");

	// 4. Index on accounts(paused) for finding active accounts
	// Used in load balancer to quickly filter active accounts
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_accounts_paused 
		ON accounts(paused) 
		WHERE paused = 0
	`);
	log.info("Added index: idx_accounts_paused");

	// 5. Index on requests(account_used, timestamp) for per-account analytics
	// Used in account performance queries
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_requests_account_timestamp 
		ON requests(account_used, timestamp DESC)
	`);
	log.info("Added index: idx_requests_account_timestamp");

	// 6. Additional indexes based on observed query patterns
	// Index for account name lookups (used in analytics joins)
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_accounts_name 
		ON accounts(name)
	`);
	log.info("Added index: idx_accounts_name");

	// Index for rate limit checks
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_accounts_rate_limited 
		ON accounts(rate_limited_until) 
		WHERE rate_limited_until IS NOT NULL
	`);
	log.info("Added index: idx_accounts_rate_limited");

	// Index for session management
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_accounts_session 
		ON accounts(session_start, session_request_count) 
		WHERE session_start IS NOT NULL
	`);
	log.info("Added index: idx_accounts_session");

	// Composite index for account ordering in load balancer
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_accounts_request_count
		ON accounts(request_count DESC, last_used)
	`);
	log.info("Added index: idx_accounts_request_count");

	// Index for account priority in load balancer
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_accounts_priority
		ON accounts(priority ASC, request_count DESC, last_used)
	`);
	log.info("Added index: idx_accounts_priority");

	// Index for OAuth session cleanup by account_name
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_oauth_sessions_account_name
		ON oauth_sessions(account_name, expires_at)
	`);
	log.info("Added index: idx_oauth_sessions_account_name");

	// Composite index for API key analytics (filtering + time-based queries)
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_requests_api_key_timestamp
		ON requests(api_key_id, timestamp DESC)
		WHERE api_key_id IS NOT NULL
	`);
	log.info("Added index: idx_requests_api_key_timestamp");

	// 8. Covering index for request_payloads cleanup
	// Used by deletePayloadsOlderThan() which uses similar pattern:
	//   DELETE FROM request_payloads WHERE id IN (SELECT id FROM request_payloads WHERE timestamp < ? LIMIT ?)
	// Note: timestamp may be NULL for legacy rows, so we use partial index where timestamp IS NOT NULL
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_request_payloads_cleanup
		ON request_payloads(timestamp, id)
		WHERE timestamp IS NOT NULL
	`);
	log.info(
		"Added index: idx_request_payloads_cleanup (covering index for payload DELETE operations)",
	);

	// 9. Covering index for the Requests tab summary query
	// Powers: SELECT r.*, a.name FROM requests r LEFT JOIN accounts a ON r.account_used = a.id
	//         ORDER BY r.timestamp DESC LIMIT ?
	// Including the most-queried scalar columns lets SQLite satisfy the query from the index
	// without a heap lookup for every row. On a 7GB database this eliminates the full table scan.
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_requests_summary_covering
		ON requests(timestamp DESC, id, account_used, status_code, success,
		            response_time_ms, model, total_tokens, cost_usd,
		            input_tokens, output_tokens, billing_type, combo_name,
		            failover_attempts)
	`);
	log.info(
		"Added index: idx_requests_summary_covering (covering index for Requests tab list query)",
	);

	// 10. Covering index for analytics aggregate queries (timestamp range scans)
	// Powers the analytics handler's WHERE timestamp > ? GROUP BY ts aggregate queries.
	// Includes aggregate columns so SQLite can compute SUM/AVG/COUNT without heap lookups.
	// Column order: timestamp first (range filter), then aggregate columns.
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_requests_analytics_covering
		ON requests(timestamp, success, total_tokens, cost_usd, billing_type,
		            output_tokens, input_tokens, cache_read_input_tokens,
		            cache_creation_input_tokens, output_tokens_per_second,
		            response_time_ms, account_used, model)
	`);
	log.info(
		"Added index: idx_requests_analytics_covering (covering index for analytics aggregate queries)",
	);

	// 11. Index for billing_type time-range queries used in analytics cost breakdown
	// 11. Partial covering index for the Errors tab grouping
	// (getRecentErrorGroups in stats.repository.ts). Only rows that carry an
	// error_message are indexed (a small fraction of the table), so the
	// `timestamp > ?` scan and the self-join probes on `timestamp = ?` never
	// touch the heap for the ~99% healthy rows. `error_message != ''` stays a
	// residual filter.
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_requests_err_ts_cov
		ON requests(timestamp DESC, account_used, error_message)
		WHERE error_message IS NOT NULL
	`);
	log.info("Added index: idx_requests_err_ts_cov");

	// 12. Index for the session -> account lookup (sessions.ts):
	//   WHERE client_session_id = ? AND account_used IS NOT NULL
	//   ORDER BY timestamp DESC, rowid DESC LIMIT 1
	// Without it an unknown session id forces a full table scan.
	db.run(`
		CREATE INDEX IF NOT EXISTS idx_requests_client_session
		ON requests(client_session_id, timestamp DESC)
		WHERE client_session_id IS NOT NULL
	`);
	log.info("Added index: idx_requests_client_session");

	log.info("Performance indexes added successfully");
}

/**
 * Analyze current index usage and suggest optimizations
 */
export function analyzeIndexUsage(db: Database): void {
	log.info("\nAnalyzing index usage...");

	// Get all indexes
	const indexes = db
		.prepare(
			`SELECT name, tbl_name, sql 
			FROM sqlite_master 
			WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
			ORDER BY tbl_name, name`,
		)
		.all() as Array<{ name: string; tbl_name: string; sql: string }>;

	log.info(`\nTotal indexes: ${indexes.length}`);
	for (const index of indexes) {
		log.info(`- ${index.name} on ${index.tbl_name}`);
	}

	// Analyze table statistics
	const tables = ["accounts", "requests", "request_payloads"];
	for (const table of tables) {
		const count = db
			.prepare(`SELECT COUNT(*) as count FROM ${table}`)
			.get() as { count: number };
		log.info(`\n${table} table: ${count.count} rows`);
	}
}
