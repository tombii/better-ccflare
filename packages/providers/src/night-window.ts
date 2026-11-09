/**
 * Provider-agnostic night-window header injection.
 *
 * Providers that offer a cheaper / lower-priority tier outside peak hours
 * register a `TierAdapter` describing their own header name and tier value.
 * `applyNightWindowHeader` then sets that header only when the account has the
 * night window enabled and the current time falls inside the configured
 * window. This module hardcodes no provider name, header, or tier: adding a
 * provider only requires registering an adapter from its own module.
 *
 * The default (non-window) tier is the adapter's concern. We never send it
 * explicitly: some providers reject an explicit default tier on certain
 * request types, so outside the window we send no header at all.
 */

import { isInNightWindow, type NightWindow } from "@better-ccflare/core";

export interface TierAdapter {
	/** Provider name this adapter applies to. */
	provider: string;
	/** Outgoing request header carrying the tier. */
	header: string;
	/** Value to set inside the window. */
	tier: string;
}

const adapters = new Map<string, TierAdapter>();

/**
 * Register (or replace) the tier adapter for a provider. Called once at
 * provider-module load time.
 */
export function registerTierAdapter(adapter: TierAdapter): void {
	adapters.set(adapter.provider, adapter);
}

/** Look up the tier adapter registered for `providerName`, if any. */
export function getTierAdapter(providerName: string): TierAdapter | undefined {
	return adapters.get(providerName);
}

/**
 * Strip any client-supplied tier header, then set the provider's in-window
 * tier only for an enabled account inside its window.
 *
 * The delete happens unconditionally (whenever an adapter is registered) so a
 * client can never smuggle a tier upstream, even when this function otherwise
 * does nothing. The default tier is never set explicitly.
 */
export function applyNightWindowHeader(
	headers: Headers,
	providerName: string,
	account: { night_window_enabled?: boolean | number | null },
	window: NightWindow | null,
	nowMs: number = Date.now(),
): void {
	const adapter = adapters.get(providerName);
	if (!adapter) return;

	headers.delete(adapter.header);

	if (!account.night_window_enabled) return;
	if (!window) return;
	if (!isInNightWindow(window, nowMs)) return;

	headers.set(adapter.header, adapter.tier);
}
