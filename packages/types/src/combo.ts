export type ComboFamily = "fable" | "opus" | "sonnet" | "haiku";

// Database row types (snake_case, INTEGER booleans — match SQLite storage)
export interface ComboRow {
	id: string;
	name: string;
	description: string | null;
	enabled: number; // 0 or 1
	created_at: number;
	updated_at: number;
}

export interface ComboSlotRow {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: number; // 0 or 1
}

export interface ComboFamilyAssignmentRow {
	family: string;
	combo_id: string | null;
	enabled: number; // 0 or 1
}

// Domain model types (camelCase, proper booleans)
export interface Combo {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	created_at: number;
	updated_at: number;
}

export interface ComboSlot {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: boolean;
}

export interface ComboFamilyAssignment {
	family: ComboFamily;
	combo_id: string | null;
	enabled: boolean;
}

// Extended type with slots populated
export interface ComboWithSlots extends Combo {
	slots: ComboSlot[];
}

/** A combo slot as read for display: `cooldown_until` is the epoch-ms instant a
 * model-scoped cooldown ends, or null. Read-only view — never written back. */
export interface ComboSlotWithCooldown extends ComboSlot {
	cooldown_until: number | null;
}
export interface ComboWithSlotsWithCooldown extends Combo {
	slots: ComboSlotWithCooldown[];
}

// Converter functions (Row -> Domain)
export function toCombo(row: ComboRow): Combo {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		enabled: !!row.enabled,
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
	};
}

export function toComboSlot(row: ComboSlotRow): ComboSlot {
	return {
		id: row.id,
		combo_id: row.combo_id,
		account_id: row.account_id,
		model: row.model,
		priority: Number(row.priority),
		enabled: !!row.enabled,
	};
}

export function toComboFamilyAssignment(
	row: ComboFamilyAssignmentRow,
): ComboFamilyAssignment {
	return {
		family: row.family as ComboFamily,
		combo_id: row.combo_id,
		enabled: !!row.enabled,
	};
}

// ── Combo Flow view (GET /api/combos/flow) ──────────────────────────────────
// Read-only, dashboard-facing projection of how requests flow through combos:
// family → assigned combo → ordered slots, plus 24h per-combo statistics
// derived from the requests table. Every field is JSON-serialisable.

/** Families the flow view always renders, in display order. */
export const COMBO_FLOW_FAMILIES: ComboFamily[] = [
	"fable",
	"opus",
	"sonnet",
	"haiku",
];

/** A family's assignment and the last order the proxy actually selected. */
export interface ComboFlowFamily {
	family: string;
	/** False when no assignment row exists or the assignment is disabled. */
	assignmentEnabled: boolean;
	/** The assigned combo (whatever its own enabled flag), or null. */
	combo: { id: string; name: string; enabled: boolean } | null;
	/**
	 * The proxy's last-observed routable order for this family (display-only
	 * telemetry), or null when nothing has been observed since process start.
	 */
	observation: {
		model: string;
		order: Array<{ id: string; name: string }>;
		observedAtMs: number;
	} | null;
}

/** One slot of a combo, as shown in the flow chain. */
export interface ComboFlowSlot {
	id: string;
	accountId: string;
	accountName: string | null;
	provider: string | null;
	/** Empty string = passthrough (the client's model is sent unchanged). */
	model: string;
	priority: number;
	enabled: boolean;
	cooldownUntil: number | null;
	/** No active cooldown and the account still exists. */
	available: boolean;
}

/**
 * One observed (requested model → served model → account) pairing.
 *
 * `originalModel`/`appliedModel` are populated only when an AGENT preference
 * rewrote the model; a combo slot's model override does not touch them. The
 * model a combo slot actually pinned therefore shows up as `servedModel` (the
 * model the upstream response reported), which is also the only field that
 * distinguishes two slots on the same account.
 */
export interface ComboFlowPairing {
	originalModel: string | null;
	appliedModel: string | null;
	/** Model reported by the upstream response — includes combo-slot overrides. */
	servedModel: string | null;
	account: string | null;
	count: number;
	/** 0..1 */
	successRate: number;
}

export interface ComboFlowStats {
	requests: number;
	/** 0..1, or null when requests = 0. */
	successRate: number | null;
	/** Requests where failover_attempts > 0. */
	failoverRequests: number;
	avgResponseMs: number | null;
	errorTop: Array<{
		status: number | null;
		error: string | null;
		/** Account the failing rows used (null when the request never reached one). */
		accountId: string | null;
		count: number;
	}>;
	pairings: ComboFlowPairing[];
}

export interface ComboFlowCombo {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	/** How many family assignments reference this combo. */
	familyCount: number;
	slots: ComboFlowSlot[];
	stats: ComboFlowStats;
}

export interface ComboFlowResponse {
	/** Epoch ms the response was generated. */
	generatedAt: number;
	windows: { requestsHours: number };
	families: ComboFlowFamily[];
	combos: ComboFlowCombo[];
}
