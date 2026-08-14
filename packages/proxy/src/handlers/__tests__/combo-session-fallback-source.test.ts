import { afterEach, describe, expect, it } from "bun:test";
import { isComboSessionFallbackDisabled } from "../account-selector";
import type { ProxyContext } from "../proxy-types";

// The guard moved from reading process.env directly to reading the config, so
// the dashboard can own it. These pin the two things that must not change:
// the config decides when there is one, and the env var still decides when
// there is not.

function ctxWith(fallbackAllowed?: boolean): ProxyContext {
	return (fallbackAllowed === undefined
		? {}
		: {
				config: { getComboSessionFallback: () => fallbackAllowed },
			}) as unknown as ProxyContext;
}

afterEach(() => {
	delete process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
});

describe("isComboSessionFallbackDisabled", () => {
	it("is not disabled by default", () => {
		expect(isComboSessionFallbackDisabled(ctxWith())).toBe(false);
	});

	it("reads the config when the context has one", () => {
		expect(isComboSessionFallbackDisabled(ctxWith(false))).toBe(true);
		expect(isComboSessionFallbackDisabled(ctxWith(true))).toBe(false);
	});

	it("lets the config win over the env var", () => {
		// The config value already accounts for env precedence (Config resolves
		// env > file > default), so the handler must not second-guess it here —
		// otherwise the env var would be applied twice, and an operator who
		// turned the fallback back on could never do so.
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "true";
		expect(isComboSessionFallbackDisabled(ctxWith(true))).toBe(false);
	});

	it("falls back to the env var when the context has no config", () => {
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "yes";
		expect(isComboSessionFallbackDisabled(ctxWith())).toBe(true);
	});
});
