import type { Config } from "@better-ccflare/config";
import {
	type AlertEvt,
	type AuthFailureEvt,
	alertEvents,
	authFailureEvents,
	getModelRates,
	type RequestEvt,
	requestEvents,
} from "@better-ccflare/core";
import type { BunSqlAdapter } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import type {
	AlertEvent,
	AlertsConfigPayload,
	AlertType,
	RequestResponse,
} from "@better-ccflare/types";
import {
	type AnomalyRequestRow,
	buildAnomalyInsightsResponse,
} from "./anomaly-insights";

const log = new Logger("AlertsService");
const HOUR_MS = 60 * 60 * 1000;
const MAX_ANOMALY_ALERTS_PER_RUN = 25;

interface AlertRow {
	id: string;
	timestamp: number;
	type: AlertType;
	severity: AlertEvent["severity"];
	title: string;
	message: string;
	value: number | null;
	threshold: number | null;
	account: string | null;
	model: string | null;
	project: string | null;
	request_id: string | null;
	acknowledged: number;
}

interface DailySpendRow {
	total: number | null;
}

interface TokensPerHourRow {
	total: number | null;
}

interface AnomalySqlRow {
	id: string;
	timestamp: number;
	account: string | null;
	model: string | null;
	project: string | null;
	input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
	output_tokens: number;
	cost_usd: number;
}

export function getAlertsConfig(config: Config): AlertsConfigPayload {
	return {
		dailySpendUsd: config.getAlertDailySpendUsd(),
		tokensPerHour: config.getAlertTokensPerHour(),
		requestTokens: config.getAlertRequestTokens(),
		anomalyEnabled: config.getAlertAnomalyEnabled(),
		anomalyIntervalMinutes: config.getAlertAnomalyIntervalMinutes(),
		cooldownMinutes: config.getAlertCooldownMinutes(),
		webhookUrl: config.getAlertWebhookUrl(),
	};
}

export function setAlertsConfig(
	config: Config,
	payload: AlertsConfigPayload,
): void {
	// Validate webhookUrl before mutating any fields to avoid partial config state.
	// setAlertWebhookUrl throws ValidationError for non-http(s) URLs; all other
	// setters only clamp/coerce and never throw.
	config.setAlertWebhookUrl(payload.webhookUrl);
	config.setAlertDailySpendUsd(payload.dailySpendUsd);
	config.setAlertTokensPerHour(payload.tokensPerHour);
	config.setAlertRequestTokens(payload.requestTokens);
	config.setAlertAnomalyEnabled(payload.anomalyEnabled);
	config.setAlertAnomalyIntervalMinutes(payload.anomalyIntervalMinutes);
	config.setAlertCooldownMinutes(payload.cooldownMinutes);
}

export function shouldFireAlert(threshold: number, value: number): boolean {
	return threshold > 0 && value >= threshold;
}

export function buildThresholdAlertId(
	type: AlertType,
	scope: string,
	timestamp: number,
	cooldownMinutes: number,
): string {
	const bucketMs = Math.max(1, cooldownMinutes) * 60 * 1000;
	return `${type}:${scope}:${Math.floor(timestamp / bucketMs)}`;
}

