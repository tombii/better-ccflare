import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type Stats } from "../api";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";

export function StatsTab() {
	const [stats, setStats] = useState<Stats | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const loadStats = useCallback(async () => {
		try {
			const data = await api.getStats();
			setStats(data);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load stats");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadStats();
		const interval = setInterval(loadStats, 10000);
		return () => clearInterval(interval);
	}, [loadStats]);

	const handleResetStats = async () => {
		if (!confirm("Are you sure you want to reset all statistics?")) return;

		try {
			await api.resetStats();
			await loadStats();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to reset stats");
		}
	};

	if (loading) {
		return (
			<Card>
				<CardContent className="pt-6">
					<p className="text-muted-foreground">Loading statistics...</p>
				</CardContent>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<CardContent className="pt-6">
					<p className="text-destructive">Error: {error}</p>
					<Button
						onClick={loadStats}
						variant="outline"
						size="sm"
						className="mt-2"
					>
						<RefreshCw className="mr-2 h-4 w-4" />
						Retry
					</Button>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-4">
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle>Account Performance</CardTitle>
						<Button onClick={loadStats} variant="ghost" size="sm">
							<RefreshCw className="h-4 w-4" />
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					{stats?.accounts && stats.accounts.length > 0 ? (
						<div className="space-y-4">
							{stats.accounts.map(
								(account: {
									name: string;
									requestCount: number;
									successRate: number;
								}) => (
									<div key={account.name} className="space-y-2">
										<div className="flex items-center justify-between">
											<span className="font-medium">{account.name}</span>
											<span className="text-sm text-muted-foreground">
												{account.requestCount} requests
											</span>
										</div>
										<div className="w-full bg-secondary rounded-full h-2">
											<div
												className="bg-primary h-2 rounded-full transition-all"
												style={{ width: `${account.successRate}%` }}
											/>
										</div>
										<div className="flex items-center justify-between text-sm">
											<span className="text-muted-foreground">
												Success rate
											</span>
											<span
												className={
													account.successRate >= 95
														? "text-green-600"
														: account.successRate >= 80
															? "text-yellow-600"
															: "text-red-600"
												}
											>
												{account.successRate}%
											</span>
										</div>
									</div>
								),
							)}
						</div>
					) : (
						<p className="text-muted-foreground">No account data available</p>
					)}
				</CardContent>
			</Card>

			{stats?.recentErrors && stats.recentErrors.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>Recent Errors</CardTitle>
						<CardDescription>Last 10 errors from all accounts</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="space-y-2">
							{stats.recentErrors.map((error: string, i: number) => (
								<div
									key={`error-${i}-${error.substring(0, 10)}`}
									className="text-sm p-2 bg-destructive/10 rounded-md"
								>
									<p className="text-destructive">{error}</p>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<CardTitle>Actions</CardTitle>
				</CardHeader>
				<CardContent>
					<Button onClick={handleResetStats} variant="destructive">
						Reset All Statistics
					</Button>
				</CardContent>
			</Card>
		</div>
	);
}
