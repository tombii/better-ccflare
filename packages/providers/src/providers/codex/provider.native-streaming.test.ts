import { describe, expect, it } from "bun:test";
import { CodexProvider } from "./provider";

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];

describe("CodexProvider native streaming passthrough", () => {
	it("passes Responses API SSE events through without Anthropic reconstruction", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				type: "response.created",
				response: { id: "resp_test", model: "gpt-5.3-codex" },
			}),
			...eventLine("response.output_item.added", {
				type: "response.output_item.added",
				item: { type: "function_call", call_id: "call_1", name: "read_file" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				type: "response.function_call_arguments.delta",
				delta: '{"path":"README.md"}',
				output_index: 0,
			}),
			...eventLine("response.completed", {
				type: "response.completed",
				response: {
					model: "gpt-5.3-codex",
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const result = await provider.processResponse(
			response,
			null,
			new Headers({ "x-better-ccflare-native-passthrough": "true" }),
		);

		const body = await result.text();
		expect(body).toContain("event: response.function_call_arguments.delta");
		expect(body).toContain("response.function_call_arguments.delta");
		expect(body).not.toContain("content_block_delta");
		expect(body).not.toContain("message_start");
	});
});
