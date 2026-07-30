import { NO_ACCOUNT_ID } from "@better-ccflare/types";

/**
 * Shared range + filter parsing for request-analytics style endpoints
 * (/api/analytics, /api/insights/cache).
 *
 * Extracted verbatim from the analytics handler so both endpoints interpret
 * `range`, `accounts`, `models`, `apiKeys` and `status` identically.
 */

export interface BucketConfig {
	bucketMs: number;
	displayName: string;
}

export interface RangeConfig {
	startMs: number;
	bucket: BucketConfig;
	/** The effective range actually used (unknown inputs normalize to "24h"). */
	range: string;
}

/**
 * Map a range string (1h/6h/24h/7d/30d) to a window start (ms since epoch)
 * and a time-series bucket size. Unknown ranges fall back to 24h, and the
 * returned `range` reflects that effective value.
 */
export function getRangeConfig(range: string): RangeConfig {
	const now = Date.now();
	const hour = 60 * 60 * 1000;
	const day = 24 * hour;

	switch (range) {
		case "1h":
			return {
				startMs: now - hour,
				bucket: { bucketMs: 60 * 1000, displayName: "1m" },
				range,
			};
		case "6h":
			return {
				startMs: now - 6 * hour,
				bucket: { bucketMs: 5 * 60 * 1000, displayName: "5m" },
				range,
			};
		case "24h":
			return {
				startMs: now - day,
				bucket: { bucketMs: hour, displayName: "1h" },
				range,
			};
		case "7d":
			return {
				startMs: now - 7 * day,
				bucket: { bucketMs: hour, displayName: "1h" },
				range,
			};
		case "30d":
			return {
				startMs: now - 30 * day,
				bucket: { bucketMs: day, displayName: "1d" },
				range,
			};
		default:
			return {
				startMs: now - day,
				bucket: { bucketMs: hour, displayName: "1h" },
				range: "24h",
			};
	}
}

export interface RequestFilterResult {
	/** SQL conditions joined with AND; assumes the requests table is aliased `r`. */
	whereClause: string;
	/** Bind parameters matching the `?` placeholders in whereClause, in order. */
	params: (string | number)[];
}

/**
 * Build the WHERE clause + bind params for queries over the `requests` table
 * (aliased `r`) from dashboard filter search params.
 *
 * Conditions, in order: timestamp window, accounts (names resolved to ids via
 * subquery, plus the NO_ACCOUNT_ID sentinel escape hatch), models, apiKeys,
 * status (success/error; anything else adds no condition).
 *
 * Every column reference is qualified with the `r` alias so the clause stays
 * unambiguous in queries that join other tables sharing column names (e.g.
 * request_payloads also has a timestamp column).
 */
export function buildRequestFilters(
	searchParams: URLSearchParams,
	startMs: number,
): RequestFilterResult {
	const accountsFilter =
		searchParams.get("accounts")?.split(",").filter(Boolean) || [];
	const modelsFilter =
		searchParams.get("models")?.split(",").filter(Boolean) || [];
	const apiKeysFilter =
		searchParams.get("apiKeys")?.split(",").filter(Boolean) || [];
	const statusFilter = searchParams.get("status") || "all";

	const conditions: string[] = ["r.timestamp > ?"];
	const params: (string | number)[] = [startMs];

	if (accountsFilter.length > 0) {
		// Handle account filter - map account names to IDs via join.
		// The NO_ACCOUNT_ID escape hatch covers the unauthenticated bucket,
		// which is encoded as NULL account_used under the current schema and
		// as the literal 'no_account' string in legacy rows. We match both
		// so the drill-down on the dashboard `no_account` row returns
		// unattributed requests regardless of how they were originally written.
		//
		// We branch in JS rather than emitting "? IN (...)" with the bind
		// parameter on the left side. PostgreSQL leaves an untyped parameter
		// on the left of IN rejected at Parse time; SQLite's lack of
		// parameter typing hides this. The presence of the NO_ACCOUNT_ID
		// sentinel in the filter is known here, so we split it out before
		// emitting SQL.
		const includesNoAccount = accountsFilter.includes(NO_ACCOUNT_ID);
		const accountNames = includesNoAccount
			? accountsFilter.filter((n) => n !== NO_ACCOUNT_ID)
			: accountsFilter;

		const parts: string[] = [];
		if (accountNames.length > 0) {
			const placeholders = accountNames.map(() => "?").join(",");
			parts.push(
				`r.account_used IN (SELECT id FROM accounts WHERE name IN (${placeholders}))`,
			);
			params.push(...accountNames);
		}
		if (includesNoAccount) {
			parts.push(`(r.account_used IS NULL OR r.account_used = ?)`);
			params.push(NO_ACCOUNT_ID);
		}

		conditions.push(`(${parts.join(" OR ")})`);
	}

	if (modelsFilter.length > 0) {
		const placeholders = modelsFilter.map(() => "?").join(",");
		conditions.push(`r.model IN (${placeholders})`);
		params.push(...modelsFilter);
	}

	if (apiKeysFilter.length > 0) {
		const placeholders = apiKeysFilter.map(() => "?").join(",");
		conditions.push(`r.api_key_name IN (${placeholders})`);
		params.push(...apiKeysFilter);
	}

	if (statusFilter === "success") {
		conditions.push("r.success = TRUE");
	} else if (statusFilter === "error") {
		conditions.push("r.success = FALSE");
	}

	return { whereClause: conditions.join(" AND "), params };
}
