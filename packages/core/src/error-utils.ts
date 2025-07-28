import { ValidationError, ConfigurationError, AuthenticationError, RateLimitError } from "./errors";

/**
 * Unified error handling utilities to reduce duplication
 */
export class ErrorUtils {
	/**
	 * Convert any error to a user-friendly message and status code
	 */
	static toHttpError(error: unknown): { status: number; message: string; details?: unknown } {
		if (error instanceof ValidationError) {
			return {
				status: 400,
				message: error.message,
				details: { field: error.field }
			};
		}

		if (error instanceof ConfigurationError) {
			return {
				status: 500,
				message: "Configuration error",
				details: { error: error.message }
			};
		}

		if (error instanceof AuthenticationError) {
			return {
				status: 401,
				message: error.message
			};
		}

		if (error instanceof RateLimitError) {
			return {
				status: 429,
				message: error.message,
				details: { retryAfter: error.retryAfter }
			};
		}

		// Check for HTTP-like errors
		if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
			return {
				status: error.status,
				message: "message" in error && typeof error.message === "string" ? error.message : "Unknown error",
				details: "details" in error ? error.details : undefined
			};
		}

		// Default error
		if (error instanceof Error) {
			return {
				status: 500,
				message: "Internal server error",
				details: process.env.NODE_ENV === "development" ? { error: error.message } : undefined
			};
		}

		return {
			status: 500,
			message: "Unknown error occurred"
		};
	}

	/**
	 * Create a standardized error response
	 */
	static createErrorResponse(error: unknown): { error: string; details?: unknown } {
		const { message, details } = ErrorUtils.toHttpError(error);
		return details ? { error: message, details } : { error: message };
	}

	/**
	 * Check if an error is retryable
	 */
	static isRetryable(error: unknown): boolean {
		const { status } = ErrorUtils.toHttpError(error);
		// 5xx errors and rate limits are typically retryable
		return status >= 500 || status === 429;
	}

	/**
	 * Extract retry delay from error
	 */
	static getRetryDelay(error: unknown): number | null {
		if (error instanceof RateLimitError && error.retryAfter) {
			return error.retryAfter;
		}

		const { status } = ErrorUtils.toHttpError(error);
		if (status === 429) {
			// Default rate limit retry
			return 60000; // 1 minute
		}
		if (status >= 500) {
			// Default server error retry
			return 5000; // 5 seconds
		}

		return null;
	}
}