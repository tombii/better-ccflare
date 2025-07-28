declare var self: Worker;

import type { ChunkMessage, UsageMessage, UsagePayload } from "./usage-types";

interface RequestAccumulator {
	buffer: string;
	usage: UsagePayload;
	lastActivity: number;
	accountId: string | null;
}

const MAX_BUFFER_SIZE =
	Number(process.env.CF_STREAM_USAGE_BUFFER_KB || 64) * 1024;
const TIMEOUT_MS = Number(process.env.CF_STREAM_TIMEOUT_MS || 30000);

const accumulators = new Map<string, RequestAccumulator>();

function parseSSELine(line: string): { event?: string; data?: string } {
	if (line.startsWith("event: ")) {
		return { event: line.slice(7).trim() };
	}
	if (line.startsWith("data: ")) {
		return { data: line.slice(6).trim() };
	}
	return {};
}

function extractUsageFromData(
	data: string,
	accumulator: RequestAccumulator,
): void {
	try {
		const parsed = JSON.parse(data);

		// Handle message_start
		if (parsed.type === "message_start" && parsed.message?.usage) {
			const usage = parsed.message.usage;
			accumulator.usage.inputTokens = usage.input_tokens || 0;
			accumulator.usage.cacheReadInputTokens =
				usage.cache_read_input_tokens || 0;
			accumulator.usage.cacheCreationInputTokens =
				usage.cache_creation_input_tokens || 0;
			accumulator.usage.outputTokens = usage.output_tokens || 0;
			if (parsed.message?.model) {
				accumulator.usage.model = parsed.message.model;
			}
		}

		// Handle message_delta
		if (parsed.type === "message_delta" && parsed.usage) {
			accumulator.usage.outputTokens =
				parsed.usage.output_tokens || accumulator.usage.outputTokens || 0;
		}

		// Handle any usage field in the data
		if (parsed.usage) {
			if (parsed.usage.input_tokens !== undefined) {
				accumulator.usage.inputTokens = parsed.usage.input_tokens;
			}
			if (parsed.usage.output_tokens !== undefined) {
				accumulator.usage.outputTokens = parsed.usage.output_tokens;
			}
			if (parsed.usage.cache_read_input_tokens !== undefined) {
				accumulator.usage.cacheReadInputTokens =
					parsed.usage.cache_read_input_tokens;
			}
			if (parsed.usage.cache_creation_input_tokens !== undefined) {
				accumulator.usage.cacheCreationInputTokens =
					parsed.usage.cache_creation_input_tokens;
			}
		}
	} catch {
		// Silent fail for non-JSON lines
	}
}

function processChunk(
	id: string,
	chunk: Uint8Array,
	accumulator: RequestAccumulator,
): void {
	const text = new TextDecoder().decode(chunk);
	accumulator.buffer += text;
	accumulator.lastActivity = Date.now();

	// Limit buffer size
	if (accumulator.buffer.length > MAX_BUFFER_SIZE) {
		accumulator.buffer = accumulator.buffer.slice(-MAX_BUFFER_SIZE);
	}

	// Process complete lines
	const lines = accumulator.buffer.split("\n");
	accumulator.buffer = lines.pop() || "";

	let currentEvent = "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const parsed = parseSSELine(trimmed);
		if (parsed.event) {
			currentEvent = parsed.event;
		} else if (parsed.data && currentEvent) {
			extractUsageFromData(parsed.data, accumulator);

			// Check for stream end
			if (currentEvent === "message_stop") {
				flushUsage(id, false);
			}
		}
	}
}

function flushUsage(id: string, incomplete: boolean): void {
	const accumulator = accumulators.get(id);
	if (!accumulator) return;

	// Calculate total tokens
	const usage = accumulator.usage;
	usage.totalTokens =
		(usage.inputTokens || 0) +
		(usage.outputTokens || 0) +
		(usage.cacheReadInputTokens || 0) +
		(usage.cacheCreationInputTokens || 0);

	const message: UsageMessage = {
		type: "usage",
		id,
		accountId: accumulator.accountId,
		usage,
		incomplete,
	};

	self.postMessage(message);
	accumulators.delete(id);
}

// Periodic cleanup of stale accumulators
setInterval(() => {
	const now = Date.now();
	for (const [id, accumulator] of accumulators) {
		if (now - accumulator.lastActivity > TIMEOUT_MS) {
			flushUsage(id, true);
		}
	}
}, 5000);

self.onmessage = (event: MessageEvent<ChunkMessage>) => {
	const { id, data, final } = event.data;

	if (!accumulators.has(id)) {
		accumulators.set(id, {
			buffer: "",
			usage: {},
			lastActivity: Date.now(),
			accountId: null,
		});
	}

	const accumulator = accumulators.get(id);
	if (!accumulator) return;

	if (data) {
		processChunk(id, data, accumulator);
	}

	if (final) {
		flushUsage(id, false);
	}
};

// Handle accountId messages
self.addEventListener("message", (event: MessageEvent) => {
	if (event.data.type === "account") {
		const accumulator = accumulators.get(event.data.id);
		if (accumulator) {
			accumulator.accountId = event.data.accountId;
		}
	}
});
