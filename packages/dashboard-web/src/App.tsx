import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AccountsTab } from "./components/AccountsTab";
import { AgentsTab } from "./components/AgentsTab";
import { LogsTab } from "./components/LogsTab";
import { Navigation } from "./components/navigation";
import { OverviewTab } from "./components/OverviewTab";
import { RequestsTab } from "./components/RequestsTab";
import { QUERY_CONFIG, REFRESH_INTERVALS } from "./constants";
import { ThemeProvider } from "./contexts/theme-context";
import "./index.css";

// Lazy load heavy components for better bundle splitting
const LazyAnalyticsTab = lazy(() =>
	import("./components/LazyAnalytics").then((module) => ({
		default: module.LazyAnalytics,
	})),
);
const LoadingSkeleton = () => (
	<div className="space-y-6 p-6">
		<div className="animate-pulse">
			<div className="h-8 bg-muted rounded w-32 mb-4"></div>
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
				{Array.from({ length: 4 }).map(() => (
					<div key={crypto.randomUUID()} className="h-24 bg-muted rounded" />
				))}
			</div>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{Array.from({ length: 2 }).map(() => (
					<div key={crypto.randomUUID()} className="h-64 bg-muted rounded" />
				))}
			</div>
		</div>
	</div>
);

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchInterval: REFRESH_INTERVALS.default, // Refetch every 30 seconds
			staleTime: QUERY_CONFIG.staleTime, // Consider data stale after 10 seconds
		},
	},
});

const routes = [
	{
		path: "/",
		element: <OverviewTab />,
		title: "Dashboard Overview",
		subtitle: "Monitor your ccflare performance and usage",
	},
	{
		path: "/analytics",
		element: (
			<Suspense fallback={<LoadingSkeleton />}>
				<LazyAnalyticsTab />
			</Suspense>
		),
		title: "Analytics",
		subtitle: "Deep dive into your usage patterns and trends",
	},
	{
		path: "/requests",
		element: <RequestsTab />,
		title: "Request History",
		subtitle: "View detailed request and response data",
	},
	{
		path: "/accounts",
		element: <AccountsTab />,
		title: "Account Management",
		subtitle: "Manage your OAuth accounts and settings",
	},
	{
		path: "/agents",
		element: <AgentsTab />,
		title: "Agent Management",
		subtitle: "Discover and manage Claude Code agents",
	},
	{
		path: "/logs",
		element: <LogsTab />,
		title: "System Logs",
		subtitle: "Real-time system logs and debugging information",
	},
];

export function App() {
	const location = useLocation();
	const currentRoute =
		routes.find((route) => route.path === location.pathname) || routes[0];

	return (
		<QueryClientProvider client={queryClient}>
			<ThemeProvider>
				<div className="min-h-screen bg-background">
					<Navigation />

					{/* Main Content */}
					<main className="lg:pl-64">
						{/* Mobile spacer */}
						<div className="h-16 lg:hidden" />

						{/* Page Content */}
						<div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto">
							{/* Page Header */}
							<div className="mb-8">
								<h1 className="text-3xl font-bold gradient-text">
									{currentRoute.title}
								</h1>
								<p className="text-muted-foreground mt-2">
									{currentRoute.subtitle}
								</p>
							</div>

							{/* Tab Content */}
							<div className="animate-in fade-in-0 duration-200">
								<Routes>
									{routes.map((route) => (
										<Route
											key={route.path}
											path={route.path}
											element={route.element}
										/>
									))}
									<Route path="*" element={<Navigate to="/" replace />} />
								</Routes>
							</div>
						</div>
					</main>
				</div>
			</ThemeProvider>
		</QueryClientProvider>
	);
}
