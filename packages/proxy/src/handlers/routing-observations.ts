/**
 * In-memory, process-singleton record of the LAST account order the proxy
 * actually selected for each model family (mirrors the process-singleton
 * pattern in model-capacity.ts, e.g. clearFamilyExhaustionCache).
 *
 * ARCHITECTURE CONTRACT: this is display-only telemetry for the dashboard
 * ("what did routing just do"). It must NEVER be read by the router or any
 * load-balancing strategy — feeding it back into selection would make the
 * proxy's own past output influence its future decisions, which is exactly
 * the kind of drift this module exists to avoid (see the design note this
 * implements: observe the real decision instead of simulating one).
 *
 * Only the most recent observation per family is kept -- no history/ring
 * buffer. Recording is fire-and-forget: callers (proxy.ts) must treat a
 * failure here as non-fatal to the request path.
 */

export interface RoutingObservationAccount {
	id: string;
	name: string;
}

export interface RoutingObservation {
	family: string;
	order: RoutingObservationAccount[];
	model: string;
	observedAtMs: number;
}

const observations = new Map<string, RoutingObservation>();

/**
 * Records the account order the proxy just selected for `family`, replacing
 * any previous observation for the same family (last-write-wins).
 */
export function recordRoutingObservation(
	family: string,
	accounts: RoutingObservationAccount[],
	model: string,
	now: number = Date.now(),
): void {
	observations.set(family, {
		family,
		order: accounts.map((account) => ({
			id: account.id,
			name: account.name,
		})),
		model,
		observedAtMs: now,
	});
}

/**
 * Returns a deep copy of every currently-recorded observation, keyed by
 * family -- callers may freely mutate the result without affecting the
 * internal state.
 */
export function getRoutingObservations(): Record<string, RoutingObservation> {
	const result: Record<string, RoutingObservation> = {};
	for (const [family, observation] of observations) {
		result[family] = {
			family: observation.family,
			order: observation.order.map((account) => ({ ...account })),
			model: observation.model,
			observedAtMs: observation.observedAtMs,
		};
	}
	return result;
}

/** Test-only: reset all recorded observations between test cases. */
export function clearRoutingObservations(): void {
	observations.clear();
}
