import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useApiError } from "../../hooks/useApiError";
import {
	useWebToolCallSummary,
	useWebToolCalls,
	WEB_TOOL_CALL_SUMMARY_HOURS,
} from "../../hooks/useWebToolCalls";
import type {
	WebToolCall,
	WebToolCallStatus,
} from "../../lib/search-provider-types";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import {
	formatLatency,
	formatRelativeTime,
	STATUS_BADGE_CLASSES,
	STATUS_LABELS,
	summarizeTraces,
	truncateQuery,
} from "./recent-searches-utils";

const STATUS_FILTER_ALL = "all";

function StatusBadge({ status }: { status: WebToolCallStatus }) {
	return (
		<Badge
			variant="outline"
			className={cn("whitespace-nowrap", STATUS_BADGE_CLASSES[status])}
		>
			{STATUS_LABELS[status]}
		</Badge>
	);
}

function TraceRow({ trace, now }: { trace: WebToolCall; now: number }) {
	return (
		<div
			className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 text-sm last:border-b-0"
			data-testid="recent-search-row"
		>
			<span
				className="w-16 shrink-0 text-xs text-muted-foreground"
				title={new Date(trace.timestamp).toLocaleString()}
			>
				{formatRelativeTime(trace.timestamp, now)}
			</span>
			<span
				className="min-w-0 flex-1 truncate"
				title={trace.queryText ?? undefined}
			>
				{truncateQuery(trace.queryText)}
			</span>
			<span className="w-24 shrink-0 truncate font-mono text-xs text-muted-foreground">
				{trace.providerKind ?? "—"}
			</span>
			<span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
				{trace.resultCount ?? "—"} hits
			</span>
			<span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
				{formatLatency(trace.latencyMs)}
			</span>
			<StatusBadge status={trace.status} />
		</div>
	);
}

/**
 * "Recent searches": every web_search the proxy intercepted, newest first,
 * plus a 24h summary. A `fallthrough` row is not a neutral event — those
 * searches were paid for at Anthropic — so it gets the amber treatment and
 * its own tile.
 */
export function RecentSearchesSection() {
	const [statusFilter, setStatusFilter] = useState<WebToolCallStatus | "all">(
		STATUS_FILTER_ALL,
	);
	const tracesQuery = useWebToolCalls(
		statusFilter === STATUS_FILTER_ALL ? undefined : statusFilter,
	);
	const summaryQuery = useWebToolCallSummary();
	const { formatError } = useApiError();

	const traces = tracesQuery.data ?? [];
	const totals = summarizeTraces(summaryQuery.data ?? []);
	const now = Date.now();

	const refresh = () => {
		void tracesQuery.refetch();
		void summaryQuery.refetch();
	};

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<CardTitle className="text-lg">Recent searches</CardTitle>
						<p className="text-sm text-muted-foreground">
							Every <code className="font-mono text-xs">web_search</code> the
							proxy intercepted, newest first. Searches that fell through still
							cost tokens at Anthropic.
						</p>
					</div>
					<div className="flex items-end gap-2">
						<div className="space-y-1">
							<Label
								htmlFor="recent-searches-status"
								className="text-xs text-muted-foreground"
							>
								Status
							</Label>
							<Select
								value={statusFilter}
								onValueChange={(value) =>
									setStatusFilter(value as WebToolCallStatus | "all")
								}
							>
								<SelectTrigger id="recent-searches-status" className="h-8 w-40">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={STATUS_FILTER_ALL}>All</SelectItem>
									<SelectItem value="ok">Served</SelectItem>
									<SelectItem value="error">Errors</SelectItem>
									<SelectItem value="fallthrough">Fell through</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={refresh}
							disabled={tracesQuery.isFetching || summaryQuery.isFetching}
						>
							<RefreshCw
								className={cn(
									"mr-2 h-4 w-4",
									tracesQuery.isFetching && "animate-spin",
								)}
							/>
							Refresh
						</Button>
					</div>
				</div>
			</CardHeader>

			<CardContent className="space-y-4">
				<div
					className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
					data-testid="recent-searches-summary"
				>
					<div className="rounded-md border p-3">
						<p className="text-xs text-muted-foreground">Served</p>
						<p className="text-lg font-semibold text-green-600 dark:text-green-400">
							{totals.served}
						</p>
					</div>
					<div className="rounded-md border p-3">
						<p className="text-xs text-muted-foreground">Errors</p>
						<p className="text-lg font-semibold text-destructive">
							{totals.errors}
						</p>
					</div>
					<div className="rounded-md border border-amber-500/50 bg-amber-50 p-3 dark:bg-amber-500/10">
						<p className="text-xs text-amber-800 dark:text-amber-200">
							Fell through
						</p>
						<p className="text-lg font-semibold text-amber-700 dark:text-amber-300">
							{totals.fellThrough}
						</p>
					</div>
					<div className="rounded-md border p-3">
						<p className="text-xs text-muted-foreground">Avg latency</p>
						<p className="text-lg font-semibold">
							{totals.calls > 0 ? formatLatency(totals.avgLatencyMs) : "—"}
						</p>
					</div>
					<div className="rounded-md border p-3">
						<p className="text-xs text-muted-foreground">Results</p>
						<p className="text-lg font-semibold">{totals.totalResults}</p>
					</div>
				</div>
				<p className="text-xs text-muted-foreground">
					Last {WEB_TOOL_CALL_SUMMARY_HOURS}h across {totals.calls} search
					{totals.calls === 1 ? "" : "es"}.
				</p>

				{summaryQuery.isError && (
					<p className="text-sm text-destructive">
						Failed to load the summary: {formatError(summaryQuery.error)}
					</p>
				)}

				{tracesQuery.isLoading && (
					<p className="text-sm text-muted-foreground">Loading searches...</p>
				)}

				{tracesQuery.isError && (
					<p className="text-sm text-destructive">
						Failed to load searches: {formatError(tracesQuery.error)}. The
						server may be running a version without the web tool call API.
					</p>
				)}

				{!tracesQuery.isLoading &&
					!tracesQuery.isError &&
					traces.length === 0 && (
						<div
							className="rounded-lg border border-dashed px-6 py-10 text-center"
							data-testid="recent-searches-empty"
						>
							<p className="text-sm text-muted-foreground">
								{statusFilter === STATUS_FILTER_ALL
									? "No searches recorded yet. Traces appear here once web-search interception is enabled and Claude Code runs a search."
									: "No searches with this status yet."}
							</p>
						</div>
					)}

				{traces.length > 0 && (
					<div className="text-sm">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-1 text-xs font-medium text-muted-foreground">
							<span className="w-16 shrink-0">When</span>
							<span className="min-w-0 flex-1">Query</span>
							<span className="w-24 shrink-0">Provider</span>
							<span className="w-14 shrink-0 text-right">Results</span>
							<span className="w-16 shrink-0 text-right">Latency</span>
							<span>Status</span>
						</div>
						{traces.map((trace) => (
							<TraceRow key={trace.id} trace={trace} now={now} />
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
