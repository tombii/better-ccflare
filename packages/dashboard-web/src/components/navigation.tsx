import {
	Activity,
	BarChart3,
	Bot,
	FileText,
	GitBranch,
	LayoutDashboard,
	Menu,
	RefreshCw,
	Shield,
	Users,
	X,
	Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "../lib/utils";
import { version } from "../lib/version";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";

interface NavItem {
	label: string;
	icon: React.ComponentType<{ className?: string }>;
	path: string;
	badge?: string;
}

const navItems: NavItem[] = [
	{ label: "Overview", icon: LayoutDashboard, path: "/" },
	{ label: "Analytics", icon: BarChart3, path: "/analytics" },
	{ label: "Requests", icon: Activity, path: "/requests" },
	{ label: "Accounts", icon: Users, path: "/accounts" },
	{ label: "Agents", icon: Bot, path: "/agents" },
	{ label: "Logs", icon: FileText, path: "/logs" },
];

export function Navigation() {
	const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
	const [updateStatus, setUpdateStatus] = useState<
		"idle" | "checking" | "available" | "current" | "error"
	>("idle");
	const [latestVersion, setLatestVersion] = useState<string>("");
	const location = useLocation();
	const isMountedRef = useRef(true);

	// Cleanup on unmount to prevent memory leaks
	useEffect(() => {
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const checkForUpdates = async () => {
		if (!isMountedRef.current) return;

		setUpdateStatus("checking");
		try {
			const response = await fetch(
				"https://registry.npmjs.org/better-ccflare/latest",
			);
			const data = await response.json();
			const latest = data.version;

			// Only update state if component is still mounted
			if (!isMountedRef.current) return;

			setLatestVersion(latest);

			// Remove 'v' prefix from version for comparison
			const currentVersion = version.replace(/^v/, "");

			if (latest !== currentVersion) {
				setUpdateStatus("available");
				console.log(
					`🚀 Update available: ${currentVersion} → ${latest}\nRun: npm install -g better-ccflare`,
				);
			} else {
				setUpdateStatus("current");
				console.log(`✅ You're on the latest version (${currentVersion})`);
			}
		} catch (error) {
			// Only update state if component is still mounted
			if (!isMountedRef.current) return;

			setUpdateStatus("error");
			console.error("❌ Failed to check for updates:", error);
		}
	};

	return (
		<>
			{/* Mobile header */}
			<div className="lg:hidden fixed top-0 left-0 right-0 z-50 h-16 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b px-4 flex items-center justify-between">
				<div className="flex items-center gap-3">
					<Shield className="h-6 w-6 text-primary" />
					<span className="font-semibold text-lg">better-ccflare</span>
				</div>
				<div className="flex items-center gap-2">
					<ThemeToggle />
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
					>
						{isMobileMenuOpen ? (
							<X className="h-5 w-5" />
						) : (
							<Menu className="h-5 w-5" />
						)}
					</Button>
				</div>
			</div>

			{/* Mobile menu overlay */}
			{isMobileMenuOpen && (
				<button
					type="button"
					className="lg:hidden fixed inset-0 z-40 bg-background/80 backdrop-blur-sm cursor-default"
					onClick={() => setIsMobileMenuOpen(false)}
					aria-label="Close menu"
				/>
			)}

			{/* Sidebar */}
			<aside
				className={cn(
					"fixed left-0 top-0 z-40 h-screen w-64 bg-card border-r transition-transform duration-300 lg:translate-x-0",
					isMobileMenuOpen
						? "translate-x-0"
						: "-translate-x-full lg:translate-x-0",
				)}
			>
				<div className="flex h-full flex-col">
					{/* Logo */}
					<div className="p-6 pb-4">
						<div className="flex items-center gap-3">
							<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
								<Shield className="h-6 w-6 text-primary" />
							</div>
							<div>
								<h1 className="font-semibold text-lg">better-ccflare</h1>
								<p className="text-xs text-muted-foreground">
									Powerful proxy for Claude Code
								</p>
							</div>
						</div>
					</div>

					<Separator />

					{/* Navigation */}
					<nav className="flex-1 space-y-1 p-4">
						{navItems.map((item) => {
							const Icon = item.icon;
							const isActive = location.pathname === item.path;
							return (
								<Link
									key={item.path}
									to={item.path}
									onClick={() => setIsMobileMenuOpen(false)}
								>
									<Button
										variant={isActive ? "secondary" : "ghost"}
										className={cn(
											"w-full justify-start gap-3 transition-all",
											isActive &&
												"bg-primary/10 text-primary hover:bg-primary/20",
										)}
									>
										<Icon className="h-4 w-4" />
										{item.label}
										{item.badge && (
											<span className="ml-auto rounded-full bg-primary/20 px-2 py-0.5 text-xs font-medium">
												{item.badge}
											</span>
										)}
									</Button>
								</Link>
							);
						})}
					</nav>

					<Separator />

					{/* Footer */}
					<div className="p-4 space-y-4">
						<div className="rounded-lg bg-muted/50 p-3">
							<div className="flex items-center gap-2 text-sm">
								<Zap className="h-4 w-4 text-primary" />
								<span className="font-medium">Status</span>
							</div>
							<p className="mt-1 text-xs text-muted-foreground">
								All systems operational
							</p>
						</div>

						{/* Update Check */}
						<button
							type="button"
							onClick={checkForUpdates}
							disabled={updateStatus === "checking"}
							className={cn(
								"w-full rounded-lg bg-muted/50 p-3 transition-colors hover:bg-muted",
								updateStatus === "checking" && "opacity-50 cursor-wait",
							)}
						>
							<div className="flex items-center gap-2 text-sm">
								<RefreshCw
									className={cn(
										"h-4 w-4",
										updateStatus === "checking" && "animate-spin",
										updateStatus === "available" && "text-green-500",
										updateStatus === "current" && "text-primary",
										updateStatus === "error" && "text-red-500",
									)}
								/>
								<span className="font-medium">
									{updateStatus === "idle" && "Check for Updates"}
									{updateStatus === "checking" && "Checking..."}
									{updateStatus === "available" && "Update Available"}
									{updateStatus === "current" && "Up to Date"}
									{updateStatus === "error" && "Check Failed"}
								</span>
							</div>
							{updateStatus === "available" && (
								<p className="mt-1 text-xs text-muted-foreground text-left">
									{version.replace(/^v/, "")} → {latestVersion}
								</p>
							)}
							{updateStatus === "current" && (
								<p className="mt-1 text-xs text-muted-foreground text-left">
									Version {version.replace(/^v/, "")}
								</p>
							)}
						</button>

						<div className="hidden lg:flex items-center justify-between">
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<GitBranch className="h-3 w-3" />
								<span>{version}</span>
							</div>
							<ThemeToggle />
						</div>
					</div>
				</div>
			</aside>
		</>
	);
}
