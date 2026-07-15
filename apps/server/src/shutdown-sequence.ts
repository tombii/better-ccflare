export interface GracefullyStoppableServer {
	stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export interface GracefulShutdownSequenceOptions {
	server: GracefullyStoppableServer | null;
	cleanupBackgroundWork: () => void;
	drainUsage: () => Promise<void>;
	shutdownCore: () => Promise<void>;
}

/**
 * Close HTTP admission first, let synchronous background cleanup run while
 * active connections finish, then drain request persistence before core
 * resources are disposed.
 */
export async function runGracefulShutdownSequence({
	server,
	cleanupBackgroundWork,
	drainUsage,
	shutdownCore,
}: GracefulShutdownSequenceOptions): Promise<void> {
	// No argument means Bun's graceful stop. Passing true would terminate active
	// agent streams before their usage finalizers can run.
	let stopFailure: { error: unknown } | null = null;
	let serverStopped: Promise<void>;
	try {
		serverStopped = Promise.resolve(server?.stop());
	} catch (error) {
		stopFailure = { error };
		serverStopped = Promise.resolve();
	}

	let cleanupFailure: { error: unknown } | null = null;
	try {
		cleanupBackgroundWork();
	} catch (error) {
		cleanupFailure = { error };
	}

	try {
		await serverStopped;
	} catch (error) {
		stopFailure = { error };
	}

	const errors: unknown[] = [];
	if (stopFailure) errors.push(stopFailure.error);
	if (cleanupFailure) errors.push(cleanupFailure.error);

	try {
		await drainUsage();
	} catch (error) {
		errors.push(error);
	}
	try {
		await shutdownCore();
	} catch (error) {
		errors.push(error);
	}

	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) {
		throw new AggregateError(
			errors,
			"Errors occurred during graceful shutdown",
		);
	}
}