function parseTimestamp(timestamp: string | number): number {
	if (typeof timestamp === "number") return timestamp;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function requestTokenTotal(request: RequestResponse): number {
	return (
		request.totalTokens ??
		(request.inputTokens ?? 0) +
			(request.cacheReadInputTokens ?? 0) +
			(request.cacheCreationInputTokens ?? 0) +
			(request.outputTokens ?? 0)
	);
}

export function buildRequestTokenAlert(
	request: RequestResponse,
	config: AlertsConfigPayload,
): AlertEvent | null {
	const totalTokens = requestTokenTotal(request);
	if (!shouldFireAlert(config.requestTokens, totalTokens)) return null;
	const timestamp = parseTimestamp(request.timestamp);
	return {
		id: buildThresholdAlertId(
			"request_tokens",
			request.id,
			timestamp,
			config.cooldownMinutes,
		),
		timestamp,
		type: "request_tokens",
		severity: "critical",
		title: "Single request token threshold exceeded",
		message: `Request ${request.id} used ${totalTokens.toLocaleString()} tokens, meeting the configured ${config.requestTokens.toLocaleString()} token threshold.`,
		value: totalTokens,
		threshold: config.requestTokens,
		account: request.accountUsed,
		model: request.model ?? null,
		project: request.project ?? null,
		requestId: request.id,
		acknowledged: false,
	};
}

function toAlertEvent(row: AlertRow): AlertEvent {
	return {
		id: row.id,
		timestamp: Number(row.timestamp),
		type: row.type,
		severity: row.severity,
		title: row.title,
		message: row.message,
		value: row.value == null ? null : Number(row.value),
		threshold: row.threshold == null ? null : Number(row.threshold),
		account: row.account,
		model: row.model,
		project: row.project,
		requestId: row.request_id,
		acknowledged: Boolean(row.acknowledged),
	};
}

function toAnomalyRow(row: AnomalySqlRow): AnomalyRequestRow {
	return {
		id: row.id,
		timestamp: Number(row.timestamp) || 0,
		account: row.account,
		model: row.model,
		project: row.project,
		inputTokens: Number(row.input_tokens) || 0,
		cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
		cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
		outputTokens: Number(row.output_tokens) || 0,
		costUsd: Number(row.cost_usd) || 0,
	};
}

export class AlertService {
	private readonly db: BunSqlAdapter;
	private readonly config: Config;
	private readonly requestListener: (event: RequestEvt) => void;
	private readonly authFailureListener: (event: AuthFailureEvt) => void;
	private readonly configChangeListener: ({ key }: { key: string }) => void;
	private anomalyTimer: ReturnType<typeof setInterval> | null = null;

	constructor(db: BunSqlAdapter, config: Config) {
		this.db = db;
		this.config = config;
		this.requestListener = (event) => {
			if (event.type === "summary") {
				void this.evaluateRequest(event.payload);
			}
		};
		this.authFailureListener = (event) => {
			void this.handleAuthFailure(event);
		};
		this.configChangeListener = ({ key }: { key: string }) => {
			if (
				key === "alert_anomaly_enabled" ||
				key === "alert_anomaly_interval_minutes"
			) {
				this.restartAnomalyTimer();
			}
		};
	}

	start(): void {
		requestEvents.on("event", this.requestListener);
		this.config.on("change", this.configChangeListener);
		authFailureEvents.on("event", this.authFailureListener);
		this.restartAnomalyTimer();
	}

	stop(): void {
		requestEvents.off("event", this.requestListener);
		this.config.off("change", this.configChangeListener);
		authFailureEvents.off("event", this.authFailureListener);
		if (this.anomalyTimer) {
			clearInterval(this.anomalyTimer);
			this.anomalyTimer = null;
		}
	}

	private async handleAuthFailure(event: AuthFailureEvt): Promise<void> {
		const timestamp = Date.now();
		const config = getAlertsConfig(this.config);
		const alert: AlertEvent = {
			id: buildThresholdAlertId(
				"auth_failure",
				event.accountId,
				timestamp,
				config.cooldownMinutes,
			),
			timestamp,
			type: "auth_failure",
			severity: "critical",
			title: "Account authentication failed",
			message: `Account ${event.accountName} (${event.provider}) requires re-authentication: ${event.reason}`,
			value: null,
			threshold: null,
			account: event.accountName,
			model: null,
			project: null,
			requestId: null,
			acknowledged: false,
		};
		await this.persistAndEmit(alert, config.webhookUrl);
	}

	private restartAnomalyTimer(): void {
		if (this.anomalyTimer) {
			clearInterval(this.anomalyTimer);
			this.anomalyTimer = null;
		}
		const config = getAlertsConfig(this.config);
		if (!config.anomalyEnabled) return;
		this.anomalyTimer = setInterval(
			() => {
				void this.evaluateAnomalies();
			},
			config.anomalyIntervalMinutes * 60 * 1000,
		);
	}

	async evaluateRequest(request: RequestResponse): Promise<void> {
		const config = getAlertsConfig(this.config);
		const alerts: AlertEvent[] = [];
		const requestAlert = buildRequestTokenAlert(request, config);
		if (requestAlert) alerts.push(requestAlert);
		const timestamp = parseTimestamp(request.timestamp);
		alerts.push(
			...(await this.buildAggregateAlerts(timestamp, request, config)),
		);
		for (const alert of alerts) {
			await this.persistAndEmit(alert, config.webhookUrl);
		}
	}

	async listAlerts(limit = 100): Promise<AlertEvent[]> {
		const rows = await this.db.query<AlertRow>(
			`SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?`,
			[Math.max(1, Math.min(500, Math.round(limit)))],
		);
		return rows.map(toAlertEvent);
	}

	async getUnacknowledgedCount(): Promise<number> {
		const row = await this.db.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0`,
		);
		return Number(row?.count) || 0;
	}

	async acknowledgeAlert(id: string): Promise<boolean> {
		const row = await this.db.get<{ cnt: number }>(
			`SELECT COUNT(*) as cnt FROM alerts WHERE id = ?`,
			[id],
		);
		if (!row || row.cnt === 0) return false;
		await this.db.run(`UPDATE alerts SET acknowledged = 1 WHERE id = ?`, [id]);
		return true;
	}

	async acknowledgeAll(): Promise<void> {
		await this.db.run(
			`UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0`,
		);
	}

	private async buildAggregateAlerts(
		timestamp: number,
		request: RequestResponse,
		config: AlertsConfigPayload,
	): Promise<AlertEvent[]> {
		const alerts: AlertEvent[] = [];
		const dayStart = new Date(timestamp);
		dayStart.setHours(0, 0, 0, 0);
		if (config.dailySpendUsd > 0) {
			const row = await this.db.get<DailySpendRow>(
				`SELECT SUM(COALESCE(cost_usd, 0)) as total FROM requests WHERE timestamp >= ?`,
				[dayStart.getTime()],
			);
			const total = Number(row?.total) || 0;
			if (shouldFireAlert(config.dailySpendUsd, total)) {
				alerts.push({
					id: buildThresholdAlertId(
						"daily_spend",
						"global",
						timestamp,
						config.cooldownMinutes,
					),
					timestamp,
					type: "daily_spend",
					severity: "warning",
					title: "Daily spend threshold exceeded",
					message: `Daily spend reached $${total.toFixed(2)}, meeting the configured $${config.dailySpendUsd.toFixed(2)} threshold.`,
					value: total,
					threshold: config.dailySpendUsd,
					account: null,
					model: null,
					project: request.project ?? null,
					requestId: request.id,
					acknowledged: false,
				});
			}
		}
		if (config.tokensPerHour > 0) {
			const row = await this.db.get<TokensPerHourRow>(
				`SELECT SUM(COALESCE(total_tokens, 0)) as total FROM requests WHERE timestamp >= ?`,
				[timestamp - HOUR_MS],
			);
			const total = Number(row?.total) || 0;
			if (shouldFireAlert(config.tokensPerHour, total)) {
				alerts.push({
					id: buildThresholdAlertId(
						"tokens_per_hour",
						"global",
						timestamp,
						config.cooldownMinutes,
					),
					timestamp,
					type: "tokens_per_hour",
					severity: "warning",
					title: "Hourly token threshold exceeded",
					message: `The last hour used ${total.toLocaleString()} tokens, meeting the configured ${config.tokensPerHour.toLocaleString()} token threshold.`,
					value: total,
					threshold: config.tokensPerHour,
					account: null,
					model: null,
					project: request.project ?? null,
					requestId: request.id,
					acknowledged: false,
				});
			}
		}
		return alerts;
	}

	async evaluateAnomalies(): Promise<void> {
		const config = getAlertsConfig(this.config);
		if (!config.anomalyEnabled) return;
		const since = Date.now() - config.anomalyIntervalMinutes * 60 * 1000;
		const rows = (
			await this.db.query<AnomalySqlRow>(
				`
				SELECT
					r.id as id,
					r.timestamp as timestamp,
					a.name as account,
					r.model as model,
					r.project as project,
					COALESCE(r.input_tokens, 0) as input_tokens,
					COALESCE(r.cache_read_input_tokens, 0) as cache_read_input_tokens,
					COALESCE(r.cache_creation_input_tokens, 0) as cache_creation_input_tokens,
					COALESCE(r.output_tokens, 0) as output_tokens,
					COALESCE(r.cost_usd, 0) as cost_usd
				FROM requests r
				LEFT JOIN accounts a ON a.id = r.account_used
				WHERE r.timestamp >= ?
				ORDER BY r.timestamp ASC
			`,
				[since],
			)
		).map(toAnomalyRow);
		if (rows.length === 0) return;
		const modelIds = [
			...new Set(
				rows
					.map((row) => row.model)
					.filter((model): model is string => model != null && model !== ""),
			),
		];
		const rateList = await Promise.all(
			modelIds.map((modelId) => getModelRates(modelId)),
		);
		const rates = new Map(
			modelIds.map((modelId, index) => [modelId, rateList[index]]),
		);
		const response = buildAnomalyInsightsResponse({
			rows,
			rates,
			options: { range: `${config.anomalyIntervalMinutes}m`, truncated: false },
		});
		const alerts: AlertEvent[] = [];
		for (const event of response.tokenOutliers.slice(
			0,
			MAX_ANOMALY_ALERTS_PER_RUN,
		)) {
			alerts.push({
				id: buildThresholdAlertId(
					"anomaly_token_outlier",
					event.requestId,
					event.timestamp,
					config.cooldownMinutes,
				),
				timestamp: event.timestamp,
				type: "anomaly_token_outlier",
				severity: "warning",
				title: "Token usage anomaly detected",
				message: `Request ${event.requestId} used ${event.value.toLocaleString()} tokens (${event.zScore.toFixed(1)}σ above baseline).`,
				value: event.value,
				threshold: null,
				account: event.account,
				model: event.model,
				project: event.project,
				requestId: event.requestId,
				acknowledged: false,
			});
		}
		for (const event of response.outputBlowups.slice(
			0,
			MAX_ANOMALY_ALERTS_PER_RUN,
		)) {
			alerts.push({
				id: buildThresholdAlertId(
					"anomaly_output_blowup",
					event.requestId,
					event.timestamp,
					config.cooldownMinutes,
				),
				timestamp: event.timestamp,
				type: "anomaly_output_blowup",
				severity: "warning",
				title: "Output token blowup detected",
				message: `Request ${event.requestId} returned ${event.value.toLocaleString()} output tokens (${event.zScore.toFixed(1)}σ above baseline).`,
				value: event.value,
				threshold: null,
				account: event.account,
				model: event.model,
				project: event.project,
				requestId: event.requestId,
				acknowledged: false,
			});
		}
		for (const loop of response.runawayLoops.slice(
			0,
			MAX_ANOMALY_ALERTS_PER_RUN,
		)) {
			alerts.push({
				id: buildThresholdAlertId(
					"anomaly_runaway_loop",
					`${loop.account}:${loop.model}:${loop.project ?? ""}`,
					loop.windowEndMs,
					config.cooldownMinutes,
				),
				timestamp: loop.windowEndMs,
				type: "anomaly_runaway_loop",
				severity: "critical",
				title: "Runaway loop detected",
				message: `${loop.requests} near-identical requests were sent in a short window for ${loop.model}.`,
				value: loop.requests,
				threshold: null,
				account: loop.account,
				model: loop.model,
				project: loop.project,
				requestId: null,
				acknowledged: false,
			});
		}
		for (const group of response.misrouting.slice(
			0,
			MAX_ANOMALY_ALERTS_PER_RUN,
		)) {
			alerts.push({
				id: buildThresholdAlertId(
					"anomaly_model_misrouting",
					`${group.account}:${group.model}`,
					Date.now(),
					config.cooldownMinutes,
				),
				timestamp: Date.now(),
				type: "anomaly_model_misrouting",
				severity: "info",
				title: "Potential model misrouting detected",
				message: `${group.requests} short requests used expensive model ${group.model}.`,
				value: group.requests,
				threshold: null,
				account: group.account,
				model: group.model,
				project: null,
				requestId: group.exampleRequestIds[0] ?? null,
				acknowledged: false,
			});
		}
		for (const alert of alerts) {
			await this.persistAndEmit(alert, config.webhookUrl);
		}
	}

	private async persistAndEmit(
		alert: AlertEvent,
		webhookUrl: string,
	): Promise<void> {
		// Check if a row with this cooldown-bucket ID already exists before inserting.
		// If it does, the alert is within its cooldown window — skip emission entirely
		// to avoid SSE storms and duplicate webhook deliveries.
		const existing = await this.db.get<{ id: string }>(
			`SELECT id FROM alerts WHERE id = ?`,
			[alert.id],
		);
		if (existing) return;

		await this.db.run(
			`
			INSERT OR IGNORE INTO alerts (
				id, timestamp, type, severity, title, message, value, threshold,
				account, model, project, request_id, acknowledged
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
			[
				alert.id,
				alert.timestamp,
				alert.type,
				alert.severity,
				alert.title,
				alert.message,
				alert.value,
				alert.threshold,
				alert.account,
				alert.model,
				alert.project,
				alert.requestId,
				alert.acknowledged ? 1 : 0,
			],
		);
		const event: AlertEvt = { type: "alert", payload: alert };
		alertEvents.emit("event", event);
		if (webhookUrl) {
			void this.deliverWebhook(webhookUrl, alert);
		}
	}

	private async deliverWebhook(
		webhookUrl: string,
		alert: AlertEvent,
	): Promise<void> {
		try {
			await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "alert", alert }),
			});
		} catch (error) {
			log.warn(`Alert webhook delivery failed: ${(error as Error).message}`);
		}
	}
}
