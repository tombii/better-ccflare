import type { BunSqlAdapter } from "@better-ccflare/database";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";
import type { AccountResponse } from "../types";

/**
 * Upper bound + sanitation applied to the incoming session id path segment,
 * mirroring `sanitizeClientSessionId` / `CLIENT_SESSION_ID_MAX_LEN` in
 * packages/database/src/repositories/request.repository.ts — the write path
 * for the `requests.client_session_id` column this endpoint reads back.
 * Applying the same bound here means a hostile or buggy caller can't drive
 * an unbounded lookup key, and applying the same character-stripping means a
 * legitimately-stored id (already stripped on write) can still be found.
 */
const CLIENT_SESSION_ID_MAX_LEN = 200;

function sanitizeSessionId(raw: string): string | null {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
	if (!cleaned) return null;
	return cleaned.length > CLIENT_SESSION_ID_MAX_LEN
		? cleaned.slice(0, CLIENT_SESSION_ID_MAX_LEN)
		: cleaned;
}

/**
 * Flat, single-shape payload for GET /api/sessions/:sessionId/account:
 * `status` is always present; `account` only when `status === "known"`. No
 * separate "not found" shape — callers always get one of these two.
 */
interface SessionAccountData {
	status: "known" | "unknown";
	account?: AccountResponse;
}

function unknownResponse(): Response {
	return jsonResponse({ status: "unknown" } satisfies SessionAccountData);
}

/**
 * GET /api/sessions/:sessionId/account — resolve the account that most
 * recently served a given client session, for local status-line
 * integrations (issue #318).
 *
 * Reduced-scope implementation per the maintainer's guidance on #318: a
 * DB-backed lookup only — the most recent `requests` row for this
 * `client_session_id` with a non-null `account_used`. The optional "live"
 * path (reading SessionAffinityStrategy's in-memory sticky map directly)
 * was evaluated and skipped: SessionAffinityStrategy currently exposes only
 * an aggregate count (`affinityEntries`), not a per-client lookup, and
 * adding one would mean widening that strategy's public surface beyond a
 * trivial change. The DB path alone satisfies the issue; a live path is a
 * possible follow-up.
 *
 * `accountsHandler` must be the SAME handler backing GET /api/accounts
 * (`createAccountsListHandler`), so the `account` this returns is
 * byte-for-byte what that endpoint would return for this account id — no
 * parallel serialization to keep in sync.
 */
export function createSessionAccountHandler(
	db: BunSqlAdapter,
	accountsHandler: () => Promise<Response>,
) {
	return async (sessionId: string): Promise<Response> => {
		const sanitized = sanitizeSessionId(sessionId);
		if (!sanitized) {
			return errorResponse(BadRequest("Session id cannot be empty"));
		}

		const rows = await db.query<{ account_used: string | null }>(
			`SELECT account_used
			 FROM requests
			 WHERE client_session_id = ? AND account_used IS NOT NULL
			 ORDER BY timestamp DESC
			 LIMIT 1`,
			[sanitized],
		);
		const accountId = rows[0]?.account_used;
		if (!accountId) {
			// No request ever recorded this session (or none carried an account).
			return unknownResponse();
		}

		const accountsRes = await accountsHandler();
		const accounts = (await accountsRes.json()) as AccountResponse[];
		const account = accounts.find((a) => a.id === accountId);
		if (!account) {
			// The serving account was removed since it last served this session —
			// resolve to unknown so the response stays single-shape.
			return unknownResponse();
		}

		const data: SessionAccountData = { status: "known", account };
		return jsonResponse(data);
	};
}
