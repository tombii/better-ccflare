import type {
	CacheInsightsResponse,
	CacheInsightsRow,
} from "@better-ccflare/types";
import {
	formatCost,
	formatNumber,
	formatPercentage,
	formatTokens,
} from "@better-ccflare/ui-common";
import {
	Activity,
	AlertTriangle,
	DollarSign,
	Percent,
	PiggyBank,
} from "lucide-react";
import type { TimeRange } from "../../constants";
import { BasePieChart } from "../charts";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

interface CacheEfficiencyViewProps {
	data?: CacheInsightsResponse;
	loading?: boolean;
	timeRange: TimeRange;
}

/** Format a USD amount that may legitimately be negative. */
function formatSignedCost(value: number): string {
	return value < 0 ? `-${formatCost(-value)}` : formatCost(value);
}

function savingsColorClass(value: number): string {
	if (value < 0) return "text-destructive";
	if (value > 0) return "text-green-500";
	return "";
}

interface BreakdownTableProps {
	rows: CacheInsightsRow[];
	nameLabel: string;
}

function BreakdownTable({ rows, nameLabel }: BreakdownTableProps) {
	if (rows.length === 0) {
		return (
			<p className="text-sm text-muted-foreground py-4">
				No data for this period
			</p>
		);
	}

	return (
		<div className="overflow-x-auto">
			<table
				aria-label={`Cache efficiency by ${nameLabel.toLowerCase()}`}
				className="w-full text-sm"
			>
				<thead className="bg-muted/50">
					<tr>
						<th scope="col" className="text-left px-3 py-2">
							{nameLabel}
						</th>
						<th scope="col" className="text-right px-3 py-2">
							Requests
						</th>
						<th scope="col" className="text-right px-3 py-2">
							Hit Rate
						</th>
						<th scope="col" className="text-right px-3 py-2">
							Savings
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.key} className="border-t">
							<td className="px-3 py-2">
								<div className="flex items-center gap-2">
									<span className="text-muted-foreground break-all">
										{row.key}
									</span>
									{row.flagged && (
										<Badge variant="warning" className="whitespace-nowrap">
											<AlertTriangle className="h-3 w-3 mr-1" />
											Low cache hit
										</Badge>
									)}
								</div>
							</td>
							<td className="px-3 py-2 text-right">
								{formatNumber(row.requests)}
							</td>
							<td className="px-3 py-2 text-right">
								{formatPercentage(row.cacheHitRate)}
							</td>
							<td className="px-3 py-2 text-right">
								{row.pricingKnown && row.savingsUsd !== null ? (
									<span className={savingsColorClass(row.savingsUsd)}>
										{formatSignedCost(row.savingsUsd)}
									</span>
								) : (
									<span
										className="text-muted-foreground"
										title="No pricing data for this model"
									>
										—
									</span>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function CacheEfficiencyView({
	data,
	loading = false,
	timeRange,
}: CacheEfficiencyViewProps) {
	const totals = data?.totals;

	const tokenComposition = [
		{
			name: "Uncached Input",
			value: totals?.uncachedInputTokens ?? 0,
		},
		{
			name: "Cache Read",
			value: totals?.cacheReadInputTokens ?? 0,
		},
		{
			name: "Cache Creation",
			value: totals?.cacheCreationInputTokens ?? 0,
		},
	].filter((item) => item.value > 0);

	const totalInputTokens =
		(totals?.uncachedInputTokens ?? 0) +
		(totals?.cacheReadInputTokens ?? 0) +
		(totals?.cacheCreationInputTokens ?? 0);

	return (
		<div className="space-y-6">
			{/* Summary Cards */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Cache Savings</CardTitle>
						<PiggyBank className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div
							className={`text-2xl font-bold ${savingsColorClass(totals?.savingsUsd ?? 0)}`}
						>
							{formatSignedCost(totals?.savingsUsd ?? 0)}
						</div>
						<p className="text-xs text-muted-foreground">
							Estimated vs. running uncached in the last {timeRange}
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							Cache Hit Rate
						</CardTitle>
						<Percent className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{formatPercentage(totals?.cacheHitRate ?? 0)}
						</div>
						<p className="text-xs text-muted-foreground">
							Cache reads as share of input tokens
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							Total Requests
						</CardTitle>
						<Activity className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{formatNumber(totals?.requests ?? 0)}
						</div>
						<p className="text-xs text-muted-foreground">
							Requests analyzed in the last {timeRange}
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							Cache Token Cost
						</CardTitle>
						<DollarSign className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{formatCost(totals?.actualCacheCostUsd ?? 0)}
						</div>
						<p className="text-xs text-muted-foreground">
							Cache read/write tokens only, vs{" "}
							{formatCost(totals?.counterfactualCostUsd ?? 0)} without caching
						</p>
					</CardContent>
				</Card>
			</div>

			{/* Token Composition + Breakdown */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<Card>
					<CardHeader>
						<CardTitle>Input Token Composition</CardTitle>
						<CardDescription>
							Uncached vs. cached input tokens in the last {timeRange}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<BasePieChart
							data={tokenComposition}
							loading={loading}
							height="small"
							innerRadius={60}
							outerRadius={80}
							paddingAngle={5}
							tooltipStyle="success"
							tooltipFormatter={(value, name) => [
								`${formatTokens(value as number)} tokens`,
								name ?? "",
							]}
							showLegend
						/>
						<div className="mt-4 pt-4 border-t">
							<div className="flex items-center justify-between text-sm">
								<span className="font-medium">Total Input Tokens</span>
								<span className="font-bold">
									{formatTokens(totalInputTokens)}
								</span>
							</div>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Cache Efficiency Breakdown</CardTitle>
						<CardDescription>
							Hit rate and estimated savings per dimension
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Tabs defaultValue="model" className="space-y-4">
							<TabsList className="grid w-full grid-cols-3">
								<TabsTrigger value="model">By Model</TabsTrigger>
								<TabsTrigger value="account">By Account</TabsTrigger>
								<TabsTrigger value="project">By Project</TabsTrigger>
							</TabsList>
							<TabsContent value="model">
								<BreakdownTable rows={data?.byModel ?? []} nameLabel="Model" />
							</TabsContent>
							<TabsContent value="account">
								<BreakdownTable
									rows={data?.byAccount ?? []}
									nameLabel="Account"
								/>
							</TabsContent>
							<TabsContent value="project">
								<BreakdownTable
									rows={data?.byProject ?? []}
									nameLabel="Project"
								/>
							</TabsContent>
						</Tabs>
					</CardContent>
				</Card>
			</div>

			{/* Footnotes */}
			<div className="space-y-1">
				{totals && totals.unknownPricingModels.length > 0 && (
					<p className="text-xs text-muted-foreground">
						<AlertTriangle className="h-3 w-3 inline mr-1" />
						No pricing data for: {totals.unknownPricingModels.join(", ")}.
						Savings exclude this traffic.
					</p>
				)}
				<p className="text-xs text-muted-foreground">
					Savings on plan-billed (subscription) traffic are notional — they
					reflect what the same usage would cost at API rates, not money
					actually spent.
				</p>
			</div>
		</div>
	);
}
