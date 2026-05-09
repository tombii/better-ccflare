import type { Account } from "@better-ccflare/types";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";
import {
	anthropicToOllama,
	isOllamaCloudEndpoint,
	ollamaChunkToAnthropicSSE,
	ollamaResponseToAnthropic,
} from "./ollama-transformer";

const OLLAMA_CLOUD_BASE = "https://ollama.com";
const OLLAMA_CHAT_PATH = "/api/chat";

export class OllamaProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "ollama",
			baseUrl: "http://localhost:11434",
			authHeader: "x-api-key",
			authType: "direct",
			supportsStreaming: true,
		});
	}

	getEndpoint(): string {
		return "http://localhost:11434";
	}

	private _isCloud(base: string): boolean {
		return isOllamaCloudEndpoint(base);
	}

	buildUrl(pathname: string, search: string, account?: Account): string {
		const effectiveBase = account?.custom_endpoint || this.getEndpoint();
		const baseUrl = effectiveBase.replace(/\/$/, "");

		if (this._isCloud(baseUrl)) {
			// For Ollama Cloud, route to native /api/chat or /api/tags
			if (
				pathname === "/api/tags" ||
				pathname === "/api/show" ||
				pathname === OLLAMA_CHAT_PATH
			) {
				return `${baseUrl}${pathname}${search}`;
			}
			// Map any other path (e.g. /v1/messages) to /api/chat
			return `${OLLAMA_CLOUD_BASE}${OLLAMA_CHAT_PATH}${search}`;
		}

		// Local Ollama: preserve incoming path
		try {
			const parsed = new URL(baseUrl);
			const basePath = parsed.pathname.replace(/\/$/, "");
			const effectivePath =
				basePath && pathname.startsWith(basePath)
					? pathname.slice(basePath.length) || "/"
					: pathname;
			return `${baseUrl}${effectivePath}${search}`;
		} catch {
			return `${baseUrl}${pathname}${search}`;
		}
	}

	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		const effectiveBase = account?.custom_endpoint || this.getEndpoint();

		if (!this._isCloud(effectiveBase)) {
			// Local Ollama: pass through Anthropic format to /v1/chat/completions
			return request;
		}

		const body = await request.json();
		const ollamaReq = anthropicToOllama(body);
		const ollamaBody = JSON.stringify(ollamaReq);

		return new Request(request.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
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
			// For Ollama Cloud use Bearer auth
			newHeaders.delete("authorization");
			newHeaders.set("Authorization", `Bearer ${token}`);
			// Remove Anthropic-specific headers
			newHeaders.delete("x-api-key");
			newHeaders.delete("anthropic-version");
		}

		newHeaders.delete("host");
		newHeaders.delete("accept-encoding");

		return newHeaders;
	}

	async processResponse(
		response: Response,
		account: Account | null,
	): Promise<Response> {
		const effectiveBase = account?.custom_endpoint || this.getEndpoint();

		if (!this._isCloud(effectiveBase)) {
			return response;
		}

		const contentType = response.headers.get("content-type") || "";

		// Streaming response: convert Ollama JSON lines to Anthropic SSE
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
