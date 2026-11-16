import { isAccountAvailable, mapModelName } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	getRepresentativeUsageSnapshotForProvider,
	usageCache,
} from "@better-ccflare/providers";
import {
	getModelCooldownsForAccount,
	getModelCooldownUntil,
} from "@better-ccflare/proxy";
import {
	type Account,
	COMBO_FLOW_FAMILIES,
	type Combo,
	type ComboFamilyAssignment,
	type ComboFlowCombo,
	type ComboFlowFamily,
	type ComboFlowPairing,
	type ComboFlowRecentRequest,
	type ComboFlowResponse,
	type ComboFlowSlot,
	type ComboFlowStats,
	type ComboSlot,
} from "@better-ccflare/types";
import { errorResponse } from "../utils/http-error";

/**
 * GET /api/combos/flow — read-only projection of how requests flow through
 * combos: family → assigned combo → ordered slots, plus 24h per-combo stats
 * derived from the requests table (rows tagged with `combo_name`).
 *
 * Stats come from a single dialect-neutral GROUP BY query
 * (dbOps.getComboRoutingAggregates); the top-N reductions happen here in JS
 * so the SQL stays portable across SQLite and PostgreSQL.
 */

const REQUESTS_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOP_PAIRINGS = 5;
/** Newest rows shown per combo in the flow view's "recent requests" tab. */
const RECENT_REQUESTS_LIMIT = 15;

type AggregateRow = Awaited<
	ReturnType<DatabaseOperations["getComboRoutingAggregates"]>
>[number];

interface ErrorCountRow {
	account_id: string | null;
	status: unknown;
	error: string | null;
	count: number;
}

interface RecentRequestRow {
	id: string;
	timestamp: unknown;
	original_model: string | null;
	applied_model: string | null;
	model: string | null;
	account_used: string | null;
	status_code: unknown;
	success: unknown;
	failover_attempts: unknown;
	response_time_ms: unknown;
}

interface ObservationsShape {
	[family: string]: {
		model: string;
		order: Array<{ id: string; name: string }>;
		observedAtMs: number;
	};
}

