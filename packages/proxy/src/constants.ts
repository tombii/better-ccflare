// Token management constants
export const TOKEN_SAFETY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes - proactive refresh window (updated from 30 seconds for 41-day OAuth tokens)
export const TOKEN_REFRESH_BACKOFF_MS = 60_000; // 60 seconds - backoff after refresh failure

// Refresh token health monitoring constants
export const REFRESH_TOKEN_WARNING_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days - warn user before refresh token expires
export const REFRESH_TOKEN_CRITICAL_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days - critical warning
export const REFRESH_TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days - assumed maximum refresh token lifespan
export const REFRESH_TOKEN_HEALTH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours - check token health periodically
