import {
	formatCost,
	formatDuration,
	formatTokens,
} from "@claudeflare/ui-common";
import type { RequestSummary } from "../api";

interface TokenUsageDisplayProps {
	summary: RequestSummary | undefined;
}

export function TokenUsageDisplay({ summary }: TokenUsageDisplayProps) {
	if (!summary || (!summary.inputTokens && !summary.outputTokens)) {
		return (
			<div className="text-center text-muted-foreground py-8">
				<p>No token usage data available</p>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="grid grid-cols-2 gap-4">
				{summary.inputTokens !== undefined && (
					<div className="bg-muted p-4 rounded-lg">
						<h4 className="font-semibold mb-2">Input Tokens</h4>
						<p className="text-2xl font-mono">
							{formatTokens(summary.inputTokens)}
						</p>
					</div>
				)}

				{summary.outputTokens !== undefined && (
					<div className="bg-muted p-4 rounded-lg">
						<h4 className="font-semibold mb-2">Output Tokens</h4>
						<p className="text-2xl font-mono">
							{formatTokens(summary.outputTokens)}
						</p>
					</div>
				)}

				{summary.cacheReadInputTokens !== undefined &&
					summary.cacheReadInputTokens > 0 && (
						<div className="bg-muted p-4 rounded-lg">
							<h4 className="font-semibold mb-2">Cache Read Tokens</h4>
							<p className="text-2xl font-mono">
								{formatTokens(summary.cacheReadInputTokens)}
							</p>
						</div>
					)}

				{summary.cacheCreationInputTokens !== undefined &&
					summary.cacheCreationInputTokens > 0 && (
						<div className="bg-muted p-4 rounded-lg">
							<h4 className="font-semibold mb-2">Cache Creation Tokens</h4>
							<p className="text-2xl font-mono">
								{formatTokens(summary.cacheCreationInputTokens)}
							</p>
						</div>
					)}
			</div>

			{summary.totalTokens !== undefined && (
				<div className="bg-primary/10 p-4 rounded-lg">
					<h4 className="font-semibold mb-2">Total Tokens</h4>
					<p className="text-3xl font-mono font-bold">
						{formatTokens(summary.totalTokens)}
					</p>
					{summary.costUsd && summary.costUsd > 0 && (
						<p className="mt-2 text-lg text-muted-foreground">
							Cost: {formatCost(summary.costUsd)}
						</p>
					)}
				</div>
			)}

			{summary.responseTimeMs && (
				<div className="bg-muted p-4 rounded-lg">
					<h4 className="font-semibold mb-2">Response Time</h4>
					<p className="text-2xl font-mono">
						{formatDuration(summary.responseTimeMs)}
					</p>
				</div>
			)}
		</div>
	);
}
