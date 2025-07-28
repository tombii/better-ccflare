export interface ChunkMessage {
	id: string; // request id (uuid)
	data?: Uint8Array; // absent for final flush
	final?: boolean;
}

export interface UsagePayload {
	model?: string;
	inputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsd?: number;
}

export interface UsageMessage {
	type: "usage";
	id: string;
	accountId: string | null;
	usage: UsagePayload;
	incomplete?: boolean;
}