function num(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/**
 * Folds the grouped rows for one combo into the flow stats: totals, average
 * response time, failover count and the top pairings. Error breakdown is
 * fetched separately (only on failures, bounded per combo).
 */
function buildStats(
	rows: AggregateRow[],
	pairings: ComboFlowPairing[],
	errorTop: ComboFlowStats["errorTop"],
): ComboFlowStats {
	let requests = 0;
	let ok = 0;
	let failovers = 0;
	const times: number[] = [];
	let timedRows = 0;
	for (const row of rows) {
		requests += num(row.cnt);
		ok += num(row.ok);
		failovers += num(row.failovers);
		if (row.avg_rt !== null && row.avg_rt !== undefined) {
			// AVG per bucket, weighted back by the bucket's row count.
			times.push(num(row.avg_rt) * num(row.cnt));
			timedRows += num(row.cnt);
		}
	}
	const avgResponseMs =
		timedRows > 0
			? round(times.reduce((a, b) => a + b, 0) / timedRows, 1)
			: null;
	return {
		requests,
		successRate: requests > 0 ? round(ok / requests, 4) : null,
		failoverRequests: failovers,
		avgResponseMs,
		errorTop,
		pairings,
	};
}

/** Global routing switches, read live so the dashboard can flag when the
 * chains it shows are not what the proxy actually consults. */
export interface ComboFlowRoutingFlags {
	combosEnabled: boolean;
	forceAccountModel: boolean;
}

export interface ComboFlowOptions {
	/** Override initial "now" (tests). */
	now?: () => number;
	/** Read the routing switches (tests / router wiring). Defaults to "active". */
	getRoutingFlags?: () => ComboFlowRoutingFlags;
}

const DEFAULT_ROUTING_FLAGS: ComboFlowRoutingFlags = {
	combosEnabled: true,
	forceAccountModel: false,
};

export function createComboFlowHandler(
	dbOps: DatabaseOperations,
	getObservations: () => ObservationsShape,
	options: ComboFlowOptions = {},
) {
	const now = options.now ?? (() => Date.now());
	return async (): Promise<Response> => {
		try {
			const generatedAt = now();
			const sinceMs = generatedAt - REQUESTS_WINDOW_MS;
			const flags = options.getRoutingFlags?.() ?? DEFAULT_ROUTING_FLAGS;

			const [combos, assignmentList, accounts, rows] = await Promise.all([
				dbOps.listCombos(),
				dbOps.getFamilyAssignments(),
				dbOps.getAllAccounts(),
				dbOps.getComboRoutingAggregates(sinceMs),
			]);

			const accountById = new Map(accounts.map((a) => [a.id, a]));
			const assignments = new Map<string, ComboFamilyAssignment>(
				assignmentList.map((a) => [a.family, a]),
			);
			const comboById = new Map(combos.map((c) => [c.id, c]));
			const observations = getObservations();

			const rowsByCombo = new Map<string, AggregateRow[]>();
			for (const row of rows) {
				const list = rowsByCombo.get(row.combo_name) ?? [];
				list.push(row);
				rowsByCombo.set(row.combo_name, list);
			}

			const familyCounts = new Map<string, number>();
			for (const a of assignmentList) {
				if (!a.combo_id) continue;
				familyCounts.set(a.combo_id, (familyCounts.get(a.combo_id) ?? 0) + 1);
			}

			const families = buildFamilies(assignments, comboById, observations);

			const flowCombos = await Promise.all(
				combos.map((combo) =>
					buildCombo(
						dbOps,
						combo,
						accountById,
						familyCounts.get(combo.id) ?? 0,
						rowsByCombo.get(combo.name) ?? [],
						generatedAt,
						sinceMs,
					),
				),
			);

			const data: ComboFlowResponse = {
				generatedAt,
				windows: { requestsHours: REQUESTS_WINDOW_MS / 3_600_000 },
				routing: {
					combosEnabled: flags.combosEnabled,
					forceAccountModel: flags.forceAccountModel,
					comboRoutingActive: flags.combosEnabled && !flags.forceAccountModel,
				},
				families,
				combos: flowCombos,
			};

			return new Response(JSON.stringify({ success: true, data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * Every known family is always rendered (with a null combo when unassigned);
 * any extra family that has an assignment row or a live observation is
 * appended after them.
 */
function buildFamilies(
	assignments: Map<string, ComboFamilyAssignment>,
	comboById: Map<string, Combo>,
	observations: ObservationsShape,
): ComboFlowFamily[] {
	const keys = new Set<string>(COMBO_FLOW_FAMILIES);
	for (const family of assignments.keys()) keys.add(family);
	for (const family of Object.keys(observations ?? {})) keys.add(family);

	const ordered = [
		...COMBO_FLOW_FAMILIES.filter((f) => keys.has(f)),
		...[...keys]
			.filter((f) => !(COMBO_FLOW_FAMILIES as string[]).includes(f))
			.sort(),
	];

	return ordered.map((family) => {
		const assignment = assignments.get(family) ?? null;
		const combo = assignment?.combo_id
			? (comboById.get(assignment.combo_id) ?? null)
			: null;
		const obs = observations?.[family];
		return {
			family,
			assignmentEnabled: !!assignment?.enabled && assignment.combo_id != null,
			combo: combo
				? { id: combo.id, name: combo.name, enabled: combo.enabled }
				: null,
			observation: obs
				? {
						model: obs.model,
						order: obs.order.map((a) => ({ id: a.id, name: a.name })),
						observedAtMs: obs.observedAtMs,
					}
				: null,
		} satisfies ComboFlowFamily;
	});
}

async function buildCombo(
	dbOps: DatabaseOperations,
	combo: Combo,
	accountById: Map<string, Account>,
	familyCount: number,
	rows: AggregateRow[],
	generatedAt: number,
	sinceMs: number,
): Promise<ComboFlowCombo> {
	const slotRows: ComboSlot[] = await dbOps.getComboSlots(combo.id);
	const slots: ComboFlowSlot[] = slotRows
		.map((s) => {
			const account = accountById.get(s.account_id) ?? null;
			const model =
				s.model && account ? mapModelName(s.model, account) : s.model;
			const cooldownUntil = model
				? getModelCooldownUntil(s.account_id, model)
				: null;
			// A passthrough slot has no model of its own, so the (account, model)
			// cooldown keyed on "" can never match — enumerate the account's
			// per-model cooldowns instead, since any of them can still skip the
			// slot for the model the client happened to request.
			const cooldowns =
				s.model === ""
					? getModelCooldownsForAccount(s.account_id, generatedAt)
					: [];
			// Same usage snapshot the selector consults, so an account exhausted
			// per telemetry reads as unavailable instead of healthy.
			const usageSnapshot = account
				? getRepresentativeUsageSnapshotForProvider(
						usageCache.get(account.id),
						account.provider ?? "anthropic",
					)
				: null;
			return {
				id: s.id,
				accountId: s.account_id,
				accountName: account?.name ?? null,
				provider: account?.provider ?? null,
				model: s.model,
				passthrough: s.model === "",
				priority: s.priority,
				enabled: s.enabled,
				cooldownUntil,
				...(cooldowns.length > 0 ? { cooldowns } : {}),
				// Same rule the selector applies before a slot can be routed:
				// paused / requires_reauth / rate-limited / usage-exhausted accounts
				// are unavailable even with no per-model cooldown of their own.
				available:
					account !== null &&
					isAccountAvailable(
						account,
						generatedAt,
						usageSnapshot ?? undefined,
					) &&
					(cooldownUntil === null || cooldownUntil <= generatedAt),
			};
		})
		.sort((a, b) => a.priority - b.priority);

	const pairings = buildPairings(rows, accountById);
	const errorTop = await loadErrorTop(dbOps, combo.name, sinceMs, rows.length);
	const stats = buildStats(rows, pairings, errorTop);
	const recentRequests = await loadRecentRequests(
		dbOps,
		combo.name,
		accountById,
		rows.length,
	);

	return {
		id: combo.id,
		name: combo.name,
		description: combo.description,
		enabled: combo.enabled,
		familyCount,
		slots,
		stats,
		recentRequests,
	};
}

/** Top pairings by count; ties broken by success rate then names, so the
 * order is deterministic. */
function buildPairings(
	rows: AggregateRow[],
	accountById: Map<string, Account>,
): ComboFlowPairing[] {
	return rows
		.map((row) => ({
			originalModel: row.original_model,
			appliedModel: row.applied_model,
			servedModel: row.model,
			account: row.account_used
				? (accountById.get(row.account_used)?.name ?? row.account_used)
				: null,
			count: num(row.cnt),
			successRate: num(row.cnt) > 0 ? round(num(row.ok) / num(row.cnt), 4) : 0,
		}))
		.sort(
			(a, b) =>
				b.count - a.count ||
				b.successRate - a.successRate ||
				String(a.originalModel).localeCompare(String(b.originalModel)) ||
				String(a.appliedModel).localeCompare(String(b.appliedModel)) ||
				String(a.servedModel).localeCompare(String(b.servedModel)) ||
				String(a.account).localeCompare(String(b.account)),
		)
		.slice(0, TOP_PAIRINGS);
}

const ERROR_TOP_SQL =
	"SELECT status_code AS status, error_message AS error, " +
	"account_used AS account_id, COUNT(*) AS count " +
	"FROM requests WHERE combo_name = ? AND timestamp >= ? AND success = FALSE " +
	"GROUP BY status_code, error_message, account_used " +
	"ORDER BY count DESC, account_used ASC LIMIT 3";

// Newest rows tagged with this combo. Per-combo LIMIT keeps the cost bounded;
// the literal LIMIT (no bind parameter) is the dialect-hazard-test-safe shape.
const RECENT_REQUESTS_SQL =
	"SELECT id, timestamp, original_model, applied_model, model, account_used, " +
	`status_code, success, failover_attempts, response_time_ms FROM requests ` +
	`WHERE combo_name = ? ORDER BY timestamp DESC LIMIT ${RECENT_REQUESTS_LIMIT}`;

/**
 * Top error groups for a combo. Skipped entirely when the combo has no
 * failed rows, so an idle combo costs no extra query.
 */
async function loadErrorTop(
	dbOps: DatabaseOperations,
	comboName: string,
	sinceMs: number,
	rowCount: number,
): Promise<ComboFlowStats["errorTop"]> {
	if (rowCount === 0) return [];
	const adapter = dbOps.getAdapter();
	const rows = await adapter.query<ErrorCountRow>(ERROR_TOP_SQL, [
		comboName,
		sinceMs,
	]);
	return rows.map((row) => ({
		status:
			row.status === null || row.status === undefined ? null : num(row.status),
		accountId:
			row.account_id === null || row.account_id === undefined
				? null
				: String(row.account_id),
		error: row.error ?? null,
		count: num(row.count),
	}));
}

/**
 * The newest requests tagged with a combo, resolved to display fields. Skipped
 * when the combo has no rows in the stats window — such a combo cannot have
 * tagged rows at all (the aggregate query selects on the same column), so the
 * extra per-combo query is wasted work.
 */
async function loadRecentRequests(
	dbOps: DatabaseOperations,
	comboName: string,
	accountById: Map<string, Account>,
	rowCount: number,
): Promise<ComboFlowRecentRequest[]> {
	if (rowCount === 0) return [];
	const adapter = dbOps.getAdapter();
	const rows = await adapter.query<RecentRequestRow>(RECENT_REQUESTS_SQL, [
		comboName,
	]);
	return rows.map((row) => ({
		id: row.id,
		// PostgreSQL returns BIGINT as a string (Bun.SQL); SQLite returns a number.
		timestamp: num(row.timestamp),
		originalModel: row.original_model ?? null,
		appliedModel: row.applied_model ?? null,
		servedModel: row.model ?? null,
		account: row.account_used
			? (accountById.get(row.account_used)?.name ?? row.account_used)
			: null,
		statusCode:
			row.status_code === null || row.status_code === undefined
				? null
				: num(row.status_code),
		success: Boolean(row.success),
		failoverAttempts: num(row.failover_attempts),
		responseTimeMs:
			row.response_time_ms === null || row.response_time_ms === undefined
				? null
				: num(row.response_time_ms),
	}));
}

/** Exposed for tests: the 24h window used for the stats. */
export const COMBO_FLOW_REQUESTS_WINDOW_MS = REQUESTS_WINDOW_MS;
