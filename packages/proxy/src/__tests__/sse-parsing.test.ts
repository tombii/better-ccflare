import { describe, expect, it } from "bun:test";

describe("Worker SSE parsing", () => {
	// Import the functions inline to test them
	function parseSSELine(line: string): { event?: string; data?: string } {
		// Handle both "event: message_start" and "event:message_start" formats
		// Some providers use no space, Anthropic uses space
		if (line.startsWith("event: ") || line.startsWith("event:")) {
			const event = line.startsWith("event: ")
				? line.slice(7).trim()
				: line.slice(6).trim();
			return { event };
		}
		// Handle both "data: {...}" and "data:{...}" formats
		if (line.startsWith("data: ") || line.startsWith("data:")) {
			const data = line.startsWith("data: ")
				? line.slice(6).trim()
				: line.slice(5).trim();
			return { data };
		}
		return {};
	}

	describe("parseSSELine", () => {
		it("parses standard Anthropic format with space", () => {
			const result = parseSSELine("event: message_start");
			expect(result.event).toBe("message_start");
			expect(result.data).toBeUndefined();
		});

		it("parses provider format without space", () => {
			const result = parseSSELine("event:message_start");
			expect(result.event).toBe("message_start");
			expect(result.data).toBeUndefined();
		});

		it("parses data line with space", () => {
			const result = parseSSELine("data: {\"type\":\"message_start\"}");
			expect(result.data).toBe("{\"type\":\"message_start\"}");
			expect(result.event).toBeUndefined();
		});

		it("parses data line without space", () => {
			const result = parseSSELine("data:{\"message\":{\"model\":\"glm-5\"}}");
			expect(result.data).toBe("{\"message\":{\"model\":\"glm-5\"}}");
			expect(result.event).toBeUndefined();
		});

		it("returns empty object for non-SSE lines", () => {
			const result = parseSSELine("some random text");
			expect(result).toEqual({});
		});

		it("handles whitespace in values", () => {
			const result = parseSSELine("event:  message_delta  ");
			expect(result.event).toBe("message_delta");
		});
	});

	describe("extractUsageFromData with eventType", () => {
		// Simulate the function signature change
		function extractUsageFromData(
			data: string,
			eventType: string,
			state: { usage: Record<string, unknown> },
		): void {
			const parsed = JSON.parse(data);

			// Handle message_start - check both parsed.type and eventType
			const isMessageStart =
				parsed.type === "message_start" || eventType === "message_start";
			if (isMessageStart) {
				if (parsed.message?.usage) {
					state.usage.inputTokens = parsed.message.usage.input_tokens || 0;
					state.usage.model = parsed.message.model;
				}
			}

			// Handle message_delta - check both parsed.type and eventType
			const isMessageDelta =
				parsed.type === "message_delta" || eventType === "message_delta";
			if (isMessageDelta) {
				if (parsed.usage) {
					state.usage.outputTokens = parsed.usage.output_tokens || 0;
				}
			}
		}

		it("extracts usage from Anthropic format (type in JSON)", () => {
			const state = { usage: {} };
			const data = JSON.stringify({
				type: "message_start",
				message: {
					model: "claude-3-5-sonnet",
					usage: { input_tokens: 100, output_tokens: 0 },
				},
			});
			extractUsageFromData(data, "message_start", state);
			expect(state.usage.model).toBe("claude-3-5-sonnet");
			expect(state.usage.inputTokens).toBe(100);
		});

		it("extracts usage from alternate format (type in event line)", () => {
			const state = { usage: {} };
			const data = JSON.stringify({
				message: {
					model: "glm-5",
					usage: { input_tokens: 41561, output_tokens: 0 },
				},
			});
			extractUsageFromData(data, "message_start", state);
			expect(state.usage.model).toBe("glm-5");
			expect(state.usage.inputTokens).toBe(41561);
		});

		it("extracts output tokens from message_delta", () => {
			const state = { usage: {} };
			const data = JSON.stringify({
				usage: { output_tokens: 51 },
			});
			extractUsageFromData(data, "message_delta", state);
			expect(state.usage.outputTokens).toBe(51);
		});

		it("handles both formats for message_delta", () => {
			const state = { usage: {} };
			const data1 = JSON.stringify({
				type: "message_delta",
				usage: { output_tokens: 100 },
			});
			extractUsageFromData(data1, "some_event", state);
			expect(state.usage.outputTokens).toBe(100);

			const state2 = { usage: {} };
			const data2 = JSON.stringify({
				usage: { output_tokens: 200 },
			});
			extractUsageFromData(data2, "message_delta", state2);
			expect(state2.usage.outputTokens).toBe(200);
		});
	});
});