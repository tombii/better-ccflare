import { useCallback, useEffect, useRef, useState } from "react";

export interface UseApiPollingOptions {
	/**
	 * Polling interval in milliseconds
	 * @default 5000
	 */
	interval?: number;
	/**
	 * Whether polling is enabled
	 * @default true
	 */
	enabled?: boolean;
	/**
	 * Whether to fetch immediately on mount
	 * @default true
	 */
	fetchOnMount?: boolean;
	/**
	 * Maximum number of consecutive errors before stopping polling
	 * Set to null to never stop on errors
	 * @default null
	 */
	maxErrorRetries?: number | null;
	/**
	 * Callback when polling is stopped due to errors
	 */
	onMaxErrorsReached?: () => void;
}

export interface UseApiPollingReturn<T> {
	data: T | null;
	loading: boolean;
	error: string | null;
	isPolling: boolean;
	errorCount: number;
	startPolling: () => void;
	stopPolling: () => void;
	refetch: () => Promise<void>;
	resetErrors: () => void;
}

/**
 * Hook for real-time data polling with automatic error handling and retry logic
 *
 * @example
 * ```tsx
 * const { data, isPolling, startPolling, stopPolling } = useApiPolling(
 *   () => api.getRequestsDetail(200),
 *   { interval: 10000 }
 * );
 * ```
 */
export function useApiPolling<T>(
	fetcher: () => Promise<T>,
	options: UseApiPollingOptions = {},
): UseApiPollingReturn<T> {
	const {
		interval = 5000,
		enabled = true,
		fetchOnMount = true,
		maxErrorRetries = null,
		onMaxErrorsReached,
	} = options;

	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isPolling, setIsPolling] = useState(enabled);
	const [errorCount, setErrorCount] = useState(0);

	const intervalRef = useRef<NodeJS.Timeout | null>(null);
	const isMountedRef = useRef(true);

	const fetch = useCallback(async () => {
		try {
			setLoading(true);
			const result = await fetcher();

			if (isMountedRef.current) {
				setData(result);
				setError(null);
				setErrorCount(0); // Reset error count on success
			}
		} catch (err) {
			if (isMountedRef.current) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to fetch data";
				setError(errorMessage);
				setErrorCount((prev) => prev + 1);

				// Check if we should stop polling due to errors
				if (maxErrorRetries !== null && errorCount + 1 >= maxErrorRetries) {
					setIsPolling(false);
					onMaxErrorsReached?.();
				}
			}
		} finally {
			if (isMountedRef.current) {
				setLoading(false);
			}
		}
	}, [fetcher, errorCount, maxErrorRetries, onMaxErrorsReached]);

	const startPolling = useCallback(() => {
		setIsPolling(true);
		setErrorCount(0);
	}, []);

	const stopPolling = useCallback(() => {
		setIsPolling(false);
	}, []);

	const refetch = useCallback(async () => {
		await fetch();
	}, [fetch]);

	const resetErrors = useCallback(() => {
		setErrorCount(0);
		setError(null);
	}, []);

	// Initial fetch
	useEffect(() => {
		if (fetchOnMount) {
			fetch();
		}
	}, [fetch, fetchOnMount]); // eslint-disable-line react-hooks/exhaustive-deps

	// Polling logic
	useEffect(() => {
		if (isPolling && interval > 0) {
			intervalRef.current = setInterval(() => {
				fetch();
			}, interval);

			return () => {
				if (intervalRef.current) {
					clearInterval(intervalRef.current);
					intervalRef.current = null;
				}
			};
		}
	}, [isPolling, interval, fetch]);

	// Cleanup
	useEffect(() => {
		isMountedRef.current = true;

		return () => {
			isMountedRef.current = false;
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
		};
	}, []);

	return {
		data,
		loading,
		error,
		isPolling,
		errorCount,
		startPolling,
		stopPolling,
		refetch,
		resetErrors,
	};
}
