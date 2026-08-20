import { describe, expect, it } from "bun:test";
import { resolveXaiContextWindow } from "./xai";

describe("resolveXaiContextWindow", () => {
	it("resolves grok-4.5 and grok-4.6 at the official 500k window", () => {
		expect(resolveXaiContextWindow("grok-4.6")).toEqual({
			family: "grok-4.6",
			contextWindow: 500_000,
			match: "exact",
		});
		expect(resolveXaiContextWindow("grok-4.5")).toEqual({
			family: "grok-4.5",
			contextWindow: 500_000,
			match: "exact",
		});
	});

	it("resolves dated or suffixed grok-4.6 variants by the longest family prefix", () => {
		expect(resolveXaiContextWindow("grok-4.6-beta")).toEqual({
			family: "grok-4.6",
			contextWindow: 500_000,
			match: "prefix",
		});
	});

	it("does not treat original grok-4 as a 500k model", () => {
		expect(resolveXaiContextWindow("grok-4")).toBeUndefined();
		expect(resolveXaiContextWindow("grok-4-0709")).toBeUndefined();
	});

	it("returns undefined for empty or unrelated model ids", () => {
		expect(resolveXaiContextWindow("")).toBeUndefined();
		expect(resolveXaiContextWindow("gpt-5.6-sol")).toBeUndefined();
		expect(resolveXaiContextWindow("claude-fable-5")).toBeUndefined();
	});
});
