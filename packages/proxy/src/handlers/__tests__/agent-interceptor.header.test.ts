import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import { agentRegistry } from "@better-ccflare/agents";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type { Agent } from "@better-ccflare/types";
import type { ModelCatalog } from "../../model-catalog";
import { interceptAndModifyRequest } from "../agent-interceptor";

const TEST_DB_PATH = "/tmp/test-agent-interceptor-header.db";

/**
 * Tests for the X-Anthropic-Agent-Id explicit-attribution header path:
 * header takes precedence over system-prompt matching, honors model
 * preference substitution, and is bounded by a length cap.
 */
describe("Agent Interceptor - X-Anthropic-Agent-Id Header", () => {
	let dbOps: DatabaseOperations;

	function createMockRequestBody(
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			model: "claude-3-5-sonnet-20241022",
			messages: [{ role: "user", content: "test message" }],
			system: "a benign system prompt",
			max_tokens: 1024,
			...overrides,
		};
	}

	function toArrayBuffer(obj: Record<string, unknown>): ArrayBuffer {
		const encoder = new TextEncoder();
		const bytes = encoder.encode(JSON.stringify(obj));
		const buffer = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(buffer).set(bytes);
		return buffer;
	}

	function headers(pairs: Record<string, string>): Headers {
		return new Headers(pairs);
	}

	// Model-preference substitution tests below assert a rewrite to a fake
	// model id succeeds. Left un-injected, interceptAndModifyRequest falls
	// through to the real getModelCatalog(), which reads this machine's
	// actual disk cache — a live, non-empty catalog that (correctly) doesn't
	// contain the fake id, vetoing the rewrite. This suite is about
	// preference precedence, not catalog serviceability (that's covered by
	// agent-interceptor.rewrite-guard.test.ts), so inject a catalog that
	// never vetoes, isolating these tests from the host's real cache state.
	function nonVetoingCatalog(): ModelCatalog {
		return { models: [], fetchedAt: Date.now(), source: "fallback" };
	}

	beforeAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
	});

	afterAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
		DatabaseFactory.reset();
	});

	describe("Precedence over system-prompt matching", () => {
		test("header value is used as agentUsed when present", async () => {
			const buffer = toArrayBuffer(createMockRequestBody());
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({ "x-anthropic-agent-id": "my-router-agent" }),
			);
			expect(result.agentUsed).toBe("my-router-agent");
			expect(result.agentAttributionSource).toBe("header_agent");
		});

		test("header is case-insensitive", async () => {
			const buffer = toArrayBuffer(createMockRequestBody());
			// mixed-case header name must still resolve
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({ "X-Anthropic-Agent-Id": "case-insensitive-agent" }),
			);
			expect(result.agentUsed).toBe("case-insensitive-agent");
			expect(result.agentAttributionSource).toBe("header_agent");
		});

		test("absent header falls through to system-prompt path (unchanged)", async () => {
			const buffer = toArrayBuffer(createMockRequestBody());
			const result = await interceptAndModifyRequest(buffer, dbOps);
			// No explicit header and a benign prompt => no agent detected
			expect(result.agentUsed).toBeNull();
			expect(result.modifiedBody).toBe(buffer);
			expect(result.agentAttributionSource).toBe("none");
		});
	});

	describe("x-better-ccflare-agent-id namespaced header alias", () => {
		test("namespaced header present -> agentUsed is header value, source is header_agent", async () => {
			const buffer = toArrayBuffer(createMockRequestBody());
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({ "x-better-ccflare-agent-id": "namespaced-agent" }),
			);
			expect(result.agentUsed).toBe("namespaced-agent");
			expect(result.agentAttributionSource).toBe("header_agent");
		});

		test("both namespaced and legacy headers present -> namespaced header wins deterministically", async () => {
			const buffer = toArrayBuffer(createMockRequestBody());
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({
					"x-better-ccflare-agent-id": "namespaced-agent",
					"x-anthropic-agent-id": "legacy-agent",
				}),
			);
			expect(result.agentUsed).toBe("namespaced-agent");
			expect(result.agentAttributionSource).toBe("header_agent");
		});

		test("trims surrounding whitespace before use", async () => {
			const buffer = toArrayBuffer(createMockRequestBody());
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({
					"x-better-ccflare-agent-id": "  trimmed-namespaced-agent  ",
				}),
			);
			expect(result.agentUsed).toBe("trimmed-namespaced-agent");
			expect(result.agentAttributionSource).toBe("header_agent");
		});

		test("caps value at 256 characters", async () => {
			const longId = "b".repeat(500);
			const buffer = toArrayBuffer(createMockRequestBody());
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({ "x-better-ccflare-agent-id": longId }),
			);
			expect(result.agentUsed).toHaveLength(256);
			expect(result.agentUsed).toBe("b".repeat(256));
			expect(result.agentAttributionSource).toBe("header_agent");
		});
	});

	describe("Attribution source for prompt/registry-based detection", () => {
		test("detected agent via system-prompt match -> source is prompt_agent", async () => {
			const fakeAgent: Agent = {
				id: "fixture-prompt-agent",
				name: "Fixture Prompt Agent",
				description: "Test fixture agent for prompt-match source labeling",
				color: "gray",
				model: "claude-3-5-sonnet-20241022",
				systemPrompt: "You are the fixture-prompt-agent-83f2 test agent.",
				source: "global",
				filePath: "/tmp/fixture-prompt-agent.md",
			};

			// The agent-interceptor imports the agentRegistry singleton directly,
			// so we stub its getAgents() for the duration of this test rather than
			// writing real workspace/global agent files to disk.
			const originalGetAgents = agentRegistry.getAgents.bind(agentRegistry);
			agentRegistry.getAgents = async () => [fakeAgent];

			try {
				const buffer = toArrayBuffer(
					createMockRequestBody({
						system: `Some preamble.\n${fakeAgent.systemPrompt}\nSome epilogue.`,
					}),
				);
				const result = await interceptAndModifyRequest(buffer, dbOps);
				expect(result.agentUsed).toBe("fixture-prompt-agent");
				expect(result.agentAttributionSource).toBe("prompt_agent");
			} finally {
				agentRegistry.getAgents = originalGetAgents;
			}
		});
	});

	describe("Model-preference substitution", () => {
		test("applies configured preference for the declared agent", async () => {
			await dbOps.setAgentPreference("preferred-agent", "claude-opus-model");
			const buffer = toArrayBuffer(
				createMockRequestBody({ model: "claude-3-5-sonnet-20241022" }),
			);
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({ "x-anthropic-agent-id": "preferred-agent" }),
				{ getModelCatalog: async () => nonVetoingCatalog() },
			);
			expect(result.agentUsed).toBe("preferred-agent");
			expect(result.agentAttributionSource).toBe("header_agent");
			expect(result.originalModel).toBe("claude-3-5-sonnet-20241022");
			expect(result.appliedModel).toBe("claude-opus-model");
			expect(result.modifiedBody).not.toBe(buffer);
			const modified = JSON.parse(
				new TextDecoder().decode(result.modifiedBody),
			);
			expect(modified.model).toBe("claude-opus-model");
		});

		test("returns original model when no preference configured", async () => {
			const buffer = toArrayBuffer(
				createMockRequestBody({ model: "claude-3-5-sonnet-20241022" }),
			);
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({ "x-anthropic-agent-id": "no-pref-agent" }),
			);
			expect(result.agentUsed).toBe("no-pref-agent");
			expect(result.agentAttributionSource).toBe("header_agent");
			expect(result.originalModel).toBe("claude-3-5-sonnet-20241022");
			expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
			// No substitution => body passed through unchanged
			expect(result.modifiedBody).toBe(buffer);
		});

		test("does not rewrite body when preferred model equals requested model", async () => {
			await dbOps.setAgentPreference(
				"same-model-agent",
				"claude-3-5-sonnet-20241022",
			);
			const buffer = toArrayBuffer(
				createMockRequestBody({ model: "claude-3-5-sonnet-20241022" }),
			);
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({ "x-anthropic-agent-id": "same-model-agent" }),
			);
			expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
			expect(result.modifiedBody).toBe(buffer);
		});
	});

	describe("Length cap and trimming", () => {
		test("trims surrounding whitespace before use", async () => {
			const buffer = toArrayBuffer(createMockRequestBody());
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({ "x-anthropic-agent-id": "  trimmed-agent  " }),
			);
			expect(result.agentUsed).toBe("trimmed-agent");
			expect(result.agentAttributionSource).toBe("header_agent");
		});

		test("caps value at 256 characters", async () => {
			const longId = "a".repeat(500);
			const buffer = toArrayBuffer(createMockRequestBody());
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({ "x-anthropic-agent-id": longId }),
			);
			expect(result.agentUsed).toHaveLength(256);
			expect(result.agentUsed).toBe("a".repeat(256));
			expect(result.agentAttributionSource).toBe("header_agent");
		});

		test("empty/whitespace-only header is treated as absent", async () => {
			const buffer = toArrayBuffer(createMockRequestBody());
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				headers({ "x-anthropic-agent-id": "   " }),
			);
			// Falls through to system-prompt path => no agent from a benign prompt
			expect(result.agentUsed).toBeNull();
			expect(result.agentAttributionSource).toBe("none");
		});
	});
});
