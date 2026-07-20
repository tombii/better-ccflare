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
// listed here even though StrategyName defines them.
const STRATEGY_OPTIONS = [
	{ label: "Session", value: "session" },
	{ label: "Session — drain soonest", value: "session-drain-soonest" },
];

export interface RoutingCardViewProps {
	strategy: string;
	onStrategyChange: (strategy: string) => void;
	strategyDisabled: boolean;
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
	capacityMode,
	capacitySource,
	onCapacityChange,
	capacityDisabled,
}: RoutingCardViewProps) {
	const envLocked = capacitySource === "env";

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
						<div className="text-sm font-medium">Load-balancing strategy</div>
						<div className="text-sm text-muted-foreground">
							<span className="font-medium">Session</span> keeps each client on
							one account for the session duration.{" "}
							<span className="font-medium">Session — drain soonest</span>{" "}
							shares the same session semantics but, at every fresh selection,
							prefers the account whose weekly window resets soonest so capacity
							is used before it expires; priority becomes a tiebreaker.
						</div>
						<Select
							disabled={strategyDisabled}
							value={strategy}
							onValueChange={onStrategyChange}
						>
							<SelectTrigger className="w-64">
								<SelectValue placeholder="Select strategy..." />
							</SelectTrigger>
							<SelectContent>
								{STRATEGY_OPTIONS.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
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
								<div className="text-sm font-medium">
									Model-scoped capacity routing
								</div>
								{envLocked && (
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
							disabled={capacityDisabled || envLocked}
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
	const { data: strategy, isLoading: strategyLoading } = useStrategy();
	const setStrategy = useSetStrategy();
	const { data: capacity, isLoading: capacityLoading } =
		useModelCapacityRouting();
	const setCapacity = useSetModelCapacityRouting();

	return (
		<RoutingCardView
			strategy={strategy ?? "session"}
			onStrategyChange={(value) => setStrategy.mutate(value)}
			strategyDisabled={strategyLoading || setStrategy.isPending}
			capacityMode={capacity?.mode ?? "off"}
			capacitySource={capacity?.source ?? "default"}
			onCapacityChange={(mode) => setCapacity.mutate(mode)}
			capacityDisabled={capacityLoading || setCapacity.isPending}
		/>
	);
}
