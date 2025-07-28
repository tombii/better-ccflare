import type { RequestSummary } from "@claudeflare/tui-core";
import { formatCost, formatTokens } from "@claudeflare/ui-common";
import { Box, Text } from "ink";

interface TokenUsageDisplayProps {
	summary: RequestSummary;
}

export function TokenUsageDisplay({ summary }: TokenUsageDisplayProps) {
	if (!summary.inputTokens && !summary.outputTokens) {
		return (
			<Box flexDirection="column" marginTop={1}>
				<Text dimColor>No token usage data available</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text bold>Token Usage:</Text>
			<Box marginLeft={2} flexDirection="column">
				{summary.inputTokens !== undefined && (
					<Box>
						<Text>Input Tokens: </Text>
						<Text color="yellow" bold>
							{formatTokens(summary.inputTokens)}
						</Text>
					</Box>
				)}

				{summary.outputTokens !== undefined && (
					<Box>
						<Text>Output Tokens: </Text>
						<Text color="yellow" bold>
							{formatTokens(summary.outputTokens)}
						</Text>
					</Box>
				)}

				{summary.cacheReadInputTokens !== undefined &&
					summary.cacheReadInputTokens > 0 && (
						<Box>
							<Text>Cache Read Tokens: </Text>
							<Text color="cyan" bold>
								{formatTokens(summary.cacheReadInputTokens)}
							</Text>
						</Box>
					)}

				{summary.cacheCreationInputTokens !== undefined &&
					summary.cacheCreationInputTokens > 0 && (
						<Box>
							<Text>Cache Creation Tokens: </Text>
							<Text color="cyan" bold>
								{formatTokens(summary.cacheCreationInputTokens)}
							</Text>
						</Box>
					)}

				<Box marginTop={1}>
					<Text>─────────────────────</Text>
				</Box>

				{summary.totalTokens !== undefined && (
					<Box>
						<Text bold>Total Tokens: </Text>
						<Text color="green" bold>
							{formatTokens(summary.totalTokens)}
						</Text>
					</Box>
				)}

				{summary.costUsd !== undefined && (
					<Box>
						<Text bold>Cost: </Text>
						<Text color="green" bold>
							{formatCost(summary.costUsd)}
						</Text>
					</Box>
				)}
			</Box>
		</Box>
	);
}
