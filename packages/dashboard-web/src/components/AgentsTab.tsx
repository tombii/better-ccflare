import { AlertCircle, Bot, RefreshCw } from "lucide-react";
import { useAgents, useUpdateAgentPreference } from "../hooks/queries";
import { AgentCard } from "./agents";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import { Skeleton } from "./ui/skeleton";

export function AgentsTab() {
	const { data: agents, isLoading, error, refetch } = useAgents();
	const updatePreference = useUpdateAgentPreference();

	const handleModelChange = (agentId: string, model: string) => {
		updatePreference.mutate({ agentId, model });
	};

	if (isLoading) {
		return (
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{[...Array(6)].map((_, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton elements
					<Card key={i}>
						<CardHeader>
							<Skeleton className="h-6 w-32" />
							<Skeleton className="h-4 w-full mt-2" />
							<Skeleton className="h-4 w-3/4" />
						</CardHeader>
						<CardContent>
							<Skeleton className="h-4 w-24" />
						</CardContent>
					</Card>
				))}
			</div>
		);
	}

	if (error) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-destructive">
						<AlertCircle className="h-5 w-5" />
						Error Loading Agents
					</CardTitle>
					<CardDescription>
						{error instanceof Error ? error.message : "Failed to load agents"}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Button onClick={() => refetch()} variant="outline" size="sm">
						<RefreshCw className="mr-2 h-4 w-4" />
						Retry
					</Button>
				</CardContent>
			</Card>
		);
	}

	if (!agents || agents.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Bot className="h-5 w-5" />
						No Agents Found
					</CardTitle>
					<CardDescription>
						No agent definition files found in ~/.claude/agents/
					</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-muted-foreground">
						To add agents, create markdown files in the ~/.claude/agents/
						directory with the following format:
					</p>
					<pre className="mt-4 p-4 bg-muted rounded-md text-xs">
						{`---
name: My Agent
description: Description of what this agent does
color: blue
model: claude-sonnet-4-20250514
---

Your system prompt content here...`}
					</pre>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h2 className="text-2xl font-semibold flex items-center gap-2">
					<Bot className="h-6 w-6" />
					Agents ({agents.length})
				</h2>
			</div>
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{agents.map((agent) => (
					<AgentCard
						key={agent.id}
						agent={agent}
						onModelChange={handleModelChange}
						isUpdating={updatePreference.isPending}
					/>
				))}
			</div>
		</div>
	);
}
