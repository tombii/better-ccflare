import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { AccountsTab } from "./components/AccountsTab";
import { AgentsTab } from "./components/AgentsTab";
import { ApiKeyAuthDialog } from "./components/ApiKeyAuthDialog";
import { ApiKeysTab } from "./components/ApiKeysTab";
import { DebugPanel } from "./components/DebugPanel";
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
				{Array.from({ length: 4 }, (_, i) => `skeleton-card-${i}`).map(
					(key) => (
						<div key={key} className="h-24 bg-muted rounded" />
					),
				)}
			</div>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{Array.from({ length: 2 }, (_, i) => `skeleton-chart-${i}`).map(
					(key) => (
						<div key={key} className="h-64 bg-muted rounded" />
					),
				)}
			</div>
		</div>
	</div>
);

// QueryClient will be created inside App component to have access to auth state

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
		path: "/api-keys",
		element: <ApiKeysTab />,
		title: "API Key Management",
		subtitle: "Generate and manage API keys for authentication",
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
	const [showAuthDialog, setShowAuthDialog] = useState(false);
	const [isAuthenticated, setIsAuthenticated] = useState(false);
	const [isCheckingAuth, setIsCheckingAuth] = useState(true);
	const [authError, setAuthError] = useState<string | null>(null);

	// Use refs to store state setters so they can be accessed in QueryClient callbacks
	const showAuthDialogRef = useRef(setShowAuthDialog);
	const isAuthenticatedRef = useRef(setIsAuthenticated);
	const authErrorRef = useRef(setAuthError);

	// Update refs when setters change
	useEffect(() => {
		showAuthDialogRef.current = setShowAuthDialog;
		isAuthenticatedRef.current = setIsAuthenticated;
		authErrorRef.current = setAuthError;
	}, [setShowAuthDialog, setIsAuthenticated, setAuthError]);

	// Create QueryClient with global error handler for 401 errors
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						refetchInterval: REFRESH_INTERVALS.default,
						staleTime: QUERY_CONFIG.staleTime,
						retry: (failureCount, error) => {
							// Don't retry on 401 errors
							if (error && typeof error === "object" && "status" in error) {
								const httpError = error as { status: number };
								if (httpError.status === 401) {
									return false;
								}
							}
							return failureCount < 2;
						},
					},
					mutations: {
						retry: false,
					},
				},
				queryCache: new QueryCache({
					onError: (error) => {
						// Show auth dialog on any 401 error
						if (error && typeof error === "object" && "status" in error) {
							const httpError = error as { status: number };
							if (httpError.status === 401) {
								console.log("[App] 401 error in query - showing auth dialog");
								api.clearApiKey();
								authErrorRef.current(null); // Clear any previous errors
								isAuthenticatedRef.current(false);
								showAuthDialogRef.current(true);
							}
						}
					},
				}),
				mutationCache: new MutationCache({
					onError: (error) => {
						// Show auth dialog on any 401 error
						if (error && typeof error === "object" && "status" in error) {
							const httpError = error as { status: number };
							if (httpError.status === 401) {
								console.log("[App] 401 error in mutation - showing auth dialog");
								api.clearApiKey();
								authErrorRef.current(null); // Clear any previous errors
								isAuthenticatedRef.current(false);
								showAuthDialogRef.current(true);
							}
						}
					},
				}),
			}),
		[],
	);

	// Check if authentication is required
	useEffect(() => {
		const checkAuth = async () => {
			setIsCheckingAuth(true);

			// Always verify with a test request, even if we have a stored key
			// The stored key might be invalid, deleted, or expired
			try {
				await api.getStats();
				// If successful, we're authenticated (either no auth required, or valid key)
				setIsAuthenticated(true);
			} catch (error) {
				// If we get a 401, auth is required
				if (error && typeof error === "object" && "status" in error) {
					const httpError = error as { status: number };
					if (httpError.status === 401) {
						// Clear any invalid stored key
						api.clearApiKey();
						setShowAuthDialog(true);
					}
				}
			} finally {
				setIsCheckingAuth(false);
			}
		};

		checkAuth();
	}, []);

	// Listen for 401 errors from API client
	useEffect(() => {
		const handleAuthRequired = () => {
			api.clearApiKey();
			setAuthError(null);
			setIsAuthenticated(false);
			setShowAuthDialog(true);
		};

		window.addEventListener("auth-required", handleAuthRequired);
		return () => window.removeEventListener("auth-required", handleAuthRequired);
	}, []);

	const handleAuthenticate = async (apiKey: string): Promise<boolean> => {
		setAuthError(null);

		// Store the API key
		api.setApiKey(apiKey);

		// Try to make a request to verify the key
		try {
			await api.getStats();
			setIsAuthenticated(true);
			setShowAuthDialog(false);
			return true;
		} catch (_error) {
			// Invalid API key, clear it
			api.clearApiKey();
			setAuthError("Invalid API key");
			return false;
		}
	};

	// Show loading state while checking authentication
	if (isCheckingAuth) {
		return (
			<QueryClientProvider client={queryClient}>
				<ThemeProvider>
					<div className="min-h-screen bg-background flex items-center justify-center">
						<div className="text-center">
							<div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
							<p className="text-muted-foreground">
								Checking authentication...
							</p>
						</div>
					</div>
				</ThemeProvider>
			</QueryClientProvider>
		);
	}

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

							{/* Tab Content - Only render if auth check is complete and user is authenticated */}
							{!isCheckingAuth && (isAuthenticated || !showAuthDialog) && (
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
							)}
						</div>
					</main>
				</div>
				<DebugPanel />

				{/* API Key Authentication Dialog */}
				<ApiKeyAuthDialog
					isOpen={showAuthDialog}
					onAuthenticate={handleAuthenticate}
					error={authError}
				/>
			</ThemeProvider>
		</QueryClientProvider>
	);
}
