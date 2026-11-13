import { useState } from "react";
import { useModelPrices } from "../hooks/useModelPrices";
import { filterModelPrices, priceSummary } from "../lib/model-prices";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

/** Shared by the create-key dialog and both spend-limit editors. */
export function ModelPriceHint({ scope }: { scope: string }) {
	const { data, isLoading, isError } = useModelPrices();
	return (
		<p className="text-xs text-muted-foreground">
			{isLoading
				? "Loading model prices…"
				: isError
					? "Model prices unavailable"
					: scope
						? priceSummary(data?.models ?? [], scope)
						: "Rates vary by model. See Model prices for USD per 1M tokens."}
		</p>
	);
}

export function ModelPricesTab() {
	const { data, isLoading, isError } = useModelPrices();
	const [search, setSearch] = useState("");
	const models = filterModelPrices(data?.models ?? [], search);
	const rate = (value: number | null | undefined) =>
		value == null ? "Unknown" : `$${value}`;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Model prices</CardTitle>
				<p className="text-sm text-muted-foreground">
					USD per 1M tokens from the gateway's cost calculation catalogue.
					Family rates can vary by model. These are API-cost-equivalent rates;
					account subscriptions and negotiated provider charges may differ.
				</p>
				<p className="text-sm text-amber-700">
					Requests using cache tokens on models with missing cache prices are
					currently recorded at $0.
				</p>
				<Input
					aria-label="Search model prices"
					placeholder="Search by model, family, or provider"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</CardHeader>
			<CardContent>
				{isLoading ? <p>Loading model prices…</p> : null}
				{isError ? <p role="alert">Model prices unavailable.</p> : null}
				{!isLoading && !isError ? (
					<div className="overflow-x-auto">
						<table className="w-full text-sm text-left">
							<thead>
								<tr className="border-b">
									{[
										"Model",
										"Family",
										"Provider",
										"Input",
										"Output",
										"Cache read",
										"Cache write",
									].map((label) => (
										<th key={label} className="p-2 whitespace-nowrap">
											{label}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{models.map((model) => (
									<tr key={model.id} className="border-b">
										<td className="p-2">
											<div>{model.name}</div>
											<code className="text-xs text-muted-foreground">
												{model.id}
											</code>
											{!model.rates ? (
												<div className="text-amber-700">No price available</div>
											) : model.rates.cacheRead == null ||
												model.rates.cacheWrite == null ? (
												<div className="text-amber-700">
													Cache prices incomplete
												</div>
											) : null}
										</td>
										<td className="p-2">{model.family}</td>
										<td className="p-2">{model.provider}</td>
										<td className="p-2">{rate(model.rates?.input)}</td>
										<td className="p-2">{rate(model.rates?.output)}</td>
										<td className="p-2">{rate(model.rates?.cacheRead)}</td>
										<td className="p-2">{rate(model.rates?.cacheWrite)}</td>
									</tr>
								))}
							</tbody>
						</table>
						{models.length === 0 ? (
							<p className="p-2">No matching models.</p>
						) : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
