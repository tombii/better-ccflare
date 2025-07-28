/**
 * Custom HTTP error class for consistent error handling
 */
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

/**
 * Common HTTP error factories
 */
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

export const UnprocessableEntity = (message: string, details?: unknown) =>
	new HttpError(422, message, details);

export const TooManyRequests = (message: string, details?: unknown) =>
	new HttpError(429, message, details);

export const InternalServerError = (message: string, details?: unknown) =>
	new HttpError(500, message, details);

export const BadGateway = (message: string, details?: unknown) =>
	new HttpError(502, message, details);

export const ServiceUnavailable = (message: string, details?: unknown) =>
	new HttpError(503, message, details);

export const GatewayTimeout = (message: string, details?: unknown) =>
	new HttpError(504, message, details);
