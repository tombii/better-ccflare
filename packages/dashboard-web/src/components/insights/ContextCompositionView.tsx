import type {
	ContextContributor,
	ContextContributorKind,
	ContextGrowthSession,
	ContextInsightsResponse,
	ContextRequestComposition,
} from "@better-ccflare/types";
import {
	formatNumber,
	formatPercentage,
	formatTokens,
} from "@better-ccflare/ui-common";
import {
	AlertTriangle,
	Database,
	FileSearch,
	Layers,
	TrendingUp,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { COLORS, type TimeRange } from "../../constants";
import { BaseLineChart, BasePieChart } from "../charts";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

interface ContextCompositionViewProps {
	data?: ContextInsightsResponse;
	loading?: boolean;
	timeRange: TimeRange;
}

/** Mirrors the backend's char→token heuristic (see ContextInsightsMeta.estimateNote). */
const CHARS_PER_TOKEN = 4;

function estimateTokensFromChars(chars: number): number {
	return Math.round(chars / CHARS_PER_TOKEN);
}

const CONTRIBUTOR_KIND_LABELS: Record<ContextContributorKind, string> = {
	tool_result: "Tool Result",
	text: "Text",
	tool_use: "Tool Use",
};

const CONTRIBUTOR_KIND_VARIANTS: Record<
	ContextContributorKind,
	"default" | "secondary" | "outline"
> = {
	tool_result: "secondary",
	text: "outline",
	tool_use: "default",
};

function formatSessionLabel(session: ContextGrowthSession): string {
	const start = new Date(session.startTimestamp).toLocaleString();
	const end = new Date(session.endTimestamp).toLocaleTimeString();
	return `${session.project ?? "Unknown"} — ${start} – ${end} (${session.requestCount} reqs)`;
}

interface ContributorsTableProps {
	contributors: ContextContributor[];
}

function ContributorsTable({ contributors }: ContributorsTableProps) {
	if (contributors.length === 0) {
		return (
			<p className="text-sm text-muted-foreground py-4">
				No large content blocks found in the analyzed payloads
			</p>
		);
	}

	return (
		<div className="overflow-x-auto">
			<table
				aria-label="Largest context contributors"
				className="w-full text-sm"
			>
				<thead className="bg-muted/50">
					<tr>
						<th scope="col" className="text-left px-3 py-2">
							Kind
						</th>
						<th scope="col" className="text-left px-3 py-2">
							Content
						</th>
						<th scope="col" className="text-right px-3 py-2">
							Size (est.)
						</th>
						<th scope="col" className="text-right px-3 py-2">
							Occurrences
						</th>
						<th scope="col" className="text-right px-3 py-2">
							Requests
						</th>
					</tr>
				</thead>
				<tbody>
					{contributors.map((contributor) => (
						<tr
							key={`${contributor.kind}-${contributor.label}-${contributor.maxChars}`}
							className="border-t"
						>
							<td className="px-3 py-2">
								<Badge
									variant={CONTRIBUTOR_KIND_VARIANTS[contributor.kind]}
									className="whitespace-nowrap"
								>
									{CONTRIBUTOR_KIND_LABELS[contributor.kind]}
								</Badge>
							</td>
							<td className="px-3 py-2">
								<span className="text-muted-foreground break-all">
									{contributor.label}
								</span>
							</td>
							<td className="px-3 py-2 text-right whitespace-nowrap">
								~{formatTokens(contributor.estimatedTokens)} tokens
								<span className="text-muted-foreground">
									{" "}
									({formatNumber(contributor.maxChars)} chars)
								</span>
							</td>
							<td className="px-3 py-2 text-right">
								{formatNumber(contributor.occurrences)}
							</td>
							<td className="px-3 py-2 text-right">
								{formatNumber(contributor.requestCount)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

interface PerRequestTableProps {
	rows: ContextRequestComposition[];
}

const PER_REQUEST_ROW_LIMIT = 20;

function PerRequestTable({ rows }: PerRequestTableProps) {
	if (rows.length === 0) {
		return (
			<p className="text-sm text-muted-foreground py-4">
				No analyzed requests for this period
			</p>
		);
	}

	return (
		<div className="overflow-x-auto">
			<table
				aria-label="Analyzed request compositions"
				className="w-full text-sm"
			>
				<thead className="bg-muted/50">
					<tr>
						<th scope="col" className="text-left px-3 py-2">
							Time
						</th>
						<th scope="col" className="text-left px-3 py-2">
							Model
						</th>
						<th scope="col" className="text-left px-3 py-2">
							Project
						</th>
						<th scope="col" className="text-right px-3 py-2">
							System
						</th>
						<th scope="col" className="text-right px-3 py-2">
							Tools
						</th>
						<th scope="col" className="text-right px-3 py-2">
							Messages
						</th>
						<th scope="col" className="text-right px-3 py-2">
							Est. Context
						</th>
						<th scope="col" className="text-right px-3 py-2">
							Actual Input
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const actualInputTokens =
							row.inputTokens +
							row.cacheReadInputTokens +
							row.cacheCreationInputTokens;
						return (
							<tr key={row.id} className="border-t">
								<td className="px-3 py-2 whitespace-nowrap">
									{new Date(row.timestamp).toLocaleString()}
								</td>
								<td className="px-3 py-2">
									<span className="text-muted-foreground break-all">
										{row.model ?? "—"}
									</span>
								</td>
								<td className="px-3 py-2">
									<span className="text-muted-foreground break-all">
										{row.project ?? "—"}
									</span>
								</td>
								<td className="px-3 py-2 text-right">
									~{formatTokens(estimateTokensFromChars(row.systemChars))}
								</td>
								<td className="px-3 py-2 text-right">
									~{formatTokens(estimateTokensFromChars(row.toolsChars))}
								</td>
								<td className="px-3 py-2 text-right">
									~{formatTokens(estimateTokensFromChars(row.messagesChars))}
								</td>
								<td className="px-3 py-2 text-right">
									~{formatTokens(row.estimatedContextTokens)}
								</td>
								<td className="px-3 py-2 text-right">
									{formatTokens(actualInputTokens)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

export const ContextCompositionView = React.memo(
	({ data, loading = false, timeRange }: ContextCompositionViewProps) => {
		const meta = data?.meta;
		const totals = data?.composition.totals;
		const tokenTotals = data?.composition.tokenTotals;

		const sessions = useMemo(
			() => data?.growthCurve.sessions ?? [],
			[data?.growthCurve.sessions],
		);

		// Index into sessions; clamped below so a shrinking session list
		// after a refetch can never point past the end.
		const [selectedSession, setSelectedSession] = useState("0");
		const sessionIndex = Math.min(
			Math.max(Number.parseInt(selectedSession, 10) || 0, 0),
			Math.max(sessions.length - 1, 0),
		);
		const activeSession = sessions[sessionIndex];

		const growthData = useMemo(
			() =>
				(activeSession?.points ?? []).map((point) => ({
					time: new Date(point.timestamp).toLocaleTimeString(),
					contextTokens: point.contextTokens,
					outputTokens: point.outputTokens,
				})),
			[activeSession],
		);

		const compositionData = [
			{ name: "System", value: totals?.systemChars ?? 0 },
			{ name: "Tools", value: totals?.toolsChars ?? 0 },
			{ name: "Messages", value: totals?.messagesChars ?? 0 },
		].filter((item) => item.value > 0);

		const tokenMixData = [
			{ name: "Uncached Input", value: tokenTotals?.uncachedInputTokens ?? 0 },
			{ name: "Cache Read", value: tokenTotals?.cacheReadInputTokens ?? 0 },
			{
				name: "Cache Creation",
				value: tokenTotals?.cacheCreationInputTokens ?? 0,
			},
		].filter((item) => item.value > 0);

		const recentRequests = useMemo(
			() =>
				[...(data?.composition.perRequest ?? [])]
					.sort((a, b) => b.timestamp - a.timestamp)
					.slice(0, PER_REQUEST_ROW_LIMIT),
			[data?.composition.perRequest],
		);

		const requestsInRange = meta?.payloadCoverage.requestsInRange ?? 0;
		const requestsWithPayload = meta?.payloadCoverage.requestsWithPayload ?? 0;
		const noPayloads = !!data && requestsWithPayload === 0;

		return (
			<div className="space-y-6">
				{/* Coverage Summary Cards */}
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
					<Card>
						<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
							<CardTitle className="text-sm font-medium">
								Requests Analyzed
							</CardTitle>
							<FileSearch className="h-4 w-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">
								{formatNumber(meta?.parsedPayloads ?? 0)}{" "}
								<span className="text-base font-normal text-muted-foreground">
									of {formatNumber(requestsInRange)}
								</span>
							</div>
							<p className="text-xs text-muted-foreground">
								Requests with a parsed payload in the last {timeRange}
							</p>
						</CardContent>
					</Card>

					<Card>
						<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
							<CardTitle className="text-sm font-medium">
								Est. Context Size
							</CardTitle>
							<Layers className="h-4 w-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">
								~{formatTokens(totals?.estimatedTokens.total ?? 0)}
							</div>
							<p className="text-xs text-muted-foreground">
								Estimated tokens across analyzed payloads (~
								{CHARS_PER_TOKEN} chars/token)
							</p>
						</CardContent>
					</Card>

					<Card>
						<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
							<CardTitle className="text-sm font-medium">
								Stored Payloads
							</CardTitle>
							<Database className="h-4 w-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">
								{formatNumber(requestsWithPayload)}
							</div>
							<p className="text-xs text-muted-foreground">
								{formatNumber(meta?.scannedPayloads ?? 0)} scanned
								{meta?.truncated ? " (scan limit reached)" : ""}
							</p>
						</CardContent>
					</Card>

					<Card>
						<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
							<CardTitle className="text-sm font-medium">
								Growth Sessions
							</CardTitle>
							<TrendingUp className="h-4 w-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">
								{formatNumber(sessions.length)}
							</div>
							<p className="text-xs text-muted-foreground">
								Request runs grouped by project and time gap
							</p>
						</CardContent>
					</Card>
				</div>

				{noPayloads ? (
					<Card>
						<CardContent className="p-6">
							<div className="flex items-start gap-3">
								<Database className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
								<div className="space-y-1">
									<p className="font-medium">
										{requestsInRange === 0
											? "No requests in this period"
											: "No stored payloads to analyze"}
									</p>
									<p className="text-sm text-muted-foreground">
										{requestsInRange === 0 ? (
											<>
												No requests were recorded in the last {timeRange}, so
												there is nothing to analyze yet. Try a wider time range.
											</>
										) : (
											<>
												Context composition is computed from stored request
												payloads, but none of the{" "}
												{formatNumber(requestsInRange)} requests in the last{" "}
												{timeRange} have one. Enable payload storage (the{" "}
												<code>store_payloads</code> config option) and new
												requests will appear here. Note that payloads are
												size-capped and cleaned up by retention, so coverage is
												always partial.
											</>
										)}
									</p>
								</div>
							</div>
						</CardContent>
					</Card>
				) : (
					<>
						{/* Composition Donuts */}
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
							<Card>
								<CardHeader>
									<CardTitle>Context Composition (Estimated)</CardTitle>
									<CardDescription>
										System prompt vs. tool definitions vs. messages, by
										serialized size in the last {timeRange}
									</CardDescription>
								</CardHeader>
								<CardContent>
									<BasePieChart
										data={compositionData}
										loading={loading}
										height="small"
										innerRadius={60}
										outerRadius={80}
										paddingAngle={5}
										tooltipStyle="success"
										tooltipFormatter={(value, name) => [
											`~${formatTokens(
												estimateTokensFromChars(value as number),
											)} tokens (${formatNumber(value as number)} chars)`,
											name ?? "",
										]}
										showLegend
									/>
									<div className="mt-4 pt-4 border-t space-y-1 text-sm">
										<div className="flex items-center justify-between">
											<span className="text-muted-foreground">System</span>
											<span>
												~{formatTokens(totals?.estimatedTokens.system ?? 0)} (
												{formatPercentage(totals?.percentages.system ?? 0)})
											</span>
										</div>
										<div className="flex items-center justify-between">
											<span className="text-muted-foreground">Tools</span>
											<span>
												~{formatTokens(totals?.estimatedTokens.tools ?? 0)} (
												{formatPercentage(totals?.percentages.tools ?? 0)})
											</span>
										</div>
										<div className="flex items-center justify-between">
											<span className="text-muted-foreground">Messages</span>
											<span>
												~{formatTokens(totals?.estimatedTokens.messages ?? 0)} (
												{formatPercentage(totals?.percentages.messages ?? 0)})
											</span>
										</div>
									</div>
								</CardContent>
							</Card>

							<Card>
								<CardHeader>
									<CardTitle>Input Token Mix (Exact)</CardTitle>
									<CardDescription>
										Exact token counts from the requests table for the analyzed
										requests
									</CardDescription>
								</CardHeader>
								<CardContent>
									<BasePieChart
										data={tokenMixData}
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
												{formatTokens(
													(tokenTotals?.uncachedInputTokens ?? 0) +
														(tokenTotals?.cacheReadInputTokens ?? 0) +
														(tokenTotals?.cacheCreationInputTokens ?? 0),
												)}
											</span>
										</div>
									</div>
								</CardContent>
							</Card>
						</div>

						{/* Growth Curve */}
						<Card>
							<CardHeader>
								<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
									<div>
										<CardTitle>Context Growth</CardTitle>
										<CardDescription>
											Exact context tokens (input + cache read + cache creation)
											per request over a session
										</CardDescription>
									</div>
									{sessions.length > 0 && (
										<Select
											value={String(sessionIndex)}
											onValueChange={setSelectedSession}
										>
											<SelectTrigger className="w-full sm:w-[340px]">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{sessions.map((session, index) => (
													<SelectItem
														key={`${session.project ?? "unknown"}-${session.startTimestamp}`}
														value={String(index)}
													>
														{formatSessionLabel(session)}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									)}
								</div>
							</CardHeader>
							<CardContent>
								<BaseLineChart
									data={growthData}
									loading={loading}
									height="medium"
									xAxisKey="time"
									lines={[
										{
											dataKey: "contextTokens",
											name: "Context tokens",
											stroke: COLORS.primary,
											dot: true,
										},
										{
											dataKey: "outputTokens",
											name: "Output tokens",
											stroke: COLORS.blue,
										},
									]}
									yAxisTickFormatter={(value) => formatTokens(Number(value))}
									tooltipFormatter={(value, name) => [
										`${formatTokens(value as number)} tokens`,
										name ?? "",
									]}
									showLegend
									emptyState={
										<p className="text-sm text-muted-foreground">
											No session data for this period
										</p>
									}
								/>
								{data?.growthCurve.truncated && (
									<p className="mt-2 text-xs text-muted-foreground">
										<AlertTriangle className="h-3 w-3 inline mr-1" />
										Some sessions or points were trimmed by scan caps.
									</p>
								)}
							</CardContent>
						</Card>

						{/* Contributors + Per-Request Tables */}
						<Card>
							<CardHeader>
								<CardTitle>Context Details</CardTitle>
								<CardDescription>
									Largest repeated content blocks and per-request composition
								</CardDescription>
							</CardHeader>
							<CardContent>
								<Tabs defaultValue="contributors" className="space-y-4">
									<TabsList className="grid w-full grid-cols-2">
										<TabsTrigger value="contributors">
											Top Contributors
										</TabsTrigger>
										<TabsTrigger value="requests">Recent Requests</TabsTrigger>
									</TabsList>
									<TabsContent value="contributors">
										<ContributorsTable
											contributors={data?.topContributors ?? []}
										/>
									</TabsContent>
									<TabsContent value="requests">
										<PerRequestTable rows={recentRequests} />
										{(data?.composition.perRequest.length ?? 0) >
											PER_REQUEST_ROW_LIMIT && (
											<p className="mt-2 text-xs text-muted-foreground">
												Showing the {PER_REQUEST_ROW_LIMIT} most recent of{" "}
												{formatNumber(data?.composition.perRequest.length ?? 0)}{" "}
												analyzed requests.
											</p>
										)}
									</TabsContent>
								</Tabs>
							</CardContent>
						</Card>
					</>
				)}

				{/* Footnotes */}
				<div className="space-y-1">
					{meta && meta.unparseablePayloads > 0 && (
						<p className="text-xs text-muted-foreground">
							<AlertTriangle className="h-3 w-3 inline mr-1" />
							{formatNumber(meta.unparseablePayloads)} stored payload
							{meta.unparseablePayloads === 1 ? "" : "s"} could not be parsed
							and {meta.unparseablePayloads === 1 ? "is" : "are"} excluded from
							the composition figures.
						</p>
					)}
					{meta?.truncated && (
						<p className="text-xs text-muted-foreground">
							<AlertTriangle className="h-3 w-3 inline mr-1" />
							More payload-bearing requests existed than the scan limit; only
							the most recent were analyzed.
						</p>
					)}
					{meta?.estimateNote && (
						<p className="text-xs text-muted-foreground">{meta.estimateNote}</p>
					)}
				</div>
			</div>
		);
	},
);

ContextCompositionView.displayName = "ContextCompositionView";
