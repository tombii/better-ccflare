import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Process-wide switch for "force account model": send the model the client
 * asked for, or serve nothing.
 *
 * It lives here, as a plain in-memory flag, for the same reason the provider
 * default map does (see providers/src/provider-model-defaults.ts): the code
 * that rewrites a model name sits in core and providers, and neither may
 * depend on @better-ccflare/config without inverting the dependency graph.
 * The config remains the source of truth — apps/server pushes the value in at
 * boot, and the config POST handler pushes it again after a write, so the
 * switch takes effect without a restart.
 *
 * Off by default, which is the behaviour every existing install has today.
 */
let forceAccountModel = false;

/**
 * Requests exempt from the switch for the whole of their async lifetime.
 *
 * The switch is a promise about *client* requests: serve the model the caller
 * named, or serve nothing. better-ccflare's own probes are not callers. The
 * auto-refresh and cache-keepalive schedulers send a compiled-in list of Claude
 * model ids to whatever account they are probing, provider and all, because
 * their job is to touch the endpoint and read what comes back — not to deliver
 * anyone's choice of model. Mapping is what makes that work on a non-Claude
 * account, so suppressing mapping for a probe does not honour the promise, it
 * just breaks the probe: the untranslated id comes back as an upstream
 * rejection, which counts as a refresh failure, and five of those pause a
 * perfectly healthy account.
 *
 * This is a scope rather than a parameter because the flag it overrides is
 * ambient by necessity. `mapModelName` is the funnel every provider maps
 * through and it takes no request; threading a boolean to it would change six
 * call sites, several of which have no headers in hand. The proxy opens the
 * scope once, at the top of the request, for a probe whose secret it has
 * already verified — and every guard that reads the flag then answers
 * correctly, including ones added later.
 */
let exemptScope: AsyncLocalStorage<true> | null = null;

/**
 * Build the scope on first use rather than at import time.
 *
 * This module reaches the browser: `core/src/index.ts` re-exports it, the
 * dashboard imports that barrel, and a browser bundle has no
 * `node:async_hooks` — Bun's browser target replaces the import with an empty
 * stub, leaving `AsyncLocalStorage` undefined. Constructing at module scope
 * therefore threw "AsyncLocalStorage is not a constructor" while the chunk was
 * still initialising, and since that chunk carries the dashboard's React
 * bootstrap, the whole UI failed to mount.
 *
 * Nothing in the browser calls the functions below — only the proxy and the
 * providers do — so deferring the construction keeps the module importable
 * there while server behaviour stays exactly the same: the first caller builds
 * the one scope, every later caller reuses it. The null branch is reachable in
 * the browser bundle only, where "no scope" is the correct answer: an
 * exemption is something the proxy opens around a verified probe, and there
 * are no probes in a browser.
 */
function getExemptScope(): AsyncLocalStorage<true> | null {
	if (typeof AsyncLocalStorage !== "function") return null;
	exemptScope ??= new AsyncLocalStorage<true>();
	return exemptScope;
}

/** Mirror the config value here. Called at boot and after a successful write. */
export function setForceAccountModel(value: boolean): void {
	forceAccountModel = value;
}

/**
 * Whether model rewriting is currently forbidden.
 *
 * Callers should treat a true here as "return the model untouched" — never as
 * "pick a different model": the entire point is that no code chooses a model
 * on the operator's behalf while this is on.
 */
export function isForceAccountModelEnabled(): boolean {
	return forceAccountModel && getExemptScope()?.getStore() !== true;
}

/**
 * Run `fn` — and everything it awaits — with the switch treated as off.
 *
 * Reserved for internal probes whose secret has been verified. Never key this
 * on a marker header alone: a client that copied one out of a log would be
 * opting itself out of the operator's setting.
 */
export function runForceAccountModelExempt<T>(fn: () => T): T {
	const scope = getExemptScope();
	return scope ? scope.run(true, fn) : fn();
}

/**
 * Whether the current scope is exempt. Exposed for callers that need to report
 * or test the state rather than act on it; the guards themselves should keep
 * reading `isForceAccountModelEnabled`, which already accounts for it.
 */
export function isForceAccountModelExempt(): boolean {
	return getExemptScope()?.getStore() === true;
}
