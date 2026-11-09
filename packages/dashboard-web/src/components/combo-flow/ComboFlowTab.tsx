import { AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { ComboFlowCombo, RequestSummary } from "../../api";
import { useComboFlow, useRequests } from "../../hooks/queries";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { FamilyFlowCard } from "./FamilyFlowCard";
import { MatrixAndStats } from "./MatrixAndStats";
import { RecentRequests } from "./RecentRequests";

const RECENT_ROWS = 15;

/** Requests belonging to one combo, newest first. */
function filterByCombo(
	requests: RequestSummary[],
	comboName: string,
): RequestSummary[] {
	return requests
		.filter((r) => r.comboName === comboName)
		.sort(
			(a, b) =>
				new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
		);
}

function ComboDetail({
	combo,
	requests,
}: {
	combo: ComboFlowCombo;
	requests: RequestSummary[];
}) {
	return (
		<Tabs defaultValue="matrix">
			<TabsList>
				<TabsTrigger value="matrix">Matrix &amp; stats</TabsTrigger>
				<TabsTrigger value="recent">Recent requests</TabsTrigger>
			</TabsList>
			<TabsContent value="matrix">
				<MatrixAndStats combo={combo} />
			</TabsContent>
			<TabsContent value="recent">
				<RecentRequests
					requests={filterByCombo(requests, combo.name)}
					limit={RECENT_ROWS}
				/>
			</TabsContent>
		</Tabs>
	);
}

/**
 * Combo Flow page root: family → combo → slot chains, each followed by that
 * combo's 24h matrix & stats (the default tab) and recent combo-tagged
 * requests.
 */
export function ComboFlowTab() {
	const { data, isLoading, error } = useComboFlow();
	const { data: requestPages } = useRequests(200);
	const now = data?.generatedAt ?? Date.now();

	const comboById = useMemo(
		() => new Map((data?.combos ?? []).map((c) => [c.id, c])),
		[data],
	);
	// The summary rows live in `detailsMap` (useRequests' placeholder list has
	// no model/account fields); tolerate the array form RequestsTab also does.
	const requests = useMemo<RequestSummary[]>(() => {
		if (!requestPages) return [];
		const map = requestPages.detailsMap;
		return map instanceof Map
			? (Array.from(map.values()) as RequestSummary[])
			: Array.isArray(map)
				? (map as unknown as RequestSummary[])
				: [];
	}, [requestPages]);

	if (isLoading) {
		return (
			<div className="space-y-4">
				{["a", "b", "c", "d"].map((key) => (
					<Skeleton key={key} className="h-32 w-full" />
				))}
			</div>
		);
	}
	if (error) {
		return (
			<Card>
				<CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
					<AlertTriangle
						className="h-4 w-4 text-yellow-500"
						aria-hidden="true"
					/>
					Failed to load the combo flow: {error.message}
				</CardContent>
			</Card>
		);
	}
	if (!data || data.combos.length === 0) {
		return (
			<Card>
				<CardContent className="space-y-2 p-6 text-sm text-muted-foreground">
					<p>No combos configured — nothing to show yet.</p>
					<Link
						to="/combos"
						className="text-primary underline-offset-2 hover:underline"
					>
						Set up combos
					</Link>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-4">
			<p className="text-xs text-muted-foreground">
				Family → combo → account/model chain, with the last routing decision
				observed by the proxy. Stats cover the last {data.windows.requestsHours}
				h; only this process's observations are available (none survive a
				restart).
			</p>
			{data.families.map((family) => {
				// Only show the combo detail once, under the first family that
				// assigns it; the chain itself is repeated for every family.
				const combo = family.combo
					? (comboById.get(family.combo.id) ?? null)
					: null;
				const showDetail =
					combo !== null &&
					data.families.find(
						(f) => f.assignmentEnabled && f.combo?.id === combo.id,
					)?.family === family.family;
				return (
					<div key={family.family} className="space-y-2">
						<FamilyFlowCard family={family} combo={combo} now={now} />
						{showDetail && combo && (
							<Card>
								<CardHeader className="pb-2">
									<CardTitle className="text-sm">
										How “{combo.name}” routes
									</CardTitle>
								</CardHeader>
								<CardContent>
									<ComboDetail combo={combo} requests={requests} />
								</CardContent>
							</Card>
						)}
					</div>
				);
			})}
		</div>
	);
}
