import { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import * as tuiCore from "@claudeflare/tui-core";

interface LogsScreenProps {
	onBack: () => void;
}

interface LogEntry {
	ts: number;
	level: string;
	msg: string;
}

export function LogsScreen({ onBack }: LogsScreenProps) {
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [paused, setPaused] = useState(false);

	useInput((input, key) => {
		if (key.escape || input === "q") {
			onBack();
		}
		if (input === " ") {
			setPaused(!paused);
		}
		if (input === "c") {
			setLogs([]);
		}
	});

	useEffect(() => {
		if (!paused) {
			const unsubscribe = tuiCore.streamLogs((log) => {
				setLogs((prev) => [...prev.slice(-100), log]); // Keep last 100 logs
			});

			return () => {
				unsubscribe();
			};
		}
	}, [paused]);

	const getLogColor = (level: string) => {
		switch (level.toUpperCase()) {
			case "ERROR":
				return "red";
			case "WARN":
				return "yellow";
			case "INFO":
				return "green";
			case "DEBUG":
				return "gray";
			default:
				return "white";
		}
	};

	return (
		<Box flexDirection="column" padding={1} height="100%">
			<Box marginBottom={1}>
				<Text color="cyan" bold>
					📜 Logs {paused && <Text color="yellow">(PAUSED)</Text>}
				</Text>
			</Box>

			<Box flexDirection="column" flexGrow={1}>
				{logs.length === 0 ? (
					<Text dimColor>No logs yet...</Text>
				) : (
					logs.map((log, i) => (
						<Box key={`${log.ts}-${i}`}>
							<Text color={getLogColor(log.level)}>
								[{log.level}] {log.msg}
							</Text>
						</Box>
					))
				)}
			</Box>

			<Box marginTop={1}>
				<Text dimColor>
					SPACE: {paused ? "Resume" : "Pause"} • 'c': Clear • 'q'/ESC: Back
				</Text>
			</Box>
		</Box>
	);
}
