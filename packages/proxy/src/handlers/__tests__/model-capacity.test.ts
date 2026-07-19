import { afterEach, describe, expect, it } from "bun:test";
import {
	clearFamilyExhaustionCache,
	createModelFamilyExhaustedResponse,
	findScopedResetAt,
	isAccountExhaustedForModel,
	isFamilyExhausted,
	markFamilyExhausted,
} from "../model-capacity";

afterEach(() => {
	clearFamilyExhaustionCache();
});

// ── isAccountExhaustedForModel ────────────────────────────────────────────────

describe("isAccountExhaustedForModel", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
	const futureReset = new Date(NOW + 2 * 24 * 60 * 60 * 1000).toISOString();
	const pastReset = new Date(NOW - 60 * 60 * 1000).toISOString();

	const scopedLimits = (
		percent: number,
		displayName = "Fable",
		resetsAt: string | null = futureReset,
	) =>
		({
			limits: [
				{
					kind: "weekly_scoped",
					percent,
					resets_at: resetsAt,
					scope: {
						model: { id: null, display_name: displayName },
						surface: null,
					},
				},
			],
		}) as never;

	it("reports exhausted when the matching family's weekly_scoped cap is >=100% with a future reset", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(100),
			"claude-fable-5",
			NOW,
		);
		expect(result.exhausted).toBe(true);
		expect(result.resetAt).toBe(new Date(futureReset).getTime());
	});

	it("reports exhausted for utilization above 100% too", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(143),
			"claude-fable-5",
			NOW,
		);
		expect(result.exhausted).toBe(true);
	});

	it("does NOT report exhausted just below the 100% boundary", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(99.9),
			"claude-fable-5",
			NOW,
		);
		expect(result.exhausted).toBe(false);
		expect(result.resetAt).toBeNull();
	});

	it("does not exclude a different family's request (e.g. sonnet vs an exhausted fable cap)", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(100, "Fable"),
			"claude-sonnet-4-5",
			NOW,
		);
		expect(result.exhausted).toBe(false);
	});

	it("fails open when the scoped row's display name has no known family mapping", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(100, "Mystery Model"),
			"claude-opus-4-8",
			NOW,
		);
		expect(result.exhausted).toBe(false);
	});

	it("fails open when the request model's own family is unknown", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(100, "Fable"),
			"gpt-4-turbo-unknown",
			NOW,
		);
		expect(result.exhausted).toBe(false);
	});

	it("fails open when the scoped cap's reset has already passed (stale telemetry)", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(100, "Fable", pastReset),
			"claude-fable-5",
			NOW,
		);
		expect(result.exhausted).toBe(false);
	});

	it("fails open when there is no telemetry at all", () => {
		expect(isAccountExhaustedForModel(null, "claude-fable-5", NOW)).toEqual({
			exhausted: false,
			resetAt: null,
		});
		expect(
			isAccountExhaustedForModel(undefined, "claude-fable-5", NOW),
		).toEqual({ exhausted: false, resetAt: null });
	});

	it("fails open when no model is given", () => {
		expect(
			isAccountExhaustedForModel(scopedLimits(100), null, NOW).exhausted,
		).toBe(false);
		expect(
			isAccountExhaustedForModel(scopedLimits(100), undefined, NOW).exhausted,
		).toBe(false);
	});

	it("ignores a weekly_all (account-wide) cap — only weekly_scoped rows drive exhaustion", () => {
		const data = {
			limits: [
				{
					kind: "weekly_all",
					percent: 100,
					resets_at: futureReset,
					scope: null,
				},
			],
		} as never;
		expect(
			isAccountExhaustedForModel(data, "claude-sonnet-4-5", NOW).exhausted,
		).toBe(false);
	});
});

// ── findScopedResetAt ──────────────────────────────────────────────────────────

