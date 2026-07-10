/**
 * On-demand prompt-cache forensics.
 *
 * When a session's cache hit rate collapses, the usual cause is a byte-level
 * prefix divergence that is invisible from usage numbers alone. Anthropic's
 * cache-diagnosis beta explains a miss directly: send two requests where the
 * second carries diagnostics.previous_message_id from the first, and the
 * response's diagnostics field reports how the prompts relate.
 *
 * Attaching an experimental beta to live traffic is not acceptable, so this
 * module works out-of-band: when CCFLARE_CACHE_DIAG=1, the proxy keeps the
 * last two request snapshots per client session (bounded, in memory only).
 * POST /api/debug/cache-diagnosis then replays that exact byte pair through
 * the proxy self-loop, non-streaming with max_tokens: 1 and the diagnosis
 * beta attached, and returns Anthropic's own explanation of where the two
 * prompts diverged. Replays wear the keepalive header, so they are exempt
 * from staging, the session governor, pacing, and dashboards.
 */
import { Logger } from "@better-ccflare/logger";

const log = new Logger("CacheDiagnosis");

export const CACHE_DIAG_ENV = "CCFLARE_CACHE_DIAG";
const CACHE_DIAG_BETA = "cache-diagnosis-2026-04-07";
/** Sessions tracked at once; oldest-inserted evicted beyond this. */
const MAX_TRACKED_SESSIONS = 8;
/** Headers that must never be captured or replayed. */
const STRIPPED_HEADERS = [
	"authorization",
	"x-api-key",
	"cookie",
	"content-length",
	"host",
];

interface DiagSnapshot {
	body: ArrayBuffer;
	headers: Array<[string, string]>;
	capturedAt: number;
}

interface SessionPair {
	prev: DiagSnapshot | null;
	last: DiagSnapshot;
}

const sessions = new Map<string, SessionPair>();

export function cacheDiagEnabled(): boolean {
	return process.env[CACHE_DIAG_ENV] === "1";
}

/** Capture a request snapshot for later diagnosis. No-op unless enabled. */
export function recordDiagnosisCandidate(
	sessionKey: string | null | undefined,
	body: ArrayBuffer | null,
	headers: Headers,
): void {
	if (!cacheDiagEnabled() || !sessionKey || !body || body.byteLength === 0) {
		return;
	}
	const snapshot: DiagSnapshot = {
		body,
		headers: snapshotHeaders(headers),
		capturedAt: Date.now(),
	};
	const existing = sessions.get(sessionKey);
	if (existing) {
		// Re-insert so Map order reflects recency for eviction.
		sessions.delete(sessionKey);
		sessions.set(sessionKey, { prev: existing.last, last: snapshot });
	} else {
		if (sessions.size >= MAX_TRACKED_SESSIONS) {
			const oldest = sessions.keys().next().value;
			if (oldest !== undefined) sessions.delete(oldest);
		}
		sessions.set(sessionKey, { prev: null, last: snapshot });
	}
}

export interface DiagnosisSessionInfo {
	session_preview: string;
	has_pair: boolean;
	last_captured_at: string;
}

export function listDiagnosisSessions(): DiagnosisSessionInfo[] {
	return [...sessions.entries()].map(([key, pair]) => ({
		session_preview: previewKey(key),
		has_pair: pair.prev !== null,
		last_captured_at: new Date(pair.last.capturedAt).toISOString(),
	}));
}

/** Build the replay body and headers for one snapshot. Exported for tests. */
export function buildDiagnosisReplay(
	snapshot: DiagSnapshot,
	previousMessageId: string | null,
): { body: string; headers: Headers } | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(new TextDecoder().decode(snapshot.body));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	parsed.max_tokens = 1;
	parsed.stream = false;
	parsed.diagnostics = { previous_message_id: previousMessageId };

	const headers = new Headers(snapshot.headers);
	headers.set("content-type", "application/json");
	headers.set("x-better-ccflare-keepalive", "true");
	const beta = headers.get("anthropic-beta");
	headers.set(
		"anthropic-beta",
		beta ? `${beta},${CACHE_DIAG_BETA}` : CACHE_DIAG_BETA,
	);
	return { body: JSON.stringify(parsed), headers };
}

