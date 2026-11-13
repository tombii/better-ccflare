import type { ApiKeyRestrictions } from "@better-ccflare/types";
import {
	formatCost,
	formatNumber,
	formatPercentage,
	formatTokens,
} from "@better-ccflare/ui-common";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../../api";
import { COLORS } from "../../constants";
import { useApiKeys, useApiKeyUsage } from "../../hooks/queries";
import { queryKeys } from "../../lib/query-keys";
import { ApiKeyLimitsEditor } from "../api-keys/ApiKeyLimitsEditor";
import { ApiKeyRestrictionsEditor } from "../api-keys/ApiKeyRestrictionsEditor";
import { ApiKeyRoutingEditor } from "../api-keys/ApiKeyRoutingEditor";
import { ApiKeySpendGauge } from "../api-keys/ApiKeySpendGauge";
import { BaseAreaChart } from "../charts/BaseAreaChart";
import { BaseBarChart } from "../charts/BaseBarChart";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import {
	apiKeyPageTarget,
	buildCostSeries,
	efficiencyCaption,
	formatEfficiencyRatio,
	pickDefaultApiKey,
	sortKeysActiveFirst,
} from "./tab-helpers";

const RANGES = [
	{ value: "1h", label: "1 hour" },
	{ value: "24h", label: "24 hours" },
	{ value: "7d", label: "7 days" },
	{ value: "30d", label: "30 days" },
	{ value: "this_month", label: "This month (Dublin)" },
	{ value: "last_month", label: "Last month (Dublin)" },
	{ value: "custom", label: "Custom range" },
];

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

