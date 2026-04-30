/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { CodexProvider, OpenAICompatibleProvider } from "@better-ccflare/providers";
import { validateProviderPath } from "../request-handler";

describe("validateProviderPath", () => {
	it("accepts count_tokens for OpenAI-compatible provider", () => {
		expect(() =>
			validateProviderPath(
				new OpenAICompatibleProvider(),
				"/v1/messages/count_tokens",
			),
		).not.toThrow();
	});

	it("accepts count_tokens for Codex provider", () => {
		expect(() =>
			validateProviderPath(new CodexProvider(), "/v1/messages/count_tokens"),
		).not.toThrow();
	});
});
