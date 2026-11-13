import {
	useCostTracking,
	useSetCostTracking,
} from "../../hooks/useCostTracking";
import { CostTrackingNotice } from "../CostTrackingNotice";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Switch } from "../ui/switch";

export function CostTrackingCard() {
	const { enabled, isLoading, error } = useCostTracking();
	const update = useSetCostTracking();
	return (
		<Card>
			<CardHeader>
				<CardTitle>Cost tracking</CardTitle>
				<CardDescription>
					Record request costs using the gateway's model prices. Enabled by
					default.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="flex items-center justify-between gap-3">
					<label htmlFor="cost-tracking">Cost tracking</label>
					<Switch
						id="cost-tracking"
						checked={enabled}
						disabled={isLoading || update.isPending || !!error}
						onCheckedChange={(value) => update.mutate(value)}
					/>
				</div>
				<p className="text-sm text-muted-foreground">
					When disabled, new requests keep their token usage but record no cost
					(NULL). Spend limits cannot block requests. Tracking resumes when
					enabled; the gap is not backfilled.
				</p>
				<CostTrackingNotice limits />
				{(error || update.error) && (
					<p role="alert" className="text-sm text-destructive">
						Could not {update.error ? "save" : "load"} cost tracking settings.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
