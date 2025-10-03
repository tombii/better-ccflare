import type { AnalyticsResponse } from "@better-ccflare/types";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";
import { useRequestDeduplication } from "./useRequestBatching";

interface AnalyticsParams {
	timeRange: string;
	filters: {
		accounts?: string[];
		models?: string[];
		status?: "all" | "success" | "error";
	};
	viewMode: "normal" | "cumulative";
	modelBreakdown?: boolean;
}

export function useDeduplicatedAnalytics() {
	const { dedupRequest } = useRequestDeduplication();

	const getAnalytics = useCallback(
		async (params: AnalyticsParams) => {
			const key = `analytics-${JSON.stringify(params)}`;

			return dedupRequest(key, () =>
				api.getAnalytics(
					params.timeRange,
					params.filters,
					params.viewMode,
					params.modelBreakdown,
				),
			);
		},
		[dedupRequest],
	);

	return { getAnalytics };
}

// Hook for multiple concurrent analytics requests with batching
export function useBatchedAnalytics() {
	const pendingRequests = useRef<
		Map<
			string,
			{
				params: AnalyticsParams;
				resolves: ((data: AnalyticsResponse) => void)[];
				rejects: ((error: unknown) => void)[];
			}
		>
	>(new Map());

	const batchTimeout = useRef<NodeJS.Timeout | null>(null);

	const processBatch = useCallback(() => {
		const batches = Array.from(pendingRequests.current.entries());
		pendingRequests.current.clear();

		if (batchTimeout.current) {
			clearTimeout(batchTimeout.current);
			batchTimeout.current = null;
		}

		// Process each batch concurrently
		batches.forEach(
			([_key, { params, resolves, rejects }]: [
				string,
				{
					params: AnalyticsParams;
					resolves: ((data: AnalyticsResponse) => void)[];
					rejects: ((error: unknown) => void)[];
				},
			]) => {
				api
					.getAnalytics(
						params.timeRange,
						params.filters,
						params.viewMode,
						params.modelBreakdown,
					)
					.then((result) => {
						resolves.forEach((resolve) => resolve(result));
					})
					.catch((error) => {
						rejects.forEach((reject) => reject(error));
					});
			},
		);
	}, []);

	const requestAnalytics = useCallback(
		(params: AnalyticsParams): Promise<AnalyticsResponse> => {
			return new Promise((resolve, reject) => {
				const key = JSON.stringify(params);
				const existing = pendingRequests.current.get(key);

				if (existing) {
					// Add to existing batch
					existing.resolves.push(resolve);
					existing.rejects.push(reject);
				} else {
					// Create new batch
					pendingRequests.current.set(key, {
						params,
						resolves: [resolve],
						rejects: [reject],
					});
				}

				// Schedule batch processing
				if (batchTimeout.current) {
					clearTimeout(batchTimeout.current);
				}
				batchTimeout.current = setTimeout(processBatch, 50); // 50ms batch window
			});
		},
		[processBatch],
	);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			// Clear timeout
			if (batchTimeout.current) {
				clearTimeout(batchTimeout.current);
				batchTimeout.current = null;
			}

			// Reject all pending requests
			const batches = Array.from(pendingRequests.current.values());
			pendingRequests.current.clear();
			batches.forEach(({ rejects }) => {
				rejects.forEach((reject) => reject(new Error("Component unmounted")));
			});
		};
	}, []);

	return { requestAnalytics };
}
