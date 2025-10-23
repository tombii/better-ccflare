declare var self: Worker;

import {
	BUFFER_SIZES,
	estimateCostUSD,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import { AsyncDbWriter, DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import {
	NO_ACCOUNT_ID,
	type RequestPayload,
	type RequestResponse,
} from "@better-ccflare/types";
import { formatCost } from "@better-ccflare/ui-common";
import { init, Tiktoken } from "@dqbd/tiktoken/lite/init";
import model from "@dqbd/tiktoken/encoders/cl100k_base.json";
import { EMBEDDED_TIKTOKEN_WASM } from "./embedded-tiktoken-wasm";
import { combineChunks } from "./stream-tee";
import type {
	ChunkMessage,
	EndMessage,
	PayloadMessage,
	StartMessage,
	SummaryMessage,
	WorkerMessage,
} from "./worker-messages";

interface RequestState {
	startMessage: StartMessage;
	buffer: string;
	chunks: Uint8Array[];
	usage: {
		model?: string;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
		outputTokensComputed?: number;
		totalTokens?: number;
		costUsd?: number;
		tokensPerSecond?: number;
	};
	lastActivity: number;
	agentUsed?: string;
	firstTokenTimestamp?: number;
	lastTokenTimestamp?: number;
	providerFinalOutputTokens?: number;
	shouldSkipLogging?: boolean;
}

const log = new Logger("PostProcessor");
const requests = new Map<string, RequestState>();

console.log("[WORKER] Post-processor worker started");
log.info("Post-processor worker started");

// Limit to prevent unbounded growth
const MAX_REQUESTS_MAP_SIZE = 10000;

// Initialize tiktoken encoder (cl100k_base is used for Claude models)
// Using embedded WASM to avoid "Missing tiktoken_bg.wasm" errors in bunx
let tokenEncoder: Tiktoken | null = null;

(async () => {
	try {
		// Decode embedded WASM from base64
		const wasmBuffer = Buffer.from(EMBEDDED_TIKTOKEN_WASM, "base64");

		// Initialize tiktoken with embedded WASM
		await init((imports) => WebAssembly.instantiate(wasmBuffer, imports));

		// Create encoder with cl100k_base model
		tokenEncoder = new Tiktoken(
			model.bpe_ranks,
			model.special_tokens,
			model.pat_str
		);

		log.info("Tiktoken encoder initialized successfully with embedded WASM");
	} catch (error) {
		log.error("Failed to initialize tiktoken encoder:", error);
		console.error("[WORKER] Tiktoken initialization failed:", error);
	}
})();

// Initialize database connection for worker
const dbOps = new DatabaseOperations();
const asyncWriter = new AsyncDbWriter();

// Environment variables
const MAX_BUFFER_SIZE =
	Number(
		process.env.CF_STREAM_USAGE_BUFFER_KB ||
			BUFFER_SIZES.STREAM_USAGE_BUFFER_KB,
	) * 1024;
const TIMEOUT_MS = Number(
	process.env.CF_STREAM_TIMEOUT_MS || TIME_CONSTANTS.STREAM_TIMEOUT_DEFAULT,
);

// Check if a request should be logged
function shouldLogRequest(path: string, status: number): boolean {
	// Skip logging .well-known 404s
	if (path.startsWith("/.well-known/") && status === 404) {
		return false;
	}
	return true;
}

// Extract system prompt from request body
function _extractSystemPrompt(requestBody: string | null): string | null {
	if (!requestBody) return null;

	try {
		// Decode base64 request body
		const decodedBody = Buffer.from(requestBody, "base64").toString("utf-8");
		const parsed = JSON.parse(decodedBody);

		// Check if there's a system property in the request
		if (parsed.system) {
			// Handle both string and array formats
			if (typeof parsed.system === "string") {
				return parsed.system;
			} else if (Array.isArray(parsed.system)) {
				// Concatenate all text from system messages
				return parsed.system
					.filter(
						(item: { type?: string; text?: string }) =>
							item.type === "text" && item.text,
					)
					.map((item: { type?: string; text?: string }) => item.text)
					.join("\n");
			}
		}
	} catch (error) {
		log.debug("Failed to extract system prompt:", error);
	}

	return null;
}

// Parse SSE lines to extract usage (reuse existing logic)
function parseSSELine(line: string): { event?: string; data?: string } {
	if (line.startsWith("event: ")) {
		return { event: line.slice(7).trim() };
	}
	if (line.startsWith("data: ")) {
		return { data: line.slice(6).trim() };
	}
	return {};
}

// Extract usage data from non-stream JSON response bodies
function extractUsageFromJson(
	json: {
		model?: string;
		usage?: {
			input_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
			output_tokens?: number;
		};
	},
	state: RequestState,
): void {
	if (!json) return;

	const usageObj = json.usage;
	if (!usageObj) return;

	state.usage.model = json.model ?? state.usage.model;

	state.usage.inputTokens = usageObj.input_tokens ?? 0;
	state.usage.cacheReadInputTokens = usageObj.cache_read_input_tokens ?? 0;
	state.usage.cacheCreationInputTokens =
		usageObj.cache_creation_input_tokens ?? 0;
	state.usage.outputTokens = usageObj.output_tokens ?? 0;

	// Calculate total tokens
	const prompt =
		(state.usage.inputTokens ?? 0) +
		(state.usage.cacheReadInputTokens ?? 0) +
		(state.usage.cacheCreationInputTokens ?? 0);
	const completion = state.usage.outputTokens ?? 0;
	state.usage.totalTokens = prompt + completion;
}

function extractUsageFromData(data: string, state: RequestState): void {
	try {
		const parsed = JSON.parse(data);

		// Handle message_start
		if (parsed.type === "message_start" && parsed.message?.usage) {
			const usage = parsed.message.usage;
			state.usage.inputTokens = usage.input_tokens || 0;
			state.usage.cacheReadInputTokens = usage.cache_read_input_tokens || 0;
			state.usage.cacheCreationInputTokens =
				usage.cache_creation_input_tokens || 0;
			state.usage.outputTokens = usage.output_tokens || 0;
			if (parsed.message?.model) {
				state.usage.model = parsed.message.model;
			}
		}

		// Track streaming start time on first content block
		if (parsed.type === "content_block_start" && !state.firstTokenTimestamp) {
			state.firstTokenTimestamp = Date.now();
		}

		// Handle message_delta - provider's authoritative token counts AND end time
		if (parsed.type === "message_delta") {
			state.lastTokenTimestamp = Date.now();

			if (parsed.usage) {
				// Update all token counts from message_delta (authoritative for zai)
				if (parsed.usage.output_tokens !== undefined) {
					state.providerFinalOutputTokens = parsed.usage.output_tokens;
					state.usage.outputTokens = parsed.usage.output_tokens;
				}
				if (parsed.usage.input_tokens !== undefined) {
					state.usage.inputTokens = parsed.usage.input_tokens;
				}
				if (parsed.usage.cache_read_input_tokens !== undefined) {
					state.usage.cacheReadInputTokens =
						parsed.usage.cache_read_input_tokens;
				}
				return; // No further processing needed
			}
			// Even if no usage info, we still set the timestamp for duration calculation
		}

		// Count tokens locally as fallback (but provider's count takes precedence)
		if (
			parsed.type === "content_block_delta" &&
			parsed.delta &&
			state.providerFinalOutputTokens === undefined // Avoid double counting
		) {
			let textToCount: string | undefined;

			// Extract text from different delta types
			if (parsed.delta.type === "text_delta" && parsed.delta.text) {
				textToCount = parsed.delta.text;
			} else if (
				parsed.delta.type === "thinking_delta" &&
				parsed.delta.thinking
			) {
				textToCount = parsed.delta.thinking;
			}

			if (textToCount && tokenEncoder) {
				// Count tokens using tiktoken
				try {
					const tokens = tokenEncoder.encode(textToCount);
					state.usage.outputTokensComputed =
						(state.usage.outputTokensComputed || 0) + tokens.length;
				} catch (err) {
					log.debug("Failed to count tokens:", err);
				}
			}
		}

		// Handle any usage field in the data
		if (parsed.usage) {
			if (parsed.usage.input_tokens !== undefined) {
				state.usage.inputTokens = parsed.usage.input_tokens;
			}
			if (parsed.usage.output_tokens !== undefined) {
				state.usage.outputTokens = parsed.usage.output_tokens;
			}
			if (parsed.usage.cache_read_input_tokens !== undefined) {
				state.usage.cacheReadInputTokens = parsed.usage.cache_read_input_tokens;
			}
			if (parsed.usage.cache_creation_input_tokens !== undefined) {
				state.usage.cacheCreationInputTokens =
					parsed.usage.cache_creation_input_tokens;
			}
		}
	} catch {
		// Silent fail for non-JSON lines
	}
}

function processStreamChunk(chunk: Uint8Array, state: RequestState): void {
	const text = new TextDecoder().decode(chunk);
	state.buffer += text;
	state.lastActivity = Date.now();

	// Limit buffer size
	if (state.buffer.length > MAX_BUFFER_SIZE) {
		state.buffer = state.buffer.slice(-MAX_BUFFER_SIZE);
	}

	// Process complete lines
	const lines = state.buffer.split("\n");
	state.buffer = lines.pop() || "";

	let currentEvent = "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const parsed = parseSSELine(trimmed);
		if (parsed.event) {
			currentEvent = parsed.event;
		} else if (parsed.data && currentEvent) {
			extractUsageFromData(parsed.data, state);
		}
	}
}

async function handleStart(msg: StartMessage): Promise<void> {
	// Check if we should skip logging this request
	const shouldSkip = !shouldLogRequest(msg.path, msg.responseStatus);

	// Limit requests map size to prevent memory leak
	if (requests.size >= MAX_REQUESTS_MAP_SIZE) {
		log.warn(
			`Requests map at capacity (${MAX_REQUESTS_MAP_SIZE}), cleaning up oldest entries`,
		);
		// Remove oldest 10% of entries
		const toRemove = Math.floor(MAX_REQUESTS_MAP_SIZE * 0.1);
		const entries = Array.from(requests.keys()).slice(0, toRemove);
		for (const key of entries) {
			requests.delete(key);
		}
	}

	// Create request state
	const state: RequestState = {
		startMessage: msg,
		buffer: "",
		chunks: [],
		usage: {},
		lastActivity: Date.now(),
		shouldSkipLogging: shouldSkip,
	};

	// Use agent from message if provided
	if (msg.agentUsed) {
		state.agentUsed = msg.agentUsed;
		log.debug(`Agent '${msg.agentUsed}' used for request ${msg.requestId}`);
	}

	requests.set(msg.requestId, state);

	// Skip all database operations for ignored requests
	if (shouldSkip) {
		log.debug(`Skipping logging for ${msg.path} (${msg.responseStatus})`);
		return;
	}

	// Save minimal request info immediately
	if (
		process.env.DEBUG?.includes("worker") ||
		process.env.DEBUG === "true" ||
		process.env.NODE_ENV === "development"
	) {
		console.log(`[WORKER] Saving request meta for ${msg.requestId}`);
		log.info(
			`Saving request meta for ${msg.requestId} (${msg.method} ${msg.path})`,
		);
	}
	asyncWriter.enqueue(() => {
		try {
			dbOps.saveRequestMeta(
				msg.requestId,
				msg.method,
				msg.path,
				msg.accountId,
				msg.responseStatus,
				msg.timestamp,
			);
			if (
				process.env.DEBUG?.includes("worker") ||
				process.env.DEBUG === "true" ||
				process.env.NODE_ENV === "development"
			) {
				log.info(`Successfully saved request meta for ${msg.requestId}`);
			}
		} catch (error) {
			log.error(`Failed to save request meta for ${msg.requestId}:`, error);
		}
	});

	// Update account usage if authenticated
	if (msg.accountId && msg.accountId !== NO_ACCOUNT_ID) {
		const accountId = msg.accountId; // Capture for closure
		asyncWriter.enqueue(() => dbOps.updateAccountUsage(accountId));
	}
}

function handleChunk(msg: ChunkMessage): void {
	const state = requests.get(msg.requestId);
	if (!state) {
		log.warn(`No state found for request ${msg.requestId}`);
		return;
	}

	// Store chunk for later payload saving
	state.chunks.push(msg.data);

	// Process for usage extraction
	processStreamChunk(msg.data, state);
}

async function handleEnd(msg: EndMessage): Promise<void> {
	const state = requests.get(msg.requestId);
	if (!state) {
		log.warn(`No state found for request ${msg.requestId}`);
		return;
	}

	const { startMessage } = state;
	const responseTime = Date.now() - startMessage.timestamp;

	// Skip all database operations for ignored requests
	if (state.shouldSkipLogging) {
		// Clean up state without logging
		requests.delete(msg.requestId);
		return;
	}

	// For non-stream responses, extract usage data from response body
	if (!state.usage.model && msg.responseBody) {
		try {
			const decoded = Buffer.from(msg.responseBody, "base64").toString("utf-8");
			const json = JSON.parse(decoded);
			extractUsageFromJson(json, state);
		} catch {
			// Ignore parse errors
		}
	}

	// Calculate total tokens and cost
	if (state.usage.model) {
		// Use provider's authoritative count if available, fallback to computed
		const finalOutputTokens =
			state.providerFinalOutputTokens ??
			state.usage.outputTokens ??
			state.usage.outputTokensComputed ??
			0;

		// Update usage with final values
		state.usage.outputTokens = finalOutputTokens;
		state.usage.outputTokensComputed = undefined; // Clear to avoid confusion

		state.usage.totalTokens =
			(state.usage.inputTokens || 0) +
			finalOutputTokens +
			(state.usage.cacheReadInputTokens || 0) +
			(state.usage.cacheCreationInputTokens || 0);

		state.usage.costUsd = await estimateCostUSD(state.usage.model, {
			inputTokens: state.usage.inputTokens,
			outputTokens: finalOutputTokens,
			cacheReadInputTokens: state.usage.cacheReadInputTokens,
			cacheCreationInputTokens: state.usage.cacheCreationInputTokens,
		});

		// Calculate tokens per second - zai specific vs other providers
		if (finalOutputTokens > 0) {
			const totalDurationSec = responseTime / 1000;

			if (totalDurationSec > 0) {
				// Check if this is a zai model (glm-*)
				const isZaiModel = state.usage.model?.startsWith("glm-");

				if (isZaiModel) {
					// For zai models, use total response time (more intuitive for users)
					state.usage.tokensPerSecond = finalOutputTokens / totalDurationSec;
					if (
						process.env.DEBUG?.includes("worker") ||
						process.env.DEBUG === "true" ||
						process.env.NODE_ENV === "development"
					) {
						log.info(
							`ZAI token/s calculation: ${finalOutputTokens} tokens / ${totalDurationSec}s = ${state.usage.tokensPerSecond} tok/s (using total response time: ${responseTime}ms)`,
						);
					}
				} else {
					// For other providers (like Anthropic), use streaming duration if available
					if (state.firstTokenTimestamp && state.lastTokenTimestamp) {
						const streamingDurationMs =
							state.lastTokenTimestamp - state.firstTokenTimestamp;
						const streamingDurationSec = streamingDurationMs / 1000;

						if (streamingDurationMs > 0) {
							// Use streaming duration for generation speed
							state.usage.tokensPerSecond =
								finalOutputTokens / streamingDurationSec;
							if (
								process.env.DEBUG?.includes("worker") ||
								process.env.DEBUG === "true" ||
								process.env.NODE_ENV === "development"
							) {
								log.info(
									`Token/s calculation (streaming): ${finalOutputTokens} tokens / ${streamingDurationSec}s = ${state.usage.tokensPerSecond} tok/s (streaming duration: ${streamingDurationMs}ms)`,
								);
							}
						} else {
							// Fallback to total response time
							state.usage.tokensPerSecond =
								finalOutputTokens / totalDurationSec;
							if (
								process.env.DEBUG?.includes("worker") ||
								process.env.DEBUG === "true" ||
								process.env.NODE_ENV === "development"
							) {
								log.info(
									`Token/s calculation (fallback): ${finalOutputTokens} tokens / ${totalDurationSec}s = ${state.usage.tokensPerSecond} tok/s (total response time: ${responseTime}ms)`,
								);
							}
						}
					} else {
						// No streaming timestamps available, use total response time
						state.usage.tokensPerSecond = finalOutputTokens / totalDurationSec;
						if (
							process.env.DEBUG?.includes("worker") ||
							process.env.DEBUG === "true" ||
							process.env.NODE_ENV === "development"
						) {
							log.info(
								`Token/s calculation (no timestamps): ${finalOutputTokens} tokens / ${totalDurationSec}s = ${state.usage.tokensPerSecond} tok/s (total response time: ${responseTime}ms)`,
							);
						}
					}
				}
			} else {
				// If response time is 0, use a very small duration
				state.usage.tokensPerSecond = finalOutputTokens / 0.001;
				if (
					process.env.DEBUG?.includes("worker") ||
					process.env.DEBUG === "true" ||
					process.env.NODE_ENV === "development"
				) {
					log.info(
						`Token/s calculation (instant): ${finalOutputTokens} tokens / 0.001s = ${state.usage.tokensPerSecond} tok/s`,
					);
				}
			}
		}
	}

	// Update request with final data
	if (
		process.env.DEBUG?.includes("worker") ||
		process.env.DEBUG === "true" ||
		process.env.NODE_ENV === "development"
	) {
		log.info(`Saving final request data for ${startMessage.requestId}`);
	}
	asyncWriter.enqueue(() =>
		dbOps.saveRequest(
			startMessage.requestId,
			startMessage.method,
			startMessage.path,
			startMessage.accountId,
			startMessage.responseStatus,
			msg.success,
			msg.error || null,
			responseTime,
			startMessage.failoverAttempts,
			state.usage.model
				? {
						model: state.usage.model,
						promptTokens:
							(state.usage.inputTokens || 0) +
							(state.usage.cacheReadInputTokens || 0) +
							(state.usage.cacheCreationInputTokens || 0),
						completionTokens: state.usage.outputTokens,
						totalTokens: state.usage.totalTokens,
						costUsd: state.usage.costUsd,
						// Keep original breakdown for payload
						inputTokens: state.usage.inputTokens,
						outputTokens: state.usage.outputTokens,
						cacheReadInputTokens: state.usage.cacheReadInputTokens,
						cacheCreationInputTokens: state.usage.cacheCreationInputTokens,
						tokensPerSecond: state.usage.tokensPerSecond,
					}
				: undefined,
			state.agentUsed,
		),
	);

	// Save payload
	let responseBody: string | null = null;

	if (msg.responseBody) {
		// Non-streaming response
		responseBody = msg.responseBody;
	} else if (state.chunks.length > 0) {
		// Streaming response - combine chunks
		const combined = combineChunks(state.chunks);
		if (combined.length > 0) {
			responseBody = combined.toString("base64");
		}
	}

	const payload = {
		request: {
			headers: startMessage.requestHeaders,
			body: startMessage.requestBody,
		},
		response: {
			status: startMessage.responseStatus,
			headers: startMessage.responseHeaders,
			body: responseBody,
		},
		meta: {
			accountId: startMessage.accountId || NO_ACCOUNT_ID,
			timestamp: startMessage.timestamp,
			success: msg.success,
			isStream: startMessage.isStream,
			retry: startMessage.retryAttempt,
		},
	};

	asyncWriter.enqueue(() =>
		dbOps.saveRequestPayload(startMessage.requestId, payload),
	);

	// Log if we have usage
	if (state.usage.model && startMessage.accountId !== NO_ACCOUNT_ID) {
		if (
			process.env.DEBUG?.includes("worker") ||
			process.env.DEBUG === "true" ||
			process.env.NODE_ENV === "development"
		) {
			log.info(
				`Usage for request ${startMessage.requestId}: Model: ${state.usage.model}, ` +
					`Tokens: ${state.usage.totalTokens || 0}, Cost: ${formatCost(state.usage.costUsd)}`,
			);
		}
	}

	// Post summary to main thread for real-time updates
	const summary: RequestResponse = {
		id: startMessage.requestId,
		timestamp: new Date(startMessage.timestamp).toISOString(),
		method: startMessage.method,
		path: startMessage.path,
		accountUsed: startMessage.accountId,
		statusCode: startMessage.responseStatus,
		success: msg.success,
		errorMessage: msg.error || null,
		responseTimeMs: responseTime,
		failoverAttempts: startMessage.failoverAttempts,
		model: state.usage.model,
		promptTokens: state.usage.inputTokens,
		completionTokens: state.usage.outputTokens,
		totalTokens: state.usage.totalTokens,
		inputTokens: state.usage.inputTokens,
		cacheReadInputTokens: state.usage.cacheReadInputTokens,
		cacheCreationInputTokens: state.usage.cacheCreationInputTokens,
		outputTokens: state.usage.outputTokens,
		costUsd: state.usage.costUsd,
		agentUsed: state.agentUsed,
		tokensPerSecond: state.usage.tokensPerSecond,
	};

	self.postMessage({
		type: "summary",
		summary,
	} satisfies SummaryMessage);

	// Post full payload to main thread
	const fullPayload: RequestPayload = {
		id: startMessage.requestId,
		request: {
			headers: startMessage.requestHeaders,
			body: startMessage.requestBody,
		},
		response: {
			status: startMessage.responseStatus,
			headers: startMessage.responseHeaders,
			body: responseBody,
		},
		error: msg.error,
		meta: {
			accountId: startMessage.accountId || NO_ACCOUNT_ID,
			timestamp: startMessage.timestamp,
			success: msg.success,
			retry: startMessage.retryAttempt,
			path: startMessage.path,
			method: startMessage.method,
			agentUsed: state.agentUsed,
		},
	};

	self.postMessage({
		type: "payload",
		payload: fullPayload,
	} satisfies PayloadMessage);

	// Clean up
	requests.delete(msg.requestId);
}

async function handleShutdown(): Promise<void> {
	log.info("Worker shutting down, flushing async writer...");

	// Stop cleanup interval
	stopCleanupInterval();

	await asyncWriter.dispose();
	dbOps.close();
	// Worker will be terminated by main thread
}

// Periodic cleanup of stale requests (safety net for orphaned requests)
// This should rarely trigger as the main app handles timeouts
let cleanupInterval: Timer | null = null;

const startCleanupInterval = () => {
	if (!cleanupInterval) {
		cleanupInterval = setInterval(() => {
			const now = Date.now();
			for (const [id, state] of requests) {
				if (now - state.lastActivity > TIMEOUT_MS) {
					log.warn(
						`Request ${id} appears orphaned (no activity for ${TIMEOUT_MS}ms), cleaning up...`,
					);
					handleEnd({
						type: "end",
						requestId: id,
						success: false,
						error: "Request orphaned - no activity",
					});
				}
			}
		}, TIMEOUT_MS); // Check every TIMEOUT_MS
	}
};

const stopCleanupInterval = () => {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
};

// Start cleanup interval
startCleanupInterval();

// Message handler
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const msg = event.data;
	console.log(`[WORKER] Received message type: ${msg.type}`);

	switch (msg.type) {
		case "start":
			await handleStart(msg);
			break;
		case "chunk":
			handleChunk(msg);
			break;
		case "end":
			await handleEnd(msg);
			break;
		case "shutdown":
			await handleShutdown();
			break;
		default:
			log.warn(`Unknown message type: ${(msg as { type: string }).type}`);
	}
};
