import type { UsageData } from "../../usage-fetcher";

/** The two Codex rate-limit windows a session can ride. */
export type CodexWindowSlot = "five_hour" | "seven_day";

/** Narrow view of a `UsageData` payload restricted to the Codex slots. */
type CodexWindows = Partial<
	Record<CodexWindowSlot, { utilization?: number; resets_at?: string | null }>
>;

function readSlot(
	usage: UsageData | null | undefined,
	slot: CodexWindowSlot,
): { utilization?: number; resets_at?: string | null } | undefined {
	return (usage as CodexWindows | null | undefined)?.[slot];
}

function resetMs(
	usage: UsageData | null | undefined,
	slot: CodexWindowSlot,
): number {
	const resetsAt = readSlot(usage, slot)?.resets_at;
	return resetsAt != null ? new Date(resetsAt).getTime() : Number.NaN;
}

/**
 * Which window a Codex session "rides": the 5-hour one when the payload
 * reports it, else the weekly one (Pro accounts have no 5-hour window).
 * Both sides of a rollover comparison must read the same slot — a 5-hour
 * boundary held against a weekly one would fabricate a rollover.
 *
 * `pinFiveHour` mirrors `CODEX_FIVE_HOUR_WINDOW_ENABLED`: with it the slot
 * stays on the 5-hour window as it was before OpenAI withdrew that window,
 * regardless of what the payload reports.
 */
export function pickCodexRolloverSlot(
	usage: UsageData | null | undefined,
	pinFiveHour = false,
): CodexWindowSlot {
	return pinFiveHour || readSlot(usage, "five_hour")?.resets_at != null
		? "five_hour"
		: "seven_day";
}

/**
 * True only for a REAL Codex window rollover: the previously known reset has
 * passed (`prevResetAt <= observedAt`), the new reset is later, and
 * utilization dropped.
 *
 * OpenAI's 5-hour deadline slides forward while an account is idle (observed
 * in production: 17:59 → 18:23 between two probes at 0 % used), so "the reset
 * moved into the future" alone is NOT a rollover — treating it as one resets
 * session/prompt-cache affinity on nearly every poll (commits c11acc5f /
 * 496cbb07 fixed exactly that on the traffic path; this helper is that
 * predicate, shared by the traffic path and the poller).
 */
export function codexWindowRolledOver(
	prev: UsageData | null | undefined,
	next: UsageData,
	observedAt: number,
	slot: CodexWindowSlot,
): boolean {
	if (!prev) return false;

	const prevMs = resetMs(prev, slot);
	const nextMs = resetMs(next, slot);
	if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs)) return false;
	if (prevMs > observedAt || nextMs <= prevMs) return false;

	const prevUtilization = readSlot(prev, slot)?.utilization;
	const nextUtilization = readSlot(next, slot)?.utilization;
	return (
		typeof prevUtilization === "number" &&
		typeof nextUtilization === "number" &&
		nextUtilization < prevUtilization
	);
}
