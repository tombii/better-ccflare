import { HttpError } from "./errors";

/**
 * Create a JSON response with proper headers
 */
export function jsonResponse(
	data: unknown,
	status = 200,
	headers?: HeadersInit,
): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
	});
}

/**
 * Create an error response from any error type
 */
export function errorResponse(error: unknown): Response {
	if (error instanceof HttpError) {
		const body: { error: string; details?: unknown } = {
			error: error.message,
		};
		if (error.details !== undefined) {
			body.details = error.details;
		}
		return jsonResponse(body, error.status);
	}

	// Handle AppError instances (like ValidationError, ProviderError, etc.) that have statusCode
	if (
		error &&
		typeof error === "object" &&
		"statusCode" in error &&
		typeof (error as { statusCode: unknown }).statusCode === "number"
	) {
		const body: { error: string; details?: unknown } = {
			error: error instanceof Error ? error.message : "Error occurred",
		};
		return jsonResponse(body, (error as { statusCode: number }).statusCode);
	}

	// Handle generic errors
	const message =
		error instanceof Error ? error.message : "Internal server error";
	const status = 500;

	// In browser context, we can't log to files
	// Server-side code should handle logging before calling errorResponse
	if (typeof console !== "undefined" && console.error) {
		// Redact sensitive user input from errors before logging
		if (error && typeof error === "object") {
			const redact = (obj: unknown): unknown => {
				if (!obj || typeof obj !== "object") return obj;
				if (Array.isArray(obj)) {
					// Handle arrays
					return obj.map((item) => redact(item));
				} else {
					// Handle objects
					const clone = { ...(obj as Record<string, unknown>) };
					for (const key of Object.keys(clone)) {
						// Redact fields named 'value', 'apiKey', or other known sensitive keys
						if (
							typeof key === "string" &&
							(key === "value" ||
								key === "apiKey" ||
								key === "password" ||
								key === "token")
						) {
							clone[key] = "[REDACTED]";
						} else if (typeof clone[key] === "object" && clone[key] !== null) {
							clone[key] = redact(clone[key]);
						}
					}
					return clone;
				}
			};
			// If the error has a 'context', redact it
			const safeError =
				"context" in error && typeof error.context === "object"
					? { ...error, context: redact(error.context) }
					: redact(error);
			console.error("Unhandled error:", safeError);
		} else {
			// If not an object, avoid logging the raw error which may contain sensitive input.
			let safeError: string;
			if (typeof error === "string") {
				// Redact sensitive string patterns
				const sensitivePattern =
					/(apiKey|token|password)(\s*[:=]\s*)([^,\s]+)/gi;
				safeError = error.replace(sensitivePattern, "$1$2[REDACTED]");
			} else {
				// For number, boolean, symbol, etc. just log type info.
				safeError = `[Non-object error of type ${typeof error}]`;
			}
			console.error("Unhandled error:", safeError);
		}
	}

	return jsonResponse({ error: message }, status);
}

/**
 * Create a success response with optional data
 */
export function successResponse(
	data?: unknown,
	message = "Success",
	status = 200,
): Response {
	return jsonResponse({ message, data }, status);
}

/**
 * Create a paginated response
 */
export function paginatedResponse<T>(
	items: T[],
	page: number,
	perPage: number,
	total: number,
	headers?: HeadersInit,
): Response {
	const totalPages = Math.ceil(total / perPage);

	return jsonResponse(
		{
			items,
			pagination: {
				page,
				perPage,
				total,
				totalPages,
				hasNext: page < totalPages,
				hasPrev: page > 1,
			},
		},
		200,
		headers,
	);
}

/**
 * Create a streaming response for Server-Sent Events
 */
export function sseResponse(
	stream: ReadableStream,
	headers?: HeadersInit,
): Response {
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			...headers,
		},
	});
}
