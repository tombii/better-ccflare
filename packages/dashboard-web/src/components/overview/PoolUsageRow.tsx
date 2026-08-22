import { formatPercentage } from "@better-ccflare/ui-common";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ComponentType } from "react";
import { Fragment } from "react";
import type { RoutingObservation } from "../../api";
import {
	buildPoolSegments,
	formatRelativeReset,
	type PoolCardWindow,
	type PoolUsageResult,
} from "../../lib/pool-usage";
import { cn } from "../../lib/utils";
import {
	atRiskBadge,
	headlineColor,
	nextQuotaTimeLabel,
	PoolUsagePopover,
	REASON_LABELS,
	routingOrderLabel,
	shouldShowNextBadge,
} from "./pool-usage-shared";

export interface PoolUsageRowProps {
	id: string;
	title: string;
	icon: ComponentType<{ className?: string }>;
	result: PoolUsageResult;
	window: PoolCardWindow;
	isExpanded: boolean;
	onToggle: () => void;
	// The name of the account the active load-balancing strategy would pick
	// for the NEXT request (AccountResponse.isPrimary from /api/accounts,
	// resolved once in OverviewTab -- see its comment for why this is never
	// recomputed here). May be absent from this pool's segments entirely (the
	// primary account can belong to a different family/window pool), in which
	// case the "next" badge simply never renders.
	primaryAccountName?: string | null;
	// Only meaningful when window === "weekly_scoped": the proxy's last
	// observed routing order for this pool's family, or null/undefined when
	// there's no recent observation. Renders as the "Routing order (observed
	// …)" line, which also REPLACES the "next" badge for this window (see
	// shouldShowNextBadge) -- the real recorded decision instead of an
	// isPrimary-derived guess.
	routingObservation?: RoutingObservation | null;
	// Current time (ms), refreshed periodically by the caller -- drives the
	// routing observation's age label and each segment's relative reset time.
	now: number;
}

// Same thresholds as headlineColor (pool-usage-shared.tsx), as a fill/bg
// class instead of a text class. Uses the SOLID variants (globals.css): the
// plain .bg-success / .bg-warning are pale badge tints and would read as
// weaker than the bg-muted track they are drawn on.
function fillClass(pct: number): string {
	if (pct < 60) return "bg-success-solid";
	if (pct < 80) return "bg-warning-solid";
	return "bg-destructive";
}

function segmentTitle(
	segment: ReturnType<typeof buildPoolSegments>[number],
	isPrimary: boolean,
): string {
	const pctText =
		segment.pct == null ? "unknown" : `${segment.pct.toFixed(0)}%`;
	const reasonText = segment.reason
		? ` (${REASON_LABELS[segment.reason]})`
		: "";
	const primaryText = isPrimary ? " — next request goes here" : "";
	return `${segment.name}: ${pctText}${reasonText}${primaryText}`;
}

/**
 * One row of the "Pool capacity" section: a headline % + bar, click-to-expand
 * into a per-account segmented bar. The whole row is click-to-expand via a
 * single real <button> stretched to cover it (Tailwind's "stretched button"
 * technique: `absolute inset-0`, visible content stacked on top with
 * `pointer-events-none` so clicks fall through to it) -- this keeps the
 * clickable button a REAL <button> element without nesting the info-chip's
 * own <button> (PoolUsagePopover) inside it, which would be invalid HTML.
 * The chip is lifted back out of the click-through layer with
 * `pointer-events-auto` and stops its own click from bubbling, so it never
 * triggers the row toggle while still opening its popover normally.
 */
