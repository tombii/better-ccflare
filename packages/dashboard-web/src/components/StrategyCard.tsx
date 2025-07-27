import { RefreshCw, Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge } from "./ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";
import { Skeleton } from "./ui/skeleton";

export function StrategyCard() {
	const [currentStrategy, setCurrentStrategy] = useState<string>("");
	const [strategies, setStrategies] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [changing, setChanging] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	const loadData = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);
			const [current, list] = await Promise.all([
				api.getStrategy(),
				api.listStrategies(),
			]);
			setCurrentStrategy(current);
			setStrategies(list);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load data");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadData();
	}, [loadData]);

	const handleStrategyChange = async (newStrategy: string) => {
		if (newStrategy === currentStrategy) return;

		try {
			setChanging(true);
			setError(null);
			setSuccess(false);
			await api.setStrategy(newStrategy);
			setCurrentStrategy(newStrategy);
			setSuccess(true);
			setTimeout(() => setSuccess(false), 3000);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to update strategy",
			);
		} finally {
			setChanging(false);
		}
	};

	if (loading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Load Balancer Strategy</CardTitle>
					<CardDescription>
						Configure how requests are distributed across accounts
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Skeleton className="h-10 w-full" />
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="card-hover">
			<CardHeader>
				<div className="flex items-center justify-between">
					<div>
						<CardTitle className="flex items-center gap-2">
							<Settings className="h-5 w-5" />
							Load Balancer Strategy
						</CardTitle>
						<CardDescription>
							Configure how requests are distributed across accounts
						</CardDescription>
					</div>
					{success && (
						<Badge variant="default" className="bg-success">
							Updated
						</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent>
				<div className="space-y-4">
					<div>
						<p className="text-sm font-medium mb-2">Current Strategy</p>
						<Select
							value={currentStrategy}
							onValueChange={handleStrategyChange}
							disabled={changing}
						>
							<SelectTrigger className="w-full">
								<SelectValue placeholder="Select a strategy" />
							</SelectTrigger>
							<SelectContent>
								{strategies.map((strategy) => (
									<SelectItem key={strategy} value={strategy}>
										{strategy}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{changing && (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<RefreshCw className="h-4 w-4 animate-spin" />
							Updating strategy...
						</div>
					)}

					{error && (
						<div className="text-sm text-destructive">Error: {error}</div>
					)}

					<div className="text-xs text-muted-foreground">
						<p>
							<strong>session:</strong> Maintains 5-hour sessions with a single
							account to minimize rate limits
						</p>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
