import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import type { ComboFlowSlot } from "../../api";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { formatClockUtc, slotModelLabel } from "./format";

export interface SlotChainProps {
	slots: ComboFlowSlot[];
	/** Account id of the family's last-observed first pick, if any. */
	lastPickedAccountId?: string | null;
	now: number;
}

/**
 * The combo's slots in priority order, rendered as the same pill chain that
 * ObservedRoutingTable uses (ChevronRight between pills). The last-picked
 * pill gets the primary highlight; a cooling or missing account gets a
 * warning treatment.
 */
export function SlotChain({ slots, lastPickedAccountId, now }: SlotChainProps) {
	if (slots.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">
				No slots in this combo — requests can't be routed through it.
			</p>
		);
	}
	return (
		<div className="flex flex-wrap items-center gap-1">
			{slots.map((slot, index) => {
				const cooling = slot.cooldownUntil !== null && slot.cooldownUntil > now;
				// A passthrough slot (no model of its own) can still be skipped
				// for whatever model the client requested — that shows up as
				// per-model cooldowns on the account rather than `cooldownUntil`.
				const passthroughCooldowns = slot.passthrough
					? (slot.cooldowns ?? [])
					: [];
				const degraded =
					cooling ||
					passthroughCooldowns.length > 0 ||
					!slot.available ||
					!slot.enabled;
				const isLastPicked =
					!!lastPickedAccountId && slot.accountId === lastPickedAccountId;
				const passthroughNote =
					passthroughCooldowns.length > 0
						? " · availability depends on the requested model"
						: "";
				return (
					<Fragment key={slot.id}>
						{index > 0 && (
							<ChevronRight
								className="h-3 w-3 shrink-0 text-muted-foreground"
								aria-hidden="true"
							/>
						)}
						<span
							className={cn(
								"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
								isLastPicked
									? "border-primary text-primary"
									: "border-border text-muted-foreground",
								degraded && "border-yellow-500/60 ring-1 ring-yellow-500/40",
							)}
							title={`Priority ${slot.priority} of ${slots.length}${slot.enabled ? "" : " (disabled)"}${passthroughNote}`}
						>
							<span
								className={cn(
									"flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
									isLastPicked
										? "bg-primary text-primary-foreground"
										: "bg-muted text-muted-foreground",
								)}
							>
								{index + 1}
							</span>
							<span className="font-medium text-foreground">
								{slot.accountName ?? slot.accountId}
							</span>
							<span>· {slotModelLabel(slot.model)}</span>
							{slot.provider && (
								<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
									{slot.provider}
								</Badge>
							)}
							{cooling && slot.cooldownUntil !== null && (
								<Badge variant="warning" className="px-1.5 py-0 text-[10px]">
									Cooling · {formatClockUtc(slot.cooldownUntil)}
								</Badge>
							)}
							{passthroughCooldowns.slice(0, 2).map((cooldown) => (
								<Badge
									key={`${cooldown.model}|${cooldown.until}`}
									variant="warning"
									className="px-1.5 py-0 text-[10px]"
									title="This account is cooling for a specific model; whether the slot is skipped depends on the model the client requested"
								>
									Cooling (model-dependent) · {cooldown.model} ·{" "}
									{formatClockUtc(cooldown.until)}
								</Badge>
							))}
							{passthroughCooldowns.length > 2 && (
								<Badge
									variant="warning"
									className="px-1.5 py-0 text-[10px]"
									title={passthroughCooldowns
										.slice(2)
										.map((c) => `${c.model} until ${formatClockUtc(c.until)}`)
										.join(", ")}
								>
									+{passthroughCooldowns.length - 2}
								</Badge>
							)}
							{!slot.enabled && (
								<Badge variant="outline" className="px-1.5 py-0 text-[10px]">
									disabled
								</Badge>
							)}
							{slot.enabled && !cooling && !slot.available && (
								<Badge
									variant="warning"
									className="px-1.5 py-0 text-[10px]"
									title={
										slot.accountName === null
											? "The slot references an account that no longer exists"
											: "The account is paused, needs re-authentication, or is rate-limited — the selector skips this slot"
									}
								>
									{slot.accountName === null
										? "account missing"
										: "unavailable"}
								</Badge>
							)}
						</span>
					</Fragment>
				);
			})}
		</div>
	);
}
