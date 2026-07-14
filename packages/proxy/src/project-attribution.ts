import { Logger } from "@better-ccflare/logger";
import type { ProjectAttributionSource } from "@better-ccflare/types";
import type { RequestJsonBody } from "./request-body-context";

const log = new Logger("ProjectAttribution");

export interface ProjectExtractionResult {
	project: string | null;
	projectAttributionSource: ProjectAttributionSource;
}

// Project names are persisted to a single TEXT column and surfaced in the UI.
// Cap length and strip control chars so a hostile system prompt can't smuggle
// newlines, ANSI escapes, or megabyte-long blobs into the database.
export const PROJECT_NAME_MAX_LEN = 64;

export function sanitizeProjectName(
	raw: string | undefined | null,
): string | null {
	if (!raw) return null;
	// Strip ASCII control chars (incl. newlines/tabs) — keep Unicode letters,
	// dashes, dots, and spaces that real project directories use.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
	if (!cleaned) return null;
	return cleaned.length > PROJECT_NAME_MAX_LEN
		? cleaned.slice(0, PROJECT_NAME_MAX_LEN)
		: cleaned;
}

export function extractSystemPromptFromJson(
	body: RequestJsonBody | null,
): string | null {
	if (!body) return null;
	const system = body.system;

	if (typeof system === "string") {
		return system;
	}

	if (Array.isArray(system)) {
		return system
			.filter(
				(item): item is { type?: string; text: string } =>
					typeof item === "object" &&
					item !== null &&
					(item as { type?: string }).type === "text" &&
					typeof (item as { text?: unknown }).text === "string",
			)
			.map((item) => item.text)
			.join("\n");
	}

	return null;
}

export function extractSystemPromptFromBase64(
	requestBody: string | null,
): string | null {
	if (!requestBody) return null;

	try {
		// Decode base64 request body, then reuse the SAME extraction as the
		// parsed-body path so the legacy/direct fallback never diverges (R7) —
		// e.g. `system: [null, {type:"text", text:"..."}]` is tolerated here
		// exactly as extractSystemPromptFromJson tolerates it, not thrown on.
		const decodedBody = Buffer.from(requestBody, "base64").toString("utf-8");
		const parsed = JSON.parse(decodedBody) as RequestJsonBody;
		return extractSystemPromptFromJson(parsed);
	} catch (error) {
		// Malformed/undecodable body — treat as no system prompt, but keep it
		// diagnosable on the legacy usage-collector recompute path.
		log.debug("Failed to extract system prompt from request body:", error);
	}

	return null;
}

// Matches bearer/API-key-ish tokens such as sk-..., pk_..., rk-..., ak_...
const SECRET_TOKEN_RE = /\b(?:sk|pk|rk|ak)[-_][A-Za-z0-9]{8,}/i;
// Known branded secret-token prefixes SECRET_TOKEN_RE doesn't cover: GitHub
// PATs (ghp_/gho_/ghu_/ghs_/ghr_) and Slack tokens (xoxb-/xoxp-/xoxa-/xoxr-/xoxs-).
const KNOWN_SECRET_PREFIX_RE =
	/\bgh[opsur]_[A-Za-z0-9]{6,}\b|\bxox[baprs]-[A-Za-z0-9-]{6,}\b/i;
// "sk_live_...", "api-key-9f8e7d6c...": 2+ short segments delimited by `_`/`-`
// followed by a long tail that mixes letters AND digits. A second separator
// defeats SECRET_TOKEN_RE (which only tolerates one), and each individual
// segment can stay under LONG_TOKEN_RE's 20-char unbroken-run threshold — this
// catches the shape as a whole instead. The digit+letter requirement on the
// tail is what keeps ordinary hyphenated slugs safe: "attribution-source-tags"
// and "my-really-long-project-name" have word-only (no-digit) tails, so they
// are unaffected; only token-shaped tails ("abc123456789") match.
const MULTI_SEGMENT_TOKEN_RE =
	/\b(?:[A-Za-z0-9]+[_-]){2,}(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,}\b/;
// AWS access-key-id shape.
const AWS_KEY_RE = /AKIA[0-9A-Z]{12,}/;
// An unbroken run of 20+ alphanumeric chars — the shape of a raw secret, hash,
// or high-entropy token. Excludes separators (-, _, /) on purpose so ordinary
// hyphenated slugs like "attribution-source-tags" are NOT rejected, while still
// catching bare tokens the old 32-char base64-class pattern missed (16-31 char
// hex/base32 secrets, session ids, etc.).
const LONG_TOKEN_RE = /[A-Za-z0-9]{20,}/;
// Bare IPv4 address — an internal host, never a real project name.
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
// UUID / raw trace-id shape (explicitly prohibited as attribution metadata).
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// A leading URI scheme or Windows drive letter (file:, http:, mailto:, C:, ...).
// Matches "scheme:" anchored at the start; ordinary slugs have no leading scheme.
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// Customer / incident / ticket labels — operational metadata (who reported,
// what ticket) that must never be surfaced as a project name, even when short
// enough to dodge the six-word sentence heuristic (e.g. "Incident INC-123 Acme").
const INCIDENT_LABEL_RE =
	/\b(?:incident|inc|ticket|case|customer|acct|account)\b[-\s]?[A-Za-z0-9-]+/i;
