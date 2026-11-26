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
	plan_name: string | null;
	models: string[];
	models_enabled: boolean;
	on_plan: boolean;
	reset_at: string | null;
	used_pct: number;
	activated: boolean;
	exhausted: boolean;
	plan_used_pct: number;
	plan_exhausted: boolean;
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

/**
 * Validate a raw response body; null when any guaranteed field has the wrong
 * type. Only the documented fields are read: TokenHarbor promises to keep them
 * and says everything else may appear or vanish.
 */
export function parseTokenHarborUsageData(
	body: unknown,
): TokenHarborUsageData | null {
	if (!body || typeof body !== "object") return null;
	const b = body as Record<string, unknown>;
	const planName = b.plan_name;
	const resetAt = b.reset_at;
	const models = b.models;
	const modelsEnabled = b.models_enabled;
	if (
		!isNullableString(planName) ||
		!isBoolean(b.on_plan) ||
		!isNumber(b.plan_used_pct) ||
		!isBoolean(b.plan_exhausted) ||
		!isNumber(b.used_pct) ||
		!isBoolean(b.exhausted) ||
		!isBoolean(b.activated) ||
		// Required key, but its value is legitimately null between windows.
		!("reset_at" in b) ||
		!isNullableString(resetAt) ||
		(models !== undefined &&
			(!Array.isArray(models) || !models.every(isString))) ||
		(modelsEnabled !== undefined && !isBoolean(modelsEnabled))
	) {
		return null;
	}
	return {
		plan_name: planName ?? null,
		models: models === undefined ? [] : (models as string[]),
		models_enabled: modelsEnabled ?? true,
		on_plan: b.on_plan,
		reset_at: resetAt ?? null,
		used_pct: b.used_pct,
		activated: b.activated,
		exhausted: b.exhausted,
		plan_used_pct: b.plan_used_pct,
		plan_exhausted: b.plan_exhausted,
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
