/**
 * Custom error classes for standardized error handling across the application
 */

/**
 * Base error class for all application errors
 */
export abstract class AppError extends Error {
	public readonly timestamp: Date;
	public readonly context?: Record<string, unknown>;

	constructor(
		message: string,
		public readonly code: string,
		public readonly statusCode: number,
		context?: Record<string, unknown>,
	) {
		super(message);
		this.name = this.constructor.name;
		this.timestamp = new Date();
		this.context = context;
		Error.captureStackTrace(this, this.constructor);
	}

	toJSON() {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			statusCode: this.statusCode,
			timestamp: this.timestamp,
			context: this.context,
		};
	}
}

/**
 * Authentication and authorization errors
 */
export class AuthError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, "AUTH_ERROR", 401, context);
	}
}

export class TokenExpiredError extends AuthError {
	constructor(accountId: string) {
		super("Access token has expired", { accountId });
	}
}

export class TokenRefreshError extends AuthError {
	constructor(accountId: string, originalError?: Error) {
		super("Failed to refresh access token", {
			accountId,
			originalError: originalError?.message,
		});
	}
}

/**
 * Rate limiting errors
 */
export class RateLimitError extends AppError {
	constructor(
		public readonly accountId: string,
		public readonly resetTime: number,
		public readonly remaining?: number,
	) {
		super("Rate limit exceeded", "RATE_LIMIT_ERROR", 429, {
			accountId,
			resetTime,
			remaining,
		});
	}
}

/**
 * Validation errors
 */
export class ValidationError extends AppError {
	constructor(
		message: string,
		public readonly field?: string,
		public readonly value?: unknown,
	) {
		super(message, "VALIDATION_ERROR", 400, { field, value });
	}
}

/**
 * Database errors
 */
export class DatabaseError extends AppError {
	constructor(message: string, originalError?: Error) {
		super(message, "DATABASE_ERROR", 500, {
			originalError: originalError?.message,
		});
	}
}

/**
 * Provider errors
 */
export class ProviderError extends AppError {
	constructor(
		message: string,
		public readonly provider: string,
		statusCode = 502,
		context?: Record<string, unknown>,
	) {
		super(message, "PROVIDER_ERROR", statusCode, { provider, ...context });
	}
}

export class OAuthError extends ProviderError {
	constructor(
		message: string,
		provider: string,
		public readonly oauthCode?: string,
	) {
		super(message, provider, 400, { oauthCode });
	}
}

/**
 * Configuration errors
 */
export class ConfigError extends AppError {
	constructor(
		message: string,
		public readonly configKey?: string,
	) {
		super(message, "CONFIG_ERROR", 500, { configKey });
	}
}

/**
 * Not found errors
 */
export class NotFoundError extends AppError {
	constructor(
		public readonly resource: string,
		public readonly identifier?: string,
	) {
		super(`${resource} not found`, "NOT_FOUND", 404, {
			resource,
			identifier,
		});
	}
}

/**
 * Service unavailable errors
 */
export class ServiceUnavailableError extends AppError {
	constructor(
		message: string,
		public readonly service?: string,
	) {
		super(message, "SERVICE_UNAVAILABLE", 503, { service });
	}
}

/**
 * Type guards
 */
export function isAppError(error: unknown): error is AppError {
	return error instanceof AppError;
}

export function isAuthError(error: unknown): error is AuthError {
	return error instanceof AuthError;
}

export function isRateLimitError(error: unknown): error is RateLimitError {
	return error instanceof RateLimitError;
}

export function isValidationError(error: unknown): error is ValidationError {
	return error instanceof ValidationError;
}

/**
 * Error logger that sanitizes sensitive data
 */
export function logError(
	error: unknown,
	logger: { error: (msg: string, ...args: unknown[]) => void },
): void {
	if (isAppError(error)) {
		// Sanitize sensitive context data
		const sanitizedContext = error.context
			? sanitizeErrorContext(error.context)
			: undefined;
		logger.error(`${error.name}: ${error.message}`, {
			code: error.code,
			statusCode: error.statusCode,
			context: sanitizedContext,
		});
	} else if (error instanceof Error) {
		logger.error(`Error: ${error.message}`, {
			name: error.name,
			stack: error.stack,
		});
	} else {
		logger.error("Unknown error", error);
	}
}

/**
 * Sanitize error context to remove sensitive data
 */
function sanitizeErrorContext(
	context: Record<string, unknown>,
): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	const sensitiveKeys = ["token", "password", "secret", "key", "authorization"];

	for (const [key, value] of Object.entries(context)) {
		const lowerKey = key.toLowerCase();
		if (sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive))) {
			sanitized[key] = "[REDACTED]";
		} else if (typeof value === "object" && value !== null) {
			sanitized[key] = sanitizeErrorContext(value as Record<string, unknown>);
		} else {
			sanitized[key] = value;
		}
	}

	return sanitized;
}
