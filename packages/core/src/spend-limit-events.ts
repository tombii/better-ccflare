import { EventEmitter } from "node:events";

/**
 * A warn-mode API key that has gone past its spend limit.
 *
 * Mirrors auth-failure-events.ts exactly, and for the same reason: the proxy
 * notices the condition but must not depend on the HTTP API's alert service
 * (the dependency runs the other way). The proxy emits, AlertService listens.
 */
export interface SpendLimitExceededEvt {
	apiKeyId: string;
	/** Child limit row; absent for callers using the legacy single limit. */
	limitId?: string;
	apiKeyName: string | null;
	spentUsd: number;
	limitUsd: number;
	window: string;
}

class SpendLimitEventBus extends EventEmitter {}
export const spendLimitEvents = new SpendLimitEventBus();

spendLimitEvents.setMaxListeners(200);
