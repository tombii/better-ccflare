import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import * as tuiCore from "@claudeflare/tui-core";

interface ServerScreenProps {
	onBack: () => void;
}

export function ServerScreen({ onBack }: ServerScreenProps) {
	const [status, setStatus] = useState<"starting" | "running" | "error">(
		"starting",
	);
	const [url, setUrl] = useState<string>("");
	const [error, setError] = useState<string>("");

	useInput((input, key) => {
		if (key.escape || input === "q") {
			onBack();
		}
		if (input === "d" && status === "running") {
			// Open dashboard in browser
			import("open" as any)
				.then((open: any) => {
					open.default(url);
				})
				.catch(() => {
					// Fallback if open package is not available
					console.log(`\nOpen dashboard at: ${url}`);
				});
		}
	});

	useEffect(() => {
		let cleanup: (() => void) | undefined;

		const startServer = async () => {
			try {
				const result = await tuiCore.serve({
					port: 8080,
					withDashboard: true,
				});
				setStatus("running");
				setUrl(`http://localhost:${result.port}`);
				cleanup = result.cleanup;
			} catch (err) {
				setStatus("error");
				setError(err instanceof Error ? err.message : "Unknown error");
			}
		};

		startServer();

		return () => {
			if (cleanup) {
				cleanup();
			}
		};
	}, []);

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text color="cyan" bold>
					🚀 Server
				</Text>
			</Box>

			{status === "starting" && (
				<Box>
					<Text color="yellow">
						<Spinner type="dots" /> Starting server...
					</Text>
				</Box>
			)}

			{status === "running" && (
				<Box flexDirection="column">
					<Text color="green">✓ Server running at {url}</Text>
					<Box marginTop={1}>
						<Text dimColor>Press 'd' to open dashboard in browser</Text>
					</Box>
				</Box>
			)}

			{status === "error" && (
				<Box flexDirection="column">
					<Text color="red">✗ Failed to start server</Text>
					<Text>{error}</Text>
				</Box>
			)}

			<Box marginTop={2}>
				<Text dimColor>Press 'q' or ESC to go back</Text>
			</Box>
		</Box>
	);
}
