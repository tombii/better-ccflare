import type { ModelPriceEntry } from "@better-ccflare/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export interface ModelPricesResponse {
	currency: "USD";
	unit: "per_million_tokens";
	models: ModelPriceEntry[];
}

/** Every picker and price view shares one catalogue request and cache. */
export function useModelPrices() {
	return useQuery({
		queryKey: ["model-prices"],
		queryFn: () => api.get<ModelPricesResponse>("/api/model-prices"),
		staleTime: 60_000,
		refetchInterval: false,
	});
}
