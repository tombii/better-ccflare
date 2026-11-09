import type { ComboFlowRecentRequest } from "../../api";
import { Badge } from "../ui/badge";
import { formatMs, formatTimeOfDay } from "./format";

export interface RecentRequestsProps {
	/**
	 * Newest combo-tagged rows, already merged newest first: seeded
	 * server-side by GET /api/combos/flow and updated live from the shared
	 * request stream (see mergeRecentRequests).
	 */
	requests: ComboFlowRecentRequest[];
	/** Cap on rows shown (default 15). */
	limit?: number;
}

/**
 * "requested → served" for one request row.
 *
 * `originalModel`/`appliedModel` are written only for AGENT-preference
 * rewrites, so a combo that pins a slot's model leaves them null. The served
 * model (what the upstream response reported) is then the only evidence of
 * the pin, and is also the ground truth when both an agent rewrite AND a slot
 * pin happened — which is why it wins over `appliedModel` whenever present.
 */
function modelLabel(row: ComboFlowRecentRequest): string {
	const requested = row.originalModel ?? "—";
	const served = row.servedModel ?? row.appliedModel;
	if (served && served !== row.originalModel) {
		return `${requested} → ${served}`;
	}
	return row.originalModel ?? served ?? "—";
}

/**
 * The most recent requests that carry this combo's `combo_name` tag. Only
 * requests routed THROUGH the combo are tagged, so an empty list means the
 * combo hasn't served anything recently — not that the filter is broken.
 *
 * Rows are the newest through THIS combo (a bounded server-side query), not a
 * sample of global traffic, and they keep updating from the live request
 * stream while the page is open.
 */
export function RecentRequests({ requests, limit = 15 }: RecentRequestsProps) {
	const rows = requests.slice(0, limit);
	return (
		<div className="space-y-2">
			<p className="text-xs text-muted-foreground">
				Only requests routed through this combo carry its tag. This list is the
				newest requests through this combo (seeded by the flow endpoint, then
				kept live by the request stream) — not a sample of global traffic.
			</p>
			{rows.length === 0 ? (
				<p className="text-xs text-muted-foreground">
					No recent requests through this combo.
				</p>
			) : (
				<table className="w-full text-xs">
					<thead>
						<tr className="text-left text-muted-foreground">
							<th className="py-1 font-medium">Time</th>
							<th className="py-1 font-medium">Model (requested → served)</th>
							<th className="py-1 font-medium">Account</th>
							<th className="py-1 font-medium">Status</th>
							<th className="py-1 text-right font-medium">Failovers</th>
							<th className="py-1 text-right font-medium">Response</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={r.id} className="border-t">
								<td className="py-1 whitespace-nowrap">
									{formatTimeOfDay(r.timestamp)}
								</td>
								<td className="py-1">{modelLabel(r)}</td>
								<td className="py-1">{r.account ?? "—"}</td>
								<td className="py-1">
									<Badge
										variant={r.success ? "success" : "destructive"}
										className="px-1.5 py-0 text-[10px]"
									>
										{r.statusCode ?? "—"}
									</Badge>
								</td>
								<td className="py-1 text-right">{r.failoverAttempts}</td>
								<td className="py-1 text-right">
									{formatMs(r.responseTimeMs)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
