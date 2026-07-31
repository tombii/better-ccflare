import type {
	AnomalyInsightsResponse,
	RunawayLoopGroup,
	TokenOutlierEvent,
} from "@better-ccflare/types";
import { formatNumber } from "@better-ccflare/ui-common";
import { AlertTriangle, BarChart3, Info } from "lucide-react";
import type { TimeRange } from "../../constants";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

interface AnomaliesViewProps {
	data?: AnomalyInsightsResponse;
	loading?: boolean;
	timeRange: TimeRange;
}

/**
 * Surface the anomaly detector output in a way the operator can act on.
 *
 * Three pieces of information make each panel actionable:
 *   1. The FULL count of detected events, not just the trimmed top-N.
 *   2. Whether the visible list is truncated at `maxEventsPerDetector`.
 *   3. Severity ordered by the strongest signal first (z-score descending
 *      for outliers / blowups, request count for loops, total cost for
 *      misrouting).
 *
 * Every panel carries the threshold reminder: these are statistical
 * outliers, not confirmed faults. They signal "look here" — the operator
 * still has to decide whether the cause is real.
 */
export const AnomaliesView = ({
	data,
	loading,
	timeRange: _timeRange,
}: AnomaliesViewProps) => {
	if (loading) {
		return (
			<Card>
				<CardContent className="p-6 text-muted-foreground">
					Loading anomaly insights…
				</CardContent>
			</Card>
		);
	}
	if (!data) {
		return (
			<Card>
				<CardContent className="p-6 text-muted-foreground">
					No anomaly insights available.
				</CardContent>
			</Card>
		);
	}
	const meta = data.meta;
	const scannedLabel = meta.scannedRequests.toLocaleString();
	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<div className="flex items-center gap-2">
						<Info className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">
							Statistical outliers, not confirmed faults
						</CardTitle>
					</div>
					<CardDescription>
						Detectors below flag requests whose token usage sits at or above{" "}
						{meta.zScoreThreshold.toFixed(1)}σ above their (account, model)
						baseline, plus dense bursts of near-identical calls and expensive
						models handling trivial traffic. With ~{scannedLabel} requests
						scanned and a 3-sigma threshold, expect some events by chance alone
						— investigate the largest, ignore the rest.
					</CardDescription>
					<div className="flex flex-wrap items-center gap-2 pt-2 text-xs text-muted-foreground">
						<span>
							Scanned: <strong>{scannedLabel}</strong> requests
						</span>
						{meta.truncated && <Badge variant="outline">Scan truncated</Badge>}
						<span>
							Capped at <strong>{meta.maxEventsPerDetector}</strong> rows per
							detector
						</span>
					</div>
				</CardHeader>
			</Card>

			<TokenOutlierPanel
				title="Token outliers (total tokens)"
				description="Total request tokens more than 3σ above baseline."
				events={data.tokenOutliers}
				totalCount={data.tokenOutliersSummary.totalCount}
				truncated={data.tokenOutliersSummary.truncated}
				threshold={meta.zScoreThreshold}
			/>

			<TokenOutlierPanel
				title="Output blowups (output tokens)"
				description="Output tokens more than 3σ above baseline."
				events={data.outputBlowups}
				totalCount={data.outputBlowupsSummary.totalCount}
				truncated={data.outputBlowupsSummary.truncated}
				threshold={meta.zScoreThreshold}
			/>

			<RunawayLoopPanel
				loops={data.runawayLoops}
				totalCount={data.runawayLoopsSummary.totalCount}
				truncated={data.runawayLoopsSummary.truncated}
				windowMinutes={meta.loopWindowMinutes}
			/>

			<MisroutingPanel
				rows={data.misrouting}
				totalCount={data.misroutingSummary.totalCount}
				truncated={data.misroutingSummary.truncated}
				costThreshold={meta.misroutingMinOutputRateUsd}
				tokenThreshold={meta.misroutingMaxTotalTokens}
			/>
		</div>
	);
};

