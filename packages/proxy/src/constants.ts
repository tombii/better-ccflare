// Token management constants
export const TOKEN_SAFETY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes - proactive refresh window (updated from 30 seconds for 41-day OAuth tokens)
export const TOKEN_REFRESH_BACKOFF_MS = 60_000; // 60 seconds - backoff after refresh failure
