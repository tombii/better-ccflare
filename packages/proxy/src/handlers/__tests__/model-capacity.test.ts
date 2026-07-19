import { afterEach, describe, expect, it } from "bun:test";
import {
	clearFamilyExhaustionCache,
	createModelFamilyExhaustedResponse,
	getFamilyExhaustionOrigin,
	isAccountExhaustedForModel,
	isFamilyExhausted,
	markFamilyExhausted,
	resolveOverageStatus,
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
		extra?: Record<string, unknown>,
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
			...extra,
		}) as never;

	// Exclusion-expecting fixtures carry an explicit unavailable-overage signal;
	// without one the tri-state resolver reports "unknown" and correctly fails open
	// (see the dedicated overage tri-state block below).
	const overageOff = { spend: { enabled: false } };

	it("reports exhausted when the matching family's weekly_scoped cap is >=100% with a future reset", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(100, "Fable", futureReset, overageOff),
			"claude-fable-5",
			NOW,
		);
		expect(result.exhausted).toBe(true);
		expect(result.resetAt).toBe(new Date(futureReset).getTime());
	});

	it("reports exhausted for utilization above 100% too", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(143, "Fable", futureReset, overageOff),
			"claude-fable-5",
			NOW,
		);
		expect(result.exhausted).toBe(true);
	});

	it("does NOT report exhausted just below the 100% boundary", () => {
		const result = isAccountExhaustedForModel(
			scopedLimits(99.9, "Fable", futureReset, overageOff),
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

	// ── v3 S4: overage tri-state — only `unavailable` may exclude ──────────────

	describe("overage tri-state (fail-open unless explicitly unavailable)", () => {
		it("stays exhausted (excluded) when extra_usage.is_enabled is explicitly false and no spend block exists", () => {
			const data = scopedLimits(100, "Fable", futureReset, {
				extra_usage: {
					is_enabled: false,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
			});
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(true);
		});

		it("fails open (NOT excluded) when extra_usage.is_enabled is true (overage available)", () => {
			const data = scopedLimits(100, "Fable", futureReset, {
				extra_usage: {
					is_enabled: true,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
			});
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(false);
		});

		it("fails open (NOT excluded) when extra_usage is missing entirely and no spend block exists (unknown, not disabled)", () => {
			const data = scopedLimits(100, "Fable", futureReset);
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(false);
		});

		it("newer spend.enabled=true takes precedence over legacy extra_usage.is_enabled=false", () => {
			const data = scopedLimits(100, "Fable", futureReset, {
				extra_usage: {
					is_enabled: false,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
				spend: { enabled: true },
			});
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(false);
		});

		it("newer spend.enabled=false takes precedence over legacy extra_usage.is_enabled=true", () => {
			const data = scopedLimits(100, "Fable", futureReset, {
				extra_usage: {
					is_enabled: true,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
				spend: { enabled: false },
			});
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(true);
		});

		it("fails open when spend block is present but its enabled field is missing (contradictory/unknown signal)", () => {
			const data = scopedLimits(100, "Fable", futureReset, {
				spend: { disabled_reason: null },
			});
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(false);
		});
	});

	// ── v3 S8/codex-6: two weekly_scoped rows for the same family (e.g. distinct surfaces) ──

	describe("multiple weekly_scoped rows for the same family", () => {
		const twoRows = (percentA: number, percentB: number) =>
			({
				limits: [
					{
						kind: "weekly_scoped",
						percent: percentA,
						resets_at: futureReset,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "cli",
						},
					},
					{
						kind: "weekly_scoped",
						percent: percentB,
						resets_at: futureReset,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "api",
						},
					},
				],
				// Overage confirmed unavailable — "unknown" would correctly fail open.
				spend: { enabled: false },
			}) as never;

		it("fails open when only ONE of two same-family rows is exhausted", () => {
			const result = isAccountExhaustedForModel(
				twoRows(100, 40),
				"claude-fable-5",
				NOW,
			);
			expect(result.exhausted).toBe(false);
		});

		it("excludes only when ALL same-family rows are exhausted", () => {
			const result = isAccountExhaustedForModel(
				twoRows(100, 100),
				"claude-fable-5",
				NOW,
			);
			expect(result.exhausted).toBe(true);
		});

		// The normalizer drops rows with a null/unparsable reset or a missing
		// percent. A dropped same-family row is unproven capacity — the "ALL
		// rows exhausted" rule must fail open, not conclude exhaustion from
		// the surviving rows alone (fresh windows legitimately report
		// resets_at: null in production payloads).
		it("fails open when a second same-family row was dropped by the normalizer (resets_at null)", () => {
			const data = {
				limits: [
					{
						kind: "weekly_scoped",
						percent: 100,
						resets_at: futureReset,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "cli",
						},
					},
					{
						kind: "weekly_scoped",
						percent: 40,
						resets_at: null,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "api",
						},
					},
				],
				spend: { enabled: false },
			} as never;
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(false);
		});

		it("fails open when a second same-family row was dropped by the normalizer (percent missing)", () => {
			const data = {
				limits: [
					{
						kind: "weekly_scoped",
						percent: 100,
						resets_at: futureReset,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "cli",
						},
					},
					{
						kind: "weekly_scoped",
						resets_at: futureReset,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: "api",
						},
					},
				],
				spend: { enabled: false },
			} as never;
			expect(
				isAccountExhaustedForModel(data, "claude-fable-5", NOW).exhausted,
			).toBe(false);
		});
	});
});

