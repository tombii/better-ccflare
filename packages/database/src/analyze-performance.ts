#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { resolveDbPath } from "./paths";
import { analyzeIndexUsage } from "./performance-indexes";

/**
 * Analyze query performance and index usage
 */
function analyzeQueryPerformance(db: Database) {
	console.log("\n=== Query Performance Analysis ===\n");

	// Test queries that should benefit from the new indexes
	const testQueries = [
		{
			name: "Time-based account analytics",
			query: `
				SELECT COUNT(*), account_used 
				FROM requests 
				WHERE timestamp > ? AND account_used IS NOT NULL 
				GROUP BY account_used
			`,
			params: [Date.now() - 24 * 60 * 60 * 1000], // Last 24 hours
		},
		{
			name: "Model performance with timestamp filter",
			query: `
				SELECT model, COUNT(*), AVG(response_time_ms)
				FROM requests 
				WHERE timestamp > ? AND model IS NOT NULL 
				GROUP BY model
			`,
			params: [Date.now() - 24 * 60 * 60 * 1000],
		},
		{
			name: "Success rate calculation",
			query: `
				SELECT 
					SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate
				FROM requests 
				WHERE timestamp > ?
			`,
			params: [Date.now() - 24 * 60 * 60 * 1000],
		},
		{
			name: "Active accounts lookup",
			query: `
				SELECT id, name, request_count 
				FROM accounts 
				WHERE paused = 0 
				ORDER BY request_count DESC
			`,
			params: [],
		},
		{
			name: "Cost analysis by model",
			query: `
				SELECT model, SUM(cost_usd) as total_cost
				FROM requests 
				WHERE cost_usd > 0 AND model IS NOT NULL 
				GROUP BY model 
				ORDER BY total_cost DESC
			`,
			params: [],
		},
		{
			name: "P95 response time calculation",
			query: `
				WITH ordered_times AS (
					SELECT 
						response_time_ms,
						ROW_NUMBER() OVER (ORDER BY response_time_ms) as row_num,
						COUNT(*) OVER () as total_count
					FROM requests 
					WHERE model = ? AND response_time_ms IS NOT NULL
				)
				SELECT response_time_ms as p95_response_time
				FROM ordered_times
				WHERE row_num = CAST(CEIL(total_count * 0.95) AS INTEGER)
				LIMIT 1
			`,
			params: ["claude-3-5-sonnet-20241022"],
		},
	];

	// Run each test query with EXPLAIN QUERY PLAN
	for (const test of testQueries) {
		console.log(`\n--- ${test.name} ---`);

		try {
			// Get query plan
			const planStmt = db.prepare(`EXPLAIN QUERY PLAN ${test.query}`);
			const plan = planStmt.all(...test.params);
			console.log("Query Plan:");
			for (const row of plan) {
				console.log(`  ${JSON.stringify(row)}`);
			}

			// Time the actual query
			const start = performance.now();
			const stmt = db.prepare(test.query);
			const result = stmt.all(...test.params);
			const duration = performance.now() - start;

			console.log(`Execution time: ${duration.toFixed(2)}ms`);
			console.log(`Rows returned: ${result.length}`);
		} catch (error) {
			console.error(`Error: ${error}`);
		}
	}
}

/**
 * Show index statistics
 */
function showIndexStats(db: Database) {
	console.log("\n=== Index Statistics ===\n");

	// Get index list with size estimates
	const indexes = db
		.prepare(`
			SELECT 
				m.name as index_name,
				m.tbl_name as table_name,
				m.sql as create_sql,
				s.stat as stat_value
			FROM sqlite_master m
			LEFT JOIN sqlite_stat1 s ON m.name = s.idx
			WHERE m.type = 'index' 
				AND m.name NOT LIKE 'sqlite_%'
				AND m.name LIKE 'idx_%'
			ORDER BY m.tbl_name, m.name
		`)
		.all() as Array<{
		index_name: string;
		table_name: string;
		create_sql: string;
		stat_value: string | null;
	}>;

	console.log(`Total performance indexes: ${indexes.length}\n`);

	let currentTable = "";
	for (const index of indexes) {
		if (index.table_name !== currentTable) {
			currentTable = index.table_name;
			console.log(`\n${currentTable}:`);
		}
		console.log(`  - ${index.index_name}`);
		if (index.stat_value) {
			console.log(`    Stats: ${index.stat_value}`);
		}
	}

	// Run ANALYZE to update statistics
	console.log("\nRunning ANALYZE to update statistics...");
	db.exec("ANALYZE");
	console.log("Statistics updated.");
}

/**
 * Main function
 */
function main() {
	const dbPath = resolveDbPath();
	console.log(`Analyzing database at: ${dbPath}\n`);

	const db = new Database(dbPath, { readonly: true });

	try {
		// Show basic index usage analysis
		analyzeIndexUsage(db);

		// Show detailed index statistics
		showIndexStats(db);

		// Analyze query performance
		analyzeQueryPerformance(db);

		console.log("\n=== Analysis Complete ===\n");
	} finally {
		db.close();
	}
}

// Run if called directly
if (import.meta.main) {
	main();
}
