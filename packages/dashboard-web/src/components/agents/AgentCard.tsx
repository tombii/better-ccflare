import type { Agent } from "@ccflare/types";
import { ALLOWED_MODELS } from "@ccflare/types";
import { Bot } from "lucide-react";
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

interface AgentCardProps {
	agent: Agent;
	onModelChange?: (agentId: string, model: string) => void;
	isUpdating?: boolean;
}

export function AgentCard({
	agent,
	onModelChange,
	isUpdating,
}: AgentCardProps) {
	// Map color names to Tailwind classes
	const colorMap: Record<string, string> = {
		gray: "border-gray-500",
		blue: "border-blue-500",
		green: "border-green-500",
		yellow: "border-yellow-500",
		orange: "border-orange-500",
		red: "border-red-500",
		purple: "border-purple-500",
		pink: "border-pink-500",
		indigo: "border-indigo-500",
	};

	const borderColorClass = colorMap[agent.color] || colorMap.gray;

	return (
		<Card className={`${borderColorClass} border-2`}>
			<CardHeader>
				<div className="flex items-start justify-between">
					<div className="flex items-center gap-2">
						<Bot className="h-5 w-5 text-muted-foreground" />
						<CardTitle className="text-lg">{agent.name}</CardTitle>
					</div>
				</div>
				<CardDescription className="mt-2 text-sm whitespace-pre-wrap">
					{agent.description}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="space-y-2">
					<p className="text-sm font-medium">Model</p>
					<Select
						value={agent.model}
						onValueChange={(value) => onModelChange?.(agent.id, value)}
						disabled={isUpdating}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{ALLOWED_MODELS.map((model) => (
								<SelectItem key={model} value={model}>
									{model.replace("claude-", "").replace("-20250514", "")}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="text-xs text-muted-foreground">
					<span className="font-mono">ID: {agent.id}</span>
				</div>
			</CardContent>
		</Card>
	);
}
