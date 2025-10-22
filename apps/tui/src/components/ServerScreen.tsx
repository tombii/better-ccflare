import { Config } from "@better-ccflare/config";
import { NETWORK } from "@better-ccflare/core";
import { Box, Text, useInput } from "ink";

interface ServerScreenProps {
	onBack: () => void;
}

export function ServerScreen({ onBack }: ServerScreenProps) {
	// Server is auto-started now, so just show the running status
	// Use the same logic as main.ts line 208
	const config = new Config();
	const port = config.getRuntime().port || NETWORK.DEFAULT_PORT;
	// Determine protocol based on SSL configuration
	const protocol =
		process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH ? "https" : "http";
	const url = `${protocol}://localhost:${port}`;

	useInput((input, key) => {
		if (key.escape || input === "q") {
			onBack();
		}
		if (input === "d") {
			// Open dashboard in browser
			import("open")
				.then((module) => {
					const open = module.default as (url: string) => Promise<void>;
					open(url);
				})
				.catch(() => {
					// Fallback if open package is not available
					console.log(`\nOpen dashboard at: ${url}`);
				});
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text color="cyan" bold>
					🚀 Server
				</Text>
			</Box>

			<Box flexDirection="column">
				<Text color="green">✓ Server running at {url}</Text>
				<Box marginTop={1}>
					<Text dimColor>Press 'd' to open dashboard in browser</Text>
				</Box>
			</Box>

			<Box marginTop={2}>
				<Text dimColor>Press 'q' or ESC to go back</Text>
			</Box>
		</Box>
	);
}
