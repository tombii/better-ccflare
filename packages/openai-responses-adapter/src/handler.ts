import crypto from "node:crypto";
import { Logger } from "@better-ccflare/logger";
import { translateRequestToAnthropic } from "./request-translator";
import { translateAnthropicResponseToResponses } from "./response-translator";
import { translateAnthropicStreamToResponses } from "./stream-translator";
import type { HandleProxyFn, ResponsesRequest } from "./types";

const log = new Logger("openai-responses-adapter");

export async function handleResponsesRequest(
	req: Request,
	url: URL,
	handleProxy: HandleProxyFn,
	ctx: unknown,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
): Promise<Response> {
	// 1. Parse body
	const rawBody = await req.arrayBuffer();
	let body: ResponsesRequest;
	try {
		body = JSON.parse(new TextDecoder().decode(rawBody)) as ResponsesRequest;
	} catch {
		return new Response(
			JSON.stringify({
				type: "error",
				error: { type: "invalid_request_error", message: "Invalid JSON body" },
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	// 2. Validate & normalise `input` — OpenAI Responses API allows a plain string
	if (!body || (typeof body.input !== "string" && !Array.isArray(body.input))) {
		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "input: Field required",
				},
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}
	if (typeof body.input === "string") {
		body = {
			...body,
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: body.input }],
				},
			],
		};
	}

	// 3. Generate response ID
	const responseId = `resp_${crypto.randomBytes(12).toString("hex")}`;

	// 4. Translate to Anthropic format
	const anthropicBody = translateRequestToAnthropic(body);

	// 5. Build synthetic request targeting /v1/messages
	const messagesUrl = new URL(url.toString());
	messagesUrl.pathname = "/v1/messages";
	const syntheticHeaders = new Headers(req.headers);
	syntheticHeaders.set("content-type", "application/json");
	syntheticHeaders.delete("content-length");
	const syntheticReq = new Request(messagesUrl.toString(), {
		method: "POST",
		headers: syntheticHeaders,
		body: JSON.stringify(anthropicBody),
	});

	// 6. Forward to proxy
	log.info(`Forwarding responses request to ${messagesUrl.pathname}`);
	const anthropicResp = await handleProxy(
		syntheticReq,
		messagesUrl,
		ctx,
		apiKeyId,
		apiKeyName,
	);

	// 7. Translate non-200 Anthropic errors to OpenAI error shape
	if (anthropicResp.status !== 200) {
		const contentType = anthropicResp.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			let errorBody: { error: { message: string; type: string; code: string } };
			try {
				const anthropicError = (await anthropicResp.json()) as {
					type?: string;
					error?: { type?: string; message?: string };
				};
				const errType = anthropicError?.error?.type ?? "api_error";
				errorBody = {
					error: {
						message: anthropicError?.error?.message ?? "Unknown error",
						type: errType,
						code: errType,
					},
				};
			} catch {
				errorBody = {
					error: {
						message: "Unknown error",
						type: "api_error",
						code: "api_error",
					},
				};
			}
			return new Response(JSON.stringify(errorBody), {
				status: anthropicResp.status,
				headers: { "Content-Type": "application/json" },
			});
		}
		return anthropicResp;
	}

	// 8. Stream path
	if (body.stream) {
		return translateAnthropicStreamToResponses(
			anthropicResp,
			responseId,
			body.model,
		);
	}

	// 9. Non-stream path
	const respBody = await anthropicResp.json();
	const translated = translateAnthropicResponseToResponses(
		respBody,
		responseId,
		body.model,
	);
	return new Response(JSON.stringify(translated), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}
