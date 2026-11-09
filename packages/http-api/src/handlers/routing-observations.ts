import {
	type RoutingObservation,
	getRoutingObservations as readProxyRoutingObservations,
} from "@better-ccflare/proxy";
import { jsonResponse } from "../utils/http-error";

/**
 * Read-only view of the proxy's last-observed routing decision per model
 * family -- see packages/proxy/src/handlers/routing-observations.ts for what
 * is recorded and why (display-only telemetry, never routing input).
 *
 * The reader is injectable so tests can supply a fake without reaching for
 * `mock.module("@better-ccflare/proxy", …)`: Bun applies module mocks
 * PROCESS-WIDE across file boundaries, so mocking the proxy package here also
 * replaced the module the proxy package's OWN tests import, breaking them
 * whenever both files ran in one `bun test` invocation (order-independent,
 * reproduced 2026-08-22). Production callers use the default.
 *
 * Re-exported (as `getRoutingObservations`) so the router can wire other
 * readers, such as the combo-flow handler, through this module.
 */
export { readProxyRoutingObservations as getRoutingObservations };

export function createRoutingObservationsHandler(
	readObservations: () => Record<
		string,
		RoutingObservation
	> = readProxyRoutingObservations,
) {
	return async (): Promise<Response> => {
		return jsonResponse({
			observations: readObservations(),
		});
	};
}
