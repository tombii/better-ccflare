/**
 * Bun's `fetch()` supports a per-request `proxy` option at runtime, but it is
 * not declared on bun-types' ambient `RequestInit`, so we extend it locally.
 */
interface FetchInitWithProxy extends RequestInit {
	proxy?: string;
}

type FetchLike = typeof fetch;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

let originalFetch: FetchLike | undefined;
let resolveProxy: (() => string | undefined) | undefined;

function extractHostname(input: RequestInfo | URL): string | undefined {
	try {
		if (typeof input === "string") {
			return new URL(input).hostname;
		}
		if (input instanceof URL) {
			return input.hostname;
		}
		if (input instanceof Request) {
			return new URL(input.url).hostname;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function isLoopbackHost(hostname: string): boolean {
	return LOOPBACK_HOSTS.has(hostname);
}

/**
 * Installs a global wrapper around `globalThis.fetch` that routes outbound
 * requests through an explicit forward proxy, as resolved by `resolver()`.
 *
 * WHY a global fetch wrapper rather than plumbing a `proxy` parameter through
 * each call site: an egress security/inspection proxy is only useful if it
 * covers ALL outbound traffic — provider requests, OAuth token exchange,
 * usage polling, webhooks, etc. Threading a proxy option through every call
 * site individually risks silently missing a code path (now or in a future
 * change) and creating a bypass hole in the security boundary. Wrapping
 * `fetch` once, globally, guarantees coverage regardless of which module
 * initiates the request.
 *
 * Loopback destinations (localhost, 127.0.0.1, ::1) are always excluded from
 * proxying, so the app's own local traffic — e.g. calls to a local
 * Ollama/LiteLLM server an operator is running for testing — never gets
 * routed through an external proxy that has no route back to the local
 * machine.
 *
 * Calling this function more than once (e.g. if startup logic runs twice, or
 * across tests) does not double-wrap `fetch`; it just swaps out which
 * resolver the existing wrapper uses.
 */
export function installOutboundProxy(resolver: () => string | undefined): void {
	resolveProxy = resolver;

	if (originalFetch) {
		// Already wrapped — only the resolver needed updating.
		return;
	}

	originalFetch = globalThis.fetch;
	const capturedOriginalFetch = originalFetch;

	function wrapperFn(
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> {
		const initWithProxy = init as FetchInitWithProxy | undefined;

		// Caller's own explicit choice always wins.
		if (initWithProxy?.proxy) {
			return capturedOriginalFetch(input, init);
		}

		const hostname = extractHostname(input);
		if (hostname === undefined) {
			// Fail open: never throw from inside the wrapper due to URL parsing.
			return capturedOriginalFetch(input, init);
		}

		if (isLoopbackHost(hostname)) {
			return capturedOriginalFetch(input, init);
		}

		const proxyUrl = resolveProxy?.();
		if (!proxyUrl) {
			return capturedOriginalFetch(input, init);
		}

		const nextInit: FetchInitWithProxy = { ...init, proxy: proxyUrl };
		return capturedOriginalFetch(input, nextInit as RequestInit);
	}

	// Preserve extra properties Bun attaches to fetch (e.g. `preconnect`), by
	// assigning them FROM the original fetch ONTO the wrapper — never the
	// reverse, which would overwrite the wrapper's own callable behavior.
	const wrapper = Object.assign(wrapperFn, capturedOriginalFetch);

	globalThis.fetch = wrapper;
}

/**
 * Test-only helper: restores `globalThis.fetch` to the original, pre-wrap
 * reference and clears wrap state, so repeated installs in the same process
 * (e.g. across test files) stay isolated from each other.
 */
export function uninstallOutboundProxy(): void {
	if (originalFetch) {
		globalThis.fetch = originalFetch;
	}
	originalFetch = undefined;
	resolveProxy = undefined;
}
