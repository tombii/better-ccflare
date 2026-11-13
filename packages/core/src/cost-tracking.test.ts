import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { getCostTrackingEpoch, setCostTrackingEnabled } from "./cost-tracking";
import { estimateCostUSD } from "./pricing";

afterEach(() => setCostTrackingEnabled(true));

describe("disabled cost estimates", () => {
	it("never loads or consults the catalogue when tracking is disabled", async () => {
		setCostTrackingEnabled(false);
		const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("unexpected catalogue fetch"),
		);
		try {
			expect(
				await estimateCostUSD("claude-opus-4-6", { inputTokens: 1_000_000 }),
			).toBe(0);
			expect(fetcher).not.toHaveBeenCalled();
		} finally {
			fetcher.mockRestore();
		}
	});
	it("changes the generation across an off/on gap", () => {
		const before = getCostTrackingEpoch();
		setCostTrackingEnabled(false);
		setCostTrackingEnabled(true);
		expect(getCostTrackingEpoch()).toBeGreaterThan(before);
	});
});
