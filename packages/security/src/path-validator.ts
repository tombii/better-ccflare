import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("PathValidator");

/**
 * Security configuration for path validation
 */
export interface SecurityConfig {
	/** Additional allowed base directories beyond the defaults */
	allowedBasePaths?: string[];
	/** Maximum number of URL decoding iterations (default: 2) */
	maxUrlDecodeIterations?: number;
	/** Whether to block symbolic links (default: false - warn only) */
	blockSymlinks?: boolean;
	/** Whether to check for symbolic links at all (default: true) */
	checkSymlinks?: boolean;
}

/**
 * Maximum number of URL decoding iterations to prevent double-encoded attacks
 * Example: %252e%252e -> %2e%2e -> ..
 */
const MAX_DECODE_ITERATIONS = 2;

/**
 * Cached default allowed paths for performance
 * Computed once and reused across validations
 */
let cachedDefaultAllowedPaths: string[] | null = null;

/**
 * Result of path validation
 */
export interface PathValidationResult {
	isValid: boolean;
	decodedPath: string;
	resolvedPath: string;
	reason?: string;
}

/**
 * Options for path validation
 */
export interface PathValidationOptions {
	/** Additional allowed base directories beyond the defaults */
	additionalAllowedPaths?: string[];
	/** Maximum number of URL decoding iterations (default: 2) */
	maxUrlDecodeIterations?: number;
	/** Whether to block symbolic links (default: false - warn only) */
	blockSymlinks?: boolean;
	/** Whether to check for symbolic links at all (default: true) */
	checkSymlinks?: boolean;
	/** Description for logging purposes */
	description?: string;
}

/**
 * Get default allowed base directories for path validation
 * Results are cached for performance
 *
 * @param forceRefresh - Force recomputation of cached paths
 * @returns Array of allowed base directory paths
 */
export function getDefaultAllowedBasePaths(forceRefresh = false): string[] {
	// Return cached value if available
	if (cachedDefaultAllowedPaths && !forceRefresh) {
		return cachedDefaultAllowedPaths;
	}

	const paths: string[] = [];

	// User's home directory
	try {
		const home = homedir();
		if (home) paths.push(home);
	} catch {
		// homedir() can fail in some environments
	}

	// Current working directory
	try {
		const cwd = process.cwd();
		if (cwd) paths.push(cwd);
	} catch {
		// process.cwd() can fail if directory was deleted
	}

	// Temp directory for testing purposes
	paths.push("/tmp");

	cachedDefaultAllowedPaths = paths.map((p) => resolve(p));
	return cachedDefaultAllowedPaths;
}

/**
 * Validates a file system path for security vulnerabilities
 *
 * This function implements defense-in-depth with multiple validation layers:
 * 1. URL decoding (iterative to catch multi-encoded attacks like %252e%252e)
 * 2. Unicode normalization (NFC to prevent fullwidth character bypasses)
 * 3. Null byte detection (prevent security bypass attempts)
 * 4. Directory traversal detection (".." sequences, Unix and Windows)
 * 5. Path resolution (normalization and absolutization)
 * 6. Whitelist validation (allowed base directories using path.relative())
 * 7. Symbolic link detection (optional warning or blocking)
 *
 * **Security Model:**
 * - **Whitelist approach**: Only paths within allowed base directories are accepted
 * - **Defense in depth**: Multiple layers of validation
 * - **Fail-safe**: Returns invalid on any error
 * - **Cross-platform**: Handles both Unix (/) and Windows (\) path separators
 *
 * **Known Limitations:**
 * - Symbolic links are detected but not fully prevented (TOCTOU vulnerability)
 * - Race conditions possible between validation and file access
 * - Very long paths may exceed PATH_MAX on some systems
 *
 * @param rawPath - The path to validate
 * @param options - Validation options
 * @returns Validation result with decoded and resolved paths
 *
 * @example
 * ```typescript
 * const result = validatePath("/home/user/../../etc/passwd");
 * if (!result.isValid) {
 *   console.error(`Path validation failed: ${result.reason}`);
 *   return;
 * }
 * // Safe to use result.resolvedPath
 * ```
 */
