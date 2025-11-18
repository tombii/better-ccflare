/**
 * Token Management Constants
 *
 * These constants define the timing and behavior for OAuth token lifecycle management.
 * They are designed to provide a balance between security, reliability, and user experience.
 *
 * **Token Safety Window (30 minutes):** Proactive refresh window to prevent token expiration
 * during active usage. Updated from 30 seconds to accommodate longer-lived OAuth tokens (41 days).
 * This provides a safety margin to ensure tokens don't expire during long-running operations.
 */
export const TOKEN_SAFETY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes - proactive refresh window

/**
 * **Token Refresh Backoff (60 seconds):** Cooldown period after failed token refresh attempts.
 * Prevents rapid retry attempts that could trigger rate limiting or account lockout.
 * Allows time for temporary network or service issues to resolve.
 */
export const TOKEN_REFRESH_BACKOFF_MS = 60_000; // 60 seconds - backoff after refresh failure

/**
 * Refresh Token Health Monitoring Thresholds
 *
 * These thresholds define the token health status levels for proactive token management:
 *
 * **Security Rationale:**
 * - OAuth refresh tokens typically have long lifespans (up to 90 days)
 * - Proactive warnings prevent unexpected service interruptions
 * - Gradual warning levels give users time to re-authenticate
 * - Health checks provide visibility into token status
 *
 * **Threshold Strategy:**
 * - WARNING (7 days): Early warning for non-urgent re-authentication
 * - CRITICAL (3 days): Urgent warning requiring immediate attention
 * - EXPIRED (0 days): Token has expired, service interruption likely
 */

/**
 * **Warning Threshold (7 days):** First level of token expiration warning.
 *
 * Triggers when refresh token age reaches 7 days. This provides sufficient time
 * for users to re-authenticate without service interruption, while still being
 * proactive about token management.
 */
export const REFRESH_TOKEN_WARNING_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * **Critical Threshold (3 days):** Second level of urgent token expiration warning.
 *
 * Triggers when refresh token age reaches 3 days. This indicates imminent token
 * expiration and requires prompt user attention to prevent service disruption.
 * Users should re-authenticate immediately at this level.
 */
export const REFRESH_TOKEN_CRITICAL_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * **Maximum Age (90 days):** Conservative upper bound for refresh token lifespan.
 *
 * While OAuth providers may support tokens with longer lifespans, this constant
 * provides a safe default assumption for token expiration. Many OAuth providers
 * issue refresh tokens with 30-90 day lifespans, making this a reasonable maximum.
 */
export const REFRESH_TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * **Health Check Interval (6 hours):** Periodic monitoring frequency.
 *
 * Determines how often token health is checked during normal operation.
 * This provides regular monitoring without excessive resource usage or API calls.
 * Six-hour intervals balance timely detection with system performance.
 *
 * **Performance Considerations:**
 * - Frequent enough to catch token issues promptly
 * - Infrequent enough to avoid unnecessary resource consumption
 * - Aligns with typical operational monitoring cycles
 */
export const REFRESH_TOKEN_HEALTH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Token Health Status Mapping:
 *
 * Token health is determined by comparing refresh token age against thresholds:
 *
 * - **healthy**: Token age < WARNING_THRESHOLD (7 days)
 * - **warning**: WARNING_THRESHOLD ≤ age < CRITICAL_THRESHOLD (7-3 days)
 * - **critical**: CRITICAL_THRESHOLD ≤ age < MAX_AGE (3-90 days)
 * - **expired**: age ≥ MAX_AGE (≥90 days) OR token expiration in past
 * - **no-refresh-token**: Non-OAuth accounts (API key accounts)
 *
 * **Status Implications:**
 * - healthy: Normal operation, no action required
 * - warning: Plan re-authentication within next week
 * - critical: Re-authenticate immediately to prevent service interruption
 * - expired: Service interruption likely, immediate re-authentication required
 */
