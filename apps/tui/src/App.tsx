import { Box, Text, useApp } from "ink";
import SelectInput from "ink-select-input";
import { useState } from "react";
import { AccountsScreen } from "./components/AccountsScreen";
import { LogsScreen } from "./components/LogsScreen";
import { ServerScreen } from "./components/ServerScreen";
import { StatsScreen } from "./components/StatsScreen";

type Screen = "home" | "server" | "accounts" | "stats" | "logs";

export function App() {
	const [screen, setScreen] = useState<Screen>("home");
	const { exit } = useApp();

	const items = [
		{ label: "🚀 Start Server", value: "server" },
		{ label: "👥 Manage Accounts", value: "accounts" },
		{ label: "📊 View Statistics", value: "stats" },
		{ label: "📜 View Logs", value: "logs" },
		{ label: "❌ Exit", value: "exit" },
	];

	const handleSelect = (item: { value: string }) => {
		if (item.value === "exit") {
			exit();
		} else {
			setScreen(item.value as Screen);
		}
	};

	const handleBack = () => {
		setScreen("home");
	};

	if (screen === "home") {
		return (
			<Box flexDirection="column" padding={1}>
				<Box marginBottom={1}>
					<Text color="cyan" bold>
						🎯 Claudeflare TUI
					</Text>
				</Box>
				<Text dimColor>Select an option:</Text>
				<Box marginTop={1}>
					<SelectInput items={items} onSelect={handleSelect} />
				</Box>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" height="100%">
			{screen === "server" && <ServerScreen onBack={handleBack} />}
			{screen === "accounts" && <AccountsScreen onBack={handleBack} />}
			{screen === "stats" && <StatsScreen onBack={handleBack} />}
			{screen === "logs" && <LogsScreen onBack={handleBack} />}
		</Box>
	);
}
