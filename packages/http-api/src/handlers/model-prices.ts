import { listModelPrices } from "@better-ccflare/core";
import { jsonResponse } from "@better-ccflare/http-common";

/** Admin authorization is applied by APIRouter, as for /api/models. */
export async function modelPricesHandler(): Promise<Response> {
	return jsonResponse({
		currency: "USD",
		unit: "per_million_tokens",
		models: await listModelPrices(),
	});
}
