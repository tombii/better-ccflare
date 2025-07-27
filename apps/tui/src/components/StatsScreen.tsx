import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import * as tuiCore from "@claudeflare/tui-core";

interface StatsScreenProps {
	onBack: () => void;
}

export function StatsScreen({ onBack }: StatsScreenProps) {
	const [stats, setStats] = useState<any>(null);
	const [loading, setLoading] = useState(true);

	useInput((input, key) => {
		if (key.escape || input === "q") {
			onBack();
		}
		if (input === "r") {
			loadStats();
		}
	});

	useEffect(() => {
		loadStats();
		const interval = setInterval(loadStats, 5000); // Auto-refresh every 5 seconds
		return () => clearInterval(interval);
	}, []);

	const loadStats = async () => {
		try {
			const data = await tuiCore.getStats();
			setStats(data);
			setLoading(false);
		} catch (error) {
			setLoading(false);
		}
	};

	if (loading) {
		return (
			<Box flexDirection="column" padding={1}>
				<Text color="cyan" bold>
					📊 Statistics
				</Text>
				<Text dimColor>Loading...</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text color="cyan" bold>
					📊 Statistics
				</Text>
			</Box>

			{stats && (
				<Box flexDirection="column">
					<Box marginBottom={1}>
						<Text bold>Overall Stats</Text>
						<Box flexDirection="column" marginLeft={2}>
							<Text>Total Requests: {stats.totalRequests || 0}</Text>
							<Text>Success Rate: {stats.successRate || 0}%</Text>
							<Text>Active Accounts: {stats.activeAccounts || 0}</Text>
						</Box>
					</Box>

					{stats.accounts && stats.accounts.length > 0 && (
						<Box flexDirection="column">
							<Text bold>Account Usage</Text>
							{stats.accounts.map((acc: any) => (
								<Box key={acc.name} marginLeft={2}>
									<Text>
										{acc.name}: {acc.requestCount || 0} requests (
										{acc.successRate || 0}% success)
									</Text>
								</Box>
							))}
						</Box>
					)}

					{stats.recentErrors && stats.recentErrors.length > 0 && (
						<Box flexDirection="column" marginTop={1}>
							<Text bold color="red">
								Recent Errors
							</Text>
							{stats.recentErrors.slice(0, 5).map((error: any, i: number) => (
								<Box key={i} marginLeft={2}>
									<Text dimColor>{error}</Text>
								</Box>
							))}
						</Box>
					)}
				</Box>
			)}

			<Box marginTop={2}>
				<Text dimColor>Press 'r' to refresh • 'q' or ESC to go back</Text>
			</Box>
		</Box>
	);
}
