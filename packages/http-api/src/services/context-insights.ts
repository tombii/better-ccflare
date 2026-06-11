import type {
	ContextCompositionTotals,
	ContextContributor,
	ContextContributorKind,
	ContextGrowthPoint,
	ContextGrowthSession,
	ContextInsightsResponse,
	ContextRequestComposition,
	ContextTokenTotals,
} from "@better-ccflare/types";

/**
 * Pure context-composition analysis for the context insights endpoint.
 *
 * No DB access: pre-fetched request rows, per-payload analyses and growth
 * rows are injected as plain data. The response shapes live in
 * @better-ccflare/types and are re-exported here for convenience.
 *
 * Two distinct data sources are combined:
 * - Stored request payloads (optional, size-capped, retention-cleaned) yield
 *   CHAR counts per section via JSON.stringify lengths — estimates, NOT
 *   token counts, converted with the CHARS_PER_TOKEN heuristic.
 * - The requests-table token columns yield EXACT token figures
 *   (tokenTotals, per-request tokens, growth curve).
 */

export type {
	ContextCompositionTotals,
	ContextContributor,
	ContextContributorKind,
	ContextGrowthPoint,
	ContextGrowthSession,
	ContextInsightsMeta,
	ContextInsightsResponse,
	ContextRequestComposition,
	ContextTokenTotals,
} from "@better-ccflare/types";

/** Clearly-labelled heuristic for char → token estimates (~4 chars/token). */
export const CHARS_PER_TOKEN = 4;

export const DEFAULT_PAYLOAD_SCAN_LIMIT = 100;
export const MAX_PAYLOAD_SCAN_LIMIT = 500;
export const DEFAULT_TOP_CONTRIBUTORS = 10;
export const MAX_TOP_CONTRIBUTORS = 50;
export const DEFAULT_SESSION_GAP_MINUTES = 30;
/** Keep only the most recent sessions (by endTimestamp) on the growth curve. */
export const MAX_GROWTH_SESSIONS = 20;
/** Keep only the most recent points within one session. */
export const MAX_POINTS_PER_SESSION = 500;
/** Content blocks below this serialized size are never tracked as contributors. */
export const MIN_CONTRIBUTOR_BLOCK_CHARS = 512;

/** Caveat echoed verbatim in meta.estimateNote. */
export const ESTIMATE_NOTE =
	"Character-based estimates (~4 chars/token); not exact token counts. Coverage is partial: payload storage is optional, size-capped and retention-cleaned.";

/** Max length of a single-line content preview used as a contributor label. */
const PREVIEW_CHARS = 80;
/** How much of a serialized block feeds the content hash (beyond kind/label/length). */
const HASH_SAMPLE_CHARS = 256;
/** Unit separator: never appears in labels, hash inputs cannot collide on it. */
const FIELD_SEPARATOR = "\u001f";

/** One large content block extracted from a payload's messages. */
export interface ContributorBlock {
	kind: ContextContributorKind;
	label: string;
	/** Serialized size of the block. */
	chars: number;
	/** Cheap content hash used to group re-sent copies across requests. */
	hash: string;
}

/** Char breakdown + contributor blocks for one successfully parsed payload. */
export interface PayloadAnalysis {
	systemChars: number;
	toolsChars: number;
	messagesChars: number;
	totalChars: number;
	blocks: ContributorBlock[];
}

/** One request row (requests-table columns) paired with its payload analysis. */
export interface ContextRequestRow {
	id: string;
	timestamp: number;
	account: string | null;
	model: string | null;
	project: string | null;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
}

/** One request row for the growth curve (requests table only, no payload). */
export interface ContextGrowthRow {
	id: string;
	timestamp: number;
	project: string | null;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
}

export interface ContextInsightsOptions {
	range: string;
	/** Whether the payload candidate fetch hit its scan limit (echoed in meta). */
	truncated: boolean;
	/** Whether the growth-curve row fetch hit its scan cap. Default false. */
	growthScanTruncated?: boolean;
	/** Contributors returned. Default 10. */
	topContributors?: number;
	/** Gap (minutes) that splits two requests into separate sessions. Default 30. */
	sessionGapMinutes?: number;
}

export interface BuildContextInsightsInput {
	/** Candidate rows in any order, each with its parsed analysis (null = unparseable). */
	analyses: Array<{ row: ContextRequestRow; analysis: PayloadAnalysis | null }>;
	coverage: { requestsInRange: number; requestsWithPayload: number };
	/** Growth rows in chronological order. */
	growthRows: ContextGrowthRow[];
	options: ContextInsightsOptions;
}