export interface CacheDiagnosisResult {
	session_preview: string;
	pair: boolean;
	first: { id: string | null; usage: unknown };
	second: { id: string | null; usage: unknown; diagnostics: unknown };
}

/**
 * Replay a session's captured request pair with diagnosis chaining and
 * return the API's explanation. When only one snapshot exists, it is
 * replayed twice, which still answers "does this prompt cache at all".
 */
export async function runCacheDiagnosis(opts: {
	port: number;
	sessionPrefix?: string;
	fetchImpl?: typeof fetch;
}): Promise<CacheDiagnosisResult> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const entry = pickSession(opts.sessionPrefix);
	if (!entry) {
		throw new Error(
			`no captured session matches; enable ${CACHE_DIAG_ENV}=1 and send traffic first`,
		);
	}
	const [key, pair] = entry;
	const firstSnapshot = pair.prev ?? pair.last;

	const firstReplay = buildDiagnosisReplay(firstSnapshot, null);
	if (!firstReplay) throw new Error("captured body is not valid JSON");
	const endpoint = `http://127.0.0.1:${opts.port}/v1/messages`;

	const r1 = await fetchImpl(endpoint, {
		method: "POST",
		headers: firstReplay.headers,
		body: firstReplay.body,
	});
	const j1 = (await r1.json()) as Record<string, unknown>;
	if (!r1.ok) {
		throw new Error(`first replay failed (${r1.status}): ${preview(j1)}`);
	}
	const firstId = typeof j1.id === "string" ? j1.id : null;

	const secondReplay = buildDiagnosisReplay(pair.last, firstId);
	if (!secondReplay) throw new Error("captured body is not valid JSON");
	const r2 = await fetchImpl(endpoint, {
		method: "POST",
		headers: secondReplay.headers,
		body: secondReplay.body,
	});
	const j2 = (await r2.json()) as Record<string, unknown>;
	if (!r2.ok) {
		throw new Error(`second replay failed (${r2.status}): ${preview(j2)}`);
	}

	log.warn(
		`cache diagnosis run for session ${previewKey(key)} (pair=${pair.prev !== null})`,
	);
	return {
		session_preview: previewKey(key),
		pair: pair.prev !== null,
		first: { id: firstId, usage: j1.usage },
		second: {
			id: typeof j2.id === "string" ? j2.id : null,
			usage: j2.usage,
			diagnostics: j2.diagnostics ?? null,
		},
	};
}

/** HTTP handler for POST /api/debug/cache-diagnosis. */
export async function handleCacheDiagnosisRequest(
	req: Request,
	port: number,
): Promise<Response> {
	if (!cacheDiagEnabled()) {
		return json(
			{ error: `${CACHE_DIAG_ENV} is not enabled on this server` },
			409,
		);
	}
	let sessionPrefix: string | undefined;
	try {
		const body = (await req.json()) as { session?: string };
		if (typeof body.session === "string" && body.session !== "latest") {
			sessionPrefix = body.session;
		}
	} catch {
		// empty body means "latest"
	}
	try {
		const result = await runCacheDiagnosis({ port, sessionPrefix });
		return json({ result, sessions: listDiagnosisSessions() }, 200);
	} catch (error) {
		return json(
			{
				error: error instanceof Error ? error.message : String(error),
				sessions: listDiagnosisSessions(),
			},
			422,
		);
	}
}

/** Test hook: clear captured sessions. */
export function resetCacheDiagnosis(): void {
	sessions.clear();
}

function pickSession(prefix?: string): [string, SessionPair] | null {
	const entries = [...sessions.entries()];
	if (entries.length === 0) return null;
	if (!prefix) {
		// Most recently captured session.
		return entries[entries.length - 1];
	}
	return entries.find(([key]) => key.startsWith(prefix)) ?? null;
}

function snapshotHeaders(headers: Headers): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	headers.forEach((value, name) => {
		const lower = name.toLowerCase();
		if (STRIPPED_HEADERS.includes(lower)) return;
		if (lower.startsWith("x-better-ccflare-")) return;
		out.push([name, value]);
	});
	return out;
}

function previewKey(key: string): string {
	return key.length <= 32 ? key : `${key.slice(0, 32)}...`;
}

function preview(value: unknown): string {
	try {
		return JSON.stringify(value).slice(0, 200);
	} catch {
		return String(value).slice(0, 200);
	}
}

function json(payload: unknown, status: number): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