// Jira-style ticket keys (PROJ-123) and explicit INC-### shapes.
const JIRA_TICKET_RE = /\b[A-Z]{2,}-\d+\b/;
// Dotted hostname-shaped label: an alphanumeric on both sides of a `.`, e.g.
// "customer.example.com" or "*.example.com" (via the "example.com" tail) or
// even a bare "foo.bar". Real project slugs don't need embedded dots between
// alnum runs, and this shape is exactly how hostnames/domains look, so it's
// rejected wholesale rather than only when a known TLD/scheme is present.
const DOTTED_HOSTNAME_LABEL_RE = /[A-Za-z0-9]\.[A-Za-z0-9]/;
// Opaque hex-shaped token: 16+ chars drawn only from [0-9a-f] (case-insensitive)
// with no separators — the shape of a hex-encoded id/hash/secret (e.g.
// "deadbeefcafebabe"). Below LONG_TOKEN_RE's 20-char general threshold, so it
// needs its own narrower rule restricted to the hex alphabet.
const HEX_OPAQUE_TOKEN_RE = /\b[0-9a-fA-F]{16,}\b/;
// Opaque base32/base64-ish token: 16+ unbroken alnum chars that mix letters
// AND digits — the shape of a random/opaque id (session id, API key body,
// etc.) rather than an ordinary English word. Requiring a digit keeps this
// from flagging long single-word slugs ("documentation-site" segments stay
// short anyway; a hypothetical all-letter 16+ char word is still let through).
const OPAQUE_MIXED_TOKEN_RE =
	/\b(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{16,}\b/;
// Credential-label prefix ("api-key-", "apikey", "access-key", "secret-key",
// "auth-token", "password", "credential(s)") followed by an opaque-looking
// tail. Catches shapes like "api-key-abcdefghijkl" that dodge
// MULTI_SEGMENT_TOKEN_RE because the tail is letters-only (no digit), by
// keying off the credential-shaped label itself rather than the tail's
// character class.
const CREDENTIAL_LABEL_RE =
	/\b(?:api[-_ ]?key|apikey|access[-_ ]?key|secret[-_ ]?key|auth[-_ ]?token|api[-_ ]?token|password|credentials?)\b[-_\s]?[A-Za-z0-9]{6,}/i;
// Allowed low-risk project-slug shape: starts with a word char or dot, then
// word chars, dots, spaces, or dashes, capped at 64 chars. Slashes and colons
// are intentionally excluded — they enable path, URI, host:port, and drive-letter
// shapes that must never be surfaced as a project label.
const SLUG_SHAPE_RE = /^[\w.][\w .-]{0,63}$/;

/**
 * Conservative validator for heading-derived project labels (R10a, hardened
 * round-2 per P1 review: reject-when-in-doubt rather than denylist
 * whack-a-mole).
 *
 * Validates the FULL cleaned heading (control-stripped, trimmed, but NEVER
 * length-capped) so a secret positioned near the 64-char truncation boundary
 * cannot be shortened below a detector threshold and slip through. Rejects
 * values that look like they could carry a secret, a raw trace/UUID id, a URL
 * or URI scheme, a dotted hostname-shaped label, an absolute/drive/traversal
 * path, an email address, a multi-segment API-key/token shape, an opaque
 * hex/base32/base64-ish token (16+ chars), a credential-labeled value
 * ("api-key-..."), a customer/incident/ticket label, or free-form
 * sentence/incident text. Accepts ordinary repo-name-shaped labels
 * (e.g. "better-ccflare", "Harness", "eval-suite", "My Project").
 */
export function isLowRiskProjectSlug(value: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const cleaned = value.replace(/[\x00-\x1F\x7F]/g, "").trim();
	if (!cleaned) return false;
	const lower = cleaned.toLowerCase();

	// URLs / URI schemes / hosts (case-insensitive — WWW.EXAMPLE.COM must fail too).
	if (
		lower.includes("://") ||
		lower.includes("www.") ||
		URI_SCHEME_RE.test(cleaned)
	) {
		return false;
	}

	// Absolute, Windows-drive, UNC, or traversal paths.
	if (
		cleaned.startsWith("/") ||
		cleaned.startsWith("\\") ||
		cleaned.includes("..")
	) {
		return false;
	}

	// Email address.
	const atIndex = cleaned.indexOf("@");
	if (atIndex !== -1 && cleaned.indexOf(".", atIndex) !== -1) return false;

	// Raw trace / UUID identifiers.
	if (UUID_RE.test(cleaned)) return false;

	// Dotted hostname-shaped labels (customer.example.com, foo.bar, ...) —
	// reject before the slug check even though dots are otherwise slug-legal,
	// since this exact shape is how a hostname/domain reads.
	if (DOTTED_HOSTNAME_LABEL_RE.test(cleaned)) return false;

	// Secrets, keys, IPs, and high-entropy tokens.
	if (
		SECRET_TOKEN_RE.test(cleaned) ||
		KNOWN_SECRET_PREFIX_RE.test(cleaned) ||
		MULTI_SEGMENT_TOKEN_RE.test(cleaned) ||
		CREDENTIAL_LABEL_RE.test(cleaned) ||
		lower.includes("bearer ") ||
		AWS_KEY_RE.test(cleaned) ||
		IPV4_RE.test(cleaned) ||
		LONG_TOKEN_RE.test(cleaned) ||
		HEX_OPAQUE_TOKEN_RE.test(cleaned) ||
		OPAQUE_MIXED_TOKEN_RE.test(cleaned)
	) {
		return false;
	}

	// Customer / incident / ticket-shaped labels — operational metadata, not a
	// project name, even when short enough to dodge the sentence heuristic below.
	if (INCIDENT_LABEL_RE.test(cleaned) || JIRA_TICKET_RE.test(cleaned)) {
		return false;
	}

	// Sentence / incident-shaped free text.
	if (cleaned.split(/\s+/).filter(Boolean).length > 6) return false;

	// Strict slug grammar on the FULL value (no slashes/colons; a >64-char value
	// fails the {0,63} bound and is rejected wholesale rather than truncated).
	return SLUG_SHAPE_RE.test(cleaned);
}

const WORKSPACE_PATH_RE =
	/\/(?:Users|home)\/[^/]+\/(?:Desktop|projects|repos|src)\/([^/]+)\//;
// Global so extractProjectAttribution can walk every H1 heading in the system
// prompt (not just the first) and pick the first one that is eligible.
const HEADING_RE = /^#\s+([^\n\r]{1,100})/gm;

/**
 * Core project attribution extraction. Accepts a header accessor so it works
 * uniformly for both the proxy's `Headers` object and the usage collector's
 * `Record<string, string>` header map.
 *
 * Precedence:
 *  1. `x-better-ccflare-project` header, then legacy `x-project` header.
 *  2. Workspace path embedded in the system prompt.
 *  3. First eligible non-Claude, low-risk-slug H1 heading in the system prompt.
 *  4. No project.
 */
export function extractProjectAttribution(
	getHeader: (name: string) => string | null | undefined,
	systemPrompt: string | null,
): ProjectExtractionResult {
	const namespacedHeader = sanitizeProjectName(
		getHeader("x-better-ccflare-project"),
	);
	if (namespacedHeader) {
		return {
			project: namespacedHeader,
			projectAttributionSource: "header_project",
		};
	}

	const legacyHeader = sanitizeProjectName(getHeader("x-project"));
	if (legacyHeader) {
		return {
			project: legacyHeader,
			projectAttributionSource: "header_project",
		};
	}

	if (systemPrompt) {
		const pathMatch = systemPrompt.match(WORKSPACE_PATH_RE);
		const sanitizedPath = sanitizeProjectName(pathMatch?.[1]);
		if (sanitizedPath) {
			return {
				project: sanitizedPath,
				projectAttributionSource: "path_project",
			};
		}

		// Walk EVERY H1 heading (not just the first) and use the first one that
		// is both non-Claude and passes the low-risk slug validator. A doc that
		// opens with "# Claude Code Instructions" before a real "# Harness"
		// heading must not lose attribution just because the first heading was
		// ineligible.
		for (const headingMatch of systemPrompt.matchAll(HEADING_RE)) {
			// Validate the FULL captured heading, then length-cap only after it
			// passes — truncating first could shorten a boundary-straddling secret
			// below a detector threshold and let a partial secret through.
			const rawHeading = headingMatch[1];
			if (rawHeading.trim().toLowerCase().startsWith("claude")) continue;
			if (!isLowRiskProjectSlug(rawHeading)) continue;
			const heading = sanitizeProjectName(rawHeading);
			if (heading) {
				return {
					project: heading,
					projectAttributionSource: "heading_project",
				};
			}
		}
	}

	return { project: null, projectAttributionSource: "none" };
}

/**
 * Convenience wrapper for the proxy's parsed-JSON-body request path.
 */
export function extractProjectAttributionFromRequest(
	headers: Headers,
	body: RequestJsonBody | null,
): ProjectExtractionResult {
	const systemPrompt = extractSystemPromptFromJson(body);
	return extractProjectAttribution((n) => headers.get(n), systemPrompt);
}

/**
 * Convenience wrapper for the usage collector's `StartMessage`-shaped input,
 * where headers arrive as a plain `Record<string, string>` and the body is a
 * base64-encoded JSON string.
 */
export function extractProjectAttributionFromParts(
	requestHeaders: Record<string, string> | null | undefined,
	requestBodyBase64: string | null,
): ProjectExtractionResult {
	const headerMap: Record<string, string> = {};
	if (requestHeaders) {
		for (const [key, value] of Object.entries(requestHeaders)) {
			headerMap[key.toLowerCase()] = value;
		}
	}
	const systemPrompt = extractSystemPromptFromBase64(requestBodyBase64);
	return extractProjectAttribution(
		(n) => headerMap[n.toLowerCase()],
		systemPrompt,
	);
}
