import type { AllowedModel } from "./agent";
import type {
	AgentAttributionSource,
	ProjectAttributionSource,
} from "./request";

/** Combo slot routing info — maps each returned account to its slot's model override */
export interface ComboSlotInfo {
	/** The combo name (null when not using combo routing) */
	comboName: string | null;
	/** Ordered list of { accountId, modelOverride } for combo slots, indexed by position in the returned accounts array */
	slots: Array<{ accountId: string; modelOverride: string }>;
}

export interface RequestMeta {
	id: string;
	method: string;
	path: string;
	timestamp: number;
	agentUsed?: string | null;
	project?: string | null;
	projectAttributionSource?: ProjectAttributionSource | null;
	agentAttributionSource?: AgentAttributionSource | null;
	headers?: Headers;
	/** Active combo name (set when combo routing is used) */
	comboName?: string | null;
	/** Combo slot index being attempted (set per-iteration in proxy loop) */
	comboSlotIndex?: number | null;
	/** Per-client session id (from request body metadata.user_id) for session-affinity routing. */
	clientSessionId?: string | null;
	/** Model the client originally requested, before any agent-preference rewrite. */
	originalModel?: string | null;
	/** Model actually forwarded upstream after an agent-preference rewrite (equal to originalModel when none occurred). */
	appliedModel?: string | null;
}

export interface AgentUpdatePayload {
	description?: string;
	/** `null` (or the string "inherit") reverts the agent to inheriting the session model. */
	model?: AllowedModel | null;
	tools?: string[];
	color?: string;
	systemPrompt?: string;
	mode?: "all" | "edit" | "read-only" | "execution" | "custom";
}

// Retention and maintenance API shapes
export interface RetentionGetResponse {
	payloadDays: number;
	requestDays: number;
	storePayloads: boolean;
}

export interface RetentionSetRequest {
	payloadDays?: number;
	requestDays?: number;
	storePayloads?: boolean;
}

export interface CleanupResponse {
	removedRequests: number;
	removedPayloads: number;
	payloadCutoffIso: string | null;
	requestCutoffIso: string;
	dbSizeBytes: number;
	tableRowCounts: Array<{ name: string; rowCount: number; dataBytes?: number }>;
}
