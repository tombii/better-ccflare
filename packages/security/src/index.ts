/**
 * @better-ccflare/security
 *
 * Centralized security utilities for path validation and sanitization.
 *
 * This package provides defense-in-depth protection against path traversal
 * and related file system security vulnerabilities.
 */

export {
	validatePath,
	validatePathOrThrow,
	getDefaultAllowedBasePaths,
	type PathValidationResult,
	type PathValidationOptions,
	type SecurityConfig,
} from "./path-validator";
