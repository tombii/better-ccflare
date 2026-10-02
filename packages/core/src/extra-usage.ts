/**
 * Process-wide switch for "use extra usage": whether an account whose plan
 * window reads 100% stays routable while its provider reports billed capacity
 * beyond the plan — Codex credits, Anthropic extra usage.
 *
 * Without it, an exhausted window removes the account from selection even
 * though the provider would keep answering: the official Codex CLI carries on
 * against purchased credits, and an Anthropic account with extra usage
 * enabled carries on against its overage budget.
 *
 * It lives here as a plain in-memory flag for the same reason the force
 * account model switch does (see force-account-model.ts): the usage snapshot
 * that gates admission is built in providers, which may not depend on
 * @better-ccflare/config. The config remains the source of truth —
 * apps/server pushes the value in at boot, and the config POST handler pushes
 * it again after a write, so the switch takes effect without a restart.
 *
 * Off by default: extra usage is billed, so spending it must be chosen.
 */
let useExtraUsage = false;

/** Mirror the config value here. Called at boot and after a successful write. */
export function setUseExtraUsage(value: boolean): void {
	useExtraUsage = value;
}

/** Whether a spent plan window may be served past on extra usage. */
export function isUseExtraUsageEnabled(): boolean {
	return useExtraUsage;
}