// ── resolveOverageStatus (v3 tri-state resolver, codex-3) ──────────────────────

describe("resolveOverageStatus", () => {
	it("returns 'unknown' when neither spend nor extra_usage is present", () => {
		expect(resolveOverageStatus({} as never)).toBe("unknown");
		expect(resolveOverageStatus(null)).toBe("unknown");
		expect(resolveOverageStatus(undefined)).toBe("unknown");
	});

	it("returns 'unavailable' from legacy extra_usage.is_enabled=false", () => {
		expect(
			resolveOverageStatus({
				extra_usage: {
					is_enabled: false,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
			} as never),
		).toBe("unavailable");
	});

	it("returns 'available' from legacy extra_usage.is_enabled=true", () => {
		expect(
			resolveOverageStatus({
				extra_usage: {
					is_enabled: true,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
			} as never),
		).toBe("available");
	});

	it("prefers spend.enabled over extra_usage.is_enabled when both present", () => {
		expect(
			resolveOverageStatus({
				extra_usage: {
					is_enabled: true,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
				spend: { enabled: false },
			} as never),
		).toBe("unavailable");
		expect(
			resolveOverageStatus({
				extra_usage: {
					is_enabled: false,
					monthly_limit: null,
					used_credits: null,
					utilization: null,
				},
				spend: { enabled: true },
			} as never),
		).toBe("available");
	});

	it("returns 'unknown' when spend is present but its enabled field is absent", () => {
		expect(resolveOverageStatus({ spend: {} } as never)).toBe("unknown");
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

	// v3 Fix1: the TTL is ALWAYS the fixed 5-minute default now — there is no
	// longer a longer-lived seeding path from a scoped reset (findScopedResetAt
	// is removed). Any untilMs the caller passes beyond 5 minutes must still be
	// honored (callers may deliberately want a shorter cap), but nothing in
	// model-capacity.ts itself extends the TTL past 5 minutes on its own.
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

	// ── v3 Revision v2 Fix1: signal provenance ────────────────────────────────

	describe("signal provenance (telemetry_confirmed vs recent_upstream_rejection)", () => {
		it("defaults to 'recent_upstream_rejection' origin when not specified (today's only caller: reactive out_of_credits)", () => {
			markFamilyExhausted("acc-1", "fable", NOW + 60_000, NOW);
			expect(getFamilyExhaustionOrigin("acc-1", "fable", NOW)).toBe(
				"recent_upstream_rejection",
			);
		});

		it("stores an explicitly-passed 'telemetry_confirmed' origin", () => {
			markFamilyExhausted(
				"acc-1",
				"fable",
				NOW + 60_000,
				NOW,
				"telemetry_confirmed",
			);
			expect(getFamilyExhaustionOrigin("acc-1", "fable", NOW)).toBe(
				"telemetry_confirmed",
			);
		});

		it("returns null for the origin when nothing is marked, or after expiry", () => {
			expect(getFamilyExhaustionOrigin("acc-1", "fable", NOW)).toBeNull();
			markFamilyExhausted("acc-1", "fable", NOW + 60_000, NOW);
			expect(
				getFamilyExhaustionOrigin("acc-1", "fable", NOW + 60_001),
			).toBeNull();
		});
	});
});

// ── createModelFamilyExhaustedResponse ──────────────────────────────────────────

describe("createModelFamilyExhaustedResponse", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);

	// v3 Fix4 (Revision v2, codex-8): 429 (not 529), Anthropic-compatible
	// error.type "rate_limit_error" + a separate machine-readable
	// error.code "model_family_exhausted".
	it("returns HTTP 429 with error.type rate_limit_error and error.code model_family_exhausted", async () => {
		const realNow = Date.now;
		Date.now = () => NOW;
		try {
			const resetAt = NOW + 90_000;
			const response = createModelFamilyExhaustedResponse({
				family: "fable",
				resetAt,
				origin: "telemetry_confirmed",
			});

			expect(response.status).toBe(429);
			expect(response.headers.get("Retry-After")).toBe("90");

			const body = (await response.json()) as {
				type: string;
				error: {
					type: string;
					code: string;
					family: string;
					resetAt: number | null;
				};
			};
			expect(body.type).toBe("error");
			expect(body.error.type).toBe("rate_limit_error");
			expect(body.error.code).toBe("model_family_exhausted");
			expect(body.error.family).toBe("fable");
			expect(body.error.resetAt).toBe(resetAt);
		} finally {
			Date.now = realNow;
		}
	});

	it("falls back to a default Retry-After of 60s when resetAt is unknown", async () => {
		const response = createModelFamilyExhaustedResponse({
			family: "sonnet",
			resetAt: null,
			origin: "recent_upstream_rejection",
		});
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
	});

	// v3 Fix4 precise formula: max(1, min(3600, ceil((resetAt-now)/1000))).
	describe("Retry-After clamping", () => {
		it("clamps to 1 (never 0 or negative) when resetAt has already passed", async () => {
			const realNow = Date.now;
			Date.now = () => NOW;
			try {
				const response = createModelFamilyExhaustedResponse({
					family: "fable",
					resetAt: NOW - 5_000,
					origin: "telemetry_confirmed",
				});
				expect(response.headers.get("Retry-After")).toBe("1");
			} finally {
				Date.now = realNow;
			}
		});

		it("clamps to 1 when resetAt is only a fraction of a second away", async () => {
			const realNow = Date.now;
			Date.now = () => NOW;
			try {
				const response = createModelFamilyExhaustedResponse({
					family: "fable",
					resetAt: NOW + 500,
					origin: "telemetry_confirmed",
				});
				expect(response.headers.get("Retry-After")).toBe("1");
			} finally {
				Date.now = realNow;
			}
		});

		it("caps at 3600 (1h) when resetAt is multiple days away", async () => {
			const realNow = Date.now;
			Date.now = () => NOW;
			try {
				const response = createModelFamilyExhaustedResponse({
					family: "fable",
					resetAt: NOW + 3 * 24 * 60 * 60 * 1000,
					origin: "telemetry_confirmed",
				});
				expect(response.headers.get("Retry-After")).toBe("3600");
			} finally {
				Date.now = realNow;
			}
		});

		it("defaults to 60 when resetAt is unknown/null", async () => {
			const response = createModelFamilyExhaustedResponse({
				family: "fable",
				resetAt: null,
				origin: "recent_upstream_rejection",
			});
			expect(response.headers.get("Retry-After")).toBe("60");
		});
	});

	// v3 S5 / Revision v2 Fix1: only telemetry-confirmed exhaustion may assert
	// "weekly capacity exhausted"; a purely reactive (out_of_credits-derived)
	// mark must produce a neutral message that does not claim weekly capacity.
	describe("message wording by signal provenance", () => {
		it("asserts weekly capacity exhaustion when origin is telemetry_confirmed", async () => {
			const response = createModelFamilyExhaustedResponse({
				family: "fable",
				resetAt: NOW + 90_000,
				origin: "telemetry_confirmed",
			});
			const body = (await response.json()) as { error: { message: string } };
			expect(body.error.message.toLowerCase()).toContain("weekly");
		});

		it("uses neutral wording (no weekly-capacity claim) when origin is recent_upstream_rejection", async () => {
			const response = createModelFamilyExhaustedResponse({
				family: "fable",
				resetAt: null,
				origin: "recent_upstream_rejection",
			});
			const body = (await response.json()) as { error: { message: string } };
			expect(body.error.message.toLowerCase()).not.toContain("weekly");
			expect(body.error.message.toLowerCase()).toContain("recently rejected");
		});
	});
});
