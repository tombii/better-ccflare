export interface ServeOptions {
	port?: number;
	withDashboard?: boolean;
}

export interface ServeResult {
	port: number;
	cleanup: () => void;
}

export async function serve(options: ServeOptions = {}): Promise<ServeResult> {
	const { port = 8080, withDashboard = true } = options;

	// Dynamic import to avoid circular dependencies
	const { default: startServer } = await import(
		"../../../apps/server/src/server.js"
	);

	// Start the server
	const server = await startServer({
		port,
		withDashboard,
	});

	return {
		port,
		cleanup: () => {
			// Server cleanup logic
			if (server && typeof server.stop === "function") {
				server.stop();
			}
		},
	};
}
