import { Logger } from "@better-ccflare/logger";

const log = new Logger("KiloUsageFetcher");

export interface KiloUsageData {
	microdollarsUsed: number;
	totalMicrodollarsAcquired: number;
	/** Remaining credits in USD */
	remainingUsd: number;
	/** Utilization as percentage 0-100 */
	utilizationPercent: number;
}

/**
 * Fetch usage data from Kilo's user endpoint
 * This is non-blocking - failures return null and won't affect provider operation
 */
export async function fetchKiloUsageData(
	apiKey: string,
): Promise<KiloUsageData | null> {
	try {
		const response = await fetch("https://api.kilo.ai/api/user", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			const errorMessage = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());
			try {
				const errorBody = await response.text();
				log.warn(
					`Failed to fetch Kilo usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.kilo.ai/api/user",
						headers: responseHeaders,
						errorBody: errorBody,
						timestamp: new Date().toISOString(),
					},
				);
			} catch {
				log.warn(
					`Failed to fetch Kilo usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.kilo.ai/api/user",
						headers: responseHeaders,
						timestamp: new Date().toISOString(),
					},
				);
			}
			return null;
		}

		const json = await response.json();

		const used: number = json.microdollars_used ?? 0;
		const acquired: number = json.total_microdollars_acquired ?? 0;
		const remaining = Math.max(0, acquired - used);
		const utilizationPercent =
			acquired > 0 ? Math.min(100, (used / acquired) * 100) : 0;

		return {
			microdollarsUsed: used,
			totalMicrodollarsAcquired: acquired,
			remainingUsd: remaining / 1_000_000,
			utilizationPercent,
		};
	} catch (error) {
		log.warn("Error fetching Kilo usage data:", error);
		return null;
	}
}

/**
 * Get the representative utilization percentage (0-100)
 */
export function getRepresentativeKiloUtilization(
	usage: KiloUsageData | null,
): number | null {
	if (!usage) return null;
	return usage.utilizationPercent;
}

/**
 * Get the representative window label
 */
export function getRepresentativeKiloWindow(
	usage: KiloUsageData | null,
): string | null {
	if (!usage) return null;
	return "credits";
}
