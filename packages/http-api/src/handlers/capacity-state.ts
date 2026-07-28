import { jsonResponse } from "@better-ccflare/http-common";
import type {
	CircuitBreaker,
	CircuitSnapshotEntry,
	StreamAdmission,
	StreamAdmissionSnapshot,
} from "@better-ccflare/proxy";

/**
 * JSON shape returned by `GET /api/capacity-state`.
 *
 * The AO fleet reaper polls this endpoint from a different host and branches
 * on it to pause new session spawns while a circuit is open. The `enabled`
 * block is the kill-switch flag surface (`CCFLARE_CIRCUIT_BREAKER=0` and
 * `CCFLARE_STREAM_ADMISSION=0`) so the reaper can short-circuit when the
 * gate is not actually doing work. The remaining blocks are direct
 * `snapshot()` output from the two modules and a `generatedAt` stamp.
 */
export interface CapacityStateResponse {
	enabled: {
		circuitBreaker: boolean;
		streamAdmission: boolean;
	};
	circuitBreaker: {
		keys: CircuitSnapshotEntry[];
	};
	streamAdmission: StreamAdmissionSnapshot;
	generatedAt: number;
}

/**
 * Factory mirroring `createHealthHandler` (health.ts). Returns a `GET`
 * handler that composes `breaker.snapshot()` and `admission.snapshot()` and
 * stamps `generatedAt`. Does NOT cache — the reaper polls on its own
 * cadence and stale snapshots would mislead the kill-switch branch.
 */
export function createCapacityStateHandler(
	breaker: CircuitBreaker,
	admission: StreamAdmission,
) {
	return async (): Promise<Response> => {
		const circuitSnapshot = breaker.snapshot();
		const admissionSnapshot = admission.snapshot();
		const body: CapacityStateResponse = {
			enabled: {
				circuitBreaker: breaker.isEnabled(),
				// `passesThrough` is true when the kill-switch has flipped the
				// gate off, so enabled is the inverse.
				streamAdmission: !admissionSnapshot.passesThrough,
			},
			circuitBreaker: {
				keys: circuitSnapshot,
			},
			streamAdmission: admissionSnapshot,
			generatedAt: Date.now(),
		};
		return jsonResponse(body, 200);
	};
}
