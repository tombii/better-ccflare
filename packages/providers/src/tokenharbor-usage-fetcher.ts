import { Logger } from "@better-ccflare/logger";

const log = new Logger("TokenHarborUsageFetcher");

const DEFAULT_ENDPOINT = "https://tokenharbor.ai";
const USAGE_PATH = "/api/cli/free-tier";
const FETCH_TIMEOUT_MS = 5_000;

/**
 * TokenHarbor's two allowances share one 7-day window (`reset_at` is also
 * `period_ends_at`); only the percentages differ. `plan_used_pct` is the
 * paid Pass allowance, `used_pct` the free-model one.
 */
export interface TokenHarborUsageData {
	plan_name: string;
	models: string[];
	models_enabled: boolean;
	on_plan: boolean;
	campaign: boolean;
	req_used: number;
	reset_at: string | null;
	unlocked: boolean;
	used_pct: number;
	activated: boolean;
	exhausted: boolean;
	rpm_limit: number;
	buffer_pct: number;
	plan_used_pct: number;
	base_share_pct: number;
	campaign_label: string;
	period_ends_at: string | null;
	plan_exhausted: boolean;
	period_started_at: string | null;
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
	return value === null || value === undefined || isString(value);
}

/**
 * The dashboard copy nests the otherwise-flat allowances under `tokenharbor`
 * and adds a `seven_day` window, so the helpers below accept either shape:
 * the raw polled payload or what the accounts handler serves.
 */
interface AllowanceShape {
	on_plan?: unknown;
	plan_used_pct?: unknown;
	used_pct?: unknown;
	reset_at?: unknown;
	exhausted?: unknown;
	plan_exhausted?: unknown;
	seven_day?: { resets_at?: unknown } | null;
	tokenharbor?: AllowanceShape | null;
}

interface TokenHarborAllowances {
	onPlan: boolean;
	planUsedPct: number;
	usedPct: number;
	resetAt: string | null;
	exhausted: boolean | null;
	planExhausted: boolean | null;
}

function readAllowances(usage: unknown): TokenHarborAllowances | null {
	if (!usage || typeof usage !== "object") return null;
	const top = usage as AllowanceShape;
	const raw =
		typeof top.plan_used_pct === "number"
			? top
			: top.tokenharbor && typeof top.tokenharbor === "object"
				? top.tokenharbor
				: null;
	if (
		!raw ||
		!isBoolean(raw.on_plan) ||
		!isNumber(raw.plan_used_pct) ||
		!isNumber(raw.used_pct)
	) {
		return null;
	}
	const resetAt =
		typeof raw.reset_at === "string"
			? raw.reset_at
			: typeof top.seven_day?.resets_at === "string"
				? top.seven_day.resets_at
				: null;
	return {
		onPlan: raw.on_plan,
		planUsedPct: raw.plan_used_pct,
		usedPct: raw.used_pct,
		resetAt,
		exhausted: isBoolean(raw.exhausted) ? raw.exhausted : null,
		planExhausted: isBoolean(raw.plan_exhausted) ? raw.plan_exhausted : null,
	};
}

/** Validate a raw response body; null when any known field has the wrong type. */
export function parseTokenHarborUsageData(
	body: unknown,
): TokenHarborUsageData | null {
	if (!body || typeof body !== "object") return null;
	const b = body as Record<string, unknown>;
	if (
		!isString(b.plan_name) ||
		!Array.isArray(b.models) ||
		!b.models.every(isString) ||
		!isBoolean(b.models_enabled) ||
		!isBoolean(b.on_plan) ||
		!isBoolean(b.campaign) ||
		!isNumber(b.req_used) ||
		!isBoolean(b.unlocked) ||
		!isNumber(b.used_pct) ||
		!isBoolean(b.activated) ||
		!isBoolean(b.exhausted) ||
		!isNumber(b.rpm_limit) ||
		!isNumber(b.buffer_pct) ||
		!isNumber(b.plan_used_pct) ||
		!isNumber(b.base_share_pct) ||
		!isString(b.campaign_label) ||
		!isBoolean(b.plan_exhausted) ||
		!isNullableString(b.reset_at) ||
		!isNullableString(b.period_ends_at) ||
		!isNullableString(b.period_started_at)
	) {
		return null;
	}
	return {
		plan_name: b.plan_name,
		models: b.models,
		models_enabled: b.models_enabled,
		on_plan: b.on_plan,
		campaign: b.campaign,
		req_used: b.req_used,
		reset_at: b.reset_at ?? null,
		unlocked: b.unlocked,
		used_pct: b.used_pct,
		activated: b.activated,
		exhausted: b.exhausted,
		rpm_limit: b.rpm_limit,
		buffer_pct: b.buffer_pct,
		plan_used_pct: b.plan_used_pct,
		base_share_pct: b.base_share_pct,
		campaign_label: b.campaign_label,
		period_ends_at: b.period_ends_at ?? null,
		plan_exhausted: b.plan_exhausted,
		period_started_at: b.period_started_at ?? null,
	};
}

/**
 * Fetch usage data from TokenHarbor's free-tier endpoint.
 * Non-blocking: failures return null and never affect provider operation.
 */
export async function fetchTokenHarborUsageData(
	apiKey: string,
	customEndpoint?: string | null,
): Promise<TokenHarborUsageData | null> {
	const baseUrl = customEndpoint || DEFAULT_ENDPOINT;
	let url: string;
	try {
		url = new URL(USAGE_PATH, baseUrl).toString();
	} catch {
		url = `${DEFAULT_ENDPOINT}${USAGE_PATH}`;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			log.warn(
				`Failed to fetch TokenHarbor usage data: ${response.status} ${response.statusText}`,
				{
					status: response.status,
					statusText: response.statusText,
					url,
					timestamp: new Date().toISOString(),
				},
			);
			return null;
		}

		const data = parseTokenHarborUsageData(await response.json());
		if (!data) log.warn(`Invalid TokenHarbor usage response from ${url}`);
		return data;
	} catch (error) {
		log.warn("Error fetching TokenHarbor usage data:", error);
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * The allowance that gates the account: the Pass on a plan, the free-model
 * allowance otherwise. Clamped to 0-100 like every other provider's reading.
 */
export function getTokenHarborRepresentativeUtilization(
	usage: unknown,
): number | null {
	const allowances = readAllowances(usage);
	if (!allowances) return null;
	const pct = allowances.onPlan ? allowances.planUsedPct : allowances.usedPct;
	return Math.min(100, Math.max(0, pct));
}

/** Epoch ms of the shared 7-day reset; null when absent or unparseable. */
export function getTokenHarborResetMs(usage: unknown): number | null {
	const allowances = readAllowances(usage);
	if (!allowances?.resetAt) return null;
	const ms = Date.parse(allowances.resetAt);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether the allowance that gates the account — the Pass on a plan, the
 * free-model allowance otherwise — reports itself spent. Null when the shape
 * carries no meaningful flag, which callers must treat as unknown.
 */
export function getTokenHarborAllowanceExhausted(
	usage: unknown,
): boolean | null {
	const allowances = readAllowances(usage);
	if (!allowances) return null;
	return allowances.onPlan ? allowances.planExhausted : allowances.exhausted;
}
