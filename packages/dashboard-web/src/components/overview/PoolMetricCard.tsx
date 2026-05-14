import { formatPercentage } from "@better-ccflare/ui-common";
import { Info } from "lucide-react";
import type {
	ExcludedReason,
	PoolUsageResult,
	PoolWindow,
} from "../../lib/pool-usage";
import { cn } from "../../lib/utils";
import { Card, CardContent } from "../ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

interface PoolMetricCardProps {
	title: string;
	icon: React.ComponentType<{ className?: string }>;
	result: PoolUsageResult;
	window: PoolWindow;
}

const REASON_LABELS: Record<ExcludedReason, string> = {
	paused: "Paused",
	rate_limited: "Rate-limited",
	token_expired: "OAuth token expired",
	usage_rate_limited: "Usage data unavailable (provider 429)",
	five_hour_exhausted: "5h quota exhausted",
	seven_day_exhausted: "7d quota exhausted",
	no_usage_data: "No usage data yet",
};

const REASON_ORDER: ExcludedReason[] = [
	"paused",
	"rate_limited",
	"token_expired",
	"usage_rate_limited",
	"five_hour_exhausted",
	"seven_day_exhausted",
	"no_usage_data",
];

function headlineColor(average: number | null): string | undefined {
	if (average == null) return undefined;
	if (average < 60) return "text-success";
	if (average < 80) return "text-warning";
	return "text-destructive";
}

function groupExcluded(
	excluded: PoolUsageResult["excluded"],
): Array<{ reason: ExcludedReason; items: PoolUsageResult["excluded"] }> {
	const map = new Map<ExcludedReason, PoolUsageResult["excluded"]>();
	for (const entry of excluded) {
		const bucket = map.get(entry.reason);
		if (bucket) {
			bucket.push(entry);
		} else {
			map.set(entry.reason, [entry]);
		}
	}
	const groups: Array<{
		reason: ExcludedReason;
		items: PoolUsageResult["excluded"];
	}> = [];
	for (const reason of REASON_ORDER) {
		const items = map.get(reason);
		if (items && items.length > 0) {
			groups.push({ reason, items });
		}
	}
	return groups;
}

function nextQuotaTimeLabel(
	earliestResetMs: number,
	window: PoolWindow,
): string {
	const date = new Date(earliestResetMs);
	return window === "seven_day"
		? date.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			})
		: date.toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			});
}

function nextQuotaLabel(
	earliestResetMs: number,
	accountName: string | null,
	window: PoolWindow,
): string {
	const name = accountName ?? "unknown";
	return `${name} at ${nextQuotaTimeLabel(earliestResetMs, window)}`;
}

export function PoolMetricCard({
	title,
	icon: Icon,
	result,
	window,
}: PoolMetricCardProps) {
	const {
		average,
		activeAverage,
		contributing,
		exhausted,
		excluded,
		fallback,
		earliestResetMs,
		earliestResetAccountName,
	} = result;

	const eligibleTotal =
		contributing.length + exhausted.length + excluded.length;
	const showChip = eligibleTotal > 0;
	const colorClass = headlineColor(average);
	const headline = average != null ? formatPercentage(average, 0) : "—";
	const nextQuotaText =
		earliestResetMs == null
			? null
			: `more quota at ${nextQuotaTimeLabel(earliestResetMs, window)}`;

	const sortedContributing = contributing.slice().sort((a, b) => b.pct - a.pct);
	const exhaustedGroups = groupExcluded(exhausted);
	const excludedGroups = groupExcluded(excluded);

	const hasContributing = contributing.length > 0;
	const hasExhausted = exhausted.length > 0;
	const hasExcluded = excluded.length > 0;
	const hasFallback = fallback.length > 0;

	const triggerNode = showChip ? (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="flex items-center gap-1 text-xs text-muted-foreground cursor-help focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
				>
					<span className="tabular-nums">
						({contributing.length}/{eligibleTotal} active)
					</span>
					<Info className="h-3 w-3" />
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-72 text-xs space-y-3">
				<div>
					<div className="font-medium mb-1">Pool usage</div>
					<div className="text-muted-foreground">
						Headline counts unavailable eligible accounts as 100% used.
					</div>
					{activeAverage != null && (
						<div className="mt-1">
							Active accounts average: {activeAverage.toFixed(0)}%
						</div>
					)}
				</div>
				{hasContributing && (
					<div>
						<div className="font-medium mb-1">
							Contributing ({contributing.length})
						</div>
						<ul className="space-y-0.5">
							{sortedContributing.map((c) => (
								<li
									key={c.name}
									className="flex items-center justify-between gap-2"
								>
									<span className="truncate" title={c.name}>
										{c.name}
									</span>
									<span className="tabular-nums">{c.pct.toFixed(0)}%</span>
								</li>
							))}
						</ul>
					</div>
				)}
				{hasExhausted && (
					<div>
						<div className="font-medium mb-1">
							Unavailable ({exhausted.length})
						</div>
						<div className="space-y-2">
							{exhaustedGroups.map(({ reason, items }) => (
								<div key={reason}>
									<div className="text-muted-foreground">
										{REASON_LABELS[reason]} · counted as 100%
									</div>
									<ul className="ml-2 space-y-0.5">
										{items.map((e) => (
											<li key={e.name} className="truncate" title={e.name}>
												{e.name}
											</li>
										))}
									</ul>
								</div>
							))}
						</div>
					</div>
				)}
				{hasExcluded && (
					<div>
						<div className="font-medium mb-1">Unknown ({excluded.length})</div>
						<div className="space-y-2">
							{excludedGroups.map(({ reason, items }) => (
								<div key={reason}>
									<div className="text-muted-foreground">
										{REASON_LABELS[reason]} · not counted
									</div>
									<ul className="ml-2 space-y-0.5">
										{items.map((e) => (
											<li key={e.name} className="truncate" title={e.name}>
												{e.name}
											</li>
										))}
									</ul>
								</div>
							))}
						</div>
					</div>
				)}
				{hasFallback && (
					<div>
						<div className="font-medium mb-1">Fallback ({fallback.length})</div>
						<div className="text-muted-foreground mb-1">
							Pay-as-you-go capacity, not counted in this pool.
						</div>
						<ul className="space-y-0.5">
							{fallback.map((f) => (
								<li
									key={f.name}
									className="truncate"
									title={`${f.name} (${f.provider})`}
								>
									{f.name}{" "}
									<span className="text-muted-foreground">({f.provider})</span>
								</li>
							))}
						</ul>
					</div>
				)}
				{earliestResetMs != null && (
					<div>
						<div className="font-medium mb-1">More quota</div>
						<div>
							{nextQuotaLabel(
								earliestResetMs,
								earliestResetAccountName,
								window,
							)}
						</div>
					</div>
				)}
			</PopoverContent>
		</Popover>
	) : null;

	return (
		<Card>
			<CardContent className="p-6">
				<div className="flex items-center justify-between mb-4">
					<Icon className="h-8 w-8 text-muted-foreground/20" />
					{triggerNode}
				</div>
				<div className="space-y-1">
					<p className="text-sm text-muted-foreground">{title}</p>
					<p className={cn("text-2xl font-bold", colorClass)}>{headline}</p>
					<p className="text-xs text-muted-foreground truncate">
						capacity used
					</p>
					{nextQuotaText && (
						<p className="text-xs text-muted-foreground truncate">
							{nextQuotaText}
						</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
