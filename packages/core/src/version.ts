/**
 * Version utility that works in both development and production environments
 */

// Claude CLI version to use in user-agent headers and as fallback
export const CLAUDE_CLI_VERSION = "2.1.19";

// Cache the version to avoid repeated file reads
let cachedVersion: string | null = null;

export async function getVersion(): Promise<string> {
	if (cachedVersion) {
		return cachedVersion;
	}

	// Try multiple sources for the version
	try {
		// 1. Try build-time injected version (for compiled binaries)
		if (process.env.BETTER_CCFLARE_VERSION) {
			cachedVersion = process.env.BETTER_CCFLARE_VERSION;
			return cachedVersion;
		}

		// 2. Try environment variable (set by npm/bun during publishing)
		if (process.env.npm_package_version) {
			cachedVersion = process.env.npm_package_version;
			return cachedVersion;
		}

		// 3. Try reading from the compiled package.json in production
		try {
			// In production, the package.json should be in the same directory as the executable
			const packageJsonPath = new URL("../package.json", import.meta.url);
			const packageJson = await fetch(packageJsonPath);
			const pkg = (await packageJson.json()) as { version?: string };
			if (pkg.version) {
				cachedVersion = pkg.version;
				return cachedVersion;
			}
		} catch {
			// Continue to next method
		}

		// 4. Try development environment - reading from apps/cli/package.json
		try {
			const packageJsonPath = new URL(
				"../../../apps/cli/package.json",
				import.meta.url,
			);
			const packageJson = await fetch(packageJsonPath);
			const pkg = (await packageJson.json()) as { version?: string };
			if (pkg.version) {
				cachedVersion = pkg.version;
				return cachedVersion;
			}
		} catch {
			// Continue to next method
		}

		// 5. Try reading from root package.json
		try {
			const packageJsonPath = new URL("../../../package.json", import.meta.url);
			const packageJson = await fetch(packageJsonPath);
			const pkg = (await packageJson.json()) as { version?: string };
			if (pkg.version) {
				cachedVersion = pkg.version;
				return cachedVersion;
			}
		} catch {
			// Continue to fallback
		}

		// 6. Fallback to a default version
		cachedVersion = CLAUDE_CLI_VERSION;
		return cachedVersion;
	} catch (_error) {
		// Ultimate fallback
		cachedVersion = CLAUDE_CLI_VERSION;
		return cachedVersion;
	}
}

// Synchronous version for contexts where async is not available
export function getVersionSync(): string {
	if (cachedVersion) {
		return cachedVersion;
	}

	// Try build-time injected version first
	if (process.env.BETTER_CCFLARE_VERSION) {
		cachedVersion = process.env.BETTER_CCFLARE_VERSION;
		return cachedVersion;
	}

	// Try environment variable
	if (process.env.npm_package_version) {
		cachedVersion = process.env.npm_package_version;
		return cachedVersion;
	}

	// For other cases, we'll use the fallback
	// The async version will be called later to update the cache
	cachedVersion = CLAUDE_CLI_VERSION;
	return cachedVersion;
}

/**
 * Extract Claude CLI version from a user-agent header
 * @param userAgent - The user-agent string to parse
 * @returns The extracted version string, or null if not found
 * @example
 * extractClaudeVersion("claude-cli/2.0.60 (external, cli)") // returns "2.0.60"
 * extractClaudeVersion("Mozilla/5.0...") // returns null
 */
export function extractClaudeVersion(userAgent: string | null): string | null {
	if (!userAgent) {
		return null;
	}

	// Match claude-cli/X.Y.Z pattern (handles semver with optional prerelease/build metadata)
	const match = userAgent.match(
		/claude-cli\/(\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?)/i,
	);
	return match ? match[1] : null;
}

// Track the most recent Claude CLI version seen from client requests
// This allows auto-refresh to use newer client versions even after app restart
let lastSeenClientVersion: string | null = null;

/**
 * Update the tracked client version from an incoming request
 * @param userAgent - The user-agent header from the client request
 */
export function trackClientVersion(userAgent: string | null): void {
	const version = extractClaudeVersion(userAgent);
	if (version) {
		lastSeenClientVersion = version;
	}
}

/**
 * Get the most recently seen client version, or fall back to the application version
 * @returns The client version if available, otherwise CLAUDE_CLI_VERSION
 */
export function getClientVersion(): string {
	return lastSeenClientVersion || CLAUDE_CLI_VERSION;
}
