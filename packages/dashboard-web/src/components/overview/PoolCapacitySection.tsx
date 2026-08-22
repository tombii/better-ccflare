import type { ComponentType } from "react";
import type { RoutingObservation } from "../../api";
import { usePersistedExpansion } from "../../hooks/usePersistedExpansion";
import type { PoolCardWindow, PoolUsageResult } from "../../lib/pool-usage";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { ObservedRoutingTable } from "./ObservedRoutingTable";
import { PoolUsageRow } from "./PoolUsageRow";

const STORAGE_KEY = "ccflare.poolCapacity.expanded";

export interface PoolCapacitySectionPool {
	id: string;
	title: string;
	icon: ComponentType<{ className?: string }>;
	result: PoolUsageResult;
	window: PoolCardWindow;
}

interface PoolCapacitySectionProps {
	pools: PoolCapacitySectionPool[];
	// Name of the account the active load-balancing strategy would pick next
	// (AccountResponse.isPrimary), passed through to every PoolUsageRow for
	// its "next" badge. Resolved once by the caller (OverviewTab) -- see its
	// comment for why this must never be recomputed here.
	primaryAccountName?: string | null;
	// Current time (ms), refreshed every 30s by the caller (OverviewTab) --
	// drives the ObservedRoutingTable's "observed Xs/Xm ago" age label and
	// each pool row's per-segment relative reset time.
	now: number;
	// The full /api/routing/observations response map, keyed by the proxy's
	// (lowercase) getModelFamily() result -- rendered in full by
	// ObservedRoutingTable (the single place the observed routing order is
	// shown). Undefined/null while the query hasn't loaded yet, or once
	// loaded but empty -- both simply render no extra block.
	observations?: Record<string, RoutingObservation> | null;
}

/**
 * The "Pool capacity" card that replaces the previous separate 5h/7d/family
 * PoolMetricCards: one row per pool (PoolUsageRow), each independently
 * expandable into a per-account segmented bar. Expansion state is persisted
 * across reloads via usePersistedExpansion.
 */
export function PoolCapacitySection({
	pools,
	primaryAccountName,
	now,
	observations,
}: PoolCapacitySectionProps) {
	const { isExpanded, toggle, expandAll, collapseAll, expandedCount } =
		usePersistedExpansion(STORAGE_KEY);

	if (pools.length === 0) return null;

	const allExpanded = expandedCount >= pools.length;

	return (
		<Card>
			<CardContent className="p-6">
				<div className="mb-2 flex items-center justify-between">
					<h3 className="text-sm font-medium">Pool capacity</h3>
					<Button
						variant="ghost"
						size="sm"
						onClick={() =>
							allExpanded
								? collapseAll()
								: expandAll(pools.map((pool) => pool.id))
						}
					>
						{allExpanded ? "Collapse all" : "Expand all"}
					</Button>
				</div>
				<div>
					{pools.map((pool) => (
						<PoolUsageRow
							key={pool.id}
							id={pool.id}
							title={pool.title}
							icon={pool.icon}
							result={pool.result}
							window={pool.window}
							isExpanded={isExpanded(pool.id)}
							onToggle={() => toggle(pool.id)}
							primaryAccountName={primaryAccountName}
							now={now}
						/>
					))}
				</div>
				<ObservedRoutingTable observations={observations} now={now} />
			</CardContent>
		</Card>
	);
}
