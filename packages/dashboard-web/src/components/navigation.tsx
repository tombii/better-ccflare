import {
	Activity,
	BarChart3,
	Bot,
	FileText,
	GitBranch,
	Key,
	LayoutDashboard,
	Menu,
	RefreshCw,
	Shield,
	Users,
	X,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "../lib/utils";
import { version } from "../lib/version";
import { CopyButton } from "./CopyButton";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";

// Store update command globally
let updateCommand: string = "npm install -g better-ccflare@latest";
let detectedPackageManager: "npm" | "bun" | "unknown" = "npm";
let isBinaryInstallation: boolean = false;
let isDockerInstallation: boolean = false;

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
	{ label: "API Keys", icon: Key, path: "/api-keys" },
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

	const detectPackageManager = async (): Promise<{
		packageManager: "npm" | "bun" | "unknown";
		isBinary: boolean;
		isDocker: boolean;
	}> => {
		try {
			// Check if the binary exists in bun's global path
			try {
				const response = await fetch("/api/system/package-manager");
				if (response.ok) {
					const data = await response.json();
					isBinaryInstallation = data.isBinary || false;
					isDockerInstallation = data.isDocker || false;
					return {
						packageManager: data.packageManager,
						isBinary: data.isBinary || false,
						isDocker: data.isDocker || false,
					};
				}
			} catch {
				// Fallback to client-side detection
			}

			// Fallback: check if user agent indicates bun (this is a weak signal)
			const userAgent = navigator.userAgent;
			if (userAgent.includes("Bun")) {
				return { packageManager: "bun", isBinary: false, isDocker: false };
			}

			// Default to npm as it's more common
			return { packageManager: "npm", isBinary: false, isDocker: false };
		} catch (error) {
			console.error("Error detecting package manager:", error);
			return { packageManager: "npm", isBinary: false, isDocker: false }; // Default fallback
		}
	};

	const getUpdateCommand = (
		packageManager: "npm" | "bun" | "unknown",
		isBinary: boolean = false,
		isDocker: boolean = false,
	): string => {
		if (isDocker) {
			// For Docker installations, provide instructions to pull latest image
			return "docker pull ghcr.io/tombii/better-ccflare:latest";
		}

		if (isBinary) {
			// For binary installations, provide instructions to download from GitHub releases
			const platform = navigator.platform.toLowerCase();
			let _arch = "x64";

			// Detect architecture
			if (platform.includes("arm") || platform.includes("aarch64")) {
				_arch = "arm64";
			}

			let _os = "linux";
			if (platform.includes("win")) {
				_os = "windows";
			} else if (platform.includes("mac")) {
				_os = "darwin";
			}

			// Return GitHub releases URL instead of a command
			return "Download latest binary from GitHub releases";
		}

		switch (packageManager) {
			case "bun":
				return "bun install -g better-ccflare@latest";
			default:
				return "npm install -g better-ccflare@latest";
		}
	};

	/**
	 * Compare two semantic versions
	 * @returns true if latest > current (update available), false otherwise
	 */
	const compareVersions = (latest: string, current: string): boolean => {
		const latestParts = latest.split(".").map(Number);
		const currentParts = current.split(".").map(Number);

		for (
			let i = 0;
			i < Math.max(latestParts.length, currentParts.length);
			i++
		) {
			const latestPart = latestParts[i] || 0;
			const currentPart = currentParts[i] || 0;

			if (latestPart > currentPart) return true;
			if (latestPart < currentPart) return false;
		}

		return false; // Versions are equal
	};

	/**
	 * Check for available updates from npm registry
	 * Uses localStorage to cache results and prevent excessive checks (max once per hour)
	 * This function is called on component mount and then every hour via setInterval
	 */
	// biome-ignore lint/correctness/useExhaustiveDependencies: helper functions are stable and don't need to be dependencies
	const checkForUpdates = useCallback(async () => {
		if (!isMountedRef.current) return;

		// Check localStorage for last check time to avoid excessive checks
		const lastCheckTime = localStorage.getItem("updateCheckLastTime");
		const now = Date.now();
		const oneHour = 60 * 60 * 1000;

		// Check cache to avoid excessive npm registry requests
		// Recheck every hour regardless of status to keep version info fresh
		if (lastCheckTime && now - Number.parseInt(lastCheckTime, 10) < oneHour) {
			const cachedStatus = localStorage.getItem("updateCheckStatus");
			const cachedVersion = localStorage.getItem("updateCheckVersion");

			// Remove 'v' prefix from version for comparison
			const currentVersion = version.replace(/^v/, "");

			if (cachedStatus === "available" && cachedVersion) {
				// Check if user has updated since cache was created
				// If cached version <= current version, they've updated, so clear cache
				if (!compareVersions(cachedVersion, currentVersion)) {
					localStorage.removeItem("updateCheckStatus");
					localStorage.removeItem("updateCheckVersion");
					localStorage.removeItem("updateCheckLastTime");
					// Fall through to do a fresh check
				} else {
					setUpdateStatus("available");
					setLatestVersion(cachedVersion);
					return;
				}
			}

			if (cachedStatus === "current") {
				setUpdateStatus("current");
				return;
			}
		}

		setUpdateStatus("checking");
		try {
			const [response, packageInfo] = await Promise.all([
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

			// Use semantic version comparison: only show update if latest > current
			if (compareVersions(latest, currentVersion)) {
				setUpdateStatus("available");
				updateCommand = getUpdateCommand(
					packageInfo.packageManager,
					packageInfo.isBinary,
					packageInfo.isDocker,
				);
				detectedPackageManager = packageInfo.packageManager;
				console.log(
					`🚀 Update available: ${currentVersion} → ${latest}\nDetected package manager: ${packageInfo.packageManager}\nRun: ${updateCommand}`,
				);

				// Cache "available" status - will recheck after 1 hour for newer versions
				localStorage.setItem("updateCheckStatus", "available");
				localStorage.setItem("updateCheckVersion", latest);
				localStorage.setItem("updateCheckLastTime", now.toString());
			} else {
				setUpdateStatus("current");
				console.log(`✅ You're on the latest version (${currentVersion})`);

				// Cache "current" status - will recheck after 1 hour
				localStorage.setItem("updateCheckStatus", "current");
				localStorage.setItem("updateCheckLastTime", now.toString());
			}
		} catch (error) {
			// Only update state if component is still mounted
			if (!isMountedRef.current) return;

			setUpdateStatus("error");
			console.error("❌ Failed to check for updates:", error);
		}
	}, []);

	// Automatic update check: run on mount and every hour
	// biome-ignore lint/correctness/useExhaustiveDependencies: checkForUpdates is stable via useCallback
	useEffect(() => {
		// Check immediately on mount (when dashboard loads)
		checkForUpdates();

		// Set up hourly check
		const intervalId = setInterval(
			() => {
				checkForUpdates();
			},
			60 * 60 * 1000,
		); // 1 hour in milliseconds

		// Cleanup interval on unmount
		return () => {
			clearInterval(intervalId);
		};
	}, []);

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
										<CopyButton
											value={updateCommand}
											size="sm"
											variant="ghost"
											className="h-6 w-6 p-0"
											title="Copy update command"
										/>
									</div>
									<p className="text-xs text-muted-foreground text-left">
										{isDockerInstallation
											? "Detected: Docker 🐳"
											: isBinaryInstallation
												? "Detected: Binary Installation 📦"
												: `Detected: ${detectedPackageManager} 📦`}
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
