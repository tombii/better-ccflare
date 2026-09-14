import type { ApiKeyResponse, ApiKeyRestrictions } from "@better-ccflare/types";
import {
	formatCost,
	formatNumber,
	formatPercentage,
	formatTokens,
} from "@better-ccflare/ui-common";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../api";
import { COLORS, type TimeRange } from "../../constants";
import { useApiKeys, useApiKeyUsage } from "../../hooks/queries";
import { queryKeys } from "../../lib/query-keys";
import { ApiKeyRestrictionsEditor } from "../api-keys/ApiKeyRestrictionsEditor";
import { ApiKeySpendGauge } from "../api-keys/ApiKeySpendGauge";
import { ApiKeySpendLimitEditor } from "../api-keys/ApiKeySpendLimitEditor";
import {
	type SpendLimitDraft,
	serializeSpendLimit,
	spendLimitDraftOf,
} from "../api-keys/spend-limit";
import { BaseAreaChart } from "../charts/BaseAreaChart";
import { BaseBarChart } from "../charts/BaseBarChart";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import {
	buildCostSeries,
	efficiencyCaption,
	formatEfficiencyRatio,
	pickDefaultApiKey,
	sortKeysActiveFirst,
} from "./tab-helpers";

// Match the ranges the endpoint accepts (getRangeConfig: 1h/6h/24h/7d/30d).
const RANGES: TimeRange[] = ["1h", "6h", "24h", "7d", "30d"];

/** The three restriction lists of a key, in the shape the editor works on. */
function restrictionsOf(key: ApiKeyResponse): ApiKeyRestrictions {
	return {
		allowedAccounts: key.allowedAccounts,
		allowedModels: key.allowedModels,
		allowedProviders: key.allowedProviders,
	};
}

interface StatTileProps {
	label: string;
	value: string;
	hint?: string;
	className?: string;
}

function StatTile({ label, value, hint, className }: StatTileProps) {
	return (
		<Card>
			<CardContent className="pt-6">
				<p className="text-xs uppercase tracking-wide text-muted-foreground">
					{label}
				</p>
				<p className={`text-2xl font-semibold tabular-nums ${className ?? ""}`}>
					{value}
				</p>
				{hint ? (
					<p className="text-xs text-muted-foreground mt-1">{hint}</p>
				) : null}
			</CardContent>
		</Card>
	);
}

/**
 * Per-API-key monitoring.
 *
 * One key at a time, chosen from the same dropdown shape the Usage History
 * tab uses (value = id, label = name, active keys first), over the same five
 * ranges.
 *
 * The page COMPOSES the per-key features that already exist — the spend gauge,
 * the restrictions editor, the spend-limit editor — rather than reimplementing
 * any of them, so an operator sees exactly the same controls here and on the
 * API Keys tab and the two can never disagree.
 *
 * On the cost model, see @better-ccflare/types/api-key-usage: "Plan Value" is a
 * counterfactual (what subscription traffic WOULD have cost at API rates) and
 * is labelled as such, never as money spent; "Plan Cost" is the apportioned
 * share of real subscription money and is the only real-money plan figure here.
 */
