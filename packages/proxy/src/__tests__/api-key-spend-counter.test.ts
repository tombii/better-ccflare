/**
 * The in-memory per-API-key spend counter.
 *
 * The whole point of this class is that the expensive rollup runs rarely, so
 * most of these cases are about WHEN the database is read and when it is not.
 * A fake DatabaseOperations counts the reads.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ApiKeySpendLimit } from "@better-ccflare/types";
import {
	ApiKeySpendCounter,
	getApiKeySpendCounter,
	resetApiKeySpendCounter,
	SPEND_RESYNC_TTL_MS,
} from "../handlers/api-key-spend";

interface FakeRow {
	totalUsd: number;
	oldestMs: number | null;
}

class FakeDbOps {
	queries: Array<{ apiKeyId: string; sinceMs: number }> = [];
	rows = new Map<string, FakeRow>();
	limitedKeys: Array<{
		id: string;
		name: string;
		limitUsd: number | null;
		limitWindow: string | null;
		limitEnforce: string | null;
	}> = [];
	failNextQuery = false;

	async listApiKeysWithSpendLimits() {
		return this.limitedKeys;
	}

	async getApiKeySpendSince(apiKeyId: string, sinceMs: number) {
		this.queries.push({ apiKeyId, sinceMs });
		if (this.failNextQuery) {
			this.failNextQuery = false;
			throw new Error("database unavailable");
		}
		return this.rows.get(apiKeyId) ?? { totalUsd: 0, oldestMs: null };
	}
}

function makeCounter(db: FakeDbOps): ApiKeySpendCounter {
	return new ApiKeySpendCounter(db as never);
}

function limit(overrides: Partial<ApiKeySpendLimit> = {}): ApiKeySpendLimit {
	return {
		limitUsd: 100,
		limitWindow: "rolling_30d",
		limitEnforce: "block",
		...overrides,
	};
}

/** Let a `void`-ed background promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	resetApiKeySpendCounter();
});

afterEach(() => {
	resetApiKeySpendCounter();
});

describe("seeding", () => {
	it("seeds one total per key that has a limit", async () => {
		const db = new FakeDbOps();
		db.limitedKeys = [
			{
				id: "k1",
				name: "one",
				limitUsd: 50,
				limitWindow: "rolling_7d",
				limitEnforce: "block",
			},
			{
				id: "k2",
				name: "two",
				limitUsd: 10,
				limitWindow: null,
				limitEnforce: null,
			},
		];
		db.rows.set("k1", { totalUsd: 12.5, oldestMs: 1000 });

		const counter = makeCounter(db);
		expect(await counter.seedAll()).toBe(2);
		expect(counter.size).toBe(2);
		expect(counter.peek("k1")?.spentUsd).toBe(12.5);
		expect(db.queries.length).toBe(2);
	});

	it("creates no counter for keys without a limit", async () => {
		const db = new FakeDbOps();
		// listApiKeysWithSpendLimits filters in SQL; a row that somehow arrives
		// with no usable limit must still not get an entry.
		db.limitedKeys = [
			{
				id: "nolimit",
				name: "n",
				limitUsd: null,
				limitWindow: null,
				limitEnforce: null,
			},
		];
		const counter = makeCounter(db);

		expect(await counter.seedAll()).toBe(0);
		expect(counter.size).toBe(0);
		expect(db.queries.length).toBe(0);
	});

	it("survives a failing seed and seeds lazily instead", async () => {
		const db = new FakeDbOps();
		db.limitedKeys = [
			{
				id: "k1",
				name: "one",
				limitUsd: 50,
				limitWindow: null,
				limitEnforce: null,
			},
		];
		db.failNextQuery = true;
		const counter = makeCounter(db);

		expect(await counter.seedAll()).toBe(0);
		expect(counter.size).toBe(0);

		db.rows.set("k1", { totalUsd: 7, oldestMs: null });
		const snapshot = await counter.getSnapshot("k1", limit({ limitUsd: 50 }));
		expect(snapshot.spentUsd).toBe(7);
	});

	it("uses an absolute epoch-ms lower bound, never a SQL expression", async () => {
		const db = new FakeDbOps();
		const counter = makeCounter(db);
		const now = Date.UTC(2026, 5, 15);

		await counter.getSnapshot("k1", limit({ limitWindow: "rolling_7d" }), now);
		expect(db.queries[0].sinceMs).toBe(now - 7 * 24 * 60 * 60 * 1000);
	});
});

describe("increments", () => {
	it("adds a completed request's cost to the cached total", async () => {
		const db = new FakeDbOps();
		db.rows.set("k1", { totalUsd: 10, oldestMs: null });
		const counter = makeCounter(db);
		await counter.getSnapshot("k1", limit());

		counter.record("k1", 2.5);
		counter.record("k1", 0.25);

		expect(counter.peek("k1")?.spentUsd).toBeCloseTo(12.75, 6);
		// The increment must cost no query at all.
		expect(db.queries.length).toBe(1);
	});

	it("ignores a key with no counter entry", () => {
		const db = new FakeDbOps();
		const counter = makeCounter(db);
		counter.record("unknown", 5);
		expect(counter.size).toBe(0);
		expect(db.queries.length).toBe(0);
	});

	it("ignores a null key id, a missing cost and a non-finite cost", async () => {
		const db = new FakeDbOps();
		db.rows.set("k1", { totalUsd: 1, oldestMs: null });
		const counter = makeCounter(db);
		await counter.getSnapshot("k1", limit());

		counter.record(null, 5);
		counter.record("k1", undefined);
		counter.record("k1", Number.NaN);
		counter.record("k1", Number.POSITIVE_INFINITY);

		expect(counter.peek("k1")?.spentUsd).toBe(1);
	});
});

describe("resync on TTL", () => {
	it("answers from memory and does not re-query inside the TTL", async () => {
		const db = new FakeDbOps();
		db.rows.set("k1", { totalUsd: 10, oldestMs: null });
		const counter = makeCounter(db);
		const now = Date.now();

		await counter.getSnapshot("k1", limit(), now);
		await counter.getSnapshot("k1", limit(), now + 1000);
		await counter.getSnapshot("k1", limit(), now + SPEND_RESYNC_TTL_MS - 1);

		expect(db.queries.length).toBe(1);
	});

	it("re-queries once the TTL has passed", async () => {
		const db = new FakeDbOps();
		db.rows.set("k1", { totalUsd: 10, oldestMs: null });
		const counter = makeCounter(db);
		const now = Date.now();

		await counter.getSnapshot("k1", limit(), now);
		// The database is the authority: it says 4, the in-memory increments
		// said 10 + 3. After the resync the counter must read 4, not 13 — this
		// is the drift repair for dropped async writes and other instances.
		counter.record("k1", 3);
		db.rows.set("k1", { totalUsd: 4, oldestMs: 500 });

		await counter.getSnapshot("k1", limit(), now + SPEND_RESYNC_TTL_MS);
		await settle();

		expect(db.queries.length).toBe(2);
		expect(counter.peek("k1")?.spentUsd).toBe(4);
	});

	it("does not block the caller on the resync", async () => {
		const db = new FakeDbOps();
		db.rows.set("k1", { totalUsd: 10, oldestMs: null });
		const counter = makeCounter(db);
		const now = Date.now();
		await counter.getSnapshot("k1", limit(), now);
		db.rows.set("k1", { totalUsd: 999, oldestMs: null });

		// The stale value is what this call returns; the fresh one lands after.
		const snapshot = await counter.getSnapshot(
			"k1",
			limit(),
			now + SPEND_RESYNC_TTL_MS,
		);
		expect(snapshot.spentUsd).toBe(10);
		await settle();
		expect(counter.peek("k1")?.spentUsd).toBe(999);
	});

	it("de-duplicates concurrent first-syncs into one query", async () => {
		const db = new FakeDbOps();
		db.rows.set("k1", { totalUsd: 6, oldestMs: null });
		const counter = makeCounter(db);

		const results = await Promise.all([
			counter.getSnapshot("k1", limit()),
			counter.getSnapshot("k1", limit()),
			counter.getSnapshot("k1", limit()),
		]);

		expect(db.queries.length).toBe(1);
		for (const result of results) expect(result.spentUsd).toBe(6);
	});

	it("throws away the total when a calendar month rolls over", async () => {
		const db = new FakeDbOps();
		db.rows.set("k1", { totalUsd: 80, oldestMs: null });
		const counter = makeCounter(db);
		const june = Date.UTC(2026, 5, 30, 23, 0, 0, 0);
		const july = Date.UTC(2026, 6, 1, 0, 0, 0, 1);
		const monthly = limit({ limitWindow: "calendar_month" });

		await counter.getSnapshot("k1", monthly, june);
		db.rows.set("k1", { totalUsd: 0, oldestMs: null });

		// Awaited, not backgrounded: the old month's total is not an answer to
		// the new month's question, so this must not be served from cache.
		const snapshot = await counter.getSnapshot("k1", monthly, july);
		expect(snapshot.spentUsd).toBe(0);
		expect(db.queries.length).toBe(2);
		expect(db.queries[1].sinceMs).toBe(Date.UTC(2026, 6, 1));
	});
});

describe("snapshot contents", () => {
	it("reports exceeded at exactly the limit, not just past it", async () => {
		const db = new FakeDbOps();
		db.rows.set("k1", { totalUsd: 100, oldestMs: null });
		const counter = makeCounter(db);

		const snapshot = await counter.getSnapshot("k1", limit({ limitUsd: 100 }));
		expect(snapshot.exceeded).toBe(true);
		expect(snapshot.spentUsd).toBe(100);
		expect(snapshot.limitUsd).toBe(100);
	});

	it("is not exceeded under the limit", async () => {
		const db = new FakeDbOps();
		db.rows.set("k1", { totalUsd: 99.99, oldestMs: null });
		const counter = makeCounter(db);

		expect(
			(await counter.getSnapshot("k1", limit({ limitUsd: 100 }))).exceeded,
		).toBe(false);
	});

	it("derives a rolling reset from the oldest counted request", async () => {
		const db = new FakeDbOps();
		const now = Date.UTC(2026, 5, 15);
		const oldest = now - 6 * 24 * 60 * 60 * 1000;
		db.rows.set("k1", { totalUsd: 1, oldestMs: oldest });
		const counter = makeCounter(db);

		const snapshot = await counter.getSnapshot(
			"k1",
			limit({ limitWindow: "rolling_7d" }),
			now,
		);
		expect(snapshot.resetMs).toBe(oldest + 7 * 24 * 60 * 60 * 1000);
	});

	it("leaves the rolling reset unknown when nothing has been counted", async () => {
		const db = new FakeDbOps();
		const counter = makeCounter(db);
		const snapshot = await counter.getSnapshot("k1", limit());
		expect(snapshot.resetMs).toBeNull();
		expect(snapshot.spentUsd).toBe(0);
	});
});

describe("forget", () => {
	it("drops a cached total so a changed limit is re-measured", async () => {
		const db = new FakeDbOps();
		db.rows.set("k1", { totalUsd: 10, oldestMs: null });
		const counter = makeCounter(db);
		await counter.getSnapshot("k1", limit());

		counter.forget("k1");
		expect(counter.peek("k1")).toBeNull();

		db.rows.set("k1", { totalUsd: 3, oldestMs: null });
		expect((await counter.getSnapshot("k1", limit())).spentUsd).toBe(3);
		expect(db.queries.length).toBe(2);
	});
});

describe("the process-wide singleton", () => {
	it("hands the same instance to every caller", () => {
		const db = new FakeDbOps();
		const first = getApiKeySpendCounter(db as never);
		const second = getApiKeySpendCounter(db as never);
		expect(second).toBe(first);
	});
});
