/**
 * Centralized constants for the better-ccflare application
 * All magic numbers should be defined here to improve maintainability
 */

// Time constants (all in milliseconds)
export const TIME_CONSTANTS = {
	// Base units
	SECOND: 1000,
	MINUTE: 60 * 1000,
	HOUR: 60 * 60 * 1000,
	DAY: 24 * 60 * 60 * 1000,

	// Session durations - specifically for Anthropic usage windows
	ANTHROPIC_SESSION_DURATION_DEFAULT: 5 * 60 * 60 * 1000, // 5 hours - default for Anthropic provider session tracking
	ANTHROPIC_SESSION_DURATION_FALLBACK: 1 * 60 * 60 * 1000, // 1 hour - fallback for Anthropic provider
	/**
	 * @deprecated Use ANTHROPIC_SESSION_DURATION_DEFAULT instead.
	 * This constant is kept for backward compatibility only and should not be used in new code.
	 */
	SESSION_DURATION_DEFAULT: 5 * 60 * 60 * 1000, // 5 hours - kept for backward compatibility - new code should use ANTHROPIC_SESSION_DURATION_DEFAULT

	// Timeouts
	STREAM_TIMEOUT_DEFAULT: 1000 * 60 * 1, // 1 minute
	STREAM_READ_TIMEOUT_MS: 60000, // 60 seconds - overall timeout for stream reads
	STREAM_OPERATION_TIMEOUT_MS: 30000, // 30 seconds - timeout per read operation

	// Streaming forwarder timeouts (response-handler.ts).
	// Agentic workloads (e.g. recursive claude-code-sdk sessions) can have long
	// quiet periods between chunks while sub-calls run. These defaults are set
	// conservatively high so nested calls don't trigger a false timeout and cause
	// the outer request to appear failed/missing in the UI (issue #84).
	// Both can be overridden at runtime via env vars:
	//   CF_STREAM_TOTAL_TIMEOUT_MS  — max total stream duration
	//   CF_STREAM_CHUNK_TIMEOUT_MS  — max silence between consecutive chunks
	STREAM_FORWARD_TOTAL_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes
	STREAM_FORWARD_CHUNK_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
	OAUTH_STATE_TTL: 10, // 10 minutes (stored separately as minutes)
	RETRY_DELAY_DEFAULT: 1000, // 1 second
	PROXY_REQUEST_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes — covers long agent calls

	// Cache durations
	CACHE_YEAR: 31536000, // 365 days in seconds for HTTP cache headers

	// Token expiration durations
	API_KEY_TOKEN_EXPIRY_MS: 365 * 24 * 60 * 60 * 1000, // 1 year - for API keys that don't expire
	GOOGLE_TOKEN_EXPIRY_MS: 60 * 60 * 1000, // 1 hour - Google Cloud access tokens

	// Default cooldown applied when an upstream returns 429 *without* a
	// reset hint (no `retry-after`, no rate-limit-reset header, no SSE
	// reset frame, no usage-cache window reset). Treats the cooldown
	// as a probe interval rather than a hard ban: the account is
	// excluded for a short window, then the next request re-probes.
	// Real upstream rate-limit replies ship a retry-after / reset
	// header and use the precise value from the header — those flows
	// are unaffected by this default.
	// Override at runtime via CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS.
	DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS: 60 * 1000, // 60s

	// Adaptive rate-limit cooldown with exponential backoff.
	// On each 429 in a consecutive streak, the cooldown grows: BASE * 2^(n-1),
	// capped at MAX. Counter resets to 0 only after a successful response that
	// follows a quiet period of at least RESET_STABILITY_MS since the last 429.
	// Override at runtime via CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS /
	// CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS / CCFLARE_RATE_LIMIT_RESET_STABILITY_MS.
	RATE_LIMIT_BACKOFF_BASE_MS: 30 * 1000, // 30s: cooldown for the 1st 429 in a streak
	RATE_LIMIT_BACKOFF_MAX_MS: 5 * 60 * 1000, // 5min: ceiling for the exponential ramp
	RATE_LIMIT_RESET_STABILITY_MS: 5 * 60 * 1000, // 5min: healthy operation needed to reset the streak counter
} as const;

/**
 * Compute the cooldown duration (ms) for the n-th consecutive 429 in a streak.
 *
 * Behavior:
 *   - For n in [1..], returns `BASE * 2^(n-1)`, clamped to MAX.
 *   - For n <= 0, behaves as n=1 (returns BASE).
 *   - Reads BASE/MAX from env (`CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS` /
 *     `CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS`), falling back to the
 *     TIME_CONSTANTS defaults.
 *   - Defends against misconfiguration: env BASE <= 0 is floored to 1000ms so
 *     cooldowns can never collapse to zero. MAX is floored to BASE so the
 *     ceiling can never sit below the floor.
 *   - Caps the exponent at 30 before the bit-shift to prevent overflow at
 *     very large n (e.g. n=100).
 *
 * Sequence with defaults: 30s → 60s → 120s → 240s → 300s (capped) → 300s …
 */
