import {
	useSetUsageThrottling,
	useUsageThrottling,
} from "../../hooks/queries";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Switch } from "../ui/switch";

export function UsageThrottlingCard() {
	const { data, isLoading } = useUsageThrottling();
	const setUsageThrottling = useSetUsageThrottling();

	const fiveHourEnabled = data?.fiveHourEnabled ?? false;
	const weeklyEnabled = data?.weeklyEnabled ?? false;

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Usage Throttling</CardTitle>
				<CardDescription>
					Control short-window and weekly pacing separately. When a selected
					window is ahead of its pacing line, the proxy returns an error
					instructing the client to retry in 60 seconds instead of sending
					another upstream request.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-4">
					<div className="flex items-center justify-between gap-3">
						<div className="space-y-1">
							<div className="text-sm font-medium">5-hour window</div>
							<div className="text-sm text-muted-foreground">
								Throttle requests when 5-hour usage is ahead of its pacing line.
							</div>
						</div>
						<Switch
							disabled={isLoading || setUsageThrottling.isPending}
							checked={fiveHourEnabled}
							onCheckedChange={(checked) =>
								setUsageThrottling.mutate({
									fiveHourEnabled: checked,
									weeklyEnabled,
								})
							}
						/>
					</div>
					<div className="flex items-center justify-between gap-3">
						<div className="space-y-1">
							<div className="text-sm font-medium">Weekly window</div>
							<div className="text-sm text-muted-foreground">
								Throttle requests when weekly usage is ahead of its pacing line.
								Disable this if you expect usage to recover overnight.
							</div>
						</div>
						<Switch
							disabled={isLoading || setUsageThrottling.isPending}
							checked={weeklyEnabled}
							onCheckedChange={(checked) =>
								setUsageThrottling.mutate({
									fiveHourEnabled,
									weeklyEnabled: checked,
								})
							}
						/>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
