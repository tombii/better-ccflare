/**
 * Input validation and sanitization utilities
 */
import { ValidationError } from "./errors";

/**
 * Validates and sanitizes a string input
 */
export function validateString(
	value: unknown,
	field: string,
	options: {
		required?: boolean;
		minLength?: number;
		maxLength?: number;
		pattern?: RegExp;
		allowedValues?: readonly string[];
		transform?: (value: string) => string;
	} = {},
): string | undefined {
	// Handle undefined/null
	if (value === undefined || value === null) {
		if (options.required) {
			throw new ValidationError(`${field} is required`, field);
		}
		return undefined;
	}

	// Ensure it's a string
	if (typeof value !== "string") {
		throw new ValidationError(`${field} must be a string`, field, value);
	}

	// Apply transformation if provided
	const sanitized = options.transform ? options.transform(value) : value;

	// Validate length
	if (options.minLength !== undefined && sanitized.length < options.minLength) {
		throw new ValidationError(
			`${field} must be at least ${options.minLength} characters long`,
			field,
			value,
		);
	}

	if (options.maxLength !== undefined && sanitized.length > options.maxLength) {
		throw new ValidationError(
			`${field} must be at most ${options.maxLength} characters long`,
			field,
			value,
		);
	}

	// Validate pattern
	if (options.pattern && !options.pattern.test(sanitized)) {
		throw new ValidationError(`${field} has an invalid format`, field, value);
	}

	// Validate allowed values
	if (options.allowedValues && !options.allowedValues.includes(sanitized)) {
		throw new ValidationError(
			`${field} must be one of: ${options.allowedValues.join(", ")}`,
			field,
			value,
		);
	}

	return sanitized;
}

/**
 * Validates and sanitizes a number input
 */
export function validateNumber(
	value: unknown,
	field: string,
	options: {
		required?: boolean;
		min?: number;
		max?: number;
		integer?: boolean;
		allowedValues?: readonly number[];
	} = {},
): number | undefined {
	// Handle undefined/null
	if (value === undefined || value === null) {
		if (options.required) {
			throw new ValidationError(`${field} is required`, field);
		}
		return undefined;
	}

	// Convert string to number if needed
	let num: number;
	if (typeof value === "string") {
		num = Number(value);
		if (Number.isNaN(num)) {
			throw new ValidationError(
				`${field} must be a valid number`,
				field,
				value,
			);
		}
	} else if (typeof value === "number") {
		num = value;
	} else {
		throw new ValidationError(`${field} must be a number`, field, value);
	}

	// Validate integer
	if (options.integer && !Number.isInteger(num)) {
		throw new ValidationError(`${field} must be an integer`, field, value);
	}

	// Validate range
	if (options.min !== undefined && num < options.min) {
		throw new ValidationError(
			`${field} must be at least ${options.min}`,
			field,
			value,
		);
	}

	if (options.max !== undefined && num > options.max) {
		throw new ValidationError(
			`${field} must be at most ${options.max}`,
			field,
			value,
		);
	}

	// Validate allowed values
	if (options.allowedValues && !options.allowedValues.includes(num)) {
		throw new ValidationError(
			`${field} must be one of: ${options.allowedValues.join(", ")}`,
			field,
			value,
		);
	}

	return num;
}

/**
 * Validates and sanitizes a boolean input
 */
export function validateBoolean(
	value: unknown,
	field: string,
	options: { required?: boolean } = {},
): boolean | undefined {
	// Handle undefined/null
	if (value === undefined || value === null) {
		if (options.required) {
			throw new ValidationError(`${field} is required`, field);
		}
		return undefined;
	}

	// Handle boolean
	if (typeof value === "boolean") {
		return value;
	}

	// Handle string booleans
	if (typeof value === "string") {
		const lower = value.toLowerCase();
		if (lower === "true" || lower === "1" || lower === "yes") {
			return true;
		}
		if (lower === "false" || lower === "0" || lower === "no") {
			return false;
		}
	}

	// Handle numbers
	if (typeof value === "number") {
		return value !== 0;
	}

	throw new ValidationError(`${field} must be a boolean`, field, value);
}

/**
 * Validates and sanitizes an array input
 */
export function validateArray<T>(
	value: unknown,
	field: string,
	options: {
		required?: boolean;
		minLength?: number;
		maxLength?: number;
		itemValidator?: (item: unknown, index: number) => T;
	} = {},
): T[] | undefined {
	// Handle undefined/null
	if (value === undefined || value === null) {
		if (options.required) {
			throw new ValidationError(`${field} is required`, field);
		}
		return undefined;
	}

	// Ensure it's an array
	if (!Array.isArray(value)) {
		throw new ValidationError(`${field} must be an array`, field, value);
	}

	// Validate length
	if (options.minLength !== undefined && value.length < options.minLength) {
		throw new ValidationError(
			`${field} must contain at least ${options.minLength} items`,
			field,
			value,
		);
	}

	if (options.maxLength !== undefined && value.length > options.maxLength) {
		throw new ValidationError(
			`${field} must contain at most ${options.maxLength} items`,
			field,
			value,
		);
	}

	// Validate items
	if (options.itemValidator) {
		return value.map((item, index) => {
			try {
				return options.itemValidator?.(item, index);
			} catch (error) {
				if (error instanceof ValidationError) {
					throw new ValidationError(
						`${field}[${index}]: ${error.message}`,
						`${field}[${index}]`,
						item,
					);
				}
				throw error;
			}
		}) as T[];
	}

	return value as T[];
}

/**
 * Validates and sanitizes an object input
 */
