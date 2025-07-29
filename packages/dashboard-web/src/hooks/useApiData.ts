import { useCallback, useEffect, useRef, useState } from "react";

export interface UseApiDataOptions<T> {
	/**
	 * Whether to fetch data immediately on mount
	 * @default true
	 */
	fetchOnMount?: boolean;
	/**
	 * Interval in milliseconds for automatic refetching
	 * Set to null or undefined to disable auto-refresh
	 */
	refetchInterval?: number | null;
	/**
	 * Dependencies that should trigger a refetch when changed
	 * @default []
	 */
	dependencies?: React.DependencyList;
	/**
	 * Transform the error before setting it
	 */
	onError?: (error: unknown) => string;
	/**
	 * Callback when data is successfully fetched
	 */
	onSuccess?: (data: T) => void;
}

export interface UseApiDataReturn<T> {
	data: T | null;
	loading: boolean;
	error: string | null;
	refetch: () => Promise<void>;
	setData: React.Dispatch<React.SetStateAction<T | null>>;
	reset: () => void;
}

/**
 * Generic hook for API data fetching with loading, error, and refetch capabilities
 *
 * @example
 * ```tsx
 * const { data, loading, error, refetch } = useApiData(
 *   () => api.getAccounts(),
 *   { refetchInterval: 10000 }
 * );
 * ```
 */
export function useApiData<T>(
	fetcher: () => Promise<T>,
	options: UseApiDataOptions<T> = {},
): UseApiDataReturn<T> {
	const {
		fetchOnMount = true,
		refetchInterval = null,
		dependencies = [],
		onError = (err) => (err instanceof Error ? err.message : String(err)),
		onSuccess,
	} = options;

	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(fetchOnMount);
	const [error, setError] = useState<string | null>(null);

	// Use ref to store the interval ID to avoid stale closures
	const intervalRef = useRef<NodeJS.Timeout | null>(null);

	// Track if component is mounted to prevent state updates after unmount
	const isMountedRef = useRef(true);

	const fetch = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);
			const result = await fetcher();

			if (isMountedRef.current) {
				setData(result);
				setError(null);
				onSuccess?.(result);
			}
		} catch (err) {
			if (isMountedRef.current) {
				const errorMessage = onError(err);
				setError(errorMessage);
			}
		} finally {
			if (isMountedRef.current) {
				setLoading(false);
			}
		}
	}, [fetcher, onError, onSuccess]);

	const refetch = useCallback(async () => {
		await fetch();
	}, [fetch]);

	const reset = useCallback(() => {
		setData(null);
		setLoading(false);
		setError(null);
	}, []);

	// Initial fetch on mount
	useEffect(() => {
		if (fetchOnMount) {
			fetch();
		}
	}, [fetch, fetchOnMount]); // eslint-disable-line react-hooks/exhaustive-deps

	// Refetch when dependencies change
	useEffect(() => {
		if (dependencies.length > 0) {
			fetch();
		}
	}, dependencies); // eslint-disable-line react-hooks/exhaustive-deps

	// Set up auto-refresh interval
	useEffect(() => {
		if (refetchInterval && refetchInterval > 0) {
			intervalRef.current = setInterval(() => {
				fetch();
			}, refetchInterval);

			return () => {
				if (intervalRef.current) {
					clearInterval(intervalRef.current);
					intervalRef.current = null;
				}
			};
		}
	}, [refetchInterval, fetch]);

	// Cleanup on unmount
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
		refetch,
		setData,
		reset,
	};
}
