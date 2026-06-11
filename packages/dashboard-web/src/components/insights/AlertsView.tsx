import { Check, CheckCheck, TriangleAlert } from "lucide-react";
import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
	useAcknowledgeAlert,
	useAcknowledgeAllAlerts,
	useAlerts,
} from "../../hooks/queries";
import { useAlertStream } from "../../hooks/useAlertStream";
import { queryKeys } from "../../lib/query-keys";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";

export const AlertsView = React.memo(() => {
	const queryClient = useQueryClient();
	const { data, isLoading } = useAlerts();
	const ack = useAcknowledgeAlert();
	const ackAll = useAcknowledgeAllAlerts();

	// Connect SSE stream and invalidate alerts query on new events.
	useAlertStream({
		onAlert: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.insightsAlerts() });
		},
	});

	const alerts = data?.alerts ?? [];
	const unacknowledgedCount = data?.unacknowledgedCount ?? 0;

	if (isLoading) {
		return (
			<Card>
				<CardContent className="p-6">Loading alerts…</CardContent>
			</Card>
		);
	}

	function formatTimestamp(ts: number): string {
		return new Date(ts).toLocaleString();
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-lg font-medium">
					Unacknowledged: {unacknowledgedCount}
				</h3>
				<Button
					size="sm"
					variant="outline"
					disabled={unacknowledgedCount === 0 || ackAll.isPending}
					onClick={() => void ackAll.mutateAsync()}
				>
					<CheckCheck className="h-4 w-4 mr-1" />
					Acknowledge all
				</Button>
			</div>

			{alerts.length === 0 ? (
				<Card>
					<CardContent className="p-6 text-muted-foreground">
						No alerts yet.
					</CardContent>
				</Card>
			) : (
				<ul className="space-y-3">
					{alerts.map((alert) => (
						<li key={alert.id}>
							<Card>
								<CardHeader>
									<div className="flex items-start justify-between gap-3">
										<div className="space-y-1">
											<div className="flex items-center gap-2">
												<TriangleAlert className="h-4 w-4 text-amber-500" />
												<span className="font-medium">{alert.title}</span>
											</div>
											<p className="text-sm text-muted-foreground">
												{alert.message}
											</p>
										</div>
										<Badge
											variant={alert.acknowledged ? "outline" : "destructive"}
										>
											{alert.acknowledged ? "Acked" : "New"}
										</Badge>
									</div>
								</CardHeader>
								<CardContent className="pb-3 pt-0 flex items-center justify-between text-xs text-muted-foreground">
									<span>{formatTimestamp(alert.timestamp)}</span>
									<Button
										size="sm"
										variant="ghost"
										disabled={alert.acknowledged || ack.isPending}
										onClick={() => void ack.mutateAsync(alert.id)}
									>
										<Check className="h-4 w-4 mr-1" />
										Acknowledge
									</Button>
								</CardContent>
							</Card>
						</li>
					))}
				</ul>
			)}
		</div>
	);
});

AlertsView.displayName = "AlertsView";
