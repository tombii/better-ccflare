import type { Account } from "@better-ccflare/types";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";
import {
	anthropicToOllama,
	ollamaChunkToAnthropicSSE,
	ollamaResponseToAnthropic,
} from "./ollama-transformer";

export class OllamaCloudProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "ollama-cloud",
			baseUrl: "https://ollama.com",
			authHeader: "authorization",
			authType: "bearer",
			supportsStreaming: true,
		});
	}

	getEndpoint(): string {
		return "https://ollama.com";
	}

	getAuthHeader(): string {
		return "authorization";
	}

	getAuthType(): "bearer" | "direct" {
		return "bearer";
	}

	buildUrl(pathname: string, search: string, _account?: Account): string {
		const searchStr = search || "";

		// Only allow /api/tags and /api/show for model management
		if (pathname === "/api/tags" || pathname === "/api/show") {
			return `https://ollama.com${pathname}${searchStr}`;
		}
		// Everything else goes to /api/chat
		return `https://ollama.com/api/chat${searchStr}`;
	}

	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		// Use base class for model mapping (mapModelName from core)
		const modelMappedRequest = await super.transformRequestBody(
			request,
			account,
		);

		// Then convert the Anthropic-format body to Ollama's native /api/chat format
		const body = await modelMappedRequest.json();
		const ollamaReq = anthropicToOllama(body);
		const ollamaBody = JSON.stringify(ollamaReq);

		const newHeaders = new Headers(modelMappedRequest.headers);
		newHeaders.set("content-type", "application/json");
		newHeaders.delete("content-length");

		return new Request(modelMappedRequest.url, {
			method: "POST",
			headers: newHeaders,
			body: ollamaBody,
		});
	}

	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);
		const token = accessToken || apiKey;

		if (token) {
			newHeaders.delete("authorization");
			newHeaders.set("Authorization", `Bearer ${token}`);
			newHeaders.delete("x-api-key");
			newHeaders.delete("anthropic-version");
		}

		newHeaders.delete("host");
		newHeaders.delete("accept-encoding");

		return newHeaders;
	}

	async processResponse(response: Response): Promise<Response> {
		const contentType = response.headers.get("content-type") || "";

		// Streaming response: convert Ollama NDJSON to Anthropic SSE
		if (
			contentType.includes("application/x-ndjson") ||
			contentType.includes("text/plain")
		) {
			const transform = new TransformStream({
				transform(chunk, controller) {
					const text = new TextDecoder().decode(chunk);
					const lines = text.split("\n").filter((l) => l.trim());

					for (const line of lines) {
						try {
							const parsed = JSON.parse(line);
							const sse = ollamaChunkToAnthropicSSE(parsed, "ollama");
							if (sse) {
								controller.enqueue(new TextEncoder().encode(sse));
							}
						} catch {
							// Skip malformed lines
						}
					}
				},
			});

			return new Response(response.body?.pipeThrough(transform), {
				status: response.status,
				statusText: response.statusText,
				headers: new Headers({
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				}),
			});
		}

		// Non-streaming response
		try {
			const clone = response.clone();
			const parsed = await clone.json();
			const anthropicBody = ollamaResponseToAnthropic(parsed);

			return new Response(JSON.stringify(anthropicBody), {
				status: response.status,
				statusText: response.statusText,
				headers: new Headers({
					"Content-Type": "application/json",
				}),
			});
		} catch {
			// If parsing fails, return original response
			return response;
		}
	}
}
