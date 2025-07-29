import { formatPercentage } from "@claudeflare/ui-common";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent } from "../ui/card";

export interface MetricCardProps {
	title: string;
	value: string | number;
	change?: number;
	icon: React.ComponentType<{ className?: string }>;
	trend?: "up" | "down" | "flat";
}

export function MetricCard({
	title,
	value,
	change,
	icon: Icon,
	trend,
}: MetricCardProps) {
	return (
		<Card>
			<CardContent className="p-6">
				<div className="flex items-center justify-between mb-4">
					<Icon className="h-8 w-8 text-muted-foreground/20" />
					{trend !== "flat" && change !== undefined && (
						<div
							className={`flex items-center gap-1 text-sm font-medium ${
								trend === "up" ? "text-success" : "text-destructive"
							}`}
						>
							{trend === "up" ? (
								<TrendingUp className="h-4 w-4" />
							) : (
								<TrendingDown className="h-4 w-4" />
							)}
							<span>{formatPercentage(Math.abs(change), 0)}</span>
						</div>
					)}
				</div>
				<div className="space-y-1">
					<p className="text-sm text-muted-foreground">{title}</p>
					<p className="text-2xl font-bold">{value}</p>
				</div>
			</CardContent>
		</Card>
	);
}
