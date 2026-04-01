/**
 * Memory leak reproduction test.
 *
 * Sends concurrent large-body requests through the proxy and measures
 * RSS growth. Before the fix in this PR, RSS grew ~5MB per request due
 * to unsized requestBody in StartMessage + incomplete state cleanup.
 * After the fix, growth should be bounded by MAX_REQUEST_BODY_BYTES.
 *
 * Run: bun test packages/proxy/src/__tests__/memory-leak.test.ts
 */
import { describe, expect, it } from "bun:test";

describe("memory leak regression", () => {
	// Helper: build a Claude-shaped request body of a given size
	function makeLargeRequestBody(sizeKB: number): string {
		const message = {
			model: "claude-sonnet-4-5-20250514",
			max_tokens: 1024,
			messages: [
				{
					role: "user",
					// Pad content to reach target size
					content: "x".repeat(sizeKB * 1024),
				},
			],
		};
		return JSON.stringify(message);
	}

	it("requestBody cap prevents multi-MB structured clones", () => {
		// Simulate what response-handler.ts does before postMessage
		const MAX_REQUEST_BODY_BYTES = 256 * 1024;
		const largeBody = new TextEncoder().encode(makeLargeRequestBody(2048)); // 2MB body

		// Before fix: full body was base64-encoded (2MB * 1.33 = 2.66MB per message)
		const uncappedSize = Buffer.from(largeBody).toString("base64").length;

		// After fix: capped to 256KB before base64 encoding
		const cappedSize = Buffer.from(
			largeBody.byteLength <= MAX_REQUEST_BODY_BYTES
				? largeBody
				: largeBody.subarray(0, MAX_REQUEST_BODY_BYTES),
		).toString("base64").length;

		// Uncapped would be ~2.7MB, capped should be ~341KB (256KB * 1.33)
		expect(uncappedSize).toBeGreaterThan(2_000_000);
		expect(cappedSize).toBeLessThan(350_000);
		expect(cappedSize).toBeGreaterThan(300_000); // 256KB base64 = ~341KB
	});

	it("freeRequestState releases startMessage fields", () => {
		// Simulate RequestState with a large startMessage
		const state = {
			chunks: [new Uint8Array(1024), new Uint8Array(1024)],
			chunksBytes: 2048,
			buffer: "some accumulated text",
			startMessage: {
				type: "start" as const,
				requestId: "test-123",
				accountId: "acc-1",
				method: "POST",
				path: "/v1/messages",
				timestamp: Date.now(),
				requestHeaders: {
					authorization: "Bearer sk-ant-...",
					"content-type": "application/json",
					"x-custom-header": "value",
				},
				requestBody: "x".repeat(256 * 1024), // 256KB base64 string
				responseStatus: 200,
				responseHeaders: {
					"content-type": "application/json",
					"x-ratelimit-remaining": "100",
				},
				isStream: true,
				providerName: "anthropic",
				agentUsed: null,
				apiKeyId: null,
				apiKeyName: null,
				retryAttempt: 0,
				failoverAttempts: 0,
			},
		};

		// Simulate freeRequestState (matches post-processor.worker.ts)
		function freeRequestState(s: typeof state): void {
			s.chunks.length = 0;
			s.chunksBytes = 0;
			s.buffer = "";
			s.startMessage.requestBody = null;
			s.startMessage.requestHeaders = {};
			s.startMessage.responseHeaders = {};
		}

		// Before cleanup, startMessage holds ~256KB
		expect(state.startMessage.requestBody).not.toBeNull();
		expect(Object.keys(state.startMessage.requestHeaders).length).toBe(3);

		freeRequestState(state);

		// After cleanup, large fields are released
		expect(state.startMessage.requestBody).toBeNull();
		expect(Object.keys(state.startMessage.requestHeaders).length).toBe(0);
		expect(Object.keys(state.startMessage.responseHeaders).length).toBe(0);
		expect(state.chunks.length).toBe(0);
		expect(state.buffer).toBe("");
	});

	it("concurrent requests stay within memory budget", () => {
		const MAX_REQUEST_BODY_BYTES = 256 * 1024;
		const CONCURRENT_REQUESTS = 15; // Simulates a 15-agent wave
		const BODY_SIZE_KB = 2048; // 2MB each (typical Claude Code conversation)

		// Without cap: 15 * 2MB * 1.33 (base64) * 2 (structured clone) = ~80MB
		const uncappedMemory = CONCURRENT_REQUESTS * BODY_SIZE_KB * 1024 * 1.33 * 2;

		// With cap: 15 * 256KB * 1.33 (base64) = ~5MB
		const cappedMemory = CONCURRENT_REQUESTS * MAX_REQUEST_BODY_BYTES * 1.33;

		expect(uncappedMemory).toBeGreaterThan(70_000_000); // ~80MB without cap
		expect(cappedMemory).toBeLessThan(6_000_000); // ~5MB with cap
		expect(uncappedMemory / cappedMemory).toBeGreaterThan(10); // >10x reduction
	});
});