/** Per-key cost, account attribution, model usage and administration. */
export function ApiKeyUsageTab() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	// React Router decodes route parameters again after resolving encoded slashes.
	// Read the raw path once so existing name links and stable ID links agree
	// with the authentication lookup performed by App.
	const directKey = apiKeyPageTarget(location.pathname, location.search) || "";
	const { data: apiKeys } = useApiKeys({ enabled: !directKey });
	const [range, setRange] = useState("24h");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const fromMs = new Date(from).getTime();
	const toMs = new Date(to).getTime();
	const validCustom =
		Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs;
	const selectedId = directKey || pickDefaultApiKey(apiKeys) || "";
	const { data, isLoading, error } = useApiKeyUsage(
		selectedId,
		range,
		range === "custom" && validCustom
			? new Date(fromMs).toISOString()
			: undefined,
		range === "custom" && validCustom
			? new Date(toMs).toISOString()
			: undefined,
	);
	const [editingId, setEditingId] = useState("");
	const [restrictionsDraft, setRestrictionsDraft] =
		useState<ApiKeyRestrictions>({
			allowedAccounts: null,
			allowedModels: null,
			allowedProviders: null,
		});
	if (data && editingId !== data.apiKey.id) {
		setEditingId(data.apiKey.id);
		setRestrictionsDraft(data.restrictions);
	}
	const saveRestrictions = useMutation({
		mutationFn: (restrictions: ApiKeyRestrictions) =>
			api.patch(
				`/api/api-keys/${encodeURIComponent(data?.apiKey.id ?? selectedId)}/restrictions`,
				restrictions,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
			queryClient.invalidateQueries({
				queryKey: [...queryKeys.all, "api-key-usage"],
			});
		},
	});

	const costSeries = useMemo(
		() => buildCostSeries(data?.series ?? [], data?.bucketMs ?? 3_600_000),
		[data?.series, data?.bucketMs],
	);

	const modelChartData = useMemo(
		() =>
			(data?.models ?? []).slice(0, 10).map((row) => ({
				name: row.model ?? "Unknown",
				costUsd: row.costUsd,
			})),
		[data?.models],
	);

	const ratioText = data
		? formatEfficiencyRatio(data.efficiencyRatio, data.efficiencyStatus)
		: null;

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-3">
				{directKey ? (
					<div className="mr-auto">
						{data?.canManage ? (
							<Link
								to="/api-keys"
								className="text-xs text-muted-foreground hover:underline"
							>
								API keys
							</Link>
						) : null}
						<h2 className="text-xl font-semibold">
							{data?.apiKey.name ?? directKey}
						</h2>
					</div>
				) : (
					<Select
						value={selectedId}
						onValueChange={(id) => {
							navigate(`/api-keys/${encodeURIComponent(id)}`);
						}}
					>
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
				)}
				<Select value={range} onValueChange={setRange}>
					<SelectTrigger className="w-52">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{RANGES.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{range === "custom" ? (
				<div className="flex flex-wrap items-end gap-3">
					<div className="space-y-1">
						<Label htmlFor="usage-from">From (your local time)</Label>
						<Input
							id="usage-from"
							type="datetime-local"
							value={from}
							onChange={(event) => setFrom(event.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="usage-to">To (your local time)</Label>
						<Input
							id="usage-to"
							type="datetime-local"
							value={to}
							onChange={(event) => setTo(event.target.value)}
						/>
					</div>
					{!validCustom ? (
						<p className="text-xs text-muted-foreground">
							Choose a start and a later end to load usage.
						</p>
					) : null}
				</div>
			) : null}
			{data ? (
				<p className="text-xs text-muted-foreground">
					{new Date(data.windowStartMs).toLocaleString("en-IE", {
						timeZone: "Europe/Dublin",
						timeZoneName: "short",
					})}{" "}
					–{" "}
					{new Date(data.windowEndMs).toLocaleString("en-IE", {
						timeZone: "Europe/Dublin",
						timeZoneName: "short",
					})}
				</p>
			) : null}

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

					<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
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
							label="Total API-cost equivalent"
							value={formatCost(data?.totalCostUsd ?? 0)}
							hint="API cost + plan value; used by spend limits"
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

					{data ? (
						<Card>
							<CardHeader>
								<CardTitle className="text-sm">Current limits</CardTitle>
							</CardHeader>
							<CardContent>
								{data.limits.length ? (
									<ApiKeySpendGauge
										apiKey={{
											...data.apiKey,
											limits: data.limits,
											limitWindowMode: data.limitWindowMode,
										}}
									/>
								) : (
									<p className="text-sm text-muted-foreground">
										No spend limits.
									</p>
								)}
							</CardContent>
						</Card>
					) : null}
					{data?.planCost.unpricedAccountIds.length ? (
						<Card className="border-warning/40">
							<CardContent className="pt-6 text-sm">
								Accounts without a monthly plan price:{" "}
								{data.planCost.accounts
									.filter((account) =>
										data.planCost.unpricedAccountIds.includes(
											account.accountId,
										),
									)
									.map((account) => account.accountName ?? account.accountId)
									.join(", ")}
								. Their plan cost is unknown.
							</CardContent>
						</Card>
					) : null}

					<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
						<Card>
							<CardHeader>
								<CardTitle className="text-sm">Cost over time</CardTitle>
							</CardHeader>
							<CardContent>
								<BaseAreaChart
									data={costSeries.data}
									dataKey="totalCostUsd"
									xAxisKey="label"
									loading={isLoading}
									color={COLORS.primary}
									gradientId="apiKeyUsageCost"
									yAxisDomain={[0, costSeries.maxCost || "auto"]}
									yAxisTickFormatter={(value) => formatCost(Number(value))}
									tooltipFormatter={(value) => [
										formatCost(value),
										"Total API-cost equivalent",
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
									bars={{ dataKey: "costUsd", fill: COLORS.blue }}
									xAxisKey="name"
									loading={isLoading}
									xAxisAngle={-25}
									xAxisTextAnchor="end"
									xAxisHeight={70}
									tooltipFormatter={(value) => [
										formatCost(value),
										"API-cost equivalent",
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

					{data ? (
						<Card>
							<CardHeader>
								<CardTitle className="text-sm">Restrictions</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								<dl className="grid gap-2 text-sm">
									{(
										[
											["Models", data.restrictions.allowedModels],
											["Accounts", data.restrictions.allowedAccounts],
											["Providers", data.restrictions.allowedProviders],
										] as const
									).map(([label, values]) => (
										<div key={label}>
											<dt className="font-medium">{label}</dt>
											<dd className="text-muted-foreground break-all">
												{values === null
													? "Unrestricted"
													: values.length
														? values.join(", ")
														: "None allowed"}
											</dd>
										</div>
									))}
								</dl>
								{data.canManage ? (
									<>
										<ApiKeyRestrictionsEditor
											idPrefix={`usage-${data.apiKey.id}`}
											value={restrictionsDraft}
											onChange={setRestrictionsDraft}
											disabled={saveRestrictions.isPending}
										/>
										{saveRestrictions.isError ? (
											<p role="alert" className="text-sm text-destructive">
												{saveRestrictions.error instanceof Error
													? saveRestrictions.error.message
													: "Failed to save restrictions."}
											</p>
										) : null}
										<Button
											disabled={saveRestrictions.isPending}
											onClick={() => saveRestrictions.mutate(restrictionsDraft)}
										>
											{saveRestrictions.isPending
												? "Saving..."
												: "Save restrictions"}
										</Button>
										{saveRestrictions.isSuccess ? (
											<p
												role="status"
												className="text-sm text-muted-foreground"
											>
												Restrictions saved.
											</p>
										) : null}
									</>
								) : null}
							</CardContent>
						</Card>
					) : null}
					{data?.canManage ? (
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
							<Card>
								<CardHeader>
									<CardTitle className="text-sm">Spend limits</CardTitle>
								</CardHeader>
								<CardContent>
									<ApiKeyLimitsEditor
										key={data.apiKey.id}
										keyId={data.apiKey.id}
										limits={data.limits}
										mode={data.limitWindowMode}
									/>
								</CardContent>
							</Card>
							<Card>
								<CardHeader>
									<CardTitle className="text-sm">Routing overrides</CardTitle>
								</CardHeader>
								<CardContent>
									<ApiKeyRoutingEditor
										key={data.apiKey.id}
										keyId={data.apiKey.id}
										overrides={data.familyComboOverrides}
									/>
								</CardContent>
							</Card>
						</div>
					) : null}
				</>
			)}
		</div>
	);
}