describe("findScopedResetAt", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
	const futureReset = new Date(NOW + 3 * 24 * 60 * 60 * 1000).toISOString();

	it("returns the scoped cap's reset time regardless of current utilization", () => {
		const data = {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 12,
					resets_at: futureReset,
					scope: { model: { id: null, display_name: "Sonnet" }, surface: null },
				},
			],
		} as never;
		expect(findScopedResetAt(data, "claude-sonnet-4-5", NOW)).toBe(
			new Date(futureReset).getTime(),
		);
	});

	it("returns null when no matching scoped window exists", () => {
		expect(findScopedResetAt(null, "claude-sonnet-4-5", NOW)).toBeNull();
		expect(findScopedResetAt(undefined, "claude-sonnet-4-5", NOW)).toBeNull();
	});

	it("returns null when the model's family is unknown", () => {
		const data = {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 50,
					resets_at: futureReset,
					scope: { model: { id: null, display_name: "Sonnet" }, surface: null },
				},
			],
		} as never;
		expect(findScopedResetAt(data, "gpt-4-turbo-unknown", NOW)).toBeNull();
	});
});

// ── markFamilyExhausted / isFamilyExhausted (negative cache) ───────────────────

describe("markFamilyExhausted / isFamilyExhausted", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);

	it("is not exhausted before anything is marked", () => {
		expect(isFamilyExhausted("acc-1", "fable", NOW)).toBe(false);
	});

	it("marks and reports exhaustion until the given untilMs", () => {
		markFamilyExhausted("acc-1", "fable", NOW + 60_000, NOW);
		expect(isFamilyExhausted("acc-1", "fable", NOW)).toBe(true);
		expect(isFamilyExhausted("acc-1", "fable", NOW + 30_000)).toBe(true);
	});

	it("expires after untilMs and evicts the entry", () => {
		markFamilyExhausted("acc-1", "fable", NOW + 60_000, NOW);
		expect(isFamilyExhausted("acc-1", "fable", NOW + 60_001)).toBe(false);
		// Still false on a second check (entry evicted, not just skipped).
		expect(isFamilyExhausted("acc-1", "fable", NOW + 60_001)).toBe(false);
	});

	it("defaults to a 5-minute TTL when no untilMs is given", () => {
		markFamilyExhausted("acc-1", "fable", null, NOW);
		expect(isFamilyExhausted("acc-1", "fable", NOW + 4 * 60 * 1000)).toBe(true);
		expect(isFamilyExhausted("acc-1", "fable", NOW + 6 * 60 * 1000)).toBe(
			false,
		);
	});

	it("defaults to a 5-minute TTL when untilMs is already in the past", () => {
		markFamilyExhausted("acc-1", "fable", NOW - 1000, NOW);
		expect(isFamilyExhausted("acc-1", "fable", NOW + 4 * 60 * 1000)).toBe(true);
	});

	it("is isolated per (accountId, family) pair", () => {
		markFamilyExhausted("acc-1", "fable", NOW + 60_000, NOW);
		expect(isFamilyExhausted("acc-2", "fable", NOW)).toBe(false);
		expect(isFamilyExhausted("acc-1", "sonnet", NOW)).toBe(false);
	});
});

// ── createModelFamilyExhaustedResponse ──────────────────────────────────────────

describe("createModelFamilyExhaustedResponse", () => {
	it("returns HTTP 529 with a model_family_exhausted error body and Retry-After from resetAt", async () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const realNow = Date.now;
		Date.now = () => now;
		try {
			const resetAt = now + 90_000;
			const response = createModelFamilyExhaustedResponse({
				family: "fable",
				resetAt,
			});

			expect(response.status).toBe(529);
			expect(response.headers.get("Retry-After")).toBe("90");

			const body = (await response.json()) as {
				type: string;
				error: { type: string; family: string; resetAt: number | null };
			};
			expect(body.type).toBe("error");
			expect(body.error.type).toBe("model_family_exhausted");
			expect(body.error.family).toBe("fable");
			expect(body.error.resetAt).toBe(resetAt);
		} finally {
			Date.now = realNow;
		}
	});

	it("falls back to a default Retry-After when resetAt is unknown", async () => {
		const response = createModelFamilyExhaustedResponse({
			family: "sonnet",
			resetAt: null,
		});
		expect(response.status).toBe(529);
		expect(response.headers.get("Retry-After")).toBe("60");
	});
});
