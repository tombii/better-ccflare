import { useEffect, useState } from "react";
import type { SearchProviderStatus as Status } from "../../lib/search-provider-types";
import { cn } from "../../lib/utils";

/**
 * Status dot + a short label. "cooldown" renders the remaining time, which
 * ticks down once a second while it is in the future.
 */

const STATUS_STYLES: Record<Status, { dot: string; label: string }> = {
	unknown: { dot: "bg-muted-foreground/50", label: "Not tested" },
	ok: { dot: "bg-green-500", label: "OK" },
	error: { dot: "bg-destructive", label: "Error" },
	// Amber: no token exists, so it uses the warning palette explicitly.
	cooldown: { dot: "bg-amber-500", label: "Cooling down" },
};

export function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h`;
}

function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [active]);
	return now;
}

export function SearchProviderStatus({
	status,
	statusMessage,
	cooldownUntil,
	testedAt,
}: {
	status: Status;
	statusMessage: string | null;
	cooldownUntil: number | null;
	/** Optional: when the status was last checked (epoch ms). */
	testedAt?: number | null;
}) {
	const coolingDown =
		status === "cooldown" &&
		cooldownUntil !== null &&
		cooldownUntil > Date.now();
	const now = useNow(coolingDown);
	const inCooldown =
		coolingDown && cooldownUntil !== null && cooldownUntil > now;
	const style = STATUS_STYLES[status];

	const base = inCooldown
		? `${style.label} · ${formatRemaining(cooldownUntil - now)}`
		: style.label;
	const label =
		testedAt != null
			? `${base} · checked ${formatAge(now - testedAt)} ago`
			: base;

	return (
		<div
			className="flex min-w-0 items-center gap-1.5"
			title={statusMessage ?? undefined}
		>
			<span
				className={cn("h-2 w-2 shrink-0 rounded-full", style.dot)}
				aria-hidden="true"
			/>
			<span className="truncate text-xs text-muted-foreground">{label}</span>
			{statusMessage && !inCooldown && (
				<span className="sr-only">: {statusMessage}</span>
			)}
		</div>
	);
}
