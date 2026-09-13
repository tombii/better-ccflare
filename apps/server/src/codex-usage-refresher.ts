import type { Logger } from "@better-ccflare/logger";
import type {
	CodexUsageRefreshFetchResult,
	UsageData,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";

export interface CodexUsageRefreshOutcome {
	success: boolean;
	message: string;
}

/**
 * Everything the refresher needs from the server, injected so the
 * free-first / probe-fallback decision is unit-testable without a database
 * or a network.
 */
export interface CodexUsageRefresherDeps {
	getAccount(accountId: string): Promise<Account | null>;
	getAccessToken(account: Account): Promise<string>;
	/**
	 * Free GET against the ChatGPT usage endpoint (`fetchCodexUsageData`).
	 * `data: null` means "nothing usable came back — fall back to the probe".
	 */
	fetchFromUsageEndpoint(
		accessToken: string,
	): Promise<{ data: UsageData | null; status: number }>;
	/**
	 * True when the account's endpoint is OpenAI's own ChatGPT backend — the
	 * only place the usage endpoint exists (`isCodexSubscriptionEndpoint`).
	 */
	usageEndpointAvailable(endpoint: string): boolean;
	defaultEndpoint: string;
	/** Weakest model the account can address, for the quota-spending probe. */
	resolvePingModel(accountId: string): Promise<string>;
	/** The quota-spending `/responses` probe (`fetchCodexUsageOnDemand`). */
	fetchFromProbe(
		accessToken: string,
		endpoint: string,
		model: string,
	): Promise<CodexUsageRefreshFetchResult>;
	/** `parseRateLimit(response).resetTime` of the codex provider, for the probe's headers. */
	probeResetTime(response: Response): number | null;
	cacheSet(accountId: string, data: UsageData): void;
	/** `recordCodexUsageSnapshot` bound to dbOps. */
	recordSnapshot(
		accountId: string,
		accountName: string,
		usage: Record<string, unknown>,
		now: number,
		force: boolean,
	): Promise<boolean>;
	updateRateLimitReset(accountId: string, resetMs: number): Promise<void>;
	/** `earliestCodexResetMs`. */
	earliestResetMs(usage: Record<string, unknown>): number | null;
	log: Pick<Logger, "debug" | "info" | "warn" | "error">;
}

function formatPercent(window: { utilization: number } | undefined): string {
	return window ? `${window.utilization}%` : "n/a";
}

/**
 * Build the handler behind `POST /api/accounts/:id/refresh-usage` for Codex.
 *
 * 1. Read the free ChatGPT usage endpoint — the same one the poller uses.
 * 2. Only if that yields nothing (custom endpoint, 403, transport error) send
 *    one deliberately minimal `/responses` request and read the `x-codex-*`
 *    headers. That probe spends quota, which is why it is the fallback.
 */
export function createCodexUsageRefresher(deps: CodexUsageRefresherDeps) {
	async function persist(
		account: Account,
		data: UsageData,
		options: { updateReset: boolean },
	): Promise<void> {
		deps.cacheSet(account.id, data);
		const usage = data as unknown as Record<string, unknown>;
		// Persist alongside the cache so the read outlives the 10-minute cache.
		// `force` skips the traffic throttle — the operator asked for this read.
		await deps.recordSnapshot(
			account.id,
			account.name,
			usage,
			Date.now(),
			true,
		);
		if (!options.updateReset) return;
		const earliest = deps.earliestResetMs(usage);
		if (earliest === null) return;
		try {
			await deps.updateRateLimitReset(account.id, earliest);
		} catch (error) {
			deps.log.warn(
				`Codex usage refresh: failed to update rate_limit_reset for ${account.name}:`,
				error,
			);
		}
	}

	return async (accountId: string): Promise<CodexUsageRefreshOutcome> => {
		const account = await deps.getAccount(accountId);
		if (!account) {
			return { success: false, message: `Account ${accountId} not found` };
		}
		if (account.provider !== "codex") {
			return {
				success: false,
				message: `Account '${account.name}' is not a Codex account`,
			};
		}
		if (!account.access_token && !account.refresh_token) {
			return {
				success: false,
				message: `Account '${account.name}' has no tokens — please re-authenticate`,
			};
		}

		let accessToken: string;
		try {
			accessToken = await deps.getAccessToken(account);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.log.warn(
				`Codex usage refresh: failed to get access token for ${account.name}: ${message}`,
			);
			return {
				success: false,
				message: `Could not refresh access token for '${account.name}': ${message}`,
			};
		}

		const endpoint = account.custom_endpoint ?? deps.defaultEndpoint;

		// 1. Free path.
		if (deps.usageEndpointAvailable(endpoint)) {
			const free = await deps.fetchFromUsageEndpoint(accessToken);
			if (free.data) {
				await persist(account, free.data, { updateReset: true });
				const fiveHour = formatPercent(free.data.five_hour);
				const sevenDay = formatPercent(free.data.seven_day);
				deps.log.info(
					`Codex usage refreshed for '${account.name}' from the usage endpoint: 5h=${fiveHour}, 7d=${sevenDay}`,
				);
				return {
					success: true,
					message: `Usage refreshed for '${account.name}' (5h: ${fiveHour}, 7d: ${sevenDay}).`,
				};
			}
			deps.log.info(
				`Codex usage endpoint returned no data for '${account.name}' (status ${free.status}); falling back to the /responses probe`,
			);
		}

		// 2. Paid fallback: one minimal /responses request, headers only.
		const pingModel = await deps.resolvePingModel(accountId);
		let fetchResult: CodexUsageRefreshFetchResult;
		try {
			fetchResult = await deps.fetchFromProbe(accessToken, endpoint, pingModel);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.log.error(
				`Codex usage refresh: upstream fetch failed for ${account.name}:`,
				message,
			);
			return {
				success: false,
				message: `Codex request failed for '${account.name}': ${message}`,
			};
		}

		// Persist the rate-limit reset even on non-2xx so the dashboard sees the
		// most accurate reset time when the account is currently limited.
		const probeReset = deps.probeResetTime(fetchResult.response);
		if (probeReset != null) {
			try {
				await deps.updateRateLimitReset(account.id, probeReset);
			} catch (error) {
				deps.log.warn(
					`Codex usage refresh: failed to update rate_limit_reset for ${account.name}:`,
					error,
				);
			}
		}

		if (!fetchResult.data) {
			// Naming the model matters here: this is the shape a rejected model
			// takes, and without it the message says nothing actionable.
			return {
				success: false,
				message: `Codex returned no usage headers (status ${fetchResult.response.status}) for '${account.name}' when pinging model '${pingModel}'`,
			};
		}

		await persist(account, fetchResult.data, { updateReset: false });

		const fiveHour = formatPercent(fetchResult.data.five_hour);
		const sevenDay = formatPercent(fetchResult.data.seven_day);
		const isRateLimited = fetchResult.response.status === 429;
		deps.log.info(
			`Codex usage refreshed for '${account.name}' via ${pingModel}: 5h=${fiveHour}, 7d=${sevenDay}${
				isRateLimited ? " (rate-limited)" : ""
			}`,
		);

		// 429 still produces a successful header refresh (the usage payload is
		// what we wanted), but the dashboard message must not celebrate it —
		// otherwise the operator sees "refreshed successfully" while the
		// account is fully exhausted. See tombii's PR #219 review note.
		const message = isRateLimited
			? `Usage refreshed for '${account.name}' — account is rate limited (5h: ${fiveHour}, 7d: ${sevenDay}).`
			: `Usage refreshed for '${account.name}' (5h: ${fiveHour}, 7d: ${sevenDay}).`;
		return { success: true, message };
	};
}
