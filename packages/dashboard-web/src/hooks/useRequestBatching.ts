import { useCallback, useEffect, useRef } from "react";

interface BatchRequest<T = unknown, R = unknown> {
	key: string;
	params: T;
	resolve: (data: R) => void;
	reject: (error: unknown) => void;
}

interface BatchConfig {
	maxBatchSize: number;
	maxWaitTime: number;
}

export function useRequestBatching<T = unknown, R = unknown>(
	batchFn: (params: T[]) => Promise<R[]>,
	config: BatchConfig = { maxBatchSize: 10, maxWaitTime: 100 },
) {
	const batchesRef = useRef<Map<string, BatchRequest<T, R>[]>>(new Map());
	const timeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

	const processBatch = useCallback(
		(batchKey: string) => {
			const batch = batchesRef.current.get(batchKey);
			const timeout = timeoutsRef.current.get(batchKey);

			if (!batch || batch.length === 0) return;

			// Clear timeout
			if (timeout) {
				clearTimeout(timeout);
				timeoutsRef.current.delete(batchKey);
			}

			// Clear batch
			batchesRef.current.delete(batchKey);

			// Process batch
			const paramsList = batch.map(({ params }) => params);
			const promises = batch.map(({ resolve, reject }) => ({
				resolve,
				reject,
			}));

			batchFn(paramsList)
				.then((results) => {
					results.forEach((result, index) => {
						promises[index].resolve(result);
					});
				})
				.catch((error) => {
					promises.forEach(({ reject }) => {
						reject(error);
					});
				});
		},
		[batchFn],
	);

	const batchRequest = useCallback(
		(key: string, params: T): Promise<R> => {
			return new Promise((resolve, reject) => {
				const batch = batchesRef.current.get(key) || [];
				const newBatch = [...batch, { key, params, resolve, reject }];
				batchesRef.current.set(key, newBatch);

				// Check if we should process the batch immediately
				if (newBatch.length >= config.maxBatchSize) {
					processBatch(key);
				} else if (newBatch.length === 1) {
					// Set timeout for first request in batch
					const timeout = setTimeout(
						() => processBatch(key),
						config.maxWaitTime,
					);
					timeoutsRef.current.set(key, timeout);
				}
			});
		},
		[config, processBatch],
	);

	// Clean up on unmount
	const cleanup = useCallback(() => {
		// Clear all timeouts
		timeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
		timeoutsRef.current.clear();

		// Reject all pending requests
		batchesRef.current.forEach((batch) => {
			batch.forEach(({ reject }) => {
				reject(new Error("Component unmounted"));
			});
		});
		batchesRef.current.clear();
	}, []);

	// Register cleanup on unmount
	useEffect(() => {
		return cleanup;
	}, [cleanup]);

	return { batchRequest };
}

// Request deduplication hook
export function useRequestDeduplication<T = unknown>() {
	const pendingRequests = useRef<Map<string, Promise<T>>>(new Map());

	const dedupRequest = useCallback(
		async (key: string, requestFn: () => Promise<T>): Promise<T> => {
			// Check if request is already pending
			const existing = pendingRequests.current.get(key);
			if (existing) {
				return existing;
			}

			// Create new request
			const requestPromise = requestFn().finally(() => {
				// Clean up from pending requests
				pendingRequests.current.delete(key);
			});

			// Store pending request
			pendingRequests.current.set(key, requestPromise);

			return requestPromise;
		},
		[],
	);

	return { dedupRequest };
}
