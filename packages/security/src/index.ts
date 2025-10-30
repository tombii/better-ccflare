/**
 * @better-ccflare/security
 *
 * Centralized security utilities for path validation and sanitization.
 *
 * This package provides defense-in-depth protection against path traversal
 * and related file system security vulnerabilities.
 */

export {
	getDefaultAllowedBasePaths,
	type PathValidationOptions,
	type PathValidationResult,
	type SecurityConfig,
	validatePath,
	validatePathOrThrow,
} from "./path-validator";
