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

	const conditions: string[] = ["timestamp > ?"];
	const params: (string | number)[] = [startMs];

	if (accountsFilter.length > 0) {
		// Handle account filter - map account names to IDs via join
		const placeholders = accountsFilter.map(() => "?").join(",");
		conditions.push(`(
				r.account_used IN (SELECT id FROM accounts WHERE name IN (${placeholders}))
				OR (r.account_used = ? AND ? IN (${placeholders}))
			)`);
		params.push(
			...accountsFilter,
			NO_ACCOUNT_ID,
			NO_ACCOUNT_ID,
			...accountsFilter,
		);
	}

	if (modelsFilter.length > 0) {
		const placeholders = modelsFilter.map(() => "?").join(",");
		conditions.push(`model IN (${placeholders})`);
		params.push(...modelsFilter);
	}

	if (apiKeysFilter.length > 0) {
		const placeholders = apiKeysFilter.map(() => "?").join(",");
		conditions.push(`api_key_name IN (${placeholders})`);
		params.push(...apiKeysFilter);
	}

	if (statusFilter === "success") {
		conditions.push("success = TRUE");
	} else if (statusFilter === "error") {
		conditions.push("success = FALSE");
	}

	return { whereClause: conditions.join(" AND "), params };
}