export function PoolUsageRow({
	id,
	title,
	icon: Icon,
	result,
	window,
	isExpanded,
	onToggle,
	primaryAccountName,
	routingObservation,
	now,
}: PoolUsageRowProps) {
	const { average, contributing, exhausted, earliestResetMs } = result;

	const capacityCount = contributing.length + exhausted.length;
	const willRunOutCount = result.atRisk.length + exhausted.length;
	const { label: willRunOutText, colorClass: willRunOutColor } = atRiskBadge(
		willRunOutCount,
		capacityCount,
	);
	const colorClass = headlineColor(average);
	const headline = average != null ? formatPercentage(average, 0) : "—";
	const nextQuotaText =
		earliestResetMs == null
			? null
			: `more quota at ${nextQuotaTimeLabel(earliestResetMs, window)}`;

	const segments = buildPoolSegments(result);
	const panelId = `pool-usage-row-${id}-panel`;
	// A pool whose accounts are all provider-ineligible has nothing to reveal:
	// no toggle, no hover affordance, no dead click target.
	const canExpand = segments.length > 0;

	// Sequencing arrows only mean something between two accounts that both
	// have a burn-rate projection to compare -- a single projected account (or
	// none) has nothing to sequence against, so no arrows render at all (see
	// buildPoolSegments' group 2/3 split in pool-usage.ts for the ordering
	// this mirrors).
	const projectedSegmentCount = segments.filter(
		(s) => s.exhaustsAtMs != null,
	).length;
	const showOrderArrows = projectedSegmentCount >= 2;

	return (
		<div
			className={cn(
				"group relative border-t first:border-t-0 rounded-md px-2 py-4 transition-colors",
				canExpand && "hover:bg-muted/40",
			)}
		>
			{canExpand && (
				<button
					type="button"
					className="absolute inset-0 z-0 w-full h-full cursor-pointer rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					aria-expanded={isExpanded}
					aria-controls={panelId}
					onClick={onToggle}
				>
					<span className="sr-only">
						{isExpanded ? `Collapse ${title}` : `Expand ${title}`}
					</span>
				</button>
			)}

			<div className="relative z-10 flex flex-col gap-3 pointer-events-none md:flex-row md:flex-wrap md:items-center lg:flex-nowrap">
				{/* Label block: ~180px on md+ */}
				<div className="flex min-w-0 flex-col gap-1 md:w-[180px] md:shrink-0">
					<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Icon className="h-3.5 w-3.5 shrink-0" />
						<span className="truncate">{title}</span>
					</div>
					<div className="flex items-center gap-2">
						<span className={cn("text-2xl font-bold", colorClass)}>
							{headline}
						</span>
						<span className="pointer-events-auto">
							<PoolUsagePopover result={result} window={window} />
						</span>
					</div>
				</div>

				{/* Bar: flexible width */}
				<div className="h-3.5 min-w-[80px] flex-1 overflow-hidden rounded-full bg-muted">
					{average != null && (
						<div
							className={cn(
								"h-full rounded-full transition-[width]",
								fillClass(average),
							)}
							style={{ width: `${Math.min(100, Math.max(0, average))}%` }}
						/>
					)}
				</div>

				{/* Meta block: ~210px on lg+, wraps below the bar on md */}
				<div className="flex flex-col gap-1 text-left md:w-full lg:w-[210px] lg:shrink-0 lg:text-right">
					{willRunOutText && (
						<span className={cn("text-xs truncate", willRunOutColor)}>
							{willRunOutText}
						</span>
					)}
					{nextQuotaText && (
						<span className="text-xs text-muted-foreground truncate">
							{nextQuotaText}
						</span>
					)}
				</div>
			</div>

			{/*
			 * Call to action. The row-wide stretched button above handles the
			 * click; this is the VISIBLE affordance, so it carries a text label
			 * rather than a lone icon -- a bare chevron at the row edge reads as
			 * decoration and was missed entirely in review.
			 */}
			{canExpand && (
				<div className="pointer-events-none relative z-10 mt-2.5">
					<span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors group-hover:border-primary group-hover:text-primary">
						<ChevronDown
							className={cn(
								"h-3.5 w-3.5 transition-transform duration-200",
								isExpanded && "rotate-180",
							)}
						/>
						{isExpanded
							? "Hide accounts"
							: `Show ${segments.length} ${segments.length === 1 ? "account" : "accounts"}`}
					</span>
				</div>
			)}

			{isExpanded && (
				<div id={panelId} className="relative z-10 mt-4">
					{/*
					 * weekly_scoped-only: the proxy's own last-observed routing
					 * decision for this family (routingOrderLabel), NEVER mixed with
					 * the depletion-order caption below -- routing order and burn-rate
					 * depletion order are two different statements about two different
					 * things (see the caption's own comment).
					 */}
					{window === "weekly_scoped" && (
						<p className="mb-2 text-xs text-muted-foreground">
							{routingOrderLabel(routingObservation, now)}
						</p>
					)}
					{/*
					 * The caption is the load-bearing disclaimer: segment position
					 * reflects capacity DEPLETION order (a burn-rate projection), never
					 * ROUTING order -- which account serves the next request is a
					 * backend strategy decision, surfaced separately via the "next"
					 * badge below (driven by isPrimary, not by this ordering).
					 */}
					<p className="mb-2 text-xs text-muted-foreground">
						{showOrderArrows
							? "Runs out in this order"
							: "One segment per account"}
					</p>
					<div className="flex gap-1.5">
						{segments.map((segment, index) => {
							const isPrimarySegment =
								primaryAccountName != null &&
								segment.name === primaryAccountName;
							// Only the transition INTO a projected (exhaustsAtMs) segment
							// carries meaning: it never fires within the already-exhausted
							// group, before/within the no-projection "rest" group, or at
							// all when fewer than two segments have a projection (see
							// showOrderArrows above).
							const showArrowBefore =
								showOrderArrows && index > 0 && segment.exhaustsAtMs != null;
							return (
								<Fragment key={segment.name}>
									{showArrowBefore && (
										<div
											className="flex h-12 shrink-0 items-center self-start text-muted-foreground"
											aria-hidden="true"
										>
											<ChevronRight className="h-3.5 w-3.5" />
										</div>
									)}
									<div
										className="flex min-w-0 flex-1 flex-col items-center gap-1"
										title={segmentTitle(segment, isPrimarySegment)}
									>
										<div
											className={cn(
												"relative h-12 w-full overflow-hidden rounded bg-muted",
												segment.kind === "unknown" &&
													"border-2 border-dashed border-border bg-transparent",
											)}
										>
											{shouldShowNextBadge(
												window,
												segment.kind,
												isPrimarySegment,
											) && (
												<span className="absolute left-1 top-1 z-10 rounded-sm bg-background/80 px-1 text-[10px] font-medium leading-none text-primary">
													next
												</span>
											)}
											{segment.kind !== "unknown" && segment.pct != null && (
												<div
													className={cn(
														"absolute bottom-0 left-0 right-0 rounded-b",
														fillClass(segment.pct),
													)}
													style={{
														height: `${Math.min(100, Math.max(0, segment.pct))}%`,
													}}
												/>
											)}
										</div>
										<span className="w-full truncate text-center text-[10px] text-muted-foreground">
											{segment.name}
										</span>
										<span className="text-[10px] tabular-nums text-muted-foreground">
											{segment.pct == null ? "—" : `${segment.pct.toFixed(0)}%`}
										</span>
										{(() => {
											const relativeReset = formatRelativeReset(
												segment.resetMs,
												now,
											);
											return (
												relativeReset != null && (
													<span className="text-[10px] tabular-nums text-muted-foreground">
														{relativeReset}
													</span>
												)
											);
										})()}
									</div>
								</Fragment>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
