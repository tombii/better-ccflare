import { type AlertEvt, alertEvents } from "@better-ccflare/core";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type { AlertsConfigPayload } from "@better-ccflare/types";
import { getAlertsConfig, setAlertsConfig } from "../services/alerts";
import type { APIContext } from "../types";

const log = new Logger("AlertsHandler");

export function createAlertsHistoryHandler(context: APIContext) {
	return async (searchParams: URLSearchParams): Promise<Response> => {
		try {
			const limit = Math.max(
				1,
				Math.min(
					500,
					Number.parseInt(searchParams.get("limit") ?? "100", 10) || 100,
				),
			);
			const alerts = await context.alertService.listAlerts(limit);
			const unacknowledgedCount =
				await context.alertService.getUnacknowledgedCount();
			return jsonResponse({ alerts, unacknowledgedCount });
		} catch (error) {
			log.error("Alert history error:", error);
			return errorResponse(InternalServerError("Failed to fetch alerts"));
		}
	};
}

export function createAlertsConfigGetHandler(context: APIContext) {
	return (): Response => jsonResponse(getAlertsConfig(context.config));
}

function parseBoolean(value: unknown): boolean {
	return value === true || value === "true" || value === 1;
}

export function createAlertsConfigSetHandler(context: APIContext) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = (await req.json()) as Partial<AlertsConfigPayload>;
			const current = getAlertsConfig(context.config);
			const next: AlertsConfigPayload = {
				dailySpendUsd: Number(body.dailySpendUsd ?? current.dailySpendUsd),
				tokensPerHour: Number(body.tokensPerHour ?? current.tokensPerHour),
				requestTokens: Number(body.requestTokens ?? current.requestTokens),
				anomalyEnabled:
					body.anomalyEnabled === undefined
						? current.anomalyEnabled
						: parseBoolean(body.anomalyEnabled),
				anomalyIntervalMinutes: Number(
					body.anomalyIntervalMinutes ?? current.anomalyIntervalMinutes,
				),
				cooldownMinutes: Number(
					body.cooldownMinutes ?? current.cooldownMinutes,
				),
				webhookUrl: String(body.webhookUrl ?? current.webhookUrl),
			};
			setAlertsConfig(context.config, next);
			return jsonResponse(getAlertsConfig(context.config));
		} catch (error) {
			log.error("Alert config update error:", error);
			return errorResponse(
				InternalServerError("Failed to update alert config"),
			);
		}
	};
}

export function createAlertAcknowledgeHandler(context: APIContext) {
	return async (id: string): Promise<Response> => {
		try {
			await context.alertService.acknowledgeAlert(id);
			return jsonResponse({ ok: true });
		} catch (error) {
			log.error("Alert acknowledge error:", error);
			return errorResponse(InternalServerError("Failed to acknowledge alert"));
		}
	};
}

export function createAlertsAcknowledgeAllHandler(context: APIContext) {
	return async (): Promise<Response> => {
		try {
			await context.alertService.acknowledgeAll();
			return jsonResponse({ ok: true });
		} catch (error) {
			log.error("Alert acknowledge-all error:", error);
			return errorResponse(InternalServerError("Failed to acknowledge alerts"));
		}
	};
}

export function createAlertsStreamHandler() {
	return (req: Request): Response => {
		let writeHandler: ((data: AlertEvt) => void) | null = null;
		let isClosed = false;
		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();
				writeHandler = (data: AlertEvt) => {
					if (isClosed) return;
					try {
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
						);
					} catch (_error) {
						isClosed = true;
						if (writeHandler) {
							alertEvents.off("event", writeHandler);
							writeHandler = null;
						}
					}
				};
				controller.enqueue(encoder.encode("event: connected\ndata: ok\n\n"));
				alertEvents.on("event", writeHandler);
			},
			cancel() {
				isClosed = true;
				if (writeHandler) {
					alertEvents.off("event", writeHandler);
					writeHandler = null;
				}
			},
		});
		req.signal?.addEventListener("abort", () => {
			if (!isClosed) {
				isClosed = true;
				if (writeHandler) {
					alertEvents.off("event", writeHandler);
					writeHandler = null;
				}
			}
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				Connection: "keep-alive",
				"Cache-Control": "no-cache",
			},
		});
	};
}
