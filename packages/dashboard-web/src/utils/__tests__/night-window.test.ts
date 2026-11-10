import { describe, expect, it } from "bun:test";
import {
	nightWindowTitle,
	providerSupportsNightWindow,
} from "../provider-utils";

/**
 * The night-window toggle is shown per provider, so the gate here has to match
 * the providers that register a tier adapter on the server. Sail Research is
 * currently the only one.
 */
describe("providerSupportsNightWindow", () => {
	it("shows the toggle for sailresearch", () => {
		expect(providerSupportsNightWindow("sailresearch")).toBe(true);
	});

	it("hides the toggle for providers with no tier adapter", () => {
		for (const provider of [
			"anthropic",
			"deepseek",
			"openai-compatible",
			"codex",
			"zai",
			"",
		]) {
			expect(providerSupportsNightWindow(provider)).toBe(false);
		}
	});
});

describe("nightWindowTitle", () => {
	it("names the tier Sail will be asked for", () => {
		expect(nightWindowTitle("sailresearch")).toContain('"balanced"');
	});

	it("makes clear no header is sent outside the window", () => {
		expect(nightWindowTitle("sailresearch")).toContain(
			"No header is sent outside the window",
		);
	});
});
