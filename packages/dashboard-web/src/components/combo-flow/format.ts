/**
 * Small display helpers for the Combo Flow view. Pure functions so they can be
 * unit-tested and used by server-rendered components alike.
 */

/** "HH:MM:SSZ" (UTC) — used for cooldown deadlines, which the server records
 * as epoch ms and logs are displayed in UTC. */
export function formatClockUtc(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** "14:03:27" (local) for a request timestamp (epoch ms). */
export function formatTimeOfDay(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 0..1 → "98.4%", or "—" when null. */
export function formatRate(rate: number | null): string {
	if (rate === null || !Number.isFinite(rate)) return "—";
	return `${(rate * 100).toFixed(1)}%`;
}

/** Milliseconds → "1.2s" / "850ms", or "—" when null. */
export function formatMs(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms)) return "—";
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms)}ms`;
}

/** A slot's model, showing an explicit label for passthrough (empty model). */
export function slotModelLabel(model: string): string {
	return model === "" ? "passthrough" : model;
}
