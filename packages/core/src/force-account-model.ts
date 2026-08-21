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
const exemptScope = new AsyncLocalStorage<true>();

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
	return forceAccountModel && exemptScope.getStore() !== true;
}

/**
 * Run `fn` — and everything it awaits — with the switch treated as off.
 *
 * Reserved for internal probes whose secret has been verified. Never key this
 * on a marker header alone: a client that copied one out of a log would be
 * opting itself out of the operator's setting.
 */
export function runForceAccountModelExempt<T>(fn: () => T): T {
	return exemptScope.run(true, fn);
}

/**
 * Whether the current scope is exempt. Exposed for callers that need to report
 * or test the state rather than act on it; the guards themselves should keep
 * reading `isForceAccountModelEnabled`, which already accounts for it.
 */
export function isForceAccountModelExempt(): boolean {
	return exemptScope.getStore() === true;
}
