import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cacheBodyStore } from "../cache-body-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeaders(entries: Record<string, string> = {}): Headers {
	return new Headers(entries);
}

function makeBody(text = '{"model":"claude-3-opus"}') {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function makeEmptyBody(): ArrayBuffer {
	return new ArrayBuffer(0);
}

// ---------------------------------------------------------------------------
// Reset singleton state between every test
// ---------------------------------------------------------------------------

beforeEach(() => {
	cacheBodyStore.setEnabled(false);
	cacheBodyStore.setEnabled(true);
});

afterEach(() => {
	cacheBodyStore.setEnabled(false);
});

// ---------------------------------------------------------------------------

describe("CacheBodyStore", () => {
	// -----------------------------------------------------------------------
	// setEnabled
	// -----------------------------------------------------------------------

	describe("setEnabled(false)", () => {
		it("clears staged entries", () => {
			cacheBodyStore.stageRequest(
				"req-1",
				"account-a",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			// Promote the staged entry so we can verify lastCachedRequest is also cleared
			cacheBodyStore.onSummary("req-1", 10);

			// Stage another request that is still in-flight
			cacheBodyStore.stageRequest(
				"req-2",
				"account-b",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);

			cacheBodyStore.setEnabled(false);
			cacheBodyStore.setEnabled(true);

			// Promoted entry should be gone
			expect(cacheBodyStore.getLastCachedRequest("account-a")).toBeNull();
			// In-flight staging entry should be gone — calling onSummary should not promote
			cacheBodyStore.onSummary("req-2", 10);
			expect(cacheBodyStore.getLastCachedRequest("account-b")).toBeNull();
		});

		it("clears lastCachedRequest entries", () => {
			cacheBodyStore.stageRequest(
				"req-3",
				"account-c",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-3", 5);

			expect(cacheBodyStore.getLastCachedRequest("account-c")).not.toBeNull();

			cacheBodyStore.setEnabled(false);

			expect(cacheBodyStore.getLastCachedRequest("account-c")).toBeNull();
			expect(cacheBodyStore.getAllCachedAccounts()).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------
	// stageRequest — skip conditions
	// -----------------------------------------------------------------------

	describe("stageRequest skips", () => {
		it("skips when disabled", () => {
			cacheBodyStore.setEnabled(false);
			cacheBodyStore.stageRequest(
				"req-disabled",
				"account-a",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			// Re-enable so we can call onSummary without re-entering disabled state
			cacheBodyStore.setEnabled(true);
			// Nothing was staged, so onSummary with tokens > 0 should not promote
			cacheBodyStore.onSummary("req-disabled", 10);
			expect(cacheBodyStore.getLastCachedRequest("account-a")).toBeNull();
		});

		it("skips when accountId is null", () => {
			cacheBodyStore.stageRequest(
				"req-no-account",
				null,
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-no-account", 10);
			expect(cacheBodyStore.getAllCachedAccounts()).toEqual([]);
		});

		it("skips when body is null", () => {
			cacheBodyStore.stageRequest(
				"req-null-body",
				"account-a",
				null,
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-null-body", 10);
			expect(cacheBodyStore.getLastCachedRequest("account-a")).toBeNull();
		});

		it("skips when body is empty (byteLength === 0)", () => {
			cacheBodyStore.stageRequest(
				"req-empty-body",
				"account-a",
				makeEmptyBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-empty-body", 10);
			expect(cacheBodyStore.getLastCachedRequest("account-a")).toBeNull();
		});

		it("stores entry when all conditions are met", () => {
			cacheBodyStore.stageRequest(
				"req-ok",
				"account-a",
				makeBody(),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-ok", 1);
			expect(cacheBodyStore.getLastCachedRequest("account-a")).not.toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// stageRequest — header sanitization
	// -----------------------------------------------------------------------

	describe("stageRequest header sanitization", () => {
		const sensitiveHeaders: Record<string, string> = {
			authorization: "Bearer sk-ant-secret",
			"x-api-key": "secret-key",
			cookie: "session=abc123",
			"x-better-ccflare-account-id": "internal-id",
			"x-better-ccflare-bypass-session": "1",
			"x-better-ccflare-skip-cache": "true",
			"content-length": "42",
			"transfer-encoding": "chunked",
			"accept-encoding": "gzip, deflate",
			"content-encoding": "gzip",
			connection: "keep-alive",
			"keep-alive": "timeout=5",
			upgrade: "websocket",
			"proxy-authorization": "Basic xyz",
			"proxy-authenticate": "Basic realm=proxy",
			host: "api.anthropic.com",
		};

		const safeHeaders: Record<string, string> = {
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15",
			"content-type": "application/json",
			"user-agent": "Claude-Code/1.0",
		};

		it("strips all sensitive/internal headers", () => {
			cacheBodyStore.stageRequest(
				"req-strip",
				"account-a",
				makeBody(),
				makeHeaders({ ...sensitiveHeaders, ...safeHeaders }),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-strip", 10);

			const entry = cacheBodyStore.getLastCachedRequest("account-a");
			expect(entry).not.toBeNull();

			for (const key of Object.keys(sensitiveHeaders)) {
				// Headers API lowercases keys; the stored record keys come from
				// the Headers iterator which also lowercases them.
				expect(entry?.headers[key]).toBeUndefined();
			}
		});

		it("keeps non-sensitive headers", () => {
			cacheBodyStore.stageRequest(
				"req-keep",
				"account-a",
				makeBody(),
				makeHeaders({ ...sensitiveHeaders, ...safeHeaders }),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-keep", 10);

			const entry = cacheBodyStore.getLastCachedRequest("account-a");
			expect(entry).not.toBeNull();

			for (const [key, value] of Object.entries(safeHeaders)) {
				expect(entry?.headers[key]).toBe(value);
			}
		});

		it("stores an empty headers object when all headers are sensitive", () => {
			cacheBodyStore.stageRequest(
				"req-all-strip",
				"account-a",
				makeBody(),
				makeHeaders(sensitiveHeaders),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-all-strip", 10);

			const entry = cacheBodyStore.getLastCachedRequest("account-a");
			expect(entry).not.toBeNull();
			expect(Object.keys(entry?.headers)).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------
	// onSummary
	// -----------------------------------------------------------------------

	describe("onSummary", () => {
		it("always deletes the staging entry after call", () => {
			cacheBodyStore.stageRequest(
				"req-del",
				"account-a",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			// cacheCreationInputTokens = 0, so no promotion
			cacheBodyStore.onSummary("req-del", 0);

			// Call again — should be a no-op, not throw
			expect(() => cacheBodyStore.onSummary("req-del", 10)).not.toThrow();
			// The second call with tokens > 0 should not promote because staging was deleted
			expect(cacheBodyStore.getLastCachedRequest("account-a")).toBeNull();
		});

		it("promotes to lastCachedRequest when cacheCreationInputTokens > 0", () => {
			const body = makeBody('{"model":"claude-3"}');
			cacheBodyStore.stageRequest(
				"req-promote",
				"account-a",
				body,
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-promote", 7);

			const entry = cacheBodyStore.getLastCachedRequest("account-a");
			expect(entry).not.toBeNull();
			expect(entry?.path).toBe("/v1/messages");
			expect(entry?.headers["content-type"]).toBe("application/json");
		});

		it("does NOT promote when cacheCreationInputTokens is 0", () => {
			cacheBodyStore.stageRequest(
				"req-no-promote-zero",
				"account-a",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-no-promote-zero", 0);
			expect(cacheBodyStore.getLastCachedRequest("account-a")).toBeNull();
		});

		it("does NOT promote when cacheCreationInputTokens is undefined", () => {
			cacheBodyStore.stageRequest(
				"req-no-promote-undef",
				"account-a",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-no-promote-undef", undefined);
			expect(cacheBodyStore.getLastCachedRequest("account-a")).toBeNull();
		});

		it("handles unknown requestId gracefully without throwing", () => {
			expect(() =>
				cacheBodyStore.onSummary("req-does-not-exist", 10),
			).not.toThrow();
		});
	});

	// -----------------------------------------------------------------------
	// getLastCachedRequest
	// -----------------------------------------------------------------------

	describe("getLastCachedRequest", () => {
		it("returns null for an unknown account", () => {
			expect(cacheBodyStore.getLastCachedRequest("no-such-account")).toBeNull();
		});

		it("returns the promoted entry for a known account", () => {
			const rawBody = makeBody('{"model":"claude-opus"}');
			cacheBodyStore.stageRequest(
				"req-known",
				"account-known",
				rawBody,
				makeHeaders({ "anthropic-version": "2023-06-01" }),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-known", 3);

			const entry = cacheBodyStore.getLastCachedRequest("account-known");
			expect(entry).not.toBeNull();
			expect(entry?.path).toBe("/v1/messages");
			expect(Buffer.from(entry?.body).toString()).toBe(
				'{"model":"claude-opus"}',
			);
			expect(entry?.headers["anthropic-version"]).toBe("2023-06-01");
			expect(typeof entry?.timestamp).toBe("number");
		});

		it("returns null after setEnabled(false)", () => {
			cacheBodyStore.stageRequest(
				"req-before-disable",
				"account-a",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-before-disable", 5);

			expect(cacheBodyStore.getLastCachedRequest("account-a")).not.toBeNull();

			cacheBodyStore.setEnabled(false);

			expect(cacheBodyStore.getLastCachedRequest("account-a")).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// getAllCachedAccounts
	// -----------------------------------------------------------------------

	describe("getAllCachedAccounts", () => {
		it("returns empty array initially", () => {
			expect(cacheBodyStore.getAllCachedAccounts()).toEqual([]);
		});

		it("returns account IDs after promotion", () => {
			cacheBodyStore.stageRequest(
				"req-a",
				"account-a",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-a", 1);

			cacheBodyStore.stageRequest(
				"req-b",
				"account-b",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-b", 2);

			const accounts = cacheBodyStore.getAllCachedAccounts();
			expect(accounts).toHaveLength(2);
			expect(accounts).toContain("account-a");
			expect(accounts).toContain("account-b");
		});

		it("does not include accounts with only staged (not promoted) entries", () => {
			// Stage but do not call onSummary
			cacheBodyStore.stageRequest(
				"req-staged-only",
				"account-staged",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);

			expect(cacheBodyStore.getAllCachedAccounts()).not.toContain(
				"account-staged",
			);
		});

		it("does not include accounts where onSummary had zero tokens", () => {
			cacheBodyStore.stageRequest(
				"req-zero",
				"account-zero",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-zero", 0);

			expect(cacheBodyStore.getAllCachedAccounts()).not.toContain(
				"account-zero",
			);
		});
	});

	// -----------------------------------------------------------------------
	// evict
	// -----------------------------------------------------------------------

	describe("evict", () => {
		it("removes a specific account's entry", () => {
			cacheBodyStore.stageRequest(
				"req-evict",
				"account-evict",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-evict", 4);

			expect(
				cacheBodyStore.getLastCachedRequest("account-evict"),
			).not.toBeNull();

			cacheBodyStore.evict("account-evict");

			expect(cacheBodyStore.getLastCachedRequest("account-evict")).toBeNull();
			expect(cacheBodyStore.getAllCachedAccounts()).not.toContain(
				"account-evict",
			);
		});

		it("is a no-op for an unknown account", () => {
			expect(() => cacheBodyStore.evict("no-such-account")).not.toThrow();
		});

		it("does not affect other accounts when evicting one", () => {
			cacheBodyStore.stageRequest(
				"req-keep-1",
				"account-keep",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-keep-1", 1);

			cacheBodyStore.stageRequest(
				"req-evict-2",
				"account-remove",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-evict-2", 1);

			cacheBodyStore.evict("account-remove");

			expect(
				cacheBodyStore.getLastCachedRequest("account-keep"),
			).not.toBeNull();
			expect(cacheBodyStore.getLastCachedRequest("account-remove")).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// evictStaleEntries
	// -----------------------------------------------------------------------

	describe("evictStaleEntries", () => {
		it("evicts entries older than ttlMinutes * ageMultiplier", () => {
			cacheBodyStore.stageRequest(
				"req-stale",
				"account-stale",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-stale", 5);

			// Manually backdate the entry's timestamp so it appears very old.
			const entry = cacheBodyStore.getLastCachedRequest("account-stale");
			expect(entry).not.toBeNull();
			// Mutate timestamp to be 1 hour in the past.
			(entry as { timestamp: number }).timestamp = Date.now() - 60 * 60 * 1000;

			// TTL=5 min, multiplier=3 → threshold = 15 min. Entry is 60 min old → evicted.
			cacheBodyStore.evictStaleEntries(5);

			expect(cacheBodyStore.getLastCachedRequest("account-stale")).toBeNull();
			expect(cacheBodyStore.getAllCachedAccounts()).not.toContain(
				"account-stale",
			);
		});

		it("retains entries newer than the threshold", () => {
			cacheBodyStore.stageRequest(
				"req-fresh",
				"account-fresh",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-fresh", 5);

			// The entry was just created (timestamp ≈ now) — well within the 15-min window.
			cacheBodyStore.evictStaleEntries(5);

			expect(
				cacheBodyStore.getLastCachedRequest("account-fresh"),
			).not.toBeNull();
		});

		it("is a no-op when the map is empty", () => {
			// Ensure map is empty.
			expect(cacheBodyStore.getAllCachedAccounts()).toHaveLength(0);

			// Should not throw.
			expect(() => cacheBodyStore.evictStaleEntries(5)).not.toThrow();

			expect(cacheBodyStore.getAllCachedAccounts()).toHaveLength(0);
		});

		it("evicts only stale entries and retains fresh ones", () => {
			// Stale entry.
			cacheBodyStore.stageRequest(
				"req-old",
				"account-old",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-old", 5);
			const oldEntry = cacheBodyStore.getLastCachedRequest("account-old");
			(oldEntry as { timestamp: number }).timestamp =
				Date.now() - 60 * 60 * 1000;

			// Fresh entry.
			cacheBodyStore.stageRequest(
				"req-new",
				"account-new",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-new", 5);

			cacheBodyStore.evictStaleEntries(5);

			expect(cacheBodyStore.getLastCachedRequest("account-old")).toBeNull();
			expect(cacheBodyStore.getLastCachedRequest("account-new")).not.toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// Multiple accounts
	// -----------------------------------------------------------------------

	describe("multiple accounts", () => {
		it("two accounts can both have independent entries", () => {
			const bodyA = makeBody('{"model":"claude-a"}');
			const bodyB = makeBody('{"model":"claude-b"}');

			cacheBodyStore.stageRequest(
				"req-multi-a",
				"account-alpha",
				bodyA,
				makeHeaders({ "anthropic-version": "2023-06-01" }),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-multi-a", 10);

			cacheBodyStore.stageRequest(
				"req-multi-b",
				"account-beta",
				bodyB,
				makeHeaders({ "anthropic-version": "2024-01-01" }),
				"/v1/completions",
			);
			cacheBodyStore.onSummary("req-multi-b", 20);

			const entryA = cacheBodyStore.getLastCachedRequest("account-alpha");
			const entryB = cacheBodyStore.getLastCachedRequest("account-beta");

			expect(entryA).not.toBeNull();
			expect(entryB).not.toBeNull();

			expect(Buffer.from(entryA?.body).toString()).toBe('{"model":"claude-a"}');
			expect(Buffer.from(entryB?.body).toString()).toBe('{"model":"claude-b"}');

			expect(entryA?.path).toBe("/v1/messages");
			expect(entryB?.path).toBe("/v1/completions");

			expect(entryA?.headers["anthropic-version"]).toBe("2023-06-01");
			expect(entryB?.headers["anthropic-version"]).toBe("2024-01-01");
		});

		it("a newer request replaces the older one for the same account", () => {
			const firstBody = makeBody('{"model":"claude-first"}');
			const secondBody = makeBody('{"model":"claude-second"}');

			cacheBodyStore.stageRequest(
				"req-first",
				"account-replace",
				firstBody,
				makeHeaders(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary("req-first", 5);

			cacheBodyStore.stageRequest(
				"req-second",
				"account-replace",
				secondBody,
				makeHeaders(),
				"/v1/completions",
			);
			cacheBodyStore.onSummary("req-second", 8);

			const entry = cacheBodyStore.getLastCachedRequest("account-replace");
			expect(entry).not.toBeNull();
			expect(Buffer.from(entry?.body).toString()).toBe(
				'{"model":"claude-second"}',
			);
			expect(entry?.path).toBe("/v1/completions");

			// getAllCachedAccounts should only list the account once
			expect(
				cacheBodyStore
					.getAllCachedAccounts()
					.filter((id) => id === "account-replace"),
			).toHaveLength(1);
		});

		it("interleaved in-flight requests are tracked independently", () => {
			const bodyX = makeBody('{"model":"x"}');
			const bodyY = makeBody('{"model":"y"}');

			// Both staged before either summary arrives
			cacheBodyStore.stageRequest(
				"req-x",
				"account-x",
				bodyX,
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
			);
			cacheBodyStore.stageRequest(
				"req-y",
				"account-y",
				bodyY,
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
			);

			// Summaries arrive in reverse order
			cacheBodyStore.onSummary("req-y", 3);
			cacheBodyStore.onSummary("req-x", 7);

			expect(
				Buffer.from(
					cacheBodyStore.getLastCachedRequest("account-x")?.body,
				).toString(),
			).toBe('{"model":"x"}');
			expect(
				Buffer.from(
					cacheBodyStore.getLastCachedRequest("account-y")?.body,
				).toString(),
			).toBe('{"model":"y"}');
		});
	});
});
