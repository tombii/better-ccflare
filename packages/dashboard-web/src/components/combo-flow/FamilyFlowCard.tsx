import { ChevronRight } from "lucide-react";
import type { ComboFlowCombo, ComboFlowFamily } from "../../api";
import { formatFamilyLabel } from "../../lib/pool-usage";
import { formatShortDuration } from "../overview/pool-usage-shared";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader } from "../ui/card";
import { SlotChain } from "./SlotChain";

export interface FamilyFlowCardProps {
	family: ComboFlowFamily;
	/** The combo entry for `family.combo`, when it still exists. */
	combo: ComboFlowCombo | null;
	now: number;
	/**
	 * False when the global routing switches mean combos are not consulted at
	 * all (combos disabled or "force account model" on). The chain is still
	 * rendered — it just is not what the proxy is doing.
	 */
	routingActive?: boolean;
}

/**
 * One model family's flow: [client `<family>` models] → [Combo: name] →
 * slot chain in priority order. Pure props so it can be server-rendered in
 * tests; all data comes from GET /api/combos/flow.
 */
export function FamilyFlowCard({
	family,
	combo,
	now,
	routingActive = true,
}: FamilyFlowCardProps) {
	const assigned = family.assignmentEnabled && family.combo !== null;
	const lastPickedId = family.observation?.order[0]?.id ?? null;

	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
				<div className="flex items-center gap-2">
					<span className="inline-flex items-center justify-center rounded bg-muted px-2 py-0.5 text-xs font-semibold">
						{formatFamilyLabel(family.family)}
					</span>
					<span className="text-xs text-muted-foreground">
						client <code>{family.family}</code> models
					</span>
					{!routingActive && (
						<Badge
							variant="outline"
							className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
							title="Combo routing is inactive — this chain shows what would route if combos were enabled"
						>
							routing off
						</Badge>
					)}
				</div>
				{family.observation && (
					<span className="text-xs text-muted-foreground">
						observed{" "}
						{formatShortDuration(
							Math.max(0, now - family.observation.observedAtMs),
						)}{" "}
						ago
					</span>
				)}
			</CardHeader>
			<CardContent className="space-y-3">
				{!assigned ? (
					<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<span>
							{family.combo && !family.assignmentEnabled
								? "Assignment disabled —"
								: "No combo assigned —"}{" "}
							normal pool routing.
						</span>
						{/* Plain <a> — a client-side Link needs a Router context, and
						    this component is server-rendered in tests. A full navigation
						    to /combos is fine for a settings link. */}
						<a
							href="/combos"
							className="text-primary underline-offset-2 hover:underline"
						>
							Set up in Combos
						</a>
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-1">
						<Badge variant="secondary">
							{formatFamilyLabel(family.family)} models
						</Badge>
						<ChevronRight
							className="h-3 w-3 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
						<span className="inline-flex items-center gap-1 rounded-full border border-primary px-2 py-0.5 text-xs text-primary">
							Combo: {family.combo?.name}
							<Badge
								variant={family.combo?.enabled ? "success" : "warning"}
								className="px-1.5 py-0 text-[10px]"
							>
								{family.combo?.enabled ? "enabled" : "disabled"}
							</Badge>
						</span>
						<ChevronRight
							className="h-3 w-3 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
						{combo ? (
							<SlotChain
								slots={combo.slots}
								lastPickedAccountId={lastPickedId}
								now={now}
							/>
						) : (
							<span className="text-xs text-muted-foreground">
								Assigned combo no longer exists.
							</span>
						)}
					</div>
				)}
				{assigned && combo && lastPickedId === null && (
					<p className="text-xs text-muted-foreground">
						No routing decision observed for this family since the proxy
						started.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
