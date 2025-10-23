import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "../utils/http-error";

export function createSystemInfoHandler() {
	return async (): Promise<Response> => {
		try {
			// Try to detect package manager by checking environment
			let packageManager = "npm"; // default fallback

			// Check if running under bun
			if (process.versions.bun) {
				packageManager = "bun";
			} else if (process.env.npm_config_user_agent?.includes("bun")) {
				packageManager = "bun";
			}

			// Detect if running from binary
			const isBinary = detectRunningFromBinary();

			// Detect if running in Docker
			const isDocker = detectRunningInDocker();

			const systemInfo = {
				packageManager,
				nodeVersion: process.version,
				bunVersion: process.versions.bun || null,
				platform: process.platform,
				arch: process.arch,
				isBinary,
				isDocker,
				execPath: process.execPath,
				timestamp: new Date().toISOString(),
			};

			return jsonResponse(systemInfo);
		} catch (_error) {
			return errorResponse(
				InternalServerError("Failed to get system information"),
			);
		}
	};
}

/**
 * Detect if the application is running in a Docker container
 */
function detectRunningInDocker(): boolean {
	// Check for Docker-specific indicators
	const dockerIndicators = [
		// Check for .dockerenv file
		() => {
			try {
				const fs = require("node:fs");
				return fs.existsSync("/.dockerenv");
			} catch {
				return false;
			}
		},
		// Check for Docker in cgroup
		() => {
			try {
				const fs = require("node:fs");
				const cgroupContent = fs.readFileSync("/proc/1/cgroup", "utf8");
				return (
					cgroupContent.includes("docker") ||
					cgroupContent.includes("containerd")
				);
			} catch {
				return false;
			}
		},
		// Check for Docker environment variables
		() => {
			return !!(
				process.env.DOCKER_CONTAINER || process.env.KUBERNETES_SERVICE_HOST
			);
		},
		// Check if running in container by checking hostname patterns
		() => {
			const hostname = require("node:os").hostname();
			return /^[a-f0-9]{12}$/.test(hostname) || hostname.includes("docker");
		},
	];

	// Return true if any Docker indicator is detected
	return dockerIndicators.some((check) => {
		try {
			return check();
		} catch {
			return false;
		}
	});
}

/**
 * Detect if the application is running from a pre-compiled binary
 */
function detectRunningFromBinary(): boolean {
	const execPath = process.execPath;

	// Check if execPath looks like a binary installation
	// Binary installations typically have specific patterns:
	// 1. Not in node_modules/.bin
	// 2. Not the node/bun executable itself
	// 3. Has a name that matches our binary pattern

	// If execPath contains 'better-ccflare' and is not in node_modules, it's likely a binary
	if (execPath.includes("better-ccflare")) {
		// Check if it's not in node_modules (which would indicate npm/bun installation)
		if (!execPath.includes("node_modules")) {
			return true;
		}
	}

	// Additional check: if execPath is in common binary installation directories
	const commonBinaryPaths = [
		"/usr/local/bin",
		"/usr/bin",
		"/opt/homebrew/bin",
		"\\Program Files\\",
		"\\Program Files (x86)\\",
	];

	for (const binaryPath of commonBinaryPaths) {
		if (execPath.includes(binaryPath)) {
			return true;
		}
	}

	// Check if the execPath is not the node/bun executable itself
	// and doesn't point to a package manager script
	const nodeExecutables = ["node", "bun", "npm", "yarn", "pnpm"];
	const execName = execPath.split(/[\\/]/).pop()?.toLowerCase();

	if (execName && !nodeExecutables.includes(execName)) {
		// If the executable name contains our app name and it's not a package manager
		// it's likely a binary
		if (execName.includes("better-ccflare")) {
			return true;
		}
	}

	return false;
}
