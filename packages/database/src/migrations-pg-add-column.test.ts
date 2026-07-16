/**
 * Tests for the duplicate-column error discrimination in runMigrationsPg's
 * ADD COLUMN loop. Upstream previously swallowed every ALTER TABLE ADD
 * COLUMN failure with a blanket try/catch + warn log, which also hid real
 * failures (permissions, lock timeout) behind a benign-looking warning and
 * let startup continue with a missing column.
 *
 * These tests exercise `addColumnTolerant` (exported for testing) directly
 * against a minimal fake adapter, rather than mocking every SQL statement
 * in the much larger `runMigrationsPg`.
 */
import { describe, expect, it } from "bun:test";
import { addColumnTolerant } from "./migrations-pg";

const COL = {
	table: "accounts",
	column: "cross_region_mode",
	definition:
		"ALTER TABLE accounts ADD COLUMN cross_region_mode TEXT DEFAULT 'geographic'",
};

function makePgError(code: string, message = "pg error"): Error {
	return Object.assign(new Error(message), { code });
}

/** Minimal fake adapter exposing only what addColumnTolerant needs. */
function makeFakeAdapter(options: {
	unsafeImpl: () => Promise<unknown>;
	columnExistsResult?: boolean;
}) {
	return {
		unsafe: options.unsafeImpl,
		get: async () => ({
			exists: options.columnExistsResult ? 1 : 0,
		}),
		// biome-ignore lint/suspicious/noExplicitAny: fake adapter for testing
	} as any;
}

describe("addColumnTolerant", () => {
	it("succeeds silently when the ALTER TABLE succeeds", async () => {
		let calls = 0;
		const adapter = makeFakeAdapter({
			unsafeImpl: async () => {
				calls++;
				return undefined;
			},
		});

		await expect(addColumnTolerant(adapter, COL)).resolves.toBeUndefined();
		expect(calls).toBe(1);
	});

	it("tolerates SQLSTATE 42701 (duplicate_column) when the column now exists", async () => {
		const adapter = makeFakeAdapter({
			unsafeImpl: async () => {
				throw makePgError("42701", 'column "cross_region_mode" already exists');
			},
			columnExistsResult: true,
		});

		await expect(addColumnTolerant(adapter, COL)).resolves.toBeUndefined();
	});

	it("rethrows on SQLSTATE 42701 if the column does not actually exist", async () => {
		const adapter = makeFakeAdapter({
			unsafeImpl: async () => {
				throw makePgError("42701", 'column "cross_region_mode" already exists');
			},
			columnExistsResult: false,
		});

		await expect(addColumnTolerant(adapter, COL)).rejects.toMatchObject({
			code: "42701",
		});
	});

	it("rethrows on non-duplicate-column errors (e.g. permissions)", async () => {
		const adapter = makeFakeAdapter({
			unsafeImpl: async () => {
				throw makePgError("42501", "permission denied for table accounts");
			},
		});

		await expect(addColumnTolerant(adapter, COL)).rejects.toMatchObject({
			code: "42501",
		});
	});

	it("rethrows on errors with no SQLSTATE code (e.g. lock timeout)", async () => {
		const adapter = makeFakeAdapter({
			unsafeImpl: async () => {
				throw new Error("canceling statement due to lock timeout");
			},
		});

		await expect(addColumnTolerant(adapter, COL)).rejects.toThrow(
			"canceling statement due to lock timeout",
		);
	});
});
