import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { AccountsTab } from "./components/AccountsTab";
import { AgentsTab } from "./components/AgentsTab";
import { AnalyticsTab } from "./components/AnalyticsTab";
import { LogsTab } from "./components/LogsTab";
import { Navigation } from "./components/navigation";
import { OverviewTab } from "./components/OverviewTab";
import { RequestsTab } from "./components/RequestsTab";
import { QUERY_CONFIG, REFRESH_INTERVALS } from "./constants";
import { ThemeProvider } from "./contexts/theme-context";
import "./index.css";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchInterval: REFRESH_INTERVALS.default, // Refetch every 30 seconds
			staleTime: QUERY_CONFIG.staleTime, // Consider data stale after 10 seconds
		},
	},
});

export function App() {
	const [activeTab, setActiveTab] = useState("overview");

	const renderContent = () => {
		switch (activeTab) {
			case "overview":
				return <OverviewTab />;
			case "analytics":
				return <AnalyticsTab />;
			case "requests":
				return <RequestsTab />;
			case "accounts":
				return <AccountsTab />;
			case "agents":
				return <AgentsTab />;
			case "logs":
				return <LogsTab />;
			default:
				return <OverviewTab />;
		}
	};

	return (
		<QueryClientProvider client={queryClient}>
			<ThemeProvider>
				<div className="min-h-screen bg-background">
					<Navigation activeTab={activeTab} onTabChange={setActiveTab} />

					{/* Main Content */}
					<main className="lg:pl-64">
						{/* Mobile spacer */}
						<div className="h-16 lg:hidden" />

						{/* Page Content */}
						<div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto">
							{/* Page Header */}
							<div className="mb-8">
								<h1 className="text-3xl font-bold gradient-text">
									{activeTab === "overview" && "Dashboard Overview"}
									{activeTab === "analytics" && "Analytics"}
									{activeTab === "requests" && "Request History"}
									{activeTab === "accounts" && "Account Management"}
									{activeTab === "agents" && "Agent Management"}
									{activeTab === "logs" && "System Logs"}
								</h1>
								<p className="text-muted-foreground mt-2">
									{activeTab === "overview" &&
										"Monitor your ccflare performance and usage"}
									{activeTab === "analytics" &&
										"Deep dive into your usage patterns and trends"}
									{activeTab === "requests" &&
										"View detailed request and response data"}
									{activeTab === "accounts" &&
										"Manage your OAuth accounts and settings"}
									{activeTab === "agents" &&
										"Discover and manage Claude Code agents"}
									{activeTab === "logs" &&
										"Real-time system logs and debugging information"}
								</p>
							</div>

							{/* Tab Content */}
							<div className="animate-in fade-in-0 duration-200">
								{renderContent()}
							</div>
						</div>
					</main>
				</div>
			</ThemeProvider>
		</QueryClientProvider>
	);
}
