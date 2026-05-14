import { CheckCircle } from "lucide-react";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { RecentErrorsCard } from "./system-status/RecentErrorsCard";

export function SystemStatus() {
	return (
		<Card>
			<CardHeader>
				<CardTitle>System Status</CardTitle>
				<CardDescription>
					Current operational status and recent events
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-4">
					<div className="flex items-center justify-between p-4 rounded-lg bg-success/10">
						<div className="flex items-center gap-3">
							<CheckCircle className="h-5 w-5 text-success" />
							<div>
								<p className="font-medium">All Systems Operational</p>
								<p className="text-sm text-muted-foreground">
									No issues detected
								</p>
							</div>
						</div>
						<Badge variant="default" className="bg-success">
							Healthy
						</Badge>
					</div>

					<RecentErrorsCard />
				</div>
			</CardContent>
		</Card>
	);
}
