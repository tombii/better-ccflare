import type {
	AnthropicResponse,
	OutputFunctionCallItem,
	OutputMessageItem,
	ResponsesResponse,
} from "./types";

export function translateAnthropicResponseToResponses(
	resp: AnthropicResponse,
	responseId: string,
	model: string,
): ResponsesResponse {
	const textBlocks = resp.content.filter((c) => c.type === "text");
	const toolBlocks = resp.content.filter((c) => c.type === "tool_use");

	const output: ResponsesResponse["output"] = [];

	if (textBlocks.length > 0) {
		const combinedText = textBlocks
			.map((c) => (c.type === "text" ? c.text : ""))
			.join("");

		const msgItem: OutputMessageItem = {
			type: "message",
			id: `${responseId}_msg`,
			role: "assistant",
			content: [{ type: "output_text", text: combinedText }],
			status: "completed",
		};
		output.push(msgItem);
	}

	let fcIndex = 0;
	for (const block of toolBlocks) {
		if (block.type !== "tool_use") continue;
		const fcItem: OutputFunctionCallItem = {
			type: "function_call",
			id: `${responseId}_fc_${fcIndex}`,
			call_id: block.id,
			name: block.name,
			arguments: JSON.stringify(block.input),
			status: "completed",
		};
		output.push(fcItem);
		fcIndex++;
	}

	return {
		id: responseId,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		model,
		status: "completed",
		output,
		usage: {
			input_tokens: resp.usage.input_tokens,
			output_tokens: resp.usage.output_tokens,
			total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
		},
	};
}
