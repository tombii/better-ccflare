import { StrategyName } from "@better-ccflare/core";
import {
	useModelCapacityRouting,
	useSetModelCapacityRouting,
	useSetStrategy,
	useStrategy,
} from "../../hooks/queries";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";

// Only session-class strategies are offered from the dashboard. Per-request
// spreading strategies (least-used, session-affinity) can trip Claude's
// anti-abuse systems and get accounts banned, so they are deliberately not
// listed here even though StrategyName defines them. Values come from the
// shared StrategyName enum (not hardcoded strings) so this list can never
// drift from the authoritative 4 values in @better-ccflare/core.
const STRATEGY_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
	{ label: "Session", value: StrategyName.Session },
	{
		label: "Session — drain soonest",
		value: StrategyName.SessionDrainSoonest,
	},
];

export interface StrategySelectItem {
	label: string;
	value: string;
	disabled?: boolean;
}

/**
 * Build the strategy Select's item list. The dashboard only offers the two
 * session-class strategies above, but the server's effective strategy
 * (getStrategy()) can be any of the four StrategyName values — settable via
 * LB_STRATEGY, an older config file, or a hand-edited one. An out-of-list
 * value used to leave the Select's trigger blank with no indication it was
 * active, and selecting either listed option would silently overwrite it
 * with no recovery path (routing-settings-ui-2026-07-20 review, rank 1).
 * When the current strategy isn't one of the two listed options, it is
 * appended as a disabled item labelled "<value> (current)" so its state is
 * visible without being re-selectable; the two deliberate options stay
 * selectable.
 */
export function getStrategySelectItems(
	strategy: string,
): readonly StrategySelectItem[] {
	const isListed = STRATEGY_OPTIONS.some((opt) => opt.value === strategy);
	if (isListed) {
		return STRATEGY_OPTIONS;
	}
	return [
		...STRATEGY_OPTIONS,
		{ label: `${strategy} (current)`, value: strategy, disabled: true },
	];
}

export interface RoutingCardViewProps {
	strategy: string;
	onStrategyChange: (strategy: string) => void;
	strategyDisabled: boolean;
	strategySource: "env" | "file" | "default";
	capacityMode: "off" | "exhausted";
	capacitySource: "env" | "file" | "default";
	onCapacityChange: (mode: "off" | "exhausted") => void;
	capacityDisabled: boolean;
}

/**
 * Presentational routing settings card. Kept free of data hooks so it can be
 * rendered with plain props in tests (renderToStaticMarkup); RoutingCard wires
 * it to react-query.
 */
export function RoutingCardView({
	strategy,
	onStrategyChange,
	strategyDisabled,
	strategySource,
	capacityMode,
	capacitySource,
	onCapacityChange,
	capacityDisabled,
}: RoutingCardViewProps) {
	const strategyEnvLocked = strategySource === "env";
	const capacityEnvLocked = capacitySource === "env";
	const strategyItems = getStrategySelectItems(strategy);

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Routing</CardTitle>
				<CardDescription>
					Choose how requests are spread across accounts and whether accounts
					that have exhausted a model's weekly capacity are skipped.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-6">
					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<Label htmlFor="routing-strategy">Load-balancing strategy</Label>
							{strategyEnvLocked && (
								<Badge
									variant="outline"
									title="Set by the LB_STRATEGY environment variable; change the env var to edit this."
								>
									env-locked
								</Badge>
							)}
						</div>
						<div className="text-sm text-muted-foreground">
							<span className="font-medium">Session</span> keeps each client on
							one account for the session duration.{" "}
							<span className="font-medium">Session — drain soonest</span>{" "}
							shares the same session semantics but, at every fresh selection,
							prefers the account whose weekly window resets soonest so capacity
							is used before it expires; priority becomes a tiebreaker.
						</div>
						<Select
							disabled={strategyDisabled || strategyEnvLocked}
							value={strategy}
							onValueChange={onStrategyChange}
						>
							<SelectTrigger id="routing-strategy" className="w-64">
								<SelectValue placeholder="Select strategy..." />
							</SelectTrigger>
							<SelectContent>
								{strategyItems.map((opt) => (
									<SelectItem
										key={opt.value}
										value={opt.value}
										disabled={opt.disabled}
									>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<div className="text-xs text-muted-foreground">
							⚠️ Only session-class strategies are shown. Strategies that spread
							individual requests across accounts can trigger Claude's
							anti-abuse systems and risk account bans.
						</div>
					</div>

					<div className="flex items-center justify-between gap-3">
						<div className="space-y-1">
							<div className="flex items-center gap-2">
								<Label htmlFor="routing-capacity">
									Model-scoped capacity routing
								</Label>
								{capacityEnvLocked && (
									<Badge
										variant="outline"
										title="Set by the MODEL_SCOPED_CAPACITY_ROUTING environment variable; change the env var to edit this."
									>
										env-locked
									</Badge>
								)}
							</div>
							<div className="text-sm text-muted-foreground">
								Skip accounts whose per-model weekly cap is exhausted so clients
								get a fast model_family_exhausted 429 instead of failover
								retries that are guaranteed to fail.
							</div>
						</div>
						<Switch
							id="routing-capacity"
							disabled={capacityDisabled || capacityEnvLocked}
							checked={capacityMode === "exhausted"}
							onCheckedChange={(checked) =>
								onCapacityChange(checked ? "exhausted" : "off")
							}
						/>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

export function RoutingCard() {
	const { data: strategyData, isLoading: strategyLoading } = useStrategy();
	const setStrategy = useSetStrategy();
	const { data: capacity, isLoading: capacityLoading } =
		useModelCapacityRouting();
	const setCapacity = useSetModelCapacityRouting();

	return (
		<RoutingCardView
			strategy={strategyData?.strategy ?? "session"}
			strategySource={strategyData?.strategySource ?? "default"}
			onStrategyChange={(value) => setStrategy.mutate(value)}
			strategyDisabled={strategyLoading || setStrategy.isPending}
			capacityMode={capacity?.mode ?? "off"}
			capacitySource={capacity?.source ?? "default"}
			onCapacityChange={(mode) => setCapacity.mutate(mode)}
			capacityDisabled={capacityLoading || setCapacity.isPending}
		/>
	);
}
