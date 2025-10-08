export interface RequestMeta {
	id: string;
	method: string;
	path: string;
	timestamp: number;
	agentUsed?: string | null;
	headers?: Headers;
}

export interface AgentUpdatePayload {
	description?: string;
	model?: string;
	tools?: string[];
	color?: string;
	systemPrompt?: string;
	mode?: "all" | "edit" | "read-only" | "execution" | "custom";
}

// Retention and maintenance API shapes
export interface RetentionGetResponse {
	payloadDays: number;
	requestDays: number;
}

export interface RetentionSetRequest {
	payloadDays?: number;
	requestDays?: number;
}

export interface CleanupResponse {
	removedRequests: number;
	removedPayloads: number;
	cutoffIso: string;
}

export interface CompactResponse {
	ok: boolean;
}