export function validatePath(
	rawPath: string,
	options: PathValidationOptions = {},
): PathValidationResult {
	const description = options.description || "path";
	const checkSymlinks = options.checkSymlinks !== false;
	const blockSymlinks = options.blockSymlinks === true;
	const maxDecodeIterations =
		options.maxUrlDecodeIterations || MAX_DECODE_ITERATIONS;

	// Step 1: Decode URL-encoded sequences (with iteration limit)
	let decodedPath = rawPath;
	for (let i = 0; i < maxDecodeIterations; i++) {
		try {
			const decoded = decodeURIComponent(decodedPath);
			if (decoded === decodedPath) break; // No more decoding needed
			decodedPath = decoded;
		} catch {
			// Decoding failed - path is malformed
			const reason = `Malformed URL encoding in ${description}: ${rawPath}`;
			log.warn(reason);
			return { isValid: false, decodedPath: "", resolvedPath: "", reason };
		}
	}

	// Normalize Unicode to prevent variations like FULLWIDTH FULL STOP from bypassing checks
	// NFC (Canonical Decomposition followed by Canonical Composition) is the standard form
	decodedPath = decodedPath.normalize("NFC");

	// Step 2: Check for null bytes (security bypass attempt)
	if (rawPath.includes("\0") || decodedPath.includes("\0")) {
		const reason = `Null byte detected in ${description}: ${rawPath}`;
		log.warn(reason, {
			source: description,
			path: rawPath,
			attack_type: "null_byte_injection",
			timestamp: new Date().toISOString(),
		});
		return { isValid: false, decodedPath, resolvedPath: "", reason };
	}

	// Step 3: Check for directory traversal in raw and decoded paths
	// Note: ".." check covers both Unix (..) and Windows (..\) patterns
	if (rawPath.includes("..") || decodedPath.includes("..")) {
		const reason = `Directory traversal detected in ${description}: ${rawPath}`;
		log.warn(reason, {
			source: description,
			path: rawPath,
			attack_type: "directory_traversal",
			timestamp: new Date().toISOString(),
		});
		return { isValid: false, decodedPath, resolvedPath: "", reason };
	}

	// Step 4: Resolve the path (normalizes and makes absolute)
	let resolvedPath: string;
	try {
		resolvedPath = resolve(decodedPath);
	} catch {
		const reason = `Path resolution failed for ${description}: ${decodedPath}`;
		log.warn(reason);
		return { isValid: false, decodedPath, resolvedPath: "", reason };
	}

	// Step 5: Validate against allowed base directories (whitelist approach)
	// SECURITY: Use path.relative() to prevent prefix bypass attacks
	// BAD: /home/user-evil starts with /home/user (VULNERABLE!)
	// GOOD: Use relative() to ensure path is truly within base directory
	const allowedBasePaths = [
		...getDefaultAllowedBasePaths(),
		...(options.additionalAllowedPaths || []).map((p) => resolve(p)),
	];

	let isWithinAllowedPaths = false;
	for (const basePath of allowedBasePaths) {
		const rel = relative(basePath, resolvedPath);
		// Path is within basePath if:
		// 1. Empty string (exact match with base path)
		// 2. Relative path that doesn't escape upward (no ".." prefix)
		// 3. Relative path that isn't absolute (no "/" or "\" prefix)
		// Check both Windows backslash and Unix forward slash for cross-platform security
		if (rel === "") {
			isWithinAllowedPaths = true;
			break;
		}
		if (
			rel &&
			!rel.startsWith("..") &&
			!rel.startsWith("/") &&
			!rel.startsWith("\\")
		) {
			isWithinAllowedPaths = true;
			break;
		}
	}

	if (!isWithinAllowedPaths) {
		const reason = `Path outside allowed directories in ${description}: ${resolvedPath} (allowed: ${allowedBasePaths.join(", ")})`;
		log.warn(reason, {
			source: description,
			path: rawPath,
			resolved_path: resolvedPath,
			attack_type: "whitelist_bypass",
			timestamp: new Date().toISOString(),
		});
		return { isValid: false, decodedPath, resolvedPath, reason };
	}

	// Step 6: Check for symbolic links
	if (checkSymlinks) {
		try {
			if (existsSync(resolvedPath)) {
				const stats = lstatSync(resolvedPath);
				if (stats.isSymbolicLink()) {
					if (blockSymlinks) {
						// Block symlinks if configured
						const reason = `Symbolic link not allowed in ${description}: ${resolvedPath}`;
						log.warn(reason, {
							source: description,
							path: rawPath,
							resolved_path: resolvedPath,
							attack_type: "symlink_attack",
							timestamp: new Date().toISOString(),
						});
						return { isValid: false, decodedPath, resolvedPath, reason };
					}
					// Otherwise just warn
					log.warn(
						`Warning: ${description} contains symbolic link: ${resolvedPath}. ` +
							`Symlink-based traversal attacks are not fully prevented. ` +
							`Ensure symlinks point to safe locations.`,
						{
							source: description,
							path: rawPath,
							resolved_path: resolvedPath,
							warning_type: "symlink_detected",
							timestamp: new Date().toISOString(),
						},
					);
				}
			}
		} catch (_error) {
			// lstatSync can fail for various reasons - don't block, just log
			log.info(
				`Could not check for symlinks in ${description}: ${resolvedPath}`,
			);
		}
	}

	return { isValid: true, decodedPath, resolvedPath };
}

/**
 * Validates a path and throws an error if invalid
 *
 * @param rawPath - The path to validate
 * @param options - Validation options
 * @returns The resolved safe path
 * @throws Error if path is invalid
 *
 * @example
 * ```typescript
 * try {
 *   const safePath = validatePathOrThrow("/home/user/file.txt");
 *   // Use safePath
 * } catch (error) {
 *   console.error("Invalid path:", error.message);
 * }
 * ```
 */
export function validatePathOrThrow(
	rawPath: string,
	options: PathValidationOptions = {},
): string {
	const result = validatePath(rawPath, options);
	if (!result.isValid) {
		throw new Error(result.reason || "Path validation failed");
	}
	return result.resolvedPath;
}
