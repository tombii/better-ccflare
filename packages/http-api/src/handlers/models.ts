import { errorResponse, jsonResponse } from "@better-ccflare/http-common";
import type { APIContext } from "../types";

/**
 * GET /api/models — return the cached Anthropic model catalog (live if a
 * successful fetch has occurred, otherwise the bundled static fallback).
 */
export function createModelsHandler(context: APIContext) {
	return async (): Promise<Response> => {
		if (!context.modelCatalog) {
			return errorResponse("Model catalog is not available");
		}
		const catalog = await context.modelCatalog.get();
		return jsonResponse(catalog);
	};
}

/**
 * POST /api/models/refresh — force an immediate live model catalog refresh.
 * Never throws: refreshModelCatalog is fail-open, so this always returns
 * 200 with the outcome (success flag + optional error) plus the resulting
 * catalog.
 */
export function createModelsRefreshHandler(context: APIContext) {
	return async (): Promise<Response> => {
		if (!context.modelCatalog) {
			return errorResponse("Model catalog is not available");
		}
		const result = await context.modelCatalog.refresh();
		const catalog = await context.modelCatalog.get();
		return jsonResponse({ ...result, catalog });
	};
}