/** Convert a char count to estimated tokens via the ~4 chars/token heuristic. */
export function estimateTokens(chars: number): number {
	return Math.round(chars / CHARS_PER_TOKEN);
}

/** djb2 hash (unsigned 32-bit, base36) — cheap and non-cryptographic. */
function djb2(input: string): string {
	let hash = 5381;
	for (let index = 0; index < input.length; index++) {
		hash = (Math.imul(hash, 33) + input.charCodeAt(index)) >>> 0;
	}
	return hash.toString(36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Serialized size of one top-level payload key; 0 when the key is absent. */
function charsOf(value: unknown): number {
	if (value === undefined) return 0;
	const serialized = JSON.stringify(value);
	return serialized === undefined ? 0 : serialized.length;
}

/** Collapse whitespace into a short single-line preview for text labels. */
function previewLabel(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > PREVIEW_CHARS
		? singleLine.slice(0, PREVIEW_CHARS)
		: singleLine;
}

function makeBlock(
	kind: ContextContributorKind,
	label: string,
	serialized: string,
): ContributorBlock {
	// Hash kind + label + length + a content sample: cheap, yet stable for
	// byte-identical re-sent blocks and unlikely to collide for distinct ones.
	const hash = djb2(
		[
			kind,
			label,
			serialized.length,
			serialized.slice(0, HASH_SAMPLE_CHARS),
		].join(FIELD_SEPARATOR),
	);
	return { kind, label, chars: serialized.length, hash };
}

/**
 * Extract contributor-sized blocks from a body's messages. Tolerant of both
 * Anthropic content-block arrays and OpenAI string contents; anything that
 * isn't message-shaped is silently skipped. Blocks under
 * MIN_CONTRIBUTOR_BLOCK_CHARS are dropped to bound memory.
 */
function extractContributorBlocks(messages: unknown): ContributorBlock[] {
	if (!Array.isArray(messages)) return [];

	// First pass: map tool_use ids to tool names so tool_result blocks can be
	// labelled with the tool that produced them (within the same request).
	const toolNamesById = new Map<string, string>();
	for (const message of messages) {
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (
				isRecord(block) &&
				block.type === "tool_use" &&
				typeof block.id === "string" &&
				typeof block.name === "string"
			) {
				toolNamesById.set(block.id, block.name);
			}
		}
	}

	const blocks: ContributorBlock[] = [];
	const push = (
		kind: ContextContributorKind,
		label: string,
		serialized: string,
	) => {
		if (serialized.length < MIN_CONTRIBUTOR_BLOCK_CHARS) return;
		blocks.push(makeBlock(kind, label, serialized));
	};

	for (const message of messages) {
		if (!isRecord(message)) continue;
		const content = message.content;
		if (typeof content === "string") {
			// String content (OpenAI-style or simple Anthropic) is one text block.
			push("text", previewLabel(content), JSON.stringify(content));
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!isRecord(block)) continue;
			if (block.type === "tool_result") {
				const label =
					(typeof block.tool_use_id === "string" &&
						toolNamesById.get(block.tool_use_id)) ||
					"tool_result";
				push("tool_result", label, JSON.stringify(block));
			} else if (block.type === "text") {
				const label = previewLabel(
					typeof block.text === "string" ? block.text : "",
				);
				push("text", label, JSON.stringify(block));
			} else if (block.type === "tool_use") {
				const label = typeof block.name === "string" ? block.name : "tool_use";
				push("tool_use", label, JSON.stringify(block));
			}
		}
	}
	return blocks;
}

/**
 * Parse one stored request_payloads.json row and measure the provider request
 * body it wraps.
 *
 * Returns null when the row is unanalyzable: the wrapper JSON does not parse
 * (including payloads encrypted at rest), request.body is missing, or the
 * base64-decoded body is not valid JSON (bodies are size-capped at 4MB at
 * write time, so they can be truncated mid-JSON).
 *
 * Char counts are JSON.stringify lengths of whatever top-level
 * system/tools/messages keys exist (Anthropic or OpenAI format); a missing
 * key counts as 0.
 */
export function analyzePayloadJson(json: string): PayloadAnalysis | null {
	let wrapper: unknown;
	try {
		wrapper = JSON.parse(json);
	} catch {
		return null;
	}
	return analyzePayloadWrapper(wrapper);
}