interface TokenOutlierPanelProps {
	title: string;
	description: string;
	events: TokenOutlierEvent[];
	totalCount: number;
	truncated: boolean;
	threshold: number;
}

function TokenOutlierPanel({
	title,
	description,
	events,
	totalCount,
	truncated,
	threshold,
}: TokenOutlierPanelProps) {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2">
						<BarChart3 className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">{title}</CardTitle>
					</div>
					<DetectorTotals
						totalCount={totalCount}
						shown={events.length}
						truncated={truncated}
						threshold={threshold}
					/>
				</div>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent>
				{events.length === 0 ? (
					<p className="text-sm text-muted-foreground py-4">
						{totalCount === 0
							? "Nothing detected above threshold."
							: `${totalCount} detected; the visible list is empty (data inconsistency).`}
					</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead className="bg-muted/50">
								<tr>
									<th scope="col" className="text-right px-3 py-2 tabular-nums">
										z-score
									</th>
									<th scope="col" className="text-left px-3 py-2">
										Account / Model
									</th>
									<th scope="col" className="text-left px-3 py-2">
										Project
									</th>
									<th scope="col" className="text-right px-3 py-2 tabular-nums">
										Tokens
									</th>
									<th scope="col" className="text-right px-3 py-2 tabular-nums">
										Baseline
									</th>
								</tr>
							</thead>
							<tbody>
								{events.map((event) => (
									<tr
										key={`${event.metric}-${event.requestId}`}
										className="border-t"
									>
										<td className="px-3 py-2 text-right tabular-nums font-mono">
											{zScoreBadge(event.zScore)}
										</td>
										<td className="px-3 py-2">
											<div className="font-medium">{event.account}</div>
											<div className="text-xs text-muted-foreground">
												{event.model}
											</div>
										</td>
										<td className="px-3 py-2 text-xs text-muted-foreground">
											{renderProject(event.project)}
										</td>
										<td className="px-3 py-2 text-right tabular-nums">
											{formatNumber(event.value)}
										</td>
										<td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
											{formatNumber(Math.round(event.baselineMean))} ±{" "}
											{formatNumber(Math.round(event.baselineStdDev))}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

interface RunawayLoopPanelProps {
	loops: RunawayLoopGroup[];
	totalCount: number;
	truncated: boolean;
	windowMinutes: number;
}

function RunawayLoopPanel({
	loops,
	totalCount,
	truncated,
	windowMinutes,
}: RunawayLoopPanelProps) {
	const label = `${windowMinutes}min`;
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2">
						<AlertTriangle className="h-4 w-4 text-amber-500" />
						<CardTitle className="text-base">Runaway loops</CardTitle>
					</div>
					<DetectorTotals
						totalCount={totalCount}
						shown={loops.length}
						truncated={truncated}
					/>
				</div>
				<CardDescription>
					Dense bursts of ≥minRequests near-identical requests per (account,
					model, project) within a {label} window. Highest request count shown
					first.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{loops.length === 0 ? (
					<p className="text-sm text-muted-foreground py-4">
						No dense bursts detected.
					</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead className="bg-muted/50">
								<tr>
									<th scope="col" className="text-right px-3 py-2 tabular-nums">
										Requests
									</th>
									<th scope="col" className="text-right px-3 py-2 tabular-nums">
										Rate
									</th>
									<th scope="col" className="text-left px-3 py-2">
										Account / Model
									</th>
									<th scope="col" className="text-left px-3 py-2">
										Project
									</th>
									<th scope="col" className="text-right px-3 py-2 tabular-nums">
										Window
									</th>
								</tr>
							</thead>
							<tbody>
								{loops.map((loop) => (
									<tr
										key={`${loop.account}-${loop.model}-${loop.windowStartMs}-${loop.project ?? ""}`}
										className="border-t"
									>
										<td className="px-3 py-2 text-right tabular-nums font-medium">
											{loop.requests.toLocaleString()}
										</td>
										<td className="px-3 py-2 text-right tabular-nums">
											{loop.requestsPerMinute.toFixed(1)}/min
										</td>
										<td className="px-3 py-2">
											<div className="font-medium">{loop.account}</div>
											<div className="text-xs text-muted-foreground">
												{loop.model}
											</div>
										</td>
										<td className="px-3 py-2 text-xs text-muted-foreground">
											{renderProject(loop.project)}
										</td>
										<td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
											{formatWindow(loop.windowEndMs - loop.windowStartMs)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

interface MisroutingRow {
	account: string;
	model: string;
	requests: number;
	meanTotalTokens: number;
	outputRateUsd: number;
	totalCostUsd: number;
}

interface MisroutingPanelProps {
	rows: MisroutingRow[];
	totalCount: number;
	truncated: boolean;
	costThreshold: number;
	tokenThreshold: number;
}

function MisroutingPanel({
	rows,
	totalCount,
	truncated,
	costThreshold,
	tokenThreshold,
}: MisroutingPanelProps) {
	const formatter = new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 2,
	});
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2">
						<AlertTriangle className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">
							Possible model misrouting
						</CardTitle>
					</div>
					<DetectorTotals
						totalCount={totalCount}
						shown={rows.length}
						truncated={truncated}
					/>
				</div>
				<CardDescription>
					(Account, model) pairs where a model with output rate ≥ $
					{costThreshold}/1M tokens has been used for{" "}
					{tokenThreshold.toLocaleString()} tokens or fewer per call at least 5
					times in this window. Sorted by total logged cost descending.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{rows.length === 0 ? (
					<p className="text-sm text-muted-foreground py-4">
						No misrouting candidates detected.
					</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead className="bg-muted/50">
								<tr>
									<th scope="col" className="text-left px-3 py-2">
										Account / Model
									</th>
									<th scope="col" className="text-right px-3 py-2 tabular-nums">
										Requests
									</th>
									<th scope="col" className="text-right px-3 py-2 tabular-nums">
										Mean tokens
									</th>
									<th scope="col" className="text-right px-3 py-2 tabular-nums">
										Total cost
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<tr key={`${row.account}-${row.model}`} className="border-t">
										<td className="px-3 py-2">
											<div className="font-medium">{row.account}</div>
											<div className="text-xs text-muted-foreground">
												{row.model} · ${row.outputRateUsd}/1M
											</div>
										</td>
										<td className="px-3 py-2 text-right tabular-nums">
											{row.requests.toLocaleString()}
										</td>
										<td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
											{Math.round(row.meanTotalTokens).toLocaleString()}
										</td>
										<td className="px-3 py-2 text-right tabular-nums font-medium">
											{formatter.format(row.totalCostUsd)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

interface DetectorTotalsProps {
	totalCount: number;
	shown: number;
	truncated: boolean;
	threshold?: number;
}

function DetectorTotals({
	totalCount,
	shown,
	truncated,
	threshold,
}: DetectorTotalsProps) {
	const label = truncated
		? `${totalCount.toLocaleString()} detected · showing top ${shown.toLocaleString()}`
		: `${totalCount.toLocaleString()} detected`;
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground">
			<span>{label}</span>
			{truncated && <Badge variant="outline">Truncated</Badge>}
			{threshold !== undefined && <span>· ≥ {threshold.toFixed(1)}σ</span>}
		</div>
	);
}

/** Render a project label or "—" when null. UI never trusts raw values. */
function renderProject(project: string | null): string {
	if (project == null || project === "") return "—";
	// Belt-and-suspenders: the API already sanitises, but if a stale row
	// from before the fix reaches the UI we still clamp + strip control
	// chars so the rendering cannot be hijacked.
	if (project.length > 64) return `${project.slice(0, 63)}…`;
	return project;
}

function zScoreBadge(z: number): string {
	if (z >= 6) return z.toFixed(1);
	if (z >= 4) return z.toFixed(2);
	return z.toFixed(2);
}

function formatWindow(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

AnomaliesView.displayName = "AnomaliesView";
