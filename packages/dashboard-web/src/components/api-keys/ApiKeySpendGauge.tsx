import { registerUIRefresh } from "@better-ccflare/core";
import type { ApiKeyResponse } from "@better-ccflare/types";
import { formatCost } from "@better-ccflare/ui-common";
import { useEffect, useState } from "react";
import { formatRelativeReset } from "../../lib/pool-usage";
import { cn } from "../../lib/utils";
import { Progress } from "../ui/progress";
import {
	hasSpendLimit,
	spendFillClass,
	spendPercent,
	spendTextClass,
	spendWindowLabel,
} from "./spend-limit";

export interface ApiKeySpendGaugeProps {
	apiKey: ApiKeyResponse;
	className?: string;
}

/**
 * Spend-against-limit bar for one API key row.
 *
 * Renders NOTHING for a key with no limit. That is the common case and the
 * row must look exactly as it did before this feature for those keys —
 * showing an empty or "unlimited" gauge on every key would make the tab
 * unreadable for the operators this feature is not for.
 *
 * Built on ui/progress.tsx with an `indicatorClassName`, because there is no
 * gauge component in this repo and RateLimitProgress (the richest "percent
 * plus reset countdown" surface here) does the same thing. The thresholds and
 * the classes come from `spend-limit.ts`, which lifts them from
 * overview/PoolUsageRow.tsx so a bar means one thing across the dashboard.
 *
 * The percentage in the caption is UNCLAMPED while the bar is clamped: a
 * warn-only key is expected to go past 100%, and that is precisely the number
 * the operator needs to see. Pinning the caption at 100% would hide it.
 */
export function ApiKeySpendGauge({ apiKey, className }: ApiKeySpendGaugeProps) {
	// Re-render on the shared UI tick so the countdown stays honest without
	// each row owning a timer. Same hook RateLimitProgress uses.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const unregister = registerUIRefresh({
			id: "api-key-spend-gauge-update",
			callback: () => setNow(Date.now()),
			seconds: 30,
			description: "API key spend gauge UI update",
		});
		return unregister;
	}, []);

	if (!hasSpendLimit(apiKey)) return null;

	const limitUsd = apiKey.limitUsd;
	// `spentUsd` is attached by the list endpoint from the live counter. Absent
	// means the total could not be computed, which is NOT the same as zero:
	// reporting "$0.0000 of $50" for an unknown total would be a confident lie.
	const known = typeof apiKey.spentUsd === "number";
	const spentUsd = known ? (apiKey.spentUsd as number) : 0;
	const pct = spendPercent(spentUsd, limitUsd);
	const resetsAtMs = apiKey.windowResetsAt
		? new Date(apiKey.windowResetsAt).getTime()
		: null;
	const relative = formatRelativeReset(
		Number.isFinite(resetsAtMs ?? Number.NaN) ? resetsAtMs : null,
		now,
	);
	const windowText = spendWindowLabel(apiKey.limitWindow);
	const warnOnly = apiKey.limitEnforce === "warn";

	return (
		<div className={cn("max-w-md space-y-1", className)}>
			<div className="flex items-baseline justify-between gap-2 text-xs">
				<span className="text-muted-foreground">
					{known ? formatCost(spentUsd) : "—"} of {formatCost(limitUsd)}{" "}
					<span className="opacity-70">({windowText})</span>
				</span>
				{known ? (
					<span className={cn("font-medium tabular-nums", spendTextClass(pct))}>
						{pct.toFixed(0)}%
					</span>
				) : (
					<span className="text-muted-foreground">spend unavailable</span>
				)}
			</div>
			<Progress
				value={Math.min(100, Math.max(0, known ? pct : 0))}
				className="h-1.5"
				indicatorClassName={known ? spendFillClass(pct) : "bg-muted-foreground"}
				aria-label={`Spend against limit for ${apiKey.name}`}
			/>
			<div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
				<span>
					{/*
					 * The window's own wording, not a generic "resets": a rolling
					 * window never resets, it only sheds its oldest request, and
					 * saying "resets" would promise a clean slate that never comes.
					 */}
					{relative
						? apiKey.limitWindow === "calendar_month"
							? `Resets ${relative}`
							: `Oldest spend drops off ${relative}`
						: "No reset scheduled"}
				</span>
				{warnOnly ? (
					<span className="shrink-0 uppercase tracking-wide">warn only</span>
				) : null}
			</div>
		</div>
	);
}
