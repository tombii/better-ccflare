/**
 * Types for the alerting system (issue #250): threshold rules,
 * anomaly-driven alerts, alert history, and alert configuration.
 *
 * Pure data shapes shared between the HTTP API, the alert engine,
 * and the dashboard.
 */

/** Severity level attached to an alert event. */
export type AlertSeverity = "info" | "warning" | "critical";

/** Discriminates which rule or anomaly detector produced an alert. */
export type AlertType =
	| "daily_spend"
	| "tokens_per_hour"
	| "request_tokens"
	| "anomaly_token_outlier"
	| "anomaly_output_blowup"
	| "anomaly_runaway_loop"
	| "anomaly_model_misrouting"
	| "auth_failure";

/** A single alert raised by the alert engine. */
export interface AlertEvent {
	id: string;
	/** ms epoch */
	timestamp: number;
	type: AlertType;
	severity: AlertSeverity;
	title: string;
	message: string;
	/** Observed value that triggered the alert. */
	value: number | null;
	/** Configured threshold (null for anomaly alerts). */
	threshold: number | null;
	account: string | null;
	model: string | null;
	project: string | null;
	requestId: string | null;
	acknowledged: boolean;
}

/** Full response of GET /api/alerts. */
export interface AlertHistoryResponse {
	alerts: AlertEvent[];
	unacknowledgedCount: number;
}

/** Alert configuration payload exchanged with the settings API. */
export interface AlertsConfigPayload {
	/** Daily spend threshold in USD; 0 = disabled. */
	dailySpendUsd: number;
	/** Tokens-per-hour threshold; 0 = disabled. */
	tokensPerHour: number;
	/** Per-request token threshold; 0 = disabled. */
	requestTokens: number;
	anomalyEnabled: boolean;
	anomalyIntervalMinutes: number;
	cooldownMinutes: number;
	/** Webhook target URL; "" = disabled. */
	webhookUrl: string;
}
