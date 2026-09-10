import {
	getCustomToolNames,
	getResponseToolIdentity,
	unwrapCustomToolInput,
} from "./custom-tools";
import type {
	AnthropicResponse,
	OutputFunctionCallItem,
	OutputMessageItem,
	ResponsesResponse,
	ResponsesTool,
} from "./types";

export function translateAnthropicResponseToResponses(
	resp: AnthropicResponse,
	responseId: string,
	model: string,
	tools?: ResponsesTool[],
): ResponsesResponse {
	const output: ResponsesResponse["output"] = [];
	const customToolNames = getCustomToolNames(tools);

	let outputIdx = 0;
	for (const block of resp.content) {
		if (block.type === "text") {
			const msgItem: OutputMessageItem = {
				type: "message",
				id: `${responseId}_msg_${outputIdx}`,
				role: "assistant",
				content: [{ type: "output_text", text: block.text }],
				status: "completed",
			};
			output.push(msgItem);
			outputIdx++;
		} else if (block.type === "tool_use") {
			if (customToolNames.has(block.name)) {
				output.push({
					type: "custom_tool_call",
					id: `${responseId}_ctc_${outputIdx}`,
					call_id: block.id,
					...getResponseToolIdentity(block.name, tools),
					input: unwrapCustomToolInput(block.input),
					status: "completed",
				});
				outputIdx++;
				continue;
			}
			const fcItem: OutputFunctionCallItem = {
				type: "function_call",
				id: `${responseId}_fc_${outputIdx}`,
				call_id: block.id,
				...getResponseToolIdentity(block.name, tools),
				arguments: JSON.stringify(block.input),
				status: "completed",
			};
			output.push(fcItem);
			outputIdx++;
		}
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
