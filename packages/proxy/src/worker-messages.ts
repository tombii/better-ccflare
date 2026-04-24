/**
 * Unified message protocol for main thread <-> worker communication
 * Handles both streaming and non-streaming responses
 */

// ===== MAIN THREAD → WORKER =====

export interface StartMessage {
	type: "start";
	messageId: string; // envelope ID for ack tracking
	requestId: string;
	accountId: string | null;
	method: string;
	path: string;
	timestamp: number;

	// Request details
	requestHeaders: Record<string, string>;
	requestBody: string | null; // base64 encoded

	// Response details
	responseStatus: number;
	responseHeaders: Record<string, string>;
	isStream: boolean;

	// Provider info for rate limit parsing
	providerName: string;

	// Account billing type override (null = use provider heuristic)
	accountBillingType: string | null;

	// Account auto-pause-on-overage flag (1 = enabled, 0 = disabled, null = not set)
	accountAutoPauseOnOverageEnabled: number | null;

	// Account name for logging
	accountName: string | null;

	// Agent info
	agentUsed: string | null;

	// Combo info
	comboName: string | null;

	// API key info
	apiKeyId: string | null;
	apiKeyName: string | null;

	// Retry info
	retryAttempt: number;
	failoverAttempts: number;
}

export interface ChunkMessage {
	type: "chunk";
	requestId: string;
	data: Uint8Array;
}

export interface EndMessage {
	type: "end";
	requestId: string;
	responseBody?: string | null; // base64 encoded, for non-streaming
	success: boolean;
	error?: string;
}

export interface ControlMessage {
	type: "shutdown";
}

export interface ConfigUpdateMessage {
	type: "config-update";
	storePayloads: boolean;
}

export type WorkerMessage =
	| StartMessage
	| ChunkMessage
	| EndMessage
	| ControlMessage
	| ConfigUpdateMessage;

// ===== WORKER → MAIN THREAD =====

/** Worker is initialized and ready to accept messages */
export interface ReadyMessage {
	type: "ready";
}

/** Worker acknowledges a StartMessage envelope */
export interface AckMessage {
	type: "ack";
	messageId: string;
}

/** Worker has flushed all pending work and is safe to terminate */
export interface ShutdownCompleteMessage {
	type: "shutdown-complete";
}

export interface SummaryMessage {
	type: "summary";
	summary: import("@better-ccflare/types").RequestResponse;
}

export type OutgoingWorkerMessage =
	| ReadyMessage
	| AckMessage
	| ShutdownCompleteMessage
	| SummaryMessage;
