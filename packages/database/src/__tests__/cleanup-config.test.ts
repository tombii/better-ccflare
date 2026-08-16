/**
 * Tests for the retention-cleanup config helpers added for #412
 * (PG deadlock on large/TOASTed request_payloads rows).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getCleanupBatchSize,
	PG_CLIENT_QUERY_TIMEOUT_MS,
} from "../adapters/bun-sql-adapter";

const ENV_KEY = "BETTER_CCFLARE_DB_CLEANUP_BATCH_SIZE";

describe("getCleanupBatchSize", () => {
	let prev: string | undefined;

	beforeEach(() => {
		prev = process.env[ENV_KEY];
	});

	afterEach(() => {
		if (prev === undefined) {
			delete process.env[ENV_KEY];
		} else {
			process.env[ENV_KEY] = prev;
		}
	});

	it("falls back to 200 when unset", () => {
		delete process.env[ENV_KEY];
		expect(getCleanupBatchSize()).toBe(200);
	});

	it("respects a valid positive override", () => {
		process.env[ENV_KEY] = "500";
		expect(getCleanupBatchSize()).toBe(500);
	});

	it("falls back to 200 for a non-numeric value", () => {
		process.env[ENV_KEY] = "not-a-number";
		expect(getCleanupBatchSize()).toBe(200);
	});

	it("falls back to 200 for zero", () => {
		process.env[ENV_KEY] = "0";
		expect(getCleanupBatchSize()).toBe(200);
	});

	it("falls back to 200 for a negative value", () => {
		process.env[ENV_KEY] = "-100";
		expect(getCleanupBatchSize()).toBe(200);
	});
});

describe("PG_CLIENT_QUERY_TIMEOUT_MS", () => {
	// Computed once at module load from BETTER_CCFLARE_DB_CLIENT_TIMEOUT, so a
	// live re-init test would require re-importing the module under a fresh
	// registry with the env var pre-set. No existing test in this directory
	// does that for module-load-time config, so we keep this as a smoke test
	// of the documented default (no override present in this test run).
	it("defaults to 8000 when no override is set at module load", () => {
		expect(PG_CLIENT_QUERY_TIMEOUT_MS).toBe(8000);
	});
});
