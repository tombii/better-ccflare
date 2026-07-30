// Read version from build-time define (injected by packages/dashboard-web/build.ts),
// falling back to apps/cli/package.json for local dev where no define is supplied.
// Honors CCFLARE_BUILD_SUFFIX when the dashboard build is invoked with the env var set.
import packageJson from "../../../../apps/cli/package.json";

// Build-time injected version (set by packages/dashboard-web/build.ts when
// CCFLARE_BUILD_SUFFIX is present). undefined at dev/runtime.
declare const __BETTER_CCFLARE_VERSION__: string | undefined;

function resolveVersion(): string {
	if (
		typeof __BETTER_CCFLARE_VERSION__ !== "undefined" &&
		__BETTER_CCFLARE_VERSION__
	) {
		return __BETTER_CCFLARE_VERSION__;
	}
	return packageJson.version;
}

export function getVersion(): string {
	const version = resolveVersion();
	return version.startsWith("v") ? version : `v${version}`;
}

export const version = getVersion();
