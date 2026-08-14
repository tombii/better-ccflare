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
	return forceAccountModel;
}
