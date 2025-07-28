import { ValidationError } from "./errors";
import { validateString, validateNumber, validateBoolean, validateArray, validateObject } from "./validation";

/**
 * Centralized validation service to reduce duplication
 */
export class ValidationService {
	/**
	 * Validate account creation input
	 */
	static validateAccountCreation(data: unknown): { name: string; mode: "console" | "max"; tier?: number } {
		if (!validateObject(data, "request body", { required: true })) {
			throw new ValidationError("Invalid request body", "body");
		}

		const obj = data as Record<string, unknown>;
		
		const name = validateString(obj.name, "name", { 
			required: true, 
			minLength: 1, 
			maxLength: 50,
			pattern: /^[a-zA-Z0-9_-]+$/
		})!;

		const mode = validateString(obj.mode, "mode", {
			required: true,
			allowedValues: ["console", "max"]
		}) as "console" | "max";

		const tier = validateNumber(obj.tier, "tier", {
			required: false,
			min: 1,
			max: 10,
			integer: true
		});

		return { name, mode, tier: tier || 1 };
	}

	/**
	 * Validate tier update input
	 */
	static validateTierUpdate(data: unknown): { tier: number } {
		if (!validateObject(data, "request body", { required: true })) {
			throw new ValidationError("Invalid request body", "body");
		}

		const obj = data as Record<string, unknown>;
		
		const tier = validateNumber(obj.tier, "tier", {
			required: true,
			min: 1,
			max: 10,
			integer: true
		})!;

		return { tier };
	}

	/**
	 * Validate pagination parameters
	 */
	static validatePagination(limit?: string | null, offset?: string | null): { limit: number; offset: number } {
		const validatedLimit = validateNumber(limit || "50", "limit", {
			min: 1,
			max: 1000,
			integer: true
		}) || 50;

		const validatedOffset = validateNumber(offset || "0", "offset", {
			min: 0,
			integer: true
		}) || 0;

		return { limit: validatedLimit, offset: validatedOffset };
	}

	/**
	 * Validate date range parameters
	 */
	static validateDateRange(start?: string | null, end?: string | null): { start?: Date; end?: Date } {
		const result: { start?: Date; end?: Date } = {};

		if (start) {
			const startStr = validateString(start, "start", { pattern: /^\d{4}-\d{2}-\d{2}$/ });
			if (startStr) {
				result.start = new Date(startStr);
				if (isNaN(result.start.getTime())) {
					throw new ValidationError("Invalid start date", "start");
				}
			}
		}

		if (end) {
			const endStr = validateString(end, "end", { pattern: /^\d{4}-\d{2}-\d{2}$/ });
			if (endStr) {
				result.end = new Date(endStr);
				if (isNaN(result.end.getTime())) {
					throw new ValidationError("Invalid end date", "end");
				}
			}
		}

		if (result.start && result.end && result.start > result.end) {
			throw new ValidationError("Start date must be before end date", "dateRange");
		}

		return result;
	}

	/**
	 * Validate strategy name
	 */
	static validateStrategy(strategy: unknown): string {
		return validateString(strategy, "strategy", {
			required: true,
			allowedValues: ["round_robin", "least_requests", "session_affinity", "tier_based"]
		})!;
	}
}