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

// Store update command globally
const updateCommand: string = "npm install -g better-ccflare@latest";
let detectedPackageManager: "npm" | "bun" | "unknown" = "npm";

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

	const detectPackageManager = async (): Promise<"npm" | "bun" | "unknown"> => {
		try {
			// Try to detect by checking common global installation paths
			const _homeDir = process.env.HOME || "";

			// Check if the binary exists in bun's global path
			try {
				const response = await fetch("/api/system/package-manager");
				if (response.ok) {
					const data = await response.json();
					return data.packageManager;
				}
			} catch {
				// Fallback to client-side detection
			}

			// Fallback: check if user agent indicates bun (this is a weak signal)
			const userAgent = navigator.userAgent;
			if (userAgent.includes("Bun")) {
				return "bun";
			}

			// Default to npm as it's more common
			return "npm";
		} catch (error) {
			console.error("Error detecting package manager:", error);
			return "npm"; // Default fallback
		}
	};

	const getUpdateCommand = (
		packageManager: "npm" | "bun" | "unknown",
	): string => {
		switch (packageManager) {
			case "bun":
				return "bun install -g better-ccflare@latest";
			default:
				return "npm install -g better-ccflare@latest";
		}
	};

	const copyToClipboard = async (text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			// Show success feedback (could add a toast here)
			return true;
		} catch (error) {
			console.error("Failed to copy to clipboard:", error);
			return false;
		}
	};

	const checkForUpdates = async () => {
		if (!isMountedRef.current) return;

		setUpdateStatus("checking");
		try {
			const [response, packageManager] = await Promise.all([
				fetch("https://registry.npmjs.org/better-ccflare/latest"),
				detectPackageManager(),
			]);

			const data = await response.json();
			const latest = data.version;

			// Only update state if component is still mounted
			if (!isMountedRef.current) return;

			setLatestVersion(latest);

			// Remove 'v' prefix from version for comparison
			const currentVersion = version.replace(/^v/, "");

			if (latest !== currentVersion) {
				setUpdateStatus("available");
				let updateCommand = getUpdateCommand(packageManager);
				console.log(
					`🚀 Update available: ${currentVersion} → ${latest}\nDetected package manager: ${packageManager}\nRun: ${updateCommand}`,
				);

				// Store the update command for later use
				updateCommand = getUpdateCommand(packageManager);
				detectedPackageManager = packageManager;
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
						<div
							className={cn(
								"rounded-lg bg-muted/50 p-3",
								updateStatus === "checking" && "opacity-50",
							)}
						>
							<button
								type="button"
								onClick={checkForUpdates}
								disabled={updateStatus === "checking"}
								className="w-full transition-colors hover:bg-muted/50 -m-3 p-3 rounded-lg"
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
							</button>
							{updateStatus === "available" && (
								<div className="mt-2 space-y-1">
									<p className="text-xs text-muted-foreground text-left">
										{version.replace(/^v/, "")} → {latestVersion}
									</p>
									<div className="flex items-center gap-1">
										<code className="text-xs bg-background px-1 py-0.5 rounded font-mono flex-1 truncate">
											{updateCommand}
										</code>
										<button
											type="button"
											onClick={() => copyToClipboard(updateCommand)}
											className="text-xs text-muted-foreground hover:text-foreground transition-colors p-1 hover:bg-background rounded"
											title="Copy update command"
										>
											<svg
												className="h-3 w-3"
												fill="none"
												stroke="currentColor"
												viewBox="0 0 24 24"
												role="img"
												aria-label="Copy to clipboard"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
												/>
											</svg>
										</button>
									</div>
									<p className="text-xs text-muted-foreground text-left">
										Detected: {detectedPackageManager} 📦
									</p>
								</div>
							)}
							{updateStatus === "current" && (
								<p className="mt-1 text-xs text-muted-foreground text-left">
									Version {version.replace(/^v/, "")}
								</p>
							)}
						</div>

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
