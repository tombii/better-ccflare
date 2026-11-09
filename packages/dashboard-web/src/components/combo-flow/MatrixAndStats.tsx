import type { ComboFlowCombo } from "../../api";
import { Badge } from "../ui/badge";
import { Separator } from "../ui/separator";
import { formatMs, formatRate, slotModelLabel } from "./format";

export interface MatrixAndStatsProps {
	combo: ComboFlowCombo;
}

function StatTile({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded border p-2">
			<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
				{label}
			</div>
			<div className="text-sm font-semibold">{value}</div>
		</div>
	);
}

function dash(value: string | null): string {
	return value === null || value === "" ? "—" : value;
}

/**
 * "Matrix & stats" view for one combo: the observed resolution matrix
 * (original model → applied model → account, with counts and success), the
 * slot definition rows, 24h stat tiles and the top errors. Pure props.
 */
export function MatrixAndStats({ combo }: MatrixAndStatsProps) {
	const { stats } = combo;
	// Error rows carry only the account id; resolve it to a slot's name so the
	// badge names the account that actually failed.
	const slotNames = new Map(
		combo.slots.map((slot) => [
			slot.accountId,
			slot.accountName ?? slot.accountId,
		]),
	);
	return (
		<div className="space-y-3">
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				<StatTile label="24h requests" value={String(stats.requests)} />
				<StatTile label="Success" value={formatRate(stats.successRate)} />
				<StatTile
					label="Failover reqs"
					value={String(stats.failoverRequests)}
				/>
				<StatTile label="Avg response" value={formatMs(stats.avgResponseMs)} />
			</div>

			<div>
				<h4 className="mb-1 text-xs text-muted-foreground">
					Observed resolution matrix (24h) — served model is what the upstream
					actually returned, so it shows the slot pin a combo applied. “—” means
					unchanged from the client’s request.
				</h4>
				{stats.pairings.length === 0 ? (
					<p className="text-xs text-muted-foreground">
						No combo-tagged requests in the last 24h.
					</p>
				) : (
					<table className="w-full text-xs">
						<thead>
							<tr className="text-left text-muted-foreground">
								<th className="py-1 font-medium">Client model</th>
								<th className="py-1 font-medium">Served model</th>
								<th className="py-1 font-medium">Account</th>
								<th className="py-1 text-right font-medium">Count</th>
								<th className="py-1 text-right font-medium">Success</th>
							</tr>
						</thead>
						<tbody>
							{stats.pairings.map((p) => (
								<tr
									key={`${p.originalModel}|${p.appliedModel}|${p.servedModel}|${p.account}`}
									className="border-t"
								>
									<td className="py-1">
										{dash(p.originalModel ?? p.appliedModel)}
									</td>
									<td className="py-1">
										{dash(p.servedModel ?? p.appliedModel)}
									</td>
									<td className="py-1">{dash(p.account)}</td>
									<td className="py-1 text-right">{p.count}</td>
									<td className="py-1 text-right">
										{formatRate(p.successRate)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>

			<Separator />

			<div>
				<h4 className="mb-1 text-xs text-muted-foreground">
					Slot definition (priority order)
				</h4>
				<table className="w-full text-xs">
					<thead>
						<tr className="text-left text-muted-foreground">
							<th className="py-1 font-medium">#</th>
							<th className="py-1 font-medium">Account</th>
							<th className="py-1 font-medium">Slot model</th>
							<th className="py-1 font-medium">Provider</th>
							<th className="py-1 text-right font-medium">State</th>
						</tr>
					</thead>
					<tbody>
						{combo.slots.map((slot, index) => (
							<tr key={slot.id} className="border-t">
								<td className="py-1">{index + 1}</td>
								<td className="py-1">{slot.accountName ?? slot.accountId}</td>
								<td className="py-1">{slotModelLabel(slot.model)}</td>
								<td className="py-1">{dash(slot.provider)}</td>
								<td className="py-1 text-right">
									{slot.enabled
										? slot.available
											? "ok"
											: "unavailable"
										: "disabled"}
								</td>
							</tr>
						))}
						{combo.slots.length === 0 && (
							<tr>
								<td colSpan={5} className="py-1 text-muted-foreground">
									No slots.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

			{stats.errorTop.length > 0 && (
				<div>
					<h4 className="mb-1 text-xs text-muted-foreground">
						Top errors (24h)
					</h4>
					<div className="flex flex-wrap gap-1">
						{stats.errorTop.map((e) => (
							<Badge
								key={`${e.status}|${e.error}|${e.accountId}`}
								variant="destructive"
								className="px-1.5 py-0 text-[10px] font-normal"
								title={e.error ?? undefined}
							>
								{dash(e.status === null ? null : String(e.status))} × {e.count}
								{e.accountId
									? ` · ${slotNames.get(e.accountId) ?? e.accountId}`
									: ""}
								{e.error ? ` · ${e.error.slice(0, 60)}` : ""}
							</Badge>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
