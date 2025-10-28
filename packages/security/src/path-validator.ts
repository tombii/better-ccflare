import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("PathValidator");

/**
 * Maximum number of URL decoding iterations to prevent double-encoded attacks
 * Example: %252e%252e -> %2e%2e -> ..
 */
const MAX_DECODE_ITERATIONS = 2;

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
	/** Whether to check for symbolic links (default: true) */
	checkSymlinks?: boolean;
	/** Description for logging purposes */
	description?: string;
}

/**
 * Get default allowed base directories for path validation
 *
 * @returns Array of allowed base directory paths
 */
export function getDefaultAllowedBasePaths(): string[] {
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

	return paths.map((p) => resolve(p));
}

/**
 * Validates a file system path for security vulnerabilities
 *
 * This function implements defense-in-depth with multiple validation layers:
 * 1. URL decoding (iterative to catch multi-encoded attacks)
 * 2. Directory traversal detection (".." sequences)
 * 3. Path resolution (normalization)
 * 4. Whitelist validation (allowed base directories)
 * 5. Symbolic link detection (optional warning)
 *
 * **Security Model:**
 * - **Whitelist approach**: Only paths within allowed base directories are accepted
 * - **Defense in depth**: Multiple layers of validation
 * - **Fail-safe**: Returns invalid on any error
 *
 * **Known Limitations:**
 * - Symbolic links are detected but not fully prevented (TOCTOU vulnerability)
 * - Windows-specific path attacks may not be fully covered on Unix systems
 * - Race conditions possible between validation and file access
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

	// Step 1: Decode URL-encoded sequences (with iteration limit)
	let decodedPath = rawPath;
	for (let i = 0; i < MAX_DECODE_ITERATIONS; i++) {
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

	// Step 2: Check for directory traversal in raw and decoded paths
	if (rawPath.includes("..") || decodedPath.includes("..")) {
		const reason = `Directory traversal detected in ${description}: ${rawPath}`;
		log.warn(reason);
		return { isValid: false, decodedPath, resolvedPath: "", reason };
	}

	// Step 3: Resolve the path (normalizes and makes absolute)
	let resolvedPath: string;
	try {
		resolvedPath = resolve(decodedPath);
	} catch {
		const reason = `Path resolution failed for ${description}: ${decodedPath}`;
		log.warn(reason);
		return { isValid: false, decodedPath, resolvedPath: "", reason };
	}

	// Step 4: Validate against allowed base directories (whitelist approach)
	const allowedBasePaths = [
		...getDefaultAllowedBasePaths(),
		...(options.additionalAllowedPaths || []).map((p) => resolve(p)),
	];

	const isWithinAllowedPaths = allowedBasePaths.some((basePath) =>
		resolvedPath.startsWith(basePath),
	);

	if (!isWithinAllowedPaths) {
		const reason = `Path outside allowed directories in ${description}: ${resolvedPath} (allowed: ${allowedBasePaths.join(", ")})`;
		log.warn(reason);
		return { isValid: false, decodedPath, resolvedPath, reason };
	}

	// Step 5: Check for symbolic links (warn but don't block - document limitation)
	if (checkSymlinks) {
		try {
			if (existsSync(resolvedPath)) {
				const stats = lstatSync(resolvedPath);
				if (stats.isSymbolicLink()) {
					log.warn(
						`Warning: ${description} contains symbolic link: ${resolvedPath}. ` +
							`Symlink-based traversal attacks are not fully prevented. ` +
							`Ensure symlinks point to safe locations.`,
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
