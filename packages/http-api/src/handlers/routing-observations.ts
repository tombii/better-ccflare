import { getRoutingObservations } from "@better-ccflare/proxy";
import { jsonResponse } from "../utils/http-error";

/**
 * Read-only view of the proxy's last-observed routing decision per model
 * family -- see packages/proxy/src/handlers/routing-observations.ts for what
 * is recorded and why (display-only telemetry, never routing input).
 */
export function createRoutingObservationsHandler() {
	return async (): Promise<Response> => {
		return jsonResponse({
			observations: getRoutingObservations(),
		});
	};
}
