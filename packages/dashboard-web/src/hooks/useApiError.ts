import { useCallback, useMemo } from "react";

export interface UseApiErrorOptions {
	/**
	 * Default error message when error is not an Error instance
	 * @default "An unexpected error occurred"
	 */
	defaultMessage?: string;
	/**
	 * Transform specific error messages
	 */
	errorMap?: Record<string, string>;
	/**
	 * Whether to log errors to console
	 * @default false
	 */
	logErrors?: boolean;
}

export interface UseApiErrorReturn {
	/**
	 * Format an error into a user-friendly message
	 */
	formatError: (error: unknown) => string;
	/**
	 * Check if an error is a network error
	 */
	isNetworkError: (error: unknown) => boolean;
	/**
	 * Check if an error is an authentication error
	 */
	isAuthError: (error: unknown) => boolean;
	/**
	 * Check if an error is a rate limit error
	 */
	isRateLimitError: (error: unknown) => boolean;
	/**
	 * Get error type
	 */
	getErrorType: (
		error: unknown,
	) => "network" | "auth" | "rate-limit" | "validation" | "server" | "unknown";
}

/**
 * Hook for consistent error handling across the dashboard
 *
 * @example
 * ```tsx
 * const { formatError, isNetworkError } = useApiError({
 *   errorMap: {
 *     "Network Error": "Unable to connect to the server. Please check your connection.",
 *   }
 * });
 *
 * try {
 *   await api.getAccounts();
 * } catch (err) {
 *   const message = formatError(err);
 *   setError(message);
 * }
 * ```
 */
export function useApiError(
	options: UseApiErrorOptions = {},
): UseApiErrorReturn {
	const {
		defaultMessage = "An unexpected error occurred",
		errorMap = {},
		logErrors = false,
	} = options;

	const formatError = useCallback(
		(error: unknown): string => {
			if (logErrors) {
				console.error("[API Error]", error);
			}

			// Handle null/undefined
			if (error == null) {
				return defaultMessage;
			}

			// Handle Error instances
			if (error instanceof Error) {
				const message = error.message;

				// Check error map for custom messages
				for (const [key, value] of Object.entries(errorMap)) {
					if (message.includes(key)) {
						return value;
					}
				}

				// Handle specific error types
				if (message.toLowerCase().includes("network")) {
					return "Network error. Please check your connection and try again.";
				}

				if (
					message.toLowerCase().includes("unauthorized") ||
					message.toLowerCase().includes("401")
				) {
					return "Authentication failed. Please re-add your account.";
				}

				if (
					message.toLowerCase().includes("rate limit") ||
					message.toLowerCase().includes("429")
				) {
					return "Rate limit exceeded. Please try again later.";
				}

				if (message.toLowerCase().includes("validation")) {
					return message; // Validation errors are usually already user-friendly
				}

				if (message.toLowerCase().includes("timeout")) {
					return "Request timed out. Please try again.";
				}

				return message;
			}

			// Handle string errors
			if (typeof error === "string") {
				// Check error map
				for (const [key, value] of Object.entries(errorMap)) {
					if (error.includes(key)) {
						return value;
					}
				}
				return error;
			}

			// Handle objects with message property
			if (
				typeof error === "object" &&
				"message" in error &&
				typeof error.message === "string"
			) {
				return formatError(new Error(error.message));
			}

			// Fallback
			return defaultMessage;
		},
		[defaultMessage, errorMap, logErrors],
	);

	const isNetworkError = useCallback((error: unknown): boolean => {
		if (error instanceof Error) {
			const message = error.message.toLowerCase();
			return (
				message.includes("network") ||
				message.includes("fetch") ||
				message.includes("connect") ||
				message.includes("timeout") ||
				message.includes("offline")
			);
		}
		return false;
	}, []);

	const isAuthError = useCallback((error: unknown): boolean => {
		if (error instanceof Error) {
			const message = error.message.toLowerCase();
			return (
				message.includes("unauthorized") ||
				message.includes("401") ||
				message.includes("authentication") ||
				message.includes("auth") ||
				message.includes("forbidden") ||
				message.includes("403")
			);
		}
		return false;
	}, []);

	const isRateLimitError = useCallback((error: unknown): boolean => {
		if (error instanceof Error) {
			const message = error.message.toLowerCase();
			return (
				message.includes("rate limit") ||
				message.includes("429") ||
				message.includes("too many requests")
			);
		}
		return false;
	}, []);

	const getErrorType = useCallback(
		(
			error: unknown,
		):
			| "network"
			| "auth"
			| "rate-limit"
			| "validation"
			| "server"
			| "unknown" => {
			if (isNetworkError(error)) return "network";
			if (isAuthError(error)) return "auth";
			if (isRateLimitError(error)) return "rate-limit";

			if (error instanceof Error) {
				const message = error.message.toLowerCase();
				if (message.includes("validation") || message.includes("invalid")) {
					return "validation";
				}
				if (message.includes("500") || message.includes("server error")) {
					return "server";
				}
			}

			return "unknown";
		},
		[isNetworkError, isAuthError, isRateLimitError],
	);

	return useMemo(
		() => ({
			formatError,
			isNetworkError,
			isAuthError,
			isRateLimitError,
			getErrorType,
		}),
		[formatError, isNetworkError, isAuthError, isRateLimitError, getErrorType],
	);
}
