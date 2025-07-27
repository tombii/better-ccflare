export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
		public details?: unknown,
	) {
		super(message);
		this.name = "HttpError";
	}
}

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

	// Handle generic errors
	const message =
		error instanceof Error ? error.message : "Internal server error";
	const status = 500;

	// Log unexpected errors
	console.error("Unhandled error:", error);

	return jsonResponse({ error: message }, status);
}

// Common error factories
export const BadRequest = (message: string, details?: unknown) =>
	new HttpError(400, message, details);

export const Unauthorized = (message: string, details?: unknown) =>
	new HttpError(401, message, details);

export const Forbidden = (message: string, details?: unknown) =>
	new HttpError(403, message, details);

export const NotFound = (message: string, details?: unknown) =>
	new HttpError(404, message, details);

export const Conflict = (message: string, details?: unknown) =>
	new HttpError(409, message, details);

export const InternalServerError = (message: string, details?: unknown) =>
	new HttpError(500, message, details);