export function ApiKeyUsageTab() {
	const queryClient = useQueryClient();
	const { data: apiKeys } = useApiKeys();
	const [keyId, setKeyId] = useState<string>("");
	const [range, setRange] = useState<string>("24h");

	const selectedId = keyId || pickDefaultApiKey(apiKeys) || "";
	const selectedKey = apiKeys?.find((key) => key.id === selectedId);
	const { data, isLoading, error } = useApiKeyUsage(selectedId, range);

	// Editors are drafts until saved, and are re-seeded whenever the selected
	// key changes — keying the state off the id rather than syncing in an
	// effect keeps a half-typed limit from leaking onto a different key.
	const [editingId, setEditingId] = useState<string>("");
	const [restrictionsDraft, setRestrictionsDraft] =
		useState<ApiKeyRestrictions>({
			allowedAccounts: null,
			allowedModels: null,
			allowedProviders: null,
		});
	const [limitDraft, setLimitDraft] = useState<SpendLimitDraft>(
		spendLimitDraftOf({}),
	);
	const [limitError, setLimitError] = useState<string | null>(null);
	if (selectedKey && editingId !== selectedKey.id) {
		setEditingId(selectedKey.id);
		setRestrictionsDraft(restrictionsOf(selectedKey));
		setLimitDraft(spendLimitDraftOf(selectedKey));
		setLimitError(null);
	}

	const invalidate = () => {
		queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
		queryClient.invalidateQueries({
			queryKey: queryKeys.apiKeyUsage(selectedId, range),
		});
	};

	const saveRestrictions = useMutation({
		mutationFn: (restrictions: ApiKeyRestrictions) =>
			api.patch(
				`/api/api-keys/${encodeURIComponent(selectedId)}/restrictions`,
				{
					allowedAccounts: restrictions.allowedAccounts,
					allowedModels: restrictions.allowedModels,
					allowedProviders: restrictions.allowedProviders,
				},
			),
		onSuccess: invalidate,
	});

	const saveLimit = useMutation({
		mutationFn: (body: unknown) =>
			api.patch(`/api/api-keys/${encodeURIComponent(selectedId)}/limit`, body),
		onSuccess: invalidate,
	});

	const costSeries = useMemo(
		() => buildCostSeries(data?.series ?? [], data?.bucketMs ?? 3_600_000),
		[data?.series, data?.bucketMs],
	);

	const modelChartData = useMemo(
		() =>
			(data?.models ?? []).slice(0, 10).map((row) => ({
				name: row.model ?? "Unknown",
				requests: row.requests,
			})),
		[data?.models],
	);

	const ratioText = data
		? formatEfficiencyRatio(data.efficiencyRatio, data.efficiencyStatus)
		: null;

	return (
		<div className="space-y-4">
			<div className="flex gap-3">
				<Select value={selectedId} onValueChange={setKeyId}>
					<SelectTrigger className="w-64">
						<SelectValue placeholder="Select API key" />
					</SelectTrigger>
					<SelectContent>
						{sortKeysActiveFirst(apiKeys ?? []).map((key) => (
							<SelectItem key={key.id} value={key.id}>
								{key.name}
								{key.isActive ? "" : " (disabled)"}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select value={range} onValueChange={setRange}>
					<SelectTrigger className="w-28">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{RANGES.map((r) => (
							<SelectItem key={r} value={r}>
								{r}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{!selectedId ? (
				<Card>
					<CardContent className="py-10 text-center text-sm text-muted-foreground">
						No API keys yet. Create one on the API Keys tab to monitor it here.
					</CardContent>
				</Card>
			) : error ? (
				<Card>
					<CardContent className="py-10 text-center text-sm text-destructive">
						{error instanceof Error
							? error.message
							: "Failed to load usage for this key."}
					</CardContent>
				</Card>
			) : (
				<>
					{/* Headline: the one figure this page exists for. */}
					<Card>
						<CardHeader>
							<CardTitle className="text-sm font-medium text-muted-foreground">
								Plan efficiency
							</CardTitle>
						</CardHeader>
						<CardContent>
							<p className="text-5xl font-bold tabular-nums">
								{isLoading ? "…" : (ratioText ?? "unavailable")}
							</p>
							<p className="text-sm text-muted-foreground mt-2">
								{data
									? efficiencyCaption(
											data.efficiencyStatus,
											data.planCost.unpricedAccountIds.length,
										)
									: ""}
							</p>
						</CardContent>
					</Card>

					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
						<StatTile
							label="API cost"
							value={formatCost(data?.apiCostUsd ?? 0)}
							hint="Real money, pay-per-token billing"
						/>
						<StatTile
							label="Plan value"
							value={formatCost(data?.planValueUsd ?? 0)}
							hint="What subscription traffic would have cost at API rates"
						/>
						<StatTile
							label="Plan cost"
							value={formatCost(data?.planCost.planCostUsd ?? 0)}
							hint={`Apportioned subscription money over ${
								data ? data.planCost.windowDays.toFixed(2) : "0"
							} days`}
						/>
						<StatTile
							label="Requests"
							value={formatNumber(data?.requests ?? 0)}
							hint={`${formatPercentage(data?.successRate ?? 0)} succeeded`}
						/>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-4 gap-4">
						<StatTile
							label="Input tokens"
							value={formatTokens(data?.tokens.inputTokens ?? 0)}
						/>
						<StatTile
							label="Output tokens"
							value={formatTokens(data?.tokens.outputTokens ?? 0)}
						/>
						<StatTile
							label="Cache read"
							value={formatTokens(data?.tokens.cacheReadInputTokens ?? 0)}
						/>
						<StatTile
							label="Cache creation"
							value={formatTokens(data?.tokens.cacheCreationInputTokens ?? 0)}
						/>
					</div>

					{data && data.unknownPricingModels.length > 0 ? (
						<Card className="border-warning/40">
							<CardContent className="pt-6 flex items-start gap-2 text-sm">
								<AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
								<span>
									No pricing data for{" "}
									<span className="font-medium">
										{data.unknownPricingModels.join(", ")}
									</span>
									. Their traffic is counted at $0, so every cost above
									understates by whatever those models moved.
								</span>
							</CardContent>
						</Card>
					) : null}

					{selectedKey ? (
						<ApiKeySpendGauge apiKey={selectedKey} className="px-1" />
					) : null}

					<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
						<Card>
							<CardHeader>
								<CardTitle className="text-sm">Cost over time</CardTitle>
							</CardHeader>
							<CardContent>
								<BaseAreaChart
									data={costSeries.data}
									dataKey="apiCostUsd"
									xAxisKey="label"
									loading={isLoading}
									color={COLORS.primary}
									gradientId="apiKeyUsageCost"
									yAxisDomain={[0, costSeries.maxCost || "auto"]}
									yAxisTickFormatter={(value) => formatCost(Number(value))}
									tooltipFormatter={(value, name) => [
										formatCost(value),
										name === "apiCostUsd" ? "API cost" : "Plan value",
									]}
									emptyState="No requests from this key in this window."
								/>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle className="text-sm">Models used</CardTitle>
							</CardHeader>
							<CardContent>
								<BaseBarChart
									data={modelChartData}
									bars={{ dataKey: "requests", fill: COLORS.blue }}
									xAxisKey="name"
									loading={isLoading}
									xAxisAngle={-25}
									xAxisTextAnchor="end"
									xAxisHeight={70}
									tooltipFormatter={(value) => [
										formatNumber(value),
										"Requests",
									]}
									emptyState="No models recorded for this key in this window."
								/>
							</CardContent>
						</Card>
					</div>

					<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
						<Card>
							<CardHeader>
								<CardTitle className="text-sm">By model</CardTitle>
							</CardHeader>
							<CardContent className="overflow-x-auto">
								<table aria-label="Usage by model" className="w-full text-sm">
									<thead className="bg-muted/50">
										<tr>
											<th scope="col" className="text-left px-3 py-2">
												Model
											</th>
											<th scope="col" className="text-right px-3 py-2">
												Requests
											</th>
											<th scope="col" className="text-right px-3 py-2">
												Tokens
											</th>
											<th scope="col" className="text-right px-3 py-2">
												Cost
											</th>
										</tr>
									</thead>
									<tbody>
										{(data?.models ?? []).map((row) => (
											<tr key={row.model ?? "__unknown__"} className="border-t">
												<td className="px-3 py-2 break-all">
													{row.model ?? (
														<span className="text-muted-foreground">
															Unknown
														</span>
													)}
												</td>
												<td className="px-3 py-2 text-right">
													{formatNumber(row.requests)}
												</td>
												<td className="px-3 py-2 text-right">
													{formatTokens(row.totalTokens)}
												</td>
												<td className="px-3 py-2 text-right">
													{formatCost(row.costUsd)}
												</td>
											</tr>
										))}
										{(data?.models.length ?? 0) === 0 ? (
											<tr>
												<td
													colSpan={4}
													className="px-3 py-4 text-muted-foreground"
												>
													No requests in this window.
												</td>
											</tr>
										) : null}
									</tbody>
								</table>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle className="text-sm">By account</CardTitle>
							</CardHeader>
							<CardContent className="overflow-x-auto">
								<table aria-label="Usage by account" className="w-full text-sm">
									<thead className="bg-muted/50">
										<tr>
											<th scope="col" className="text-left px-3 py-2">
												Account
											</th>
											<th scope="col" className="text-right px-3 py-2">
												Requests
											</th>
											<th scope="col" className="text-right px-3 py-2">
												Cost
											</th>
											<th scope="col" className="text-right px-3 py-2">
												Plan share
											</th>
										</tr>
									</thead>
									<tbody>
										{(data?.accounts ?? []).map((row) => {
											const share = data?.planCost.accounts.find(
												(entry) => entry.accountId === row.accountId,
											);
											return (
												<tr
													key={row.accountId ?? "__none__"}
													className="border-t"
												>
													<td className="px-3 py-2 break-all">
														{row.accountName ?? (
															<span className="text-muted-foreground">
																Unattributed
															</span>
														)}
													</td>
													<td className="px-3 py-2 text-right">
														{formatNumber(row.requests)}
													</td>
													<td className="px-3 py-2 text-right">
														{formatCost(row.costUsd)}
													</td>
													<td className="px-3 py-2 text-right">
														{share == null ? (
															<span className="text-muted-foreground">—</span>
														) : share.contributionUsd === null ? (
															<Badge variant="warning">no plan price</Badge>
														) : (
															<span
																title={`${(share.share * 100).toFixed(1)}% of this account's plan traffic`}
															>
																{formatCost(share.contributionUsd)}
															</span>
														)}
													</td>
												</tr>
											);
										})}
										{(data?.accounts.length ?? 0) === 0 ? (
											<tr>
												<td
													colSpan={4}
													className="px-3 py-4 text-muted-foreground"
												>
													No requests in this window.
												</td>
											</tr>
										) : null}
									</tbody>
								</table>
							</CardContent>
						</Card>
					</div>

					{/* Edit in place: the same two editors the API Keys tab uses. */}
					{selectedKey ? (
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
							<Card>
								<CardHeader>
									<CardTitle className="text-sm">Restrictions</CardTitle>
								</CardHeader>
								<CardContent className="space-y-4">
									<ApiKeyRestrictionsEditor
										idPrefix={`usage-${selectedKey.id}`}
										value={restrictionsDraft}
										onChange={setRestrictionsDraft}
										disabled={saveRestrictions.isPending}
									/>
									{saveRestrictions.isError ? (
										<p className="text-sm text-destructive">
											{saveRestrictions.error instanceof Error
												? saveRestrictions.error.message
												: "Failed to update restrictions."}
										</p>
									) : null}
									<Button
										onClick={() => saveRestrictions.mutate(restrictionsDraft)}
										disabled={saveRestrictions.isPending}
									>
										{saveRestrictions.isPending
											? "Saving..."
											: "Save restrictions"}
									</Button>
								</CardContent>
							</Card>

							<Card>
								<CardHeader>
									<CardTitle className="text-sm">Spend limit</CardTitle>
								</CardHeader>
								<CardContent className="space-y-4">
									<ApiKeySpendLimitEditor
										idPrefix={`usage-${selectedKey.id}`}
										value={limitDraft}
										onChange={(next) => {
											setLimitDraft(next);
											setLimitError(null);
										}}
										disabled={saveLimit.isPending}
									/>
									{limitError ? (
										<p className="text-sm text-destructive">{limitError}</p>
									) : null}
									{saveLimit.isError ? (
										<p className="text-sm text-destructive">
											{saveLimit.error instanceof Error
												? saveLimit.error.message
												: "Failed to update spend limit."}
										</p>
									) : null}
									<Button
										onClick={() => {
											const limit = serializeSpendLimit(limitDraft);
											if (!limit.ok) {
												setLimitError(limit.error);
												return;
											}
											setLimitError(null);
											saveLimit.mutate(limit.body);
										}}
										disabled={saveLimit.isPending}
									>
										{saveLimit.isPending
											? "Saving..."
											: limitDraft.limitUsd.trim() === ""
												? "Remove limit"
												: "Save limit"}
									</Button>
								</CardContent>
							</Card>
						</div>
					) : null}
				</>
			)}
		</div>
	);
}
