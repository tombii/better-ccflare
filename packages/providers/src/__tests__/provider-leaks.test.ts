import { describe, expect, it } from "bun:test";
import {
	clearDerivedProviderModelDefaults,
	clearDerivedProviderModelDefaultsForAccount,
	hasDerivedProviderModelDefaults,
	setDerivedProviderModelDefaults,
} from "../provider-model-defaults";
import { usageCache } from "../usage-fetcher";

describe("derived defaults per-account removal", () => {
	it("removes only the given account across providers", () => {
		clearDerivedProviderModelDefaults();
		setDerivedProviderModelDefaults("codex", "a1", { opus: "x" });
		setDerivedProviderModelDefaults("codex", "a2", { opus: "y" });
		setDerivedProviderModelDefaults("openai-compatible", "a1", { opus: "z" });
		clearDerivedProviderModelDefaultsForAccount("a1");
		expect(hasDerivedProviderModelDefaults("codex", "a1")).toBe(false);
		expect(hasDerivedProviderModelDefaults("openai-compatible", "a1")).toBe(
			false,
		);
		expect(hasDerivedProviderModelDefaults("codex", "a2")).toBe(true);
		clearDerivedProviderModelDefaults();
	});

	it("does not remove an account whose id has the removed id as a suffix", () => {
		clearDerivedProviderModelDefaults();
		setDerivedProviderModelDefaults("codex", "a1", { opus: "x" });
		setDerivedProviderModelDefaults("codex", "xa1", { opus: "y" });
		clearDerivedProviderModelDefaultsForAccount("a1");
		expect(hasDerivedProviderModelDefaults("codex", "a1")).toBe(false);
		expect(hasDerivedProviderModelDefaults("codex", "xa1")).toBe(true);
		clearDerivedProviderModelDefaults();
	});
});

describe("UsageCache.stopPolling", () => {
	it("clears provider type and custom endpoint tracking", () => {
		const cache = usageCache as unknown as {
			providerTypes: Map<string, string>;
			customEndpoints: Map<string, string | null>;
			tokenProviders: Map<string, unknown>;
			stopPolling(id: string): void;
		};
		cache.tokenProviders.set("acc", async () => "t");
		cache.providerTypes.set("acc", "zai");
		cache.customEndpoints.set("acc", null);
		cache.stopPolling("acc");
		expect(cache.providerTypes.has("acc")).toBe(false);
		expect(cache.customEndpoints.has("acc")).toBe(false);
	});
});
