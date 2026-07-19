import { describe, expect, it } from "bun:test";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { BedrockProvider } from "../provider";

async function* toAsyncIterable(
	events: ConverseStreamOutput[],
): AsyncIterable<ConverseStreamOutput> {
	for (const event of events) {
		yield event;
	}
}

async function collectSseEvents(
	stream: ReadableStream,
): Promise<Array<{ event: string; data: unknown }>> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const events: Array<{ event: string; data: unknown }> = [];

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
	}

	for (const chunk of buffer.split("\n\n")) {
		if (!chunk.trim()) continue;
		const eventMatch = chunk.match(/^event: (.+)$/m);
		const dataMatch = chunk.match(/^data: (.+)$/m);
		if (eventMatch && dataMatch) {
			events.push({
				event: eventMatch[1],
				data: JSON.parse(dataMatch[1]),
			});
		}
	}

	return events;
}

describe("BedrockProvider.createAnthropicCompatibleStream", () => {
	it("emits input_json_delta events from toolUse.input deltas", async () => {
		const provider = new BedrockProvider();

		const bedrockEvents: ConverseStreamOutput[] = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockStart: {
					contentBlockIndex: 0,
					start: { toolUse: { toolUseId: "tool_1", name: "get_weather" } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { toolUse: { input: '{"location":' } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { toolUse: { input: '"NYC"}' } },
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "tool_use" } },
		];

		const stream = (
			provider as unknown as {
				createAnthropicCompatibleStream: (
					bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
					clientModelName: string,
				) => ReadableStream;
			}
		).createAnthropicCompatibleStream(
			toAsyncIterable(bedrockEvents),
			"claude-3-5-sonnet",
		);

		const events = await collectSseEvents(stream);
		const deltaEvents = events.filter((e) => e.event === "content_block_delta");

		expect(deltaEvents).toHaveLength(2);
		expect(deltaEvents[0].data).toMatchObject({
			delta: { type: "input_json_delta", partial_json: '{"location":' },
		});
		expect(deltaEvents[1].data).toMatchObject({
			delta: { type: "input_json_delta", partial_json: '"NYC"}' },
		});
	});

	it("does not emit a delta event when toolUse.input is absent", async () => {
		const provider = new BedrockProvider();

		const bedrockEvents: ConverseStreamOutput[] = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockStart: {
					contentBlockIndex: 0,
					start: { toolUse: { toolUseId: "tool_1", name: "get_weather" } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { toolUse: {} },
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "tool_use" } },
		];

		const stream = (
			provider as unknown as {
				createAnthropicCompatibleStream: (
					bedrockStream: AsyncIterable<ConverseStreamOutput> | undefined,
					clientModelName: string,
				) => ReadableStream;
			}
		).createAnthropicCompatibleStream(
			toAsyncIterable(bedrockEvents),
			"claude-3-5-sonnet",
		);

		const events = await collectSseEvents(stream);
		const deltaEvents = events.filter((e) => e.event === "content_block_delta");

		expect(deltaEvents).toHaveLength(0);
	});
});
