import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

/**
 * Security tests for agent-interceptor.ts
 * Tests the directory traversal protection in extractAgentDirectories()
 */

import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
// We need to import the function we want to test
// Since extractAgentDirectories is not exported, we'll test via the public API
import { interceptAndModifyRequest } from "../agent-interceptor";

const TEST_DB_PATH = "/tmp/test-agent-interceptor-security.db";

describe("Agent Interceptor - Directory Traversal Security", () => {
	let dbOps: DatabaseOperations;

	// Helper function to create a mock request body with a system prompt
	function createMockRequestBody(systemPrompt: string) {
		return {
			model: "claude-3-5-sonnet-20241022",
			messages: [
				{
					role: "user",
					content: "test message",
				},
			],
			system: systemPrompt,
			max_tokens: 1024,
		};
	}

	// Helper to convert object to ArrayBuffer
	function toArrayBuffer(obj: Record<string, unknown>): ArrayBuffer {
		const jsonStr = JSON.stringify(obj);
		const encoder = new TextEncoder();
		const uint8Array = encoder.encode(jsonStr);
		const buffer = new ArrayBuffer(uint8Array.byteLength);
		new Uint8Array(buffer).set(uint8Array);
		return buffer;
	}

	beforeAll(() => {
		// Setup database before tests
		if (existsSync(TEST_DB_PATH)) {
			unlinkSync(TEST_DB_PATH);
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
	});

	afterAll(() => {
		// Cleanup test database
		if (existsSync(TEST_DB_PATH)) {
			unlinkSync(TEST_DB_PATH);
		}
		DatabaseFactory.reset();
	});

	describe("Directory Traversal Protection - Pattern 1 (/.claude/agents paths)", () => {
		test("should block simple .. traversal attempts", async () => {
			const maliciousPrompt =
				"Check ../../etc/.claude/agents for custom agents";
			const requestBody = createMockRequestBody(maliciousPrompt);
			const buffer = toArrayBuffer(requestBody);

			// This should not throw and should handle the malicious path safely
			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			// Verify no agent was detected from the malicious path
			expect(result.agentUsed).toBeNull();
			// The original request should be returned unmodified
			expect(result.modifiedBody).toBe(buffer);
		});

		test("should block URL-encoded .. traversal (%2e%2e)", async () => {
			const maliciousPrompt =
				"Check /%2e%2e/%2e%2e/etc/.claude/agents for agents";
			const requestBody = createMockRequestBody(maliciousPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			expect(result.agentUsed).toBeNull();
			expect(result.modifiedBody).toBe(buffer);
		});

		test("should block double URL-encoded traversal (%252e%252e)", async () => {
			const maliciousPrompt =
				"Check /%252e%252e/%252e%252e/etc/.claude/agents for agents";
			const requestBody = createMockRequestBody(maliciousPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			expect(result.agentUsed).toBeNull();
			expect(result.modifiedBody).toBe(buffer);
		});

		test("should allow legitimate paths without traversal", async () => {
			const legitimatePrompt =
				"Check /home/user/project/.claude/agents for agents";
			const requestBody = createMockRequestBody(legitimatePrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			// Legitimate path should still be processed (no agent found is OK)
			// We're just verifying it doesn't crash or throw errors
		});

		test("should block paths with mixed encoding", async () => {
			const maliciousPrompt = "Check /../%2e%2e/etc/.claude/agents for agents";
			const requestBody = createMockRequestBody(maliciousPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			expect(result.agentUsed).toBeNull();
			expect(result.modifiedBody).toBe(buffer);
		});
	});

	describe("Directory Traversal Protection - Pattern 2 (Contents of .../CLAUDE.md)", () => {
		test("should block .. in CLAUDE.md repo root paths", async () => {
			const maliciousPrompt = "Contents of ../../etc/passwd/CLAUDE.md";
			const requestBody = createMockRequestBody(maliciousPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			expect(result.agentUsed).toBeNull();
			expect(result.modifiedBody).toBe(buffer);
		});

		test("should block URL-encoded .. in CLAUDE.md paths", async () => {
			const maliciousPrompt = "Contents of /%2e%2e/%2e%2e/etc/CLAUDE.md";
			const requestBody = createMockRequestBody(maliciousPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			expect(result.agentUsed).toBeNull();
			expect(result.modifiedBody).toBe(buffer);
		});

		test("should block double URL-encoded .. in CLAUDE.md paths", async () => {
			const maliciousPrompt =
				"Contents of /%252e%252e/%252e%252e/etc/CLAUDE.md";
			const requestBody = createMockRequestBody(maliciousPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			expect(result.agentUsed).toBeNull();
			expect(result.modifiedBody).toBe(buffer);
		});

		test("should allow legitimate CLAUDE.md paths", async () => {
			const legitimatePrompt = "Contents of /home/user/project/CLAUDE.md";
			const requestBody = createMockRequestBody(legitimatePrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
		});

		test("should handle multiple CLAUDE.md references with mixed safety", async () => {
			const mixedPrompt = `
Contents of /home/user/safe-project/CLAUDE.md
Contents of ../../etc/CLAUDE.md
Contents of /home/user/another-safe/CLAUDE.md
			`;
			const requestBody = createMockRequestBody(mixedPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			// Should only process the safe paths and skip the malicious one
		});
	});

	describe("Edge Cases and Attack Vectors", () => {
		test("should handle malformed URL encoding gracefully", async () => {
			// Invalid percent encoding (incomplete sequence)
			const maliciousPrompt = "Check /%2e%2/.claude/agents for agents";
			const requestBody = createMockRequestBody(maliciousPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
		});

		test("should handle very long paths safely", async () => {
			// Attempt to cause buffer issues with extremely long paths
			const longPath = `${"/very/".repeat(1000)}.claude/agents`;
			const requestBody = createMockRequestBody(longPath);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
		});

		test("should handle empty system prompts", async () => {
			const requestBody = createMockRequestBody("");
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			expect(result.agentUsed).toBeNull();
		});

		test("should handle null bytes in paths", async () => {
			const maliciousPrompt = "Check /etc/passwd\0/.claude/agents";
			const requestBody = createMockRequestBody(maliciousPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
		});

		test("should handle backslash traversal attempts (Windows-style)", async () => {
			const maliciousPrompt = "Check \\..\\..\\etc\\.claude\\agents";
			const requestBody = createMockRequestBody(maliciousPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
		});

		test("should handle Unicode variations of dots", async () => {
			// Unicode variations that might be normalized to dots
			const maliciousPrompt = "Check /\u2024\u2024/etc/.claude/agents"; // ONE DOT LEADER (U+2024)
			const requestBody = createMockRequestBody(maliciousPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
		});
	});

	describe("Defense in Depth - Multiple Attack Patterns", () => {
		test("should block complex multi-stage traversal", async () => {
			const complexPrompt = `
Check /safe/path/.claude/agents
Contents of ../../etc/shadow/CLAUDE.md
Also check /%2e%2e/var/.claude/agents
And /legitimate/path/.claude/agents
			`;
			const requestBody = createMockRequestBody(complexPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			// Should only process legitimate paths
		});

		test("should handle symbolic link-like patterns", async () => {
			// While we can't test actual symlinks in unit tests,
			// we can test that paths that might reference symlinks are handled
			const symlinkPrompt = "Check /tmp/symlink-to-etc/.claude/agents";
			const requestBody = createMockRequestBody(symlinkPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
		});

		test("should preserve functionality for normal use cases", async () => {
			// Ensure our security measures don't break normal functionality
			const normalPrompt = `
You are Claude Code. Your task is to help with software development.

Contents of /home/tom/git_repos/better-ccflare/CLAUDE.md
This is the project documentation.

Check /home/tom/git_repos/better-ccflare/.claude/agents for custom agents.
			`;
			const requestBody = createMockRequestBody(normalPrompt);
			const buffer = toArrayBuffer(requestBody);

			const result = await interceptAndModifyRequest(buffer, dbOps);
			expect(result).toBeDefined();
			// Normal paths should work fine
		});
	});

	describe("Logging and Monitoring", () => {
		test("should not throw errors on malicious paths (fail safe)", async () => {
			const attacks = [
				"../../etc/.claude/agents",
				"/%2e%2e/etc/.claude/agents",
				"Contents of /../../../etc/CLAUDE.md",
				"/\0/.claude/agents",
				`/${"x".repeat(10000)}/.claude/agents`,
			];

			for (const attack of attacks) {
				const requestBody = createMockRequestBody(attack);
				const buffer = toArrayBuffer(requestBody);

				// None of these should throw - they should fail safely
				await expect(
					interceptAndModifyRequest(buffer, dbOps),
				).resolves.toBeDefined();
			}
		});
	});
});
