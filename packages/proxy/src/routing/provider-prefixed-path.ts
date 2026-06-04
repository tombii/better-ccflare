import { isKnownProvider, type ProviderName } from "@better-ccflare/types";

export class ProviderPrefixError extends Error {
	constructor(
		message: string,
		public readonly code:
			| "empty_provider"
			| "unknown_provider"
			| "unsupported_native_path",
	) {
		super(message);
		this.name = "ProviderPrefixError";
	}
}

export interface ResolvedNativeRoute {
	provider: string;
	clientPath: string;
	upstreamPath: string;
}

/** URL path prefix segment → account provider name */
const NATIVE_ROUTE_PREFIX_TO_PROVIDER: Record<string, ProviderName> = {
	openai: "openai-compatible",
	anthropic: "anthropic",
	codex: "codex",
};

const SUPPORTED_NATIVE_UPSTREAM_PATHS: Record<string, ReadonlySet<string>> = {
	openai: new Set(["/responses", "/chat/completions"]),
	anthropic: new Set(["/v1/messages"]),
	codex: new Set(["/responses"]),
};

function resolveAccountProvider(prefixSegment: string): ProviderName | null {
	const aliased = NATIVE_ROUTE_PREFIX_TO_PROVIDER[prefixSegment];
	if (aliased) {
		return aliased;
	}
	if (isKnownProvider(prefixSegment)) {
		return prefixSegment;
	}
	return null;
}

const NON_PROVIDER_V1_PREFIXES = new Set(["messages", "responses", "api"]);

function parseNativePrefix(
	pathname: string,
): { provider: string; remainder: string } | null {
	const match = pathname.match(/^\/v1\/([^/]*)(\/.*)$/);
	if (!match) {
		return null;
	}

	const [, provider, remainder] = match;
	if (!remainder || remainder === "/") {
		return null;
	}

	if (provider !== "" && NON_PROVIDER_V1_PREFIXES.has(provider)) {
		return null;
	}

	return { provider, remainder };
}

function looksLikeNativePrefix(pathname: string): boolean {
	return parseNativePrefix(pathname) !== null;
}

export function isProviderPrefixedPath(pathname: string): boolean {
	return looksLikeNativePrefix(pathname);
}

export function resolveProviderPrefixedPath(
	pathname: string,
): ResolvedNativeRoute {
	const parsed = parseNativePrefix(pathname);
	if (!parsed) {
		throw new ProviderPrefixError(
			`Invalid provider-prefixed path: ${pathname}`,
			"unsupported_native_path",
		);
	}

	const { provider: providerSegment, remainder } = parsed;

	if (providerSegment === "") {
		throw new ProviderPrefixError(
			"Provider segment is empty in provider-prefixed path",
			"empty_provider",
		);
	}

	const accountProvider = resolveAccountProvider(providerSegment);
	if (!accountProvider) {
		throw new ProviderPrefixError(
			`Unknown provider in native route: ${providerSegment}`,
			"unknown_provider",
		);
	}

	const upstreamPath = remainder.startsWith("/") ? remainder : `/${remainder}`;
	const supportedPaths = SUPPORTED_NATIVE_UPSTREAM_PATHS[providerSegment];
	if (!supportedPaths?.has(upstreamPath)) {
		throw new ProviderPrefixError(
			`Unsupported native path for provider ${providerSegment}: ${upstreamPath}`,
			"unsupported_native_path",
		);
	}

	return {
		provider: accountProvider,
		clientPath: pathname,
		upstreamPath,
	};
}

export function tryResolveProviderPrefixedPath(
	pathname: string,
):
	| { ok: true; route: ResolvedNativeRoute }
	| { ok: false; error: ProviderPrefixError }
	| null {
	if (!isProviderPrefixedPath(pathname)) {
		return null;
	}

	try {
		return { ok: true, route: resolveProviderPrefixedPath(pathname) };
	} catch (error) {
		if (error instanceof ProviderPrefixError) {
			return { ok: false, error };
		}
		throw error;
	}
}
