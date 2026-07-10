import { useState } from "react";
import type { TimeRange } from "../../constants";
import { useAccounts, useUsageHistory } from "../../hooks/queries";
import { Card } from "../ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { formatPredictionAnnotation } from "./chart-data";
import {
	pickDefaultAccount,
	rangeToMs,
	sortAccountsActiveFirst,
	usageEmptyStateMessage,
} from "./tab-helpers";
import { UsageHistoryChart } from "./UsageHistoryChart";

// Match the ranges the endpoint accepts (getRangeConfig: 1h/6h/24h/7d/30d).
const RANGES: TimeRange[] = ["1h", "6h", "24h", "7d", "30d"];

export function UsageHistoryTab() {
	const { data: accounts } = useAccounts();
	const [accountId, setAccountId] = useState<string>("");
	const [range, setRange] = useState<string>("24h");

	const selected = accountId || pickDefaultAccount(accounts) || "";
	const selectedAccount = accounts?.find((a) => a.id === selected);
	const { data, isLoading } = useUsageHistory(selected, range);
	const windows = data?.windows ?? [];
	// Bucket "now" to 1-minute granularity (matching the chart's nowBucket) so the
	// per-window annotations use a single, stable reference rather than a fresh
	// Date.now() per window per render — avoids sub-minute ETA display drift.
	const nowBucket = Math.floor(Date.now() / 60_000) * 60_000;

	return (
		<div className="space-y-4">
			<div className="flex gap-3">
				<Select value={selected} onValueChange={setAccountId}>
					<SelectTrigger className="w-64">
						<SelectValue placeholder="Select account" />
					</SelectTrigger>
					<SelectContent>
						{sortAccountsActiveFirst(accounts ?? []).map((a) => (
							<SelectItem key={a.id} value={a.id}>
								{a.name}
								{a.paused ? " (paused)" : ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select value={range} onValueChange={setRange}>
					<SelectTrigger className="w-28">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{RANGES.map((r) => (
							<SelectItem key={r} value={r}>
								{r}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<Card className="p-4">
				<UsageHistoryChart
					windows={windows}
					rangeMs={rangeToMs(range)}
					loading={isLoading}
					emptyState={usageEmptyStateMessage(selectedAccount)}
				/>
			</Card>

			{windows.length > 0 && (
				<Card className="p-4 space-y-1 text-sm">
					{windows.map((w) => (
						<div key={w.window}>{formatPredictionAnnotation(w, nowBucket)}</div>
					))}
				</Card>
			)}
		</div>
	);
}
