export interface Disposable {
	dispose(): Promise<void> | void;
}

class LifecycleManager {
	private disposables: Set<Disposable> = new Set();
	private isShuttingDown = false;

	register(disposable: Disposable): void {
		this.disposables.add(disposable);
	}

	unregister(disposable: Disposable): void {
		this.disposables.delete(disposable);
	}

	async shutdown(): Promise<void> {
		if (this.isShuttingDown) {
			return;
		}

		this.isShuttingDown = true;
		const errors: Error[] = [];

		// Dispose in reverse order of registration
		const disposableArray = Array.from(this.disposables).reverse();

		for (const disposable of disposableArray) {
			try {
				await disposable.dispose();
			} catch (error) {
				errors.push(
					error instanceof Error
						? error
						: new Error(`Disposal error: ${String(error)}`),
				);
			}
		}

		this.disposables.clear();
		this.isShuttingDown = false;

		if (errors.length > 0) {
			throw new AggregateError(errors, "Errors occurred during shutdown");
		}
	}

	clear(): void {
		this.disposables.clear();
		this.isShuttingDown = false;
	}
}

// Global lifecycle manager instance
const lifecycleManager = new LifecycleManager();

export function registerDisposable(disposable: Disposable): void {
	lifecycleManager.register(disposable);
}

export function unregisterDisposable(disposable: Disposable): void {
	lifecycleManager.unregister(disposable);
}

export async function shutdown(): Promise<void> {
	await lifecycleManager.shutdown();
}

export function clearDisposables(): void {
	lifecycleManager.clear();
}
