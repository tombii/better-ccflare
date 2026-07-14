import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	canonicalizeBetaSignature,
	MODEL_SCOPED_DEPLETION_TTL_MS,
	usageCache,
} from "../usage-fetcher";

const ACCOUNT = "model-depletion-test";
const NOW = 1_800_000_000_000;
const realDateNow = Date.now;

beforeEach(() => {
	Date.now = () => NOW;
});

afterEach(() => {
	Date.now = realDateNow;
	usageCache.delete(ACCOUNT);
});

describe("UsageCache model-scoped depletion", () => {
	it("marks an exact model without blocking versions or other families", () => {
		usageCache.markModelScopedExhausted(
			ACCOUNT,
			"claude-fable-5",
			"context-1m, beta-b",
		);
		expect(
			usageCache.getModelScopedExhaustion(
				ACCOUNT,
				"claude-fable-5",
				"beta-b,context-1m",
				NOW,
			),
		).toEqual({
			exhausted: true,
			markedAt: NOW,
			expiresAt: NOW + MODEL_SCOPED_DEPLETION_TTL_MS,
		});
		expect(
			usageCache.getModelScopedExhaustion(
				ACCOUNT,
				"claude-fable-5-20260701",
				"context-1m,beta-b",
				NOW,
			),
		).toBeNull();
		expect(
			usageCache.getModelScopedExhaustion(
				ACCOUNT,
				"claude-opus-4-8",
				"context-1m,beta-b",
				NOW,
			),
		).toBeNull();
	});
	it("keeps beta configurations isolated and canonical", () => {
		usageCache.markModelScopedExhausted(
			ACCOUNT,
			"claude-fable-5",
			" Beta-B,context-1m,beta-b ",
			NOW + 10_000,
		);
		expect(canonicalizeBetaSignature(" Beta-B,context-1m,beta-b ")).toBe(
			"beta-b,context-1m",
		);
		expect(
			usageCache.getModelScopedExhaustion(
				ACCOUNT,
				"claude-fable-5",
				"context-1m,beta-b",
				NOW,
			),
		).not.toBeNull();
		expect(
			usageCache.getModelScopedExhaustion(
				ACCOUNT,
				"claude-fable-5",
				"other-beta",
				NOW,
			),
		).toBeNull();
	});

	it("matches unknown models exactly and expires lazily", () => {
		usageCache.markModelScopedExhausted(
			ACCOUNT,
			"custom-model-A",
			null,
			NOW + 100,
		);
		expect(
			usageCache.getModelScopedExhaustion(ACCOUNT, "CUSTOM-MODEL-A", null, NOW),
		).not.toBeNull();
		expect(
			usageCache.getModelScopedExhaustion(ACCOUNT, "custom-model-B", null, NOW),
		).toBeNull();
		expect(
			usageCache.getModelScopedExhaustion(
				ACCOUNT,
				"custom-model-A",
				null,
				NOW + 100,
			),
		).toBeNull();
	});

	it("bounds marker growth per account", () => {
		for (let i = 0; i < 65; i++) {
			usageCache.markModelScopedExhausted(
				ACCOUNT,
				`unknown-model-${i}`,
				null,
				NOW + 10_000,
			);
		}
		expect(
			usageCache.getModelScopedExhaustion(
				ACCOUNT,
				"unknown-model-0",
				null,
				NOW,
			),
		).toBeNull();
		expect(
			usageCache.getModelScopedExhaustion(
				ACCOUNT,
				"unknown-model-64",
				null,
				NOW,
			),
		).not.toBeNull();
	});

	it("authoritative set preserves TTL evidence while delete clears it", () => {
		usageCache.markModelScopedExhausted(
			ACCOUNT,
			"claude-fable-5",
			null,
			NOW + 10_000,
		);
		usageCache.set(ACCOUNT, {
			five_hour: { utilization: 1, resets_at: null },
			seven_day: { utilization: 1, resets_at: null },
		});
		expect(
			usageCache.getModelScopedExhaustion(ACCOUNT, "claude-fable-5", null, NOW),
		).not.toBeNull();

		usageCache.markModelScopedExhausted(
			ACCOUNT,
			"claude-fable-5",
			null,
			NOW + 10_000,
		);
		usageCache.delete(ACCOUNT);
		expect(
			usageCache.getModelScopedExhaustion(ACCOUNT, "claude-fable-5", null, NOW),
		).toBeNull();
	});
});