/**
 * Measure an already-parsed payload wrapper (as returned by
 * dbOps.getRequestPayload, which handles at-rest decryption). Same null
 * semantics as analyzePayloadJson for missing/unparseable request bodies.
 */
export function analyzePayloadWrapper(
	wrapper: unknown,
): PayloadAnalysis | null {
	if (!isRecord(wrapper) || !isRecord(wrapper.request)) return null;
	const bodyB64 = wrapper.request.body;
	if (typeof bodyB64 !== "string" || bodyB64.length === 0) return null;

	// Invalid base64 yields garbage rather than throwing; both that and
	// truncated bodies surface as a JSON.parse failure here.
	let body: unknown;
	try {
		body = JSON.parse(Buffer.from(bodyB64, "base64").toString("utf-8"));
	} catch {
		return null;
	}
	if (!isRecord(body)) return null;

	const systemChars = charsOf(body.system);
	const toolsChars = charsOf(body.tools);
	const messagesChars = charsOf(body.messages);
	return {
		systemChars,
		toolsChars,
		messagesChars,
		totalChars: systemChars + toolsChars + messagesChars,
		blocks: extractContributorBlocks(body.messages),
	};
}

interface ContributorAccumulator {
	kind: ContextContributorKind;
	label: string;
	maxChars: number;
	occurrences: number;
	requestIds: Set<string>;
}

/**
 * Group contributor blocks by content hash across requests: occurrences
 * counts every hit, requestCount counts distinct requests, maxChars keeps the
 * largest copy. Sorted by maxChars descending (label ascending on ties).
 */
function aggregateContributors(
	parsed: Array<{ row: ContextRequestRow; analysis: PayloadAnalysis }>,
	topContributors: number,
): ContextContributor[] {
	const groups = new Map<string, ContributorAccumulator>();
	for (const { row, analysis } of parsed) {
		for (const block of analysis.blocks) {
			let acc = groups.get(block.hash);
			if (!acc) {
				acc = {
					kind: block.kind,
					label: block.label,
					maxChars: 0,
					occurrences: 0,
					requestIds: new Set(),
				};
				groups.set(block.hash, acc);
			}
			acc.occurrences += 1;
			acc.maxChars = Math.max(acc.maxChars, block.chars);
			acc.requestIds.add(row.id);
		}
	}

	return [...groups.entries()]
		.map(([hash, acc]) => ({
			hash,
			kind: acc.kind,
			label: acc.label,
			maxChars: acc.maxChars,
			estimatedTokens: estimateTokens(acc.maxChars),
			occurrences: acc.occurrences,
			requestCount: acc.requestIds.size,
		}))
		.sort((a, b) =>
			b.maxChars !== a.maxChars
				? b.maxChars - a.maxChars
				: a.label < b.label
					? -1
					: a.label > b.label
						? 1
						: 0,
		)
		.slice(0, topContributors);
}

/** Map key for grouping by project; the separator cannot appear in names. */
const NULL_PROJECT_KEY = `${FIELD_SEPARATOR}null`;

function toGrowthPoint(row: ContextGrowthRow): ContextGrowthPoint {
	return {
		requestId: row.id,
		timestamp: row.timestamp,
		contextTokens:
			row.inputTokens + row.cacheReadInputTokens + row.cacheCreationInputTokens,
		outputTokens: row.outputTokens,
	};
}

/**
 * Build the growth curve: group rows by project, sort each group
 * chronologically, split into sessions when the gap between neighbours
 * exceeds sessionGapMinutes, then apply the point/session caps (keeping the
 * most recent data and flagging truncated when anything was trimmed).
 */
function buildGrowthCurve(
	rows: ContextGrowthRow[],
	sessionGapMinutes: number,
	scanTruncated: boolean,
): { sessions: ContextGrowthSession[]; truncated: boolean } {
	const gapMs = sessionGapMinutes * 60_000;
	const byProject = new Map<string, ContextGrowthRow[]>();
	for (const row of rows) {
		const key = row.project ?? NULL_PROJECT_KEY;
		const group = byProject.get(key);
		if (group) {
			group.push(row);
		} else {
			byProject.set(key, [row]);
		}
	}

	let truncated = scanTruncated;
	const sessions: ContextGrowthSession[] = [];
	for (const group of byProject.values()) {
		group.sort((a, b) => a.timestamp - b.timestamp);
		let current: ContextGrowthRow[] = [];
		const flush = () => {
			if (current.length === 0) return;
			let points = current.map(toGrowthPoint);
			if (points.length > MAX_POINTS_PER_SESSION) {
				points = points.slice(points.length - MAX_POINTS_PER_SESSION);
				truncated = true;
			}
			sessions.push({
				project: current[0].project,
				startTimestamp: current[0].timestamp,
				endTimestamp: current[current.length - 1].timestamp,
				// Session size before the point cap, so trimmed sessions still
				// report their true request volume.
				requestCount: current.length,
				points,
			});
			current = [];
		};
		for (const row of group) {
			const last = current[current.length - 1];
			if (last && row.timestamp - last.timestamp > gapMs) flush();
			current.push(row);
		}
		flush();
	}

	// Most recent sessions first; drop the oldest beyond the cap.
	sessions.sort((a, b) => b.endTimestamp - a.endTimestamp);
	if (sessions.length > MAX_GROWTH_SESSIONS) {
		sessions.length = MAX_GROWTH_SESSIONS;
		truncated = true;
	}
	return { sessions, truncated };
}

