import type { Config } from "@better-ccflare/config";

export function parseCostTrackingValue(value: string | undefined): boolean {
	if (value === "on") return true;
	if (value === "off") return false;
	throw new Error("--cost-tracking requires on or off");
}

/** Persist locally, then invalidate just this setting in any local server. */
export async function configureCostTracking(
	config: Config,
	value: string,
	request: typeof fetch = fetch,
): Promise<{ enabled: boolean; notified: boolean }> {
	const enabled = parseCostTrackingValue(value);
	config.setCostTrackingEnabled(enabled);
	const ports = [...new Set([config.getRuntime().port || 8080, 8080, 8081])];
	const localControlSecret = config.getLocalControlSecret();
	let notified = false;
	await Promise.all(
		ports.map(async (port) => {
			try {
				const response = await request(
					`http://localhost:${port}/api/config/cost-tracking/reload`,
					{
						method: "POST",
						headers: {
							"x-better-ccflare-local-control-secret": localControlSecret,
						},
						signal: AbortSignal.timeout(2_000),
					},
				);
				if (response.ok) notified = true;
			} catch {
				/* Persisted setting still applies on the next server start. */
			}
		}),
	);
	return { enabled, notified };
}
