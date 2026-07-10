import { describe, expect, it } from "bun:test";
import type { APIContext } from "@better-ccflare/types";
import { allowedModelErrorMessage, isAllowedModel } from "../model-validation";

function makeCatalog(
	models: string[],
	source: "live" | "fallback" = "live",
): APIContext["modelCatalog"] {
	return {
		get: async () => ({
			models: models.map((id) => ({ id, displayName: id, createdAt: null })),
			fetchedAt: Date.now(),
			source,
		}),
		refresh: async () => ({ success: true }),
	};
}

describe("isAllowedModel", () => {
	it("accepts a pattern-matching model even without a catalog", async () => {
		expect(await isAllowedModel("claude-sonnet-5", undefined)).toBe(true);
	});

	it("rejects a non-pattern model when no catalog is injected", async () => {
		expect(await isAllowedModel("claude-nova-9", undefined)).toBe(false);
	});

	it("accepts a non-pattern model present in a live catalog", async () => {
		const catalog = makeCatalog(["claude-nova-9"], "live");
		expect(await isAllowedModel("claude-nova-9", catalog)).toBe(true);
	});

	it("rejects a non-pattern model absent from a live catalog", async () => {
		const catalog = makeCatalog(["claude-other-model"], "live");
		expect(await isAllowedModel("claude-nova-9", catalog)).toBe(false);
	});

	it("rejects a non-pattern model when the catalog is a fallback", async () => {
		const catalog = makeCatalog(["claude-nova-9"], "fallback");
		expect(await isAllowedModel("claude-nova-9", catalog)).toBe(false);
	});

	it("fails open to pattern-only when the catalog getter throws", async () => {
		const catalog: APIContext["modelCatalog"] = {
			get: async () => {
				throw new Error("catalog unavailable");
			},
			refresh: async () => ({ success: true }),
		};
		expect(await isAllowedModel("claude-nova-9", catalog)).toBe(false);
		expect(await isAllowedModel("claude-sonnet-5", catalog)).toBe(true);
	});
});

describe("allowedModelErrorMessage", () => {
	it("mentions both the pattern rule and the live catalog", () => {
		const message = allowedModelErrorMessage();
		expect(message).toContain("fable");
		expect(message).toContain("live Anthropic model catalog");
	});
});
