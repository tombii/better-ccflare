/**
 * Version utility that works in both development and production environments
 */

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

		// 4. Try development environment - reading from apps/tui/package.json
		try {
			const packageJsonPath = new URL(
				"../../apps/tui/package.json",
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
			const packageJsonPath = new URL("../../package.json", import.meta.url);
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
		cachedVersion = "1.2.19";
		return cachedVersion;
	} catch (_error) {
		// Ultimate fallback
		cachedVersion = "1.2.19";
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
	cachedVersion = "1.2.19";
	return cachedVersion;
}
