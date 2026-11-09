import type { RequestPayload, RequestSummary } from "../../api";
import { summaryToPlaceholder } from "../../hooks/queries";
import { Badge } from "../ui/badge";
import { formatMs, formatTimeOfDay } from "./format";

export interface RecentRequestsProps {
	/** Rows from `GET /api/requests` (already sorted newest first). */
	requests: RequestSummary[];
	/** Cap on rows shown (default 15). */
	limit?: number;
}

interface Row {
	id: string;
	at: number;
	originalModel?: string;
	appliedModel?: string;
	/** Model the upstream reported — includes a combo slot's model pin. */
	servedModel?: string;
	account: string | null;
	status: number | null;
	success: boolean;
	failoverAttempts: number;
	responseTimeMs: number | null;
}

function toRow(summary: RequestSummary): Row {
	const placeholder: RequestPayload = summaryToPlaceholder(summary);
	return {
		id: summary.id,
		at: placeholder.meta.timestamp,
		originalModel: summary.originalModel,
		appliedModel: summary.appliedModel,
		servedModel: summary.model,
		account: summary.accountUsed,
		status: summary.statusCode,
		success: summary.success,
		failoverAttempts: summary.failoverAttempts,
		responseTimeMs: summary.responseTimeMs,
	};
}

/**
 * "requested → served" for one request row.
 *
 * `originalModel`/`appliedModel` are written only for AGENT-preference
 * rewrites, so a combo that pins a slot's model leaves them null. The served
 * model (what the upstream response reported) is then the only evidence of
 * the pin, and without it a combo-routed row would render as a bare "—".
 */
function modelLabel(row: Row): string {
	const requested = row.originalModel ?? "—";
	if (row.appliedModel && row.appliedModel !== row.originalModel) {
		return `${requested} → ${row.appliedModel}`;
	}
	if (row.servedModel && row.servedModel !== row.originalModel) {
		return `${requested} → ${row.servedModel}`;
	}
	return row.originalModel ?? row.servedModel ?? "—";
}

/**
 * The most recent requests that carry this combo's `combo_name` tag. Only
 * requests routed THROUGH the combo are tagged, so an empty list means the
 * combo hasn't served anything recently — not that the filter is broken.
 */
export function RecentRequests({ requests, limit = 15 }: RecentRequestsProps) {
	// RequestPayload loses the model/account fields this table needs, so the
	// summary rows are converted back where only the meta shape is read.
	const rows = requests.slice(0, limit).map(toRow);
	return (
		<div className="space-y-2">
			<p className="text-xs text-muted-foreground">
				Only requests routed through this combo carry its tag.
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
									{formatTimeOfDay(r.at)}
								</td>
								<td className="py-1">{modelLabel(r)}</td>
								<td className="py-1">{r.account ?? "—"}</td>
								<td className="py-1">
									<Badge
										variant={r.success ? "success" : "destructive"}
										className="px-1.5 py-0 text-[10px]"
									>
										{r.status ?? "—"}
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