export function computeRateLimitBackoffMs(consecutiveCount: number): number {
	// Read raw env values. We deliberately preserve 0 / negatives here (rather
	// than treating them as "unset") so the Math.max floors below can defend
	// against deliberate misconfiguration. Only an unset / non-numeric env
	// falls back to the default.
	const baseEnv = Number(process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS);
	const maxEnv = Number(process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS);
	const baseRaw = Number.isFinite(baseEnv)
		? baseEnv
		: TIME_CONSTANTS.RATE_LIMIT_BACKOFF_BASE_MS;
	const maxRaw = Number.isFinite(maxEnv)
		? maxEnv
		: TIME_CONSTANTS.RATE_LIMIT_BACKOFF_MAX_MS;
	// Clamp to defend against misconfiguration (env=0/negative would collapse cooldown to 0)
	const base = Math.max(1000, baseRaw);
	const max = Math.max(base, maxRaw);
	const n = Math.max(1, consecutiveCount);
	// Cap exponent before bit-shift to avoid overflow at large n
	const exp = Math.min(n - 1, 30);
	return Math.min(base * 2 ** exp, max);
}

/**
 * Read the stability-reset window (ms) for the consecutive_rate_limits counter.
 *
 * Behavior:
 *   - Reads `CCFLARE_RATE_LIMIT_RESET_STABILITY_MS` from env.
 *   - Falls back to the TIME_CONSTANTS default (5 min) when unset / non-numeric
 *     OR when the env value is <= 0 (a 0/negative value would mean the counter
 *     resets immediately on any success, defeating the streak detection).
 *   - Uses `Number.isFinite(raw) && raw > 0` (not `Number(env) || DEFAULT`,
 *     because `0` is falsy in JS — same rationale as computeRateLimitBackoffMs).
 */
export function getRateLimitResetStabilityMs(): number {
	const raw = Number(process.env.CCFLARE_RATE_LIMIT_RESET_STABILITY_MS);
	// Clamp to defend against misconfiguration (env=0/negative would never reset the counter).
	return Number.isFinite(raw) && raw > 0
		? raw
		: TIME_CONSTANTS.RATE_LIMIT_RESET_STABILITY_MS;
}

// Buffer sizes (in bytes unless specified)
export const BUFFER_SIZES = {
	// Stream usage buffer size in KB (multiplied by 1024 to get bytes)
	STREAM_USAGE_BUFFER_KB: 64,
	STREAM_USAGE_BUFFER_BYTES: 64 * 1024,

	// Stream body max size
	STREAM_BODY_MAX_KB: 256,
	STREAM_BODY_MAX_BYTES: 256 * 1024, // 256KB default

	// Anthropic provider stream cap
	ANTHROPIC_STREAM_CAP_BYTES: 32768, // 32KB

	// Stream tee default max bytes
	STREAM_TEE_MAX_BYTES: 1024 * 1024, // 1MB

	// Log file size
	LOG_FILE_MAX_SIZE: 10 * 1024 * 1024, // 10MB
} as const;

// Network constants
export const NETWORK = {
	// Ports
	DEFAULT_PORT: 8080,

	// Timeouts
	IDLE_TIMEOUT_MAX: 255, // Max allowed by Bun
} as const;

// Cache control headers
export const CACHE = {
	// HTTP cache control max-age values (in seconds)
	STATIC_ASSETS_MAX_AGE: 31536000, // 1 year
	CACHE_CONTROL_IMMUTABLE: "public, max-age=31536000, immutable",
	CACHE_CONTROL_STATIC: "public, max-age=31536000",
	CACHE_CONTROL_NO_CACHE: "no-cache, no-store, must-revalidate",
} as const;

// Request/Response limits
export const LIMITS = {
	// Request history limits
	REQUEST_HISTORY_DEFAULT: 50,
	REQUEST_DETAILS_DEFAULT: 100,
	REQUEST_HISTORY_MAX: 1000,
	LOG_READ_DEFAULT: 1000,

	// Account name constraints
	ACCOUNT_NAME_MIN_LENGTH: 1,
	ACCOUNT_NAME_MAX_LENGTH: 100,

	// UI formatting
	CONSOLE_SEPARATOR_LENGTH: 100,
	CONSOLE_COLUMN_PADDING: {
		NAME: 20,
		TYPE: 10,
		REQUESTS: 12,
		TOKEN: 10,
		STATUS: 20,
	},
} as const;

// HTTP status codes
export const HTTP_STATUS = {
	OK: 200,
	NOT_FOUND: 404,
	TOO_MANY_REQUESTS: 429,
	INTERNAL_SERVER_ERROR: 500,
	SERVICE_UNAVAILABLE: 503,
} as const;

// Account tiers - removed unused ACCOUNT_TIERS export
// Statistical calculations - removed unused STATS export
