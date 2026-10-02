import { describe, expect, it } from "bun:test";
import { shouldRefetchOnOpen } from "../useRequestStream";

describe("shouldRefetchOnOpen", () => {
	it("does not refetch on the first open", () => {
		expect(shouldRefetchOnOpen(false, 0)).toBe(false);
	});

	it("refetches when the same stream re-opens", () => {
		expect(shouldRefetchOnOpen(true, 0)).toBe(true);
	});

	it("refetches on a retried connection's first open", () => {
		expect(shouldRefetchOnOpen(false, 1)).toBe(true);
	});
});
