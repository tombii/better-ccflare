import { useCallback, useEffect, useState } from "react";
import { api, type Stats } from "./api";
import { AccountsTab } from "./components/AccountsTab";
import { LogsTab } from "./components/LogsTab";
import { RequestsTab } from "./components/RequestsTab";
import { StatsTab } from "./components/StatsTab";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import "./index.css";

export function App() {
	const [activeTab, setActiveTab] = useState("stats");
	const [stats, setStats] = useState<Stats | null>(null);
	const [error, setError] = useState<string | null>(null);

	const loadStats = useCallback(async () => {
		try {
			const data = await api.getStats();
			setStats(data);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load stats");
		}
	}, []);

	useEffect(() => {
		loadStats();
		const interval = setInterval(loadStats, 5000);
		return () => clearInterval(interval);
	}, [loadStats]);

	return (
		<div className="min-h-screen bg-background">
			<header className="relative bg-gradient-to-r from-orange-500 to-orange-600 dark:from-orange-600 dark:to-orange-700 text-white shadow-lg">
				<div className="absolute inset-0 bg-black/10 dark:bg-black/20"></div>
				<div className="relative container mx-auto px-4 py-6">
					<div className="flex items-center gap-3">
						<div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center backdrop-blur-sm">
							<span className="text-2xl">⚡</span>
						</div>
						<div>
							<h1 className="text-3xl font-bold tracking-tight">Claudeflare</h1>
							<p className="text-white/90 text-sm">
								High-performance load balancer for Claude API
							</p>
						</div>
					</div>
				</div>
			</header>

			<main className="container mx-auto px-4 py-8">
				{error && (
					<Card className="mb-6 border-destructive">
						<CardContent className="pt-6">
							<p className="text-destructive">Error: {error}</p>
							<Button
								onClick={loadStats}
								variant="outline"
								size="sm"
								className="mt-2"
							>
								Retry
							</Button>
						</CardContent>
					</Card>
				)}

				{stats && (
					<>
						<div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6 mb-6">
							<Card>
								<CardHeader className="pb-2">
									<CardTitle className="text-sm font-medium text-muted-foreground">
										Total Requests
									</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="text-2xl font-bold">
										{stats.totalRequests || 0}
									</p>
								</CardContent>
							</Card>

							<Card>
								<CardHeader className="pb-2">
									<CardTitle className="text-sm font-medium text-muted-foreground">
										Success Rate
									</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="text-2xl font-bold text-green-600 dark:text-green-400">
										{stats.successRate || 0}%
									</p>
								</CardContent>
							</Card>

							<Card>
								<CardHeader className="pb-2">
									<CardTitle className="text-sm font-medium text-muted-foreground">
										Active Accounts
									</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="text-2xl font-bold">
										{stats.activeAccounts || 0}
									</p>
								</CardContent>
							</Card>

							<Card>
								<CardHeader className="pb-2">
									<CardTitle className="text-sm font-medium text-muted-foreground">
										Total Tokens
									</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="text-2xl font-bold">
										{(stats.totalTokens || 0).toLocaleString()}
									</p>
								</CardContent>
							</Card>

							<Card>
								<CardHeader className="pb-2">
									<CardTitle className="text-sm font-medium text-muted-foreground">
										Total Cost
									</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="text-2xl font-bold text-primary">
										${(stats.totalCostUsd || 0).toFixed(2)}
									</p>
								</CardContent>
							</Card>

							<Card>
								<CardHeader className="pb-2">
									<CardTitle className="text-sm font-medium text-muted-foreground">
										Avg Response
									</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="text-2xl font-bold">
										{stats.avgResponseTime || 0}ms
									</p>
								</CardContent>
							</Card>
						</div>

						{stats.topModels && stats.topModels.length > 0 && (
							<Card className="mb-6">
								<CardHeader>
									<CardTitle>Model Usage</CardTitle>
								</CardHeader>
								<CardContent>
									<div className="space-y-2">
										{stats.topModels.map((model) => (
											<div
												key={model.model}
												className="flex items-center justify-between"
											>
												<span className="text-sm font-medium">
													{model.model}
												</span>
												<div className="flex items-center gap-2">
													<div className="w-32 bg-secondary rounded-full h-2">
														<div
															className="bg-primary h-2 rounded-full transition-all"
															style={{
																width: `${(model.count / stats.totalRequests) * 100}%`,
															}}
														/>
													</div>
													<span className="text-sm text-muted-foreground w-12 text-right">
														{model.count}
													</span>
												</div>
											</div>
										))}
									</div>
								</CardContent>
							</Card>
						)}
					</>
				)}

				<Tabs value={activeTab} onValueChange={setActiveTab}>
					<TabsList className="grid w-full grid-cols-4">
						<TabsTrigger value="stats">Statistics</TabsTrigger>
						<TabsTrigger value="accounts">Accounts</TabsTrigger>
						<TabsTrigger value="requests">Requests</TabsTrigger>
						<TabsTrigger value="logs">Logs</TabsTrigger>
					</TabsList>

					<TabsContent value="stats">
						<StatsTab />
					</TabsContent>

					<TabsContent value="accounts">
						<AccountsTab />
					</TabsContent>

					<TabsContent value="requests">
						<RequestsTab />
					</TabsContent>

					<TabsContent value="logs">
						<LogsTab />
					</TabsContent>
				</Tabs>
			</main>
		</div>
	);
}
