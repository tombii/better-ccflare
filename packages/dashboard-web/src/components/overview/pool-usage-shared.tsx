import { Info } from "lucide-react";
import type {
	ExcludedReason,
	PoolCardWindow,
	PoolUsageResult,
} from "../../lib/pool-usage";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export const REASON_LABELS: Record<ExcludedReason, string> = {
	paused: "Paused",
	rate_limited: "Rate-limited",
	token_expired: "OAuth token expired",
	usage_rate_limited: "Usage data unavailable (provider 429)",
	five_hour_exhausted: "5h quota exhausted",
	seven_day_exhausted: "7d quota exhausted",
	family_exhausted: "Model quota exhausted",
	no_usage_data: "No usage data yet",
};

export const REASON_ORDER: ExcludedReason[] = [
	"paused",
	"rate_limited",
	"token_expired",
	"usage_rate_limited",
	"five_hour_exhausted",
	"seven_day_exhausted",
	"family_exhausted",
	"no_usage_data",
];

export function headlineColor(average: number | null): string | undefined {
	if (average == null) return undefined;
	if (average < 60) return "text-success";
	if (average < 80) return "text-warning";
	return "text-destructive";
}

export function groupExcluded(
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

export function nextQuotaTimeLabel(
	earliestResetMs: number,
	window: PoolCardWindow,
): string {
	const date = new Date(earliestResetMs);
	// seven_day and weekly_scoped (per-model-family) pools both reset on a
	// multi-day cadence, so both get the long month/day/time format; only
	// five_hour gets the short time-only format.
	return window !== "five_hour"
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

export function nextQuotaLabel(
	earliestResetMs: number,
	accountName: string | null,
	window: PoolCardWindow,
): string {
	const name = accountName ?? "unknown";
	return `${name} at ${nextQuotaTimeLabel(earliestResetMs, window)}`;
}

export function formatShortDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.round(ms / 60000));
	// Sub-30s-rounding-to-a-minute durations (< 30_000ms, since
	// Math.round(ms / 60000) first hits 1 at ms === 30_000) get a seconds
	// granularity instead of collapsing to "0m" -- used by the routing
	// observation's age label ("observed 12s ago"). Everything from 30s
	// upward keeps the exact prior minutes/hours formatting unchanged.
	if (totalMinutes === 0) {
		const totalSeconds = Math.max(0, Math.round(ms / 1000));
		return `${totalSeconds}s`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/**
 * Whether a segment's "next" badge should render. Two independent
 * suppressions, both load-bearing:
 *  - weekly_scoped rows never show it -- primaryAccountName reflects the
 *    NEXT request overall, which may target a different family than this
 *    pool's; the account-wide isPrimary flag is not a reliable guess for a
 *    single family's routing order (see ObservedRoutingTable for the real
 *    recorded per-family decision instead).
 *  - an exhausted segment never shows it, in ANY window -- an account with
 *    no capacity left can't credibly claim to serve the next request.
 */
export function shouldShowNextBadge(
	window: PoolCardWindow,
	segmentKind: "active" | "exhausted" | "unknown",
	isPrimarySegment: boolean,
): boolean {
	if (!isPrimarySegment) return false;
	if (window === "weekly_scoped") return false;
	if (segmentKind === "exhausted") return false;
	return true;
}

export function atRiskBadge(
	willRunOutCount: number,
	capacityCount: number,
): { label: string | null; colorClass: string | null } {
	if (willRunOutCount === 0 || capacityCount === 0) {
		return { label: null, colorClass: null };
	}
	const colorClass =
		willRunOutCount >= capacityCount ? "text-destructive" : "text-warning";
	return {
		label: `${willRunOutCount} of ${capacityCount} will run out`,
		colorClass,
	};
}

interface PoolUsagePopoverProps {
	result: PoolUsageResult;
	window: PoolCardWindow;
}

/**
 * The "(N/M active)" info chip + its popover breakdown (contributing / at
 * risk / unavailable / unknown / fallback / more-quota). Shared, unchanged
 * behavior between the old PoolMetricCard and PoolUsageRow -- see the task
 * that introduced this extraction for the rationale.
 *
 * The trigger button stops click propagation so it can sit inside a row
 * that is itself click-to-expand (PoolUsageRow) without also toggling that
 * row; it still opens its own popover normally (stopPropagation only blocks
 * bubbling to an ancestor's handler, not Radix's own click handling on this
 * element).
 */
export function PoolUsagePopover({ result, window }: PoolUsagePopoverProps) {
	const {
		activeAverage,
		contributing,
		exhausted,
		excluded,
		fallback,
		earliestResetMs,
		earliestResetAccountName,
		atRisk,
	} = result;

	const eligibleTotal =
		contributing.length + exhausted.length + excluded.length;
	const showChip = eligibleTotal > 0;

	const sortedContributing = contributing.slice().sort((a, b) => b.pct - a.pct);
	const sortedAtRisk = atRisk
		.slice()
		.sort((a, b) => a.exhaustsAtMs - b.exhaustsAtMs);
	const exhaustedGroups = groupExcluded(exhausted);
	const excludedGroups = groupExcluded(excluded);

	const hasContributing = contributing.length > 0;
	const hasExhausted = exhausted.length > 0;
	const hasExcluded = excluded.length > 0;
	const hasFallback = fallback.length > 0;
	const hasAtRisk = atRisk.length > 0;

	if (!showChip) return null;

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="flex items-center gap-1 text-xs text-muted-foreground cursor-help focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
					onClick={(e) => e.stopPropagation()}
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
				{hasAtRisk && (
					<div>
						<div className="font-medium mb-1">At risk ({atRisk.length})</div>
						<div className="text-muted-foreground mb-1">
							Projected to exhaust before their window resets.
						</div>
						<ul className="space-y-0.5">
							{sortedAtRisk.map((a) => (
								<li
									key={a.name}
									className="flex items-center justify-between gap-2"
								>
									<span className="truncate" title={a.name}>
										{a.name}
									</span>
									<span className="tabular-nums">
										runs out in {formatShortDuration(a.timeToExhaustMs)}
									</span>
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
	);
}
