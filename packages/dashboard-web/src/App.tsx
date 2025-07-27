import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./components/ui/card";
import { Button } from "./components/ui/button";
import { AccountsTab } from "./components/AccountsTab";
import { StatsTab } from "./components/StatsTab";
import { LogsTab } from "./components/LogsTab";
import { api } from "./api";
import "./index.css";

export function App() {
	const [activeTab, setActiveTab] = useState("stats");
	const [stats, setStats] = useState<any>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		loadStats();
		const interval = setInterval(loadStats, 5000);
		return () => clearInterval(interval);
	}, []);

	const loadStats = async () => {
		try {
			const data = await api.getStats();
			setStats(data);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load stats");
		}
	};

	return (
		<div className="min-h-screen bg-background">
			<header className="border-b">
				<div className="container mx-auto px-4 py-4">
					<h1 className="text-2xl font-bold">🎯 Claudeflare Dashboard</h1>
					<p className="text-muted-foreground">Load balancer for Claude</p>
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
					<div className="grid gap-4 md:grid-cols-3 mb-6">
						<Card>
							<CardHeader className="pb-2">
								<CardTitle className="text-base">Total Requests</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="text-2xl font-bold">{stats.totalRequests || 0}</p>
							</CardContent>
						</Card>

						<Card>
							<CardHeader className="pb-2">
								<CardTitle className="text-base">Success Rate</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="text-2xl font-bold">{stats.successRate || 0}%</p>
							</CardContent>
						</Card>

						<Card>
							<CardHeader className="pb-2">
								<CardTitle className="text-base">Active Accounts</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="text-2xl font-bold">
									{stats.activeAccounts || 0}
								</p>
							</CardContent>
						</Card>
					</div>
				)}

				<Tabs value={activeTab} onValueChange={setActiveTab}>
					<TabsList className="grid w-full grid-cols-3">
						<TabsTrigger value="stats">Statistics</TabsTrigger>
						<TabsTrigger value="accounts">Accounts</TabsTrigger>
						<TabsTrigger value="logs">Logs</TabsTrigger>
					</TabsList>

					<TabsContent value="stats">
						<StatsTab />
					</TabsContent>

					<TabsContent value="accounts">
						<AccountsTab />
					</TabsContent>

					<TabsContent value="logs">
						<LogsTab />
					</TabsContent>
				</Tabs>
			</main>
		</div>
	);
}
