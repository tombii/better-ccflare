import type { ModelPriceEntry, ModelRates } from "@better-ccflare/core";

export type { ModelPriceEntry };

export function filterModelPrices(
	models: ModelPriceEntry[],
	search: string,
): ModelPriceEntry[] {
	const query = search.trim().toLowerCase();
	return models.filter((model) =>
		[model.id, model.name, model.family, model.provider]
			.join(" ")
			.toLowerCase()
			.includes(query),
	);
}

export function priceSummary(models: ModelPriceEntry[], scope: string): string {
	const exact = models.find((model) => model.id === scope);
	const matches = exact
		? [exact]
		: models.filter((model) => model.family === scope);
	const priced = matches.filter((model) => model.rates !== null);
	if (!priced.length) return "No price available";
	const range = (kind: keyof ModelRates) => {
		const values = priced.map((model) => model.rates?.[kind] ?? null);
		const known = values.filter((rate): rate is number => rate !== null);
		if (!known.length) return "unknown";
		const min = Math.min(...known);
		const max = Math.max(...known);
		return `$${min === max ? min : `${min}–${max}`}${known.length < values.length ? " (some unknown)" : ""}`;
	};
	return `${range("input")} in / ${range("output")} out / ${range("cacheRead")} cache-read / ${range("cacheWrite")} cache-write per 1M tokens (USD${matches.length > 1 ? "; varies by model" : ""})${priced.length < matches.length ? "; some models have no price" : ""}`;
}