/**
 * Assemble the full context insights response from per-payload analyses,
 * coverage counts and growth rows.
 *
 * - composition.totals/perRequest cover only requests whose payload PARSED;
 *   unparseable rows are surfaced via meta.unparseablePayloads instead.
 * - composition.tokenTotals are exact requests-table sums over those same
 *   parsed requests.
 * - topContributors groups blocks by content hash across requests.
 * - growthCurve uses only exact token columns (no payload data).
 */
export function buildContextInsightsResponse(
	input: BuildContextInsightsInput,
): ContextInsightsResponse {
	const topContributors =
		input.options.topContributors ?? DEFAULT_TOP_CONTRIBUTORS;
	const sessionGapMinutes =
		input.options.sessionGapMinutes ?? DEFAULT_SESSION_GAP_MINUTES;

	const parsed = input.analyses.filter(
		(entry): entry is { row: ContextRequestRow; analysis: PayloadAnalysis } =>
			entry.analysis !== null,
	);

	let systemChars = 0;
	let toolsChars = 0;
	let messagesChars = 0;
	const tokenTotals: ContextTokenTotals = {
		uncachedInputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
	};
	for (const { row, analysis } of parsed) {
		systemChars += analysis.systemChars;
		toolsChars += analysis.toolsChars;
		messagesChars += analysis.messagesChars;
		tokenTotals.uncachedInputTokens += row.inputTokens;
		tokenTotals.cacheReadInputTokens += row.cacheReadInputTokens;
		tokenTotals.cacheCreationInputTokens += row.cacheCreationInputTokens;
	}
	const totalChars = systemChars + toolsChars + messagesChars;
	const percentOf = (chars: number) =>
		totalChars === 0 ? 0 : (chars * 100) / totalChars;
	const totals: ContextCompositionTotals = {
		systemChars,
		toolsChars,
		messagesChars,
		totalChars,
		estimatedTokens: {
			system: estimateTokens(systemChars),
			tools: estimateTokens(toolsChars),
			messages: estimateTokens(messagesChars),
			total: estimateTokens(totalChars),
		},
		percentages: {
			system: percentOf(systemChars),
			tools: percentOf(toolsChars),
			messages: percentOf(messagesChars),
		},
	};

	const perRequest: ContextRequestComposition[] = parsed
		.map(({ row, analysis }) => ({
			id: row.id,
			timestamp: row.timestamp,
			account: row.account,
			model: row.model,
			project: row.project,
			systemChars: analysis.systemChars,
			toolsChars: analysis.toolsChars,
			messagesChars: analysis.messagesChars,
			totalChars: analysis.totalChars,
			estimatedContextTokens: estimateTokens(analysis.totalChars),
			inputTokens: row.inputTokens,
			cacheReadInputTokens: row.cacheReadInputTokens,
			cacheCreationInputTokens: row.cacheCreationInputTokens,
			outputTokens: row.outputTokens,
		}))
		.sort((a, b) => b.timestamp - a.timestamp);

	return {
		meta: {
			range: input.options.range,
			generatedAt: Date.now(),
			scannedPayloads: input.analyses.length,
			parsedPayloads: parsed.length,
			unparseablePayloads: input.analyses.length - parsed.length,
			truncated: input.options.truncated,
			payloadCoverage: input.coverage,
			estimateNote: ESTIMATE_NOTE,
		},
		composition: { totals, tokenTotals, perRequest },
		topContributors: aggregateContributors(parsed, topContributors),
		growthCurve: buildGrowthCurve(
			input.growthRows,
			sessionGapMinutes,
			input.options.growthScanTruncated ?? false,
		),
	};
}
