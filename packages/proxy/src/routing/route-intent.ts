export const ROUTE_INTENT_ALLOW_PROVIDERS_HEADER =
	"x-better-ccflare-allow-providers";

const EXCLUDE_PROVIDERS_HEADER = "x-better-ccflare-exclude-providers";
const INCLUDE_PROVIDERS_HEADER = "x-better-ccflare-include-providers";

export interface RouteIntent {
	excludeProviders: string[];
	includeProviders: string[];
}

function parseProviderHeader(
	headers: Headers | null | undefined,
	name: string,
): string[] {
	return (
		headers
			?.get(name)
			?.split(",")
			.map((provider) => provider.trim())
			.filter(Boolean) ?? []
	);
}

function mergeUnique(...lists: string[][]): string[] {
	return [...new Set(lists.flat())];
}

function isClaudeCompatibilityPath(path: string): boolean {
	return path === "/v1/messages" || path.startsWith("/v1/messages/");
}

export function resolveRouteIntent(
	path: string,
	headers?: Headers | null,
): RouteIntent {
	const explicitExclude = parseProviderHeader(
		headers,
		EXCLUDE_PROVIDERS_HEADER,
	);
	const explicitInclude = parseProviderHeader(
		headers,
		INCLUDE_PROVIDERS_HEADER,
	);
	const explicitAllow = parseProviderHeader(
		headers,
		ROUTE_INTENT_ALLOW_PROVIDERS_HEADER,
	);

	if (explicitInclude.length > 0) {
		return {
			excludeProviders: explicitExclude,
			includeProviders: explicitInclude,
		};
	}

	const defaultExclude: string[] = [];
	if (isClaudeCompatibilityPath(path) && !explicitAllow.includes("codex")) {
		defaultExclude.push("codex");
	}

	return {
		excludeProviders: mergeUnique(defaultExclude, explicitExclude),
		includeProviders: explicitInclude,
	};
}
