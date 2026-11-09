import { isAccountAvailable } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { getModelCooldownUntil } from "@better-ccflare/proxy";
import {
	type Account,
	COMBO_FLOW_FAMILIES,
	type Combo,
	type ComboFamilyAssignment,
	type ComboFlowCombo,
	type ComboFlowFamily,
	type ComboFlowPairing,
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

type AggregateRow = Awaited<
	ReturnType<DatabaseOperations["getComboRoutingAggregates"]>
>[number];

interface ErrorCountRow {
	account_id: string | null;
	status: unknown;
	error: string | null;
	count: number;
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

export interface ComboFlowOptions {
	/** Override initial "now" (tests). */
	now?: () => number;
}

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
			const cooldownUntil = getModelCooldownUntil(s.account_id, s.model);
			return {
				id: s.id,
				accountId: s.account_id,
				accountName: account?.name ?? null,
				provider: account?.provider ?? null,
				model: s.model,
				priority: s.priority,
				enabled: s.enabled,
				cooldownUntil,
				// Same rule the selector applies before a slot can be routed:
				// paused / requires_reauth / rate-limited accounts are unavailable
				// even with no per-model cooldown of their own.
				available:
					account !== null &&
					isAccountAvailable(account, generatedAt) &&
					(cooldownUntil === null || cooldownUntil <= generatedAt),
			};
		})
		.sort((a, b) => a.priority - b.priority);

	const pairings = buildPairings(rows, accountById);
	const errorTop = await loadErrorTop(dbOps, combo.name, sinceMs, rows.length);
	const stats = buildStats(rows, pairings, errorTop);

	return {
		id: combo.id,
		name: combo.name,
		description: combo.description,
		enabled: combo.enabled,
		familyCount,
		slots,
		stats,
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
	"MIN(account_used) AS account_id, COUNT(*) AS count " +
	"FROM requests WHERE combo_name = ? AND timestamp >= ? AND success = FALSE " +
	"GROUP BY status_code, error_message ORDER BY count DESC LIMIT 3";

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

/** Exposed for tests: the 24h window used for the stats. */
export const COMBO_FLOW_REQUESTS_WINDOW_MS = REQUESTS_WINDOW_MS;
