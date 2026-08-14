import { afterEach, describe, expect, it } from "bun:test";
import { isComboSessionFallbackDisabled } from "../account-selector";
import type { ProxyContext } from "../proxy-types";

// The guard reads the config and nothing else. The old environment variable is
// adopted into that config once, at boot, so that the dashboard switch is the
// answer instead of one opinion among two — these pin exactly that.

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
	it("reads the config", () => {
		expect(isComboSessionFallbackDisabled(ctxWith(false))).toBe(true);
		expect(isComboSessionFallbackDisabled(ctxWith(true))).toBe(false);
	});

	it("ignores the legacy environment variable at request time", () => {
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "true";
		expect(isComboSessionFallbackDisabled(ctxWith(true))).toBe(false);
	});

	it("leaves a context without a config on the historical behaviour", () => {
		// No config means no operator to ask. Applying the new default there
		// would change what happens for callers who never chose it.
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "true";
		expect(isComboSessionFallbackDisabled(ctxWith())).toBe(false);
	});
});
