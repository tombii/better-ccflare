/**
 * Tests for BunSqlAdapter's retry-on-ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE
 * behavior (withPgIntegerSizeRetry, exercised through query()/get()).
 *
 * The real Bun.SQL client isn't exercised here — we stub a minimal fake with
 * an `unsafe()` method that throws once before succeeding, using
 * `(adapter as any).sql` to reach the private field. See issue #284.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../bun-sql-adapter";

function makeIntegerSizeError(): Error {
	return Object.assign(
		new Error(
			'Failed to read data code: "ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE"',
		),
		{ code: "ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE" },
	);
}

/** Minimal fake standing in for Bun's SQL client. */
function makeFakeSql(
	unsafeImpl: (sql: string, params: unknown[]) => Promise<unknown>,
) {
	return {
		unsafe: unsafeImpl,
		on: () => {},
	};
}

describe("BunSqlAdapter withPgIntegerSizeRetry", () => {
	let adapter: BunSqlAdapter | undefined;

	afterEach(() => {
		adapter = undefined;
	});

	describe("query() retries once on ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE", () => {
		it("returns the result from the second attempt", async () => {
			let calls = 0;
			const fakeSql = makeFakeSql(async () => {
				calls++;
				if (calls === 1) throw makeIntegerSizeError();
				return [{ id: 1, val: "hello" }];
			});
			// biome-ignore lint/suspicious/noExplicitAny: constructing adapter with a fake SQL client for testing
			adapter = new BunSqlAdapter(fakeSql as any, false);

			const rows = await adapter.query<{ id: number; val: string }>(
				"SELECT id, val FROM t",
			);
			expect(rows).toEqual([{ id: 1, val: "hello" }]);
			expect(calls).toBe(2);
		});
	});

	describe("get() retries once on ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE", () => {
		it("returns the row from the second attempt", async () => {
			let calls = 0;
			const fakeSql = makeFakeSql(async () => {
				calls++;
				if (calls === 1) throw makeIntegerSizeError();
				return [{ id: 2, val: "world" }];
			});
			// biome-ignore lint/suspicious/noExplicitAny: constructing adapter with a fake SQL client for testing
			adapter = new BunSqlAdapter(fakeSql as any, false);

			const row = await adapter.get<{ id: number; val: string }>(
				"SELECT id, val FROM t WHERE id = $1",
				[2],
			);
			expect(row).toEqual({ id: 2, val: "world" });
			expect(calls).toBe(2);
		});
	});

	describe("a second consecutive failure is not retried again", () => {
		it("propagates the error after one retry attempt", async () => {
			let calls = 0;
			const fakeSql = makeFakeSql(async () => {
				calls++;
				throw makeIntegerSizeError();
			});
			// biome-ignore lint/suspicious/noExplicitAny: constructing adapter with a fake SQL client for testing
			adapter = new BunSqlAdapter(fakeSql as any, false);

			await expect(adapter.query("SELECT id FROM t")).rejects.toMatchObject({
				code: "ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE",
			});
			expect(calls).toBe(2);
		});
	});

	describe("non-matching errors are not retried", () => {
		it("propagates immediately without a second attempt", async () => {
			let calls = 0;
			const fakeSql = makeFakeSql(async () => {
				calls++;
				throw Object.assign(new Error("connection closed"), {
					code: "ERR_POSTGRES_CONNECTION_CLOSED",
				});
			});
			// biome-ignore lint/suspicious/noExplicitAny: constructing adapter with a fake SQL client for testing
			adapter = new BunSqlAdapter(fakeSql as any, false);

			await expect(adapter.query("SELECT id FROM t")).rejects.toMatchObject({
				code: "ERR_POSTGRES_CONNECTION_CLOSED",
			});
			expect(calls).toBe(1);
		});
	});
});
