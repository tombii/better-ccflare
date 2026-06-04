import { describe, expect, it } from "bun:test";
import {
	ProviderPrefixError,
	resolveProviderPrefixedPath,
	tryResolveProviderPrefixedPath,
} from "../provider-prefixed-path";

describe("resolveProviderPrefixedPath", () => {
	it("resolves /v1/codex/responses to codex provider with /responses upstream", () => {
		const route = resolveProviderPrefixedPath("/v1/codex/responses");
		expect(route).toEqual({
			provider: "codex",
			clientPath: "/v1/codex/responses",
			upstreamPath: "/responses",
		});
	});

	it("resolves /v1/openai/responses to openai-compatible with /responses upstream", () => {
		const route = resolveProviderPrefixedPath("/v1/openai/responses");
		expect(route).toEqual({
			provider: "openai-compatible",
			clientPath: "/v1/openai/responses",
			upstreamPath: "/responses",
		});
	});

	it("resolves /v1/openai/chat/completions to openai-compatible with /chat/completions upstream", () => {
		const route = resolveProviderPrefixedPath("/v1/openai/chat/completions");
		expect(route).toEqual({
			provider: "openai-compatible",
			clientPath: "/v1/openai/chat/completions",
			upstreamPath: "/chat/completions",
		});
	});

	it("resolves /v1/anthropic/v1/messages to anthropic with /v1/messages upstream", () => {
		const route = resolveProviderPrefixedPath("/v1/anthropic/v1/messages");
		expect(route).toEqual({
			provider: "anthropic",
			clientPath: "/v1/anthropic/v1/messages",
			upstreamPath: "/v1/messages",
		});
	});

	it("preserves upstream path segments beyond /responses for resolver output", () => {
		expect(() =>
			resolveProviderPrefixedPath("/v1/codex/responses/extra"),
		).toThrow(ProviderPrefixError);
	});

	it("rejects unknown providers explicitly", () => {
		expect(() => resolveProviderPrefixedPath("/v1/unknown/responses")).toThrow(
			ProviderPrefixError,
		);
		try {
			resolveProviderPrefixedPath("/v1/unknown/responses");
		} catch (error) {
			expect(error).toBeInstanceOf(ProviderPrefixError);
			expect((error as ProviderPrefixError).code).toBe("unknown_provider");
		}
	});

	it("rejects empty provider segments", () => {
		expect(() => resolveProviderPrefixedPath("/v1//responses")).toThrow(
			ProviderPrefixError,
		);
		try {
			resolveProviderPrefixedPath("/v1//responses");
		} catch (error) {
			expect((error as ProviderPrefixError).code).toBe("empty_provider");
		}
	});

	it("rejects repeated provider prefixes as unsupported native paths", () => {
		expect(() =>
			resolveProviderPrefixedPath("/v1/codex/codex/responses"),
		).toThrow(ProviderPrefixError);
		try {
			resolveProviderPrefixedPath("/v1/codex/codex/responses");
		} catch (error) {
			expect((error as ProviderPrefixError).code).toBe(
				"unsupported_native_path",
			);
		}
	});

	it("treats provider names as case-sensitive", () => {
		expect(() => resolveProviderPrefixedPath("/v1/Codex/responses")).toThrow(
			ProviderPrefixError,
		);
		try {
			resolveProviderPrefixedPath("/v1/Codex/responses");
		} catch (error) {
			expect((error as ProviderPrefixError).code).toBe("unknown_provider");
		}
	});

	it("rejects unsupported native paths for known providers", () => {
		expect(() => resolveProviderPrefixedPath("/v1/codex/messages")).toThrow(
			ProviderPrefixError,
		);
		expect(() => resolveProviderPrefixedPath("/v1/openai/messages")).toThrow(
			ProviderPrefixError,
		);
		expect(() => resolveProviderPrefixedPath("/v1/anthropic/messages")).toThrow(
			ProviderPrefixError,
		);
	});

	it("returns null from tryResolve when path is not provider-prefixed", () => {
		expect(tryResolveProviderPrefixedPath("/v1/messages")).toBeNull();
		expect(tryResolveProviderPrefixedPath("/v1/responses")).toBeNull();
		expect(tryResolveProviderPrefixedPath("/v1/responses/compact")).toBeNull();
		expect(
			tryResolveProviderPrefixedPath("/v1/messages/count_tokens"),
		).toBeNull();
	});

	it("returns explicit errors for unknown provider-prefixed paths", () => {
		const resolution = tryResolveProviderPrefixedPath("/v1/unknown/responses");
		expect(resolution?.ok).toBeFalse();
		if (resolution && !resolution.ok) {
			expect(resolution.error.code).toBe("unknown_provider");
		}
	});
});
