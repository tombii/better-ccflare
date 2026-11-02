import { api } from "../api";
import type {
	WebToolCall,
	WebToolCallStatus,
	WebToolCallSummary,
} from "./search-provider-types";

/**
 * Fetch wrappers for the read-only web tool call trace:
 *
 *   GET /api/web-tool-calls?limit&status&providerKind&since
 *     -> { success, data: WebToolCall[], count }
 *   GET /api/web-tool-calls/summary?hours
 *     -> { success, data: WebToolCallSummary[] }
 *
 * Every row is normalized defensively, like the search-provider adapter: a
 * malformed field degrades to a safe default rather than crashing the page.
 * The rows are the server's own record — there is no key field to normalize,
 * and none is ever rendered.
 *
 * Authentication comes from the shared `api` client.
 */

interface Envelope<T> {
	success?: boolean;
	data?: T;
	count?: number;
}

export interface WebToolCallQuery {
	limit?: number;
	status?: WebToolCallStatus;
	providerKind?: string;
	/** Epoch ms; rows at or after this instant. */
	since?: number;
}

const STATUSES: WebToolCallStatus[] = ["ok", "error", "fallthrough"];

function asRecord(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function asString(raw: unknown): string | null {
	return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function asNumber(raw: unknown, fallback = 0): number {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function asNullableNumber(raw: unknown): number | null {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function asStatus(raw: unknown): WebToolCallStatus {
	return STATUSES.includes(raw as WebToolCallStatus)
		? (raw as WebToolCallStatus)
		: "fallthrough";
}

export function normalizeWebToolCall(raw: unknown): WebToolCall | null {
	const entry = asRecord(raw);
	const id = asString(entry.id);
	if (!id) return null;
	return {
		id,
		timestamp: asNumber(entry.timestamp),
		tool: asString(entry.tool) ?? "web_search",
		providerId: asString(entry.providerId),
		providerKind: asString(entry.providerKind),
		accountId: asString(entry.accountId),
		project: asString(entry.project),
		queryText: asString(entry.queryText),
		queryChars: asNumber(entry.queryChars),
		resultCount: asNullableNumber(entry.resultCount),
		latencyMs: asNumber(entry.latencyMs),
		status: asStatus(entry.status),
		errorCode: asString(entry.errorCode),
		estimatedCostUsd: asNullableNumber(entry.estimatedCostUsd),
	};
}

export function normalizeWebToolCallSummary(
	raw: unknown,
): WebToolCallSummary | null {
	const entry = asRecord(raw);
	const status = entry.status;
	if (!STATUSES.includes(status as WebToolCallStatus)) return null;
	return {
		providerKind: asString(entry.providerKind),
		status: status as WebToolCallStatus,
		callCount: asNumber(entry.callCount),
		totalLatencyMs: asNumber(entry.totalLatencyMs),
		avgLatencyMs: asNumber(entry.avgLatencyMs),
		totalResults: asNumber(entry.totalResults),
	};
}

export async function listWebToolCalls(
	query: WebToolCallQuery = {},
): Promise<WebToolCall[]> {
	const params = new URLSearchParams();
	if (query.limit !== undefined) params.set("limit", String(query.limit));
	if (query.status !== undefined) params.set("status", query.status);
	if (query.providerKind) params.set("providerKind", query.providerKind);
	if (query.since !== undefined) params.set("since", String(query.since));
	const suffix = params.size > 0 ? `?${params.toString()}` : "";
	const body = await api.get<Envelope<unknown[]>>(
		`/api/web-tool-calls${suffix}`,
	);
	const rows = Array.isArray(body?.data) ? body.data : [];
	return rows
		.map(normalizeWebToolCall)
		.filter((row): row is WebToolCall => row !== null);
}

export async function getWebToolCallSummary(
	hours = 24,
): Promise<WebToolCallSummary[]> {
	const body = await api.get<Envelope<unknown[]>>(
		`/api/web-tool-calls/summary?hours=${hours}`,
	);
	const rows = Array.isArray(body?.data) ? body.data : [];
	return rows
		.map(normalizeWebToolCallSummary)
		.filter((row): row is WebToolCallSummary => row !== null);
}
