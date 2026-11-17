import { Logger } from "@better-ccflare/logger";
import type { DatabaseRetryConfig } from "./database-operations";

const logger = new Logger("db-retry");

/**
 * Error codes that indicate database lock contention or transient errors and should trigger retries
 */
const RETRYABLE_SQLITE_ERRORS = [
	"SQLITE_BUSY",
	"SQLITE_LOCKED",
	"database is locked",
	"database table is locked",
];

/**
 * PostgreSQL error codes / messages that are transient and should trigger retries
 */
const RETRYABLE_PG_ERRORS = [
	"ECONNREFUSED",
	"ECONNRESET",
	"connection timeout",
	"too many connections",
	"deadlock detected",
	"could not connect",
	"Connection terminated",
	"socket hang up",
];

/**
 * Check if an error is retryable (indicates database lock contention)
 */
function isRetryableError(error: unknown): boolean {
	if (!error) return false;

	const errorMessage = error instanceof Error ? error.message : String(error);
	const errorCode =
		typeof error === "object" && error !== null && "code" in error
			? error.code
			: undefined;

	return (
		RETRYABLE_SQLITE_ERRORS.some(
			(retryableError) =>
				errorMessage.includes(retryableError) || errorCode === retryableError,
		) ||
		RETRYABLE_PG_ERRORS.some((retryableError) =>
			errorMessage.includes(retryableError),
		)
	);
}

/**
 * Calculate delay for exponential backoff with jitter
 */
function calculateDelay(
	attempt: number,
	config: Required<DatabaseRetryConfig>,
): number {
	const baseDelay = config.delayMs * config.backoff ** attempt;
	const jitter = Math.random() * 0.1 * baseDelay; // Add 10% jitter
	const delayWithJitter = baseDelay + jitter;

	return Math.min(delayWithJitter, config.maxDelayMs);
}

/**
 * Sleep for the specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Async retry logic - uses iterative approach to avoid recursive Promise chains
 */
async function executeWithRetryAsync<T>(
	operation: () => T | Promise<T>,
	config: Required<DatabaseRetryConfig>,
	operationName: string,
): Promise<T> {
	let lastError: unknown;

	for (let attempt = 0; attempt < config.attempts; attempt++) {
		try {
			const result = await operation();

			// Log successful retry if this wasn't the first attempt
			if (attempt > 0) {
				logger.info(`${operationName} succeeded after ${attempt + 1} attempts`);
			}

			return result;
		} catch (error) {
			lastError = error;

			// Check if this is a retryable error
			if (!isRetryableError(error)) {
				logger.debug(
					`${operationName} failed with non-retryable error:`,
					error,
				);
				throw error;
			}

			// If this was the last attempt, throw the error
			if (attempt === config.attempts - 1) {
				logger.error(
					`${operationName} failed after ${config.attempts} attempts:`,
					error,
				);
				throw error;
			}

			// Calculate delay and wait before retry
			const delay = calculateDelay(attempt, config);
			logger.warn(
				`${operationName} failed (attempt ${attempt + 1}/${config.attempts}), retrying in ${delay.toFixed(0)}ms:`,
				error instanceof Error ? error.message : String(error),
			);

			await sleep(delay);
		}
	}

	// This should never be reached, but TypeScript requires it
	throw lastError;
}

/**
 * Retry wrapper for database operations with exponential backoff
 */
export async function withDatabaseRetry<T>(
	operation: () => T | Promise<T>,
	config: DatabaseRetryConfig = {},
	operationName = "database operation",
): Promise<T> {
	const retryConfig: Required<DatabaseRetryConfig> = {
		attempts: 3,
		delayMs: 100,
		backoff: 2,
		maxDelayMs: 5000,
		...config,
	};

	return executeWithRetryAsync(operation, retryConfig, operationName);
}