export function validateObject<T extends Record<string, unknown>>(
	value: unknown,
	field: string,
	options: {
		required?: boolean;
		schema?: {
			[K in keyof T]: (value: unknown) => T[K];
		};
	} = {},
): T | undefined {
	// Handle undefined/null
	if (value === undefined || value === null) {
		if (options.required) {
			throw new ValidationError(`${field} is required`, field);
		}
		return undefined;
	}

	// Ensure it's an object
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`${field} must be an object`, field, value);
	}

	// Validate schema
	if (options.schema) {
		const result = {} as T;
		const obj = value as Record<string, unknown>;

		for (const [key, validator] of Object.entries(options.schema)) {
			try {
				result[key as keyof T] = validator(obj[key]);
			} catch (error) {
				if (error instanceof ValidationError) {
					throw new ValidationError(
						`${field}.${key}: ${error.message}`,
						`${field}.${key}`,
						obj[key],
					);
				}
				throw error;
			}
		}

		return result;
	}

	return value as T;
}

/**
 * Common string sanitizers
 */
export const sanitizers = {
	trim: (value: string) => value.trim(),
	lowercase: (value: string) => value.toLowerCase(),
	uppercase: (value: string) => value.toUpperCase(),
	removeWhitespace: (value: string) => value.replace(/\s+/g, ""),
	alphanumeric: (value: string) => value.replace(/[^a-zA-Z0-9]/g, ""),
	alphanumericWithSpaces: (value: string) =>
		value.replace(/[^a-zA-Z0-9\s]/g, ""),
	email: (value: string) => value.trim().toLowerCase(),
	url: (value: string) => {
		try {
			const parsed = new URL(value);
			return parsed.toString();
		} catch {
			throw new ValidationError("Invalid URL format", "url", value);
		}
	},
};

/**
 * Common validation patterns
 */
export const patterns = {
	email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
	uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	alphanumeric: /^[a-zA-Z0-9]+$/,
	alphanumericWithSpaces: /^[a-zA-Z0-9\s]+$/,
	// Account name: more restrictive pattern to prevent SQL injection and other attacks
	// Allows only alphanumeric characters, spaces, hyphens, underscores, @, and . (1-100 chars)
	// Excludes special characters that could be used in SQL injection attacks
	accountName: /^[a-zA-Z0-9\s\-_@.]{1,100}$/,
	// Path pattern for API endpoints
	apiPath: /^\/v1\/[a-zA-Z0-9\-_/]*$/,
	// URL pattern
	url: /^https?:\/\/.+$/i,
};

/**
 * Validate and sanitize a URL endpoint
 */
export function validateEndpointUrl(url: unknown, field = "endpoint"): string {
	const urlStr = validateString(url, field, {
		required: true,
		pattern: patterns.url,
		transform: (value) => value.trim().replace(/\/$/, ""), // Remove trailing slash
	});

	if (!urlStr) {
		throw new ValidationError(`${field} is required`, field);
	}

	try {
		const parsed = new URL(urlStr);

		// Validate protocol
		if (!["http:", "https:"].includes(parsed.protocol)) {
			throw new ValidationError(
				`${field} protocol must be http or https`,
				field,
				url,
			);
		}

		// Validate hostname exists
		if (!parsed.hostname) {
			throw new ValidationError(
				`${field} must have a valid hostname`,
				field,
				url,
			);
		}

		return urlStr;
	} catch (error) {
		if (error instanceof ValidationError) {
			throw error;
		}
		throw new ValidationError(
			`${field} has invalid URL format: ${error instanceof Error ? error.message : String(error)}`,
			field,
			url,
		);
	}
}

/**
 * Validate API key format (basic check)
 */
export function validateApiKey(apiKey: unknown, field = "apiKey"): string {
	const key = validateString(apiKey, field, {
		required: true,
		minLength: 10,
		transform: (value) => value.trim(),
	});

	if (!key) {
		throw new ValidationError(`${field} is required`, field);
	}

	return key;
}

/**
 * Safely parse JSON with error handling and validation
 */
export function safeJsonParse<T = unknown>(json: unknown, field = "json"): T {
	if (typeof json !== "string") {
		throw new ValidationError(`${field} must be a string`, field, json);
	}

	const trimmed = json.trim();
	if (!trimmed) {
		throw new ValidationError(`${field} cannot be empty`, field, json);
	}

	try {
		return JSON.parse(trimmed) as T;
	} catch (error) {
		throw new ValidationError(
			`${field} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			field,
			json,
		);
	}
}

/**
 * Validate model mappings object
 */
export function validateModelMappings(
	mappings: unknown,
	field = "modelMappings",
): Record<string, string> {
	if (!mappings) {
		throw new ValidationError(`${field} cannot be null or undefined`, field);
	}

	if (typeof mappings !== "object" || Array.isArray(mappings)) {
		throw new ValidationError(`${field} must be an object`, field, mappings);
	}

	const obj = mappings as Record<string, unknown>;

	// Validate all keys and values are strings
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (!key || typeof key !== "string" || !key.trim()) {
			throw new ValidationError(
				`${field} keys must be non-empty strings`,
				field,
				mappings,
			);
		}

		if (!value || typeof value !== "string" || !(value as string).trim()) {
			throw new ValidationError(
				`${field} value for key '${key}' must be a non-empty string`,
				field,
				mappings,
			);
		}

		result[key.trim()] = (value as string).trim();
	}

	return result;
}

/**
 * Validate account priority (0-100)
 */
export function validatePriority(
	priority: unknown,
	field = "priority",
): number {
	return (
		validateNumber(priority, field, {
			min: 0,
			max: 100,
			integer: true,
		}) ?? 0
	); // Default to 0 if undefined
}
