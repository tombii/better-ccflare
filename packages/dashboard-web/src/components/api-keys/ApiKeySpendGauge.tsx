import { registerUIRefresh } from "@better-ccflare/core";
import type { ApiKeyLimitStatus, ApiKeyResponse } from "@better-ccflare/types";
import { formatCost } from "@better-ccflare/ui-common";
import { useEffect, useState } from "react";
import { useCostTracking } from "../../hooks/useCostTracking";
import { formatRelativeReset } from "../../lib/pool-usage";
import { cn } from "../../lib/utils";
import { CostTrackingNotice } from "../CostTrackingNotice";
import { Progress } from "../ui/progress";
import { spendFillClass, spendPercent, spendTextClass } from "./spend-limit";

export interface ApiKeySpendGaugeProps {
	apiKey: Pick<ApiKeyResponse, "id" | "name" | "limits" | "limitWindowMode">;
	className?: string;
}

export function ApiKeySpendGauge({ apiKey, className }: ApiKeySpendGaugeProps) {
	const { enabled } = useCostTracking();
	const [now, setNow] = useState(() => Date.now());
	useEffect(
		() =>
			registerUIRefresh({
				id: `api-key-spend-gauge-${apiKey.id}`,
				callback: () => setNow(Date.now()),
				seconds: 30,
				description: "API key spend gauge UI update",
			}),
		[apiKey.id],
	);
	if (!apiKey.limits?.length) return null;
	if (!enabled) return <CostTrackingNotice limits />;
	return (
		<div className={cn("space-y-3", className)}>
			{apiKey.limits.map((limit) => (
				<LimitGauge
					key={limit.id}
					limit={limit}
					name={apiKey.name}
					calendar={apiKey.limitWindowMode !== "rolling"}
					now={now}
				/>
			))}
		</div>
	);
}

function LimitGauge({
	limit,
	name,
	calendar,
	now,
}: {
	limit: ApiKeyLimitStatus;
	name: string;
	calendar: boolean;
	now: number;
}) {
	const known = typeof limit.spentUsd === "number";
	const spentUsd = limit.spentUsd ?? 0;
	const pct = spendPercent(spentUsd, limit.limitUsd);
	const resetsAtMs = limit.resetsAt ? new Date(limit.resetsAt).getTime() : null;
	const relative = formatRelativeReset(resetsAtMs, now);
	const scope = limit.scopeModel ?? "Whole key";
	return (
		<div className="space-y-1">
			<div className="flex flex-wrap justify-between gap-2 text-xs">
				<span>
					{scope} · {calendar ? "calendar" : "rolling"} {limit.window} ·{" "}
					{limit.enforce === "warn" ? "warn only" : "block"}
				</span>
				<span className={cn("tabular-nums", spendTextClass(pct))}>
					{known ? formatCost(spentUsd) : "—"} / {formatCost(limit.limitUsd)}{" "}
					{known ? `(${pct.toFixed(0)}%)` : "(unavailable)"}
				</span>
			</div>
			<Progress
				value={Math.min(100, Math.max(0, pct))}
				className="h-1.5"
				indicatorClassName={known ? spendFillClass(pct) : "bg-muted-foreground"}
				aria-label={`API spend against ${scope} ${limit.window} limit for ${name}`}
			/>
			<p className="text-[11px] text-muted-foreground">
				{relative
					? `${calendar ? "Resets" : "Spend drops"} ${relative}`
					: "No reset scheduled"}
				{limit.resetsAt
					? ` · ${new Date(limit.resetsAt).toLocaleString("en-IE", { timeZone: "Europe/Dublin", timeZoneName: "short" })}`
					: ""}
			</p>
		</div>
	);
}
