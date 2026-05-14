import { useDashboardAuth, useSetDashboardAuth } from "../../hooks/queries";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Switch } from "../ui/switch";

export function DashboardAuthCard() {
	const { data, isLoading } = useDashboardAuth();
	const setDashboardAuth = useSetDashboardAuth();

	const enabled = data?.enabled ?? true;

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Dashboard API Authentication</CardTitle>
				<CardDescription>
					When enabled, the dashboard API requires a valid API key. When
					disabled, all <code>/api/*</code> routes are accessible without
					authentication. Proxy routes (<code>/v1/*</code>) and debug routes
					always require authentication regardless of this setting.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-3">
					<div className="flex items-center gap-3">
						<Switch
							disabled={isLoading || setDashboardAuth.isPending}
							checked={enabled}
							onCheckedChange={(checked) => setDashboardAuth.mutate(checked)}
						/>
						<span className="text-sm text-muted-foreground">
							{enabled ? "Authentication enabled" : "Authentication disabled"}
						</span>
					</div>
					{!enabled && (
						<div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 20 20"
								fill="currentColor"
								className="h-4 w-4 text-amber-500 mt-0.5 shrink-0"
								role="img"
								aria-labelledby="dashboard-auth-warning-title"
							>
								<title id="dashboard-auth-warning-title">Warning</title>
								<path
									fillRule="evenodd"
									d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
									clipRule="evenodd"
								/>
							</svg>
							<p className="text-xs text-amber-600 dark:text-amber-400">
								Dashboard API authentication is disabled. Anyone with network
								access to this server can read and modify configuration. Use
								only on trusted networks.
							</p>
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
