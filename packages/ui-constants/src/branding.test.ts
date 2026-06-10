import { describe, expect, it } from "bun:test";
import {
	PACKAGE_NAME,
	PRODUCT_NAME,
	REPOSITORY_URL,
	UPSTREAM_REPOSITORY_URL,
} from "./branding";

describe("branding constants", () => {
	it("exposes the fork product name for user-visible surfaces", () => {
		expect(PRODUCT_NAME).toBe("the-best-ccflare");
	});

	it("keeps the npm package and CLI binary name for compatibility", () => {
		expect(PACKAGE_NAME).toBe("better-ccflare");
	});

	it("points repository metadata at the fork", () => {
		expect(REPOSITORY_URL).toBe(
			"https://github.com/omcdowell/the-best-ccflare",
		);
	});

	it("preserves upstream attribution URL", () => {
		expect(UPSTREAM_REPOSITORY_URL).toBe(
			"https://github.com/tombii/better-ccflare",
		);
	});
});
