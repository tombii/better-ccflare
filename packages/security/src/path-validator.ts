import { existsSync, lstatSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { platform } from "node:process";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("PathValidator");

// Cache NODE_ENV check for performance
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Security configuration for path validation
 */
export interface SecurityConfig {
	/** Additional allowed base directories beyond the defaults */
	allowedBasePaths?: string[];
	/** Maximum number of URL decoding iterations (default: 2) */
	maxUrlDecodeIterations?: number;
	/** Whether to block symbolic links (default: true - block for security) */
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
 * Default cache size for validation results
 * Tuned for typical workloads while limiting memory usage
 */
const DEFAULT_CACHE_SIZE = 1000;

/**
 * Cached default allowed paths for performance
 * Computed once and reused across validations
 */
let cachedDefaultAllowedPaths: string[] | null = null;

/**
 * LRU Cache for validation results to improve performance on repeated path checks
 * Key: resolved path string, Value: validation result
 */
class ValidationCache {
	private cache = new Map<string, PathValidationResult>();
	private maxSize = DEFAULT_CACHE_SIZE; // Use documented constant

	get(key: string): PathValidationResult | undefined {
		const result = this.cache.get(key);
		if (result) {
			// Move to end (LRU behavior)
			this.cache.delete(key);
			this.cache.set(key, result);
		}
		return result;
	}

	set(key: string, value: PathValidationResult): void {
		// Remove oldest if cache is full
		if (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}
		this.cache.set(key, value);
	}

	clear(): void {
		this.cache.clear();
	}

	size(): number {
		return this.cache.size;
	}
}

// Global validation cache instance
const validationCache = new ValidationCache();

// Track if we've warned about using default paths in production
let hasWarnedAboutDefaults = false;

// Rate limiting for attack detection
interface AttackAttempt {
	timestamp: number;
	source: string;
	attackType: string;
}

// Store attack attempts for rate limiting (simple sliding window)
const attackAttempts: AttackAttempt[] = [];
const MAX_ATTACK_ATTEMPTS = 10; // Max attempts to track
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute window

/**
 * Performance-optimized structured logging helper
 * Only creates expensive objects when not in production (for security events)
 */
/**
 * Check if there are too many attack attempts from the same source within the time window
 */
function isRateLimited(source: string, attackType: string): boolean {
	const now = Date.now();

	// Clean up old attempts outside the time window
	const cutoffTime = now - RATE_LIMIT_WINDOW_MS;
	const _initialLength = attackAttempts.length;
	attackAttempts.splice(0, attackAttempts.length - MAX_ATTACK_ATTEMPTS); // Keep only recent attempts
	attackAttempts.push({
		timestamp: now,
		source,
		attackType,
	});

	// Count attempts in the current window
	const recentAttempts = attackAttempts.filter(
		(attempt) =>
			attempt.timestamp >= cutoffTime &&
			attempt.source === source &&
			attempt.attackType === attackType,
	);

	// If we have more than 5 attempts in the window, consider it rate limited
	return recentAttempts.length > 5;
}

function logSecurityEvent(
	event: string,
	details: () => Record<string, unknown>,
) {
	// Check for rate limiting before logging
	const detailsObj = details();
	const source = (detailsObj.source as string) || "unknown";
	const attackType = (detailsObj.attack_type as string) || "unknown";

	if (isRateLimited(source, attackType)) {
		// Skip logging if rate limited to prevent log flooding
		return;
	}

	// In production, only log critical security events with minimal details
	if (IS_PRODUCTION) {
		const minimalDetails = {
			source: detailsObj.source,
			attack_type: detailsObj.attack_type,
		};
		log.warn(event, minimalDetails);
	} else {
		// In development, log full details for debugging
		log.warn(event, detailsObj);
	}
}

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
	/**
	 * Whether to block symbolic links (default: true - block for security)
	 *
	 * **Security Consideration:**
	 * The default is `true` to prevent symlink attacks which can bypass path validation
	 * through TOCTOU (Time-of-Check-Time-of-Use) vulnerabilities.
	 *
	 * **Recommendation for production:**
	 * Set `blockSymlinks: true` if your threat model requires preventing symlink attacks.
	 * Symlinks can potentially bypass path validation through TOCTOU vulnerabilities.
	 * See README.md for detailed security considerations.
	 */
	blockSymlinks?: boolean;
	/** Whether to check for symbolic links at all (default: true) */
	checkSymlinks?: boolean;
	/** Description for logging purposes */
	description?: string;
	/** Whether to allow empty strings (resolves to CWD). Default: true */
	allowEmpty?: boolean;
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

	// Better-ccflare config directory (OS-independent)
	try {
		const home = homedir();
		if (home) {
			let configDir: string;
			if (platform === "win32") {
				// Windows: Use LOCALAPPDATA or APPDATA
				const baseDir =
					process.env.LOCALAPPDATA ??
					process.env.APPDATA ??
					join(home, "AppData", "Local");
				configDir = join(baseDir, "better-ccflare");
			} else {
				// Linux/macOS: Follow XDG Base Directory specification
				const xdgConfig = process.env.XDG_CONFIG_HOME;
				const baseDir = xdgConfig ?? join(home, ".config");
				configDir = join(baseDir, "better-ccflare");
			}
			paths.push(configDir);
		}
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

	// Temp directory for testing purposes (cross-platform)
	try {
		const temp = tmpdir();
		if (temp) paths.push(temp);
	} catch {
		// tmpdir() should not fail, but handle gracefully
	}

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
 * **Production Security Warning:**
 * The default allowed paths (better-ccflare config directory, current directory, temp directory)
 * may still be too permissive for some production environments. Always specify explicit
 * `additionalAllowedPaths` in production for maximum security.
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

	// Input validation: reject null, undefined, or non-string paths
	if (
		rawPath === null ||
		rawPath === undefined ||
		typeof rawPath !== "string"
	) {
		const reason = `Invalid input: path must be a string, received ${rawPath === null ? "null" : rawPath === undefined ? "undefined" : typeof rawPath}`;
		log.debug(`${description} validation failed: ${reason}`);
		return {
			isValid: false,
			decodedPath: "",
			resolvedPath: "",
			reason,
		};
	}

	// Check for empty strings if allowEmpty is explicitly set to false
	const allowEmpty = options.allowEmpty !== false; // Default to true if not specified
	if (!allowEmpty && rawPath === "") {
		const reason = `Empty string not allowed for ${description}`;
		log.debug(`${description} validation failed: ${reason}`);
		return {
			isValid: false,
			decodedPath: "",
			resolvedPath: "",
			reason,
		};
	}

	const checkSymlinks = options.checkSymlinks !== false;
	const blockSymlinks = options.blockSymlinks === true;
	const maxDecodeIterations =
		options.maxUrlDecodeIterations || MAX_DECODE_ITERATIONS;

	// PRODUCTION WARNING: Log if using default paths in production (before caching)
	if (
		!options.additionalAllowedPaths?.length &&
		IS_PRODUCTION &&
		!hasWarnedAboutDefaults
	) {
		hasWarnedAboutDefaults = true;
		log.warn(
			`SECURITY WARNING: Using default allowed paths in production environment. ` +
				`This may be too permissive. Consider specifying explicit additionalAllowedPaths.`,
			{
				description,
				environment: "production",
				recommendation:
					"Add additionalAllowedPaths option for production security",
			},
		);
	}

	// PERFORMANCE: Check cache first for successful validations
	// Create cache key from raw path and relevant options (optimized to minimize string operations)
	const symlinkFlag = checkSymlinks ? "1" : "0";
	const blockFlag = blockSymlinks ? "1" : "0";
	const additionalPaths = (options.additionalAllowedPaths || [])
		.sort()
		.join(",");
	const cacheKey = `${rawPath}|${symlinkFlag}|${blockFlag}|${additionalPaths}|${description}`;
	const cached = validationCache.get(cacheKey);
	if (cached) {
		// Log cache hit at debug level to avoid performance impact in production
		log.debug(`Cache hit for ${description}: ${rawPath}`);
		return cached;
	}

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
			log.debug(reason);
			const result = {
				isValid: false,
				decodedPath: "",
				resolvedPath: "",
				reason,
			};
			validationCache.set(cacheKey, result);
			return result;
		}
	}

	// Normalize Unicode to prevent variations like FULLWIDTH FULL STOP from bypassing checks
	// NFKC (Compatibility Decomposition followed by Canonical Composition) is more aggressive
	// and handles compatibility characters (like fullwidth forms) better
	decodedPath = decodedPath.normalize("NFKC");

	// Step 2: Check for null bytes (security bypass attempt)
	if (rawPath.includes("\0") || decodedPath.includes("\0")) {
		const reason = `Null byte detected in ${description}: ${rawPath}${rawPath !== decodedPath ? ` (decoded: ${decodedPath})` : ""}`;
		logSecurityEvent(reason, () => ({
			source: description,
			path: rawPath,
			decoded_path: decodedPath,
			attack_type: "null_byte_injection",
			timestamp: new Date().toISOString(),
		}));
		const result = { isValid: false, decodedPath, resolvedPath: "", reason };
		validationCache.set(cacheKey, result);
		return result;
	}

	// Step 3: Check for directory traversal in raw and decoded paths
	// Note: ".." check covers both Unix (..) and Windows (..\) patterns
	if (rawPath.includes("..") || decodedPath.includes("..")) {
		const reason = `Directory traversal detected in ${description}: ${rawPath}${rawPath !== decodedPath ? ` (decoded: ${decodedPath})` : ""}`;
		logSecurityEvent(reason, () => ({
			source: description,
			path: rawPath,
			decoded_path: decodedPath,
			attack_type: "directory_traversal",
			timestamp: new Date().toISOString(),
		}));
		const result = { isValid: false, decodedPath, resolvedPath: "", reason };
		validationCache.set(cacheKey, result);
		return result;
	}

	// Step 4: Resolve the path (normalizes and makes absolute)
	let resolvedPath: string;
	try {
		resolvedPath = resolve(decodedPath);
	} catch {
		const reason = `Path resolution failed for ${description}: ${decodedPath}`;
		log.debug(reason);
		const result = { isValid: false, decodedPath, resolvedPath: "", reason };
		validationCache.set(cacheKey, result);
		return result;
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
		// 3. Relative path that isn't absolute (no path separator prefix)
		//
		// Check both native and alternative separators for cross-platform security:
		// - On Unix: check "/" and "\" (Windows-style attacks)
		// - On Windows: check "\" and "/" (Unix-style attacks)
		const nativeSep = sep; // Platform's native separator
		const altSep = nativeSep === "/" ? "\\" : "/"; // Alternative separator

		if (rel === "") {
			isWithinAllowedPaths = true;
			break;
		}
		if (
			rel &&
			!rel.startsWith("..") &&
			!rel.startsWith(nativeSep) &&
			!rel.startsWith(altSep)
		) {
			isWithinAllowedPaths = true;
			break;
		}
	}

	if (!isWithinAllowedPaths) {
		const reason = `Path outside allowed directories in ${description}: ${rawPath} → ${resolvedPath} (allowed: ${allowedBasePaths.join(", ")}). To allow this path, add it to additionalAllowedPaths option.`;
		logSecurityEvent(reason, () => ({
			source: description,
			path: rawPath,
			decoded_path: decodedPath,
			resolved_path: resolvedPath,
			attack_type: "whitelist_bypass",
			timestamp: new Date().toISOString(),
		}));
		const result = { isValid: false, decodedPath, resolvedPath, reason };
		validationCache.set(cacheKey, result);
		return result;
	}

	// Step 6: Check for symbolic links
	if (checkSymlinks) {
		try {
			if (existsSync(resolvedPath)) {
				const stats = lstatSync(resolvedPath);
				if (stats.isSymbolicLink()) {
					if (blockSymlinks) {
						// Block symlinks if configured
						const reason = `Symbolic link not allowed in ${description}: ${rawPath} → ${resolvedPath}`;
						logSecurityEvent(reason, () => ({
							source: description,
							path: rawPath,
							decoded_path: decodedPath,
							resolved_path: resolvedPath,
							attack_type: "symlink_attack",
							timestamp: new Date().toISOString(),
						}));
						const result = {
							isValid: false,
							decodedPath,
							resolvedPath,
							reason,
						};
						validationCache.set(cacheKey, result);
						return result;
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
		} catch (error) {
			// Type guard for Node.js system errors
			const isErrorWithCode = (err: unknown): err is { code: string } => {
				return (
					err !== null &&
					typeof err === "object" &&
					"code" in err &&
					typeof (err as { code: unknown }).code === "string"
				);
			};

			// ENOENT is expected for non-existent files, don't log as debug in that case
			if (isErrorWithCode(error) && error.code !== "ENOENT") {
				log.debug(
					`Could not check for symlinks in ${description}: ${resolvedPath}`,
					{
						error: error instanceof Error ? error.message : String(error),
						path: resolvedPath,
						description,
						error_code: error.code,
					},
				);
			}
		}
	}

	// PERFORMANCE: Cache successful result for future use
	const result = { isValid: true, decodedPath, resolvedPath };
	validationCache.set(cacheKey, result);

	// PERFORMANCE: Log successful validation at debug level in production
	if (IS_PRODUCTION) {
		log.debug(`Path validation successful: ${description} → ${resolvedPath}`);
	} else {
		log.info(`Path validation successful: ${description} → ${resolvedPath}`);
	}

	return result;
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

/**
 * Clear the validation cache
 * Useful for testing or when path configurations change
 */
export function clearValidationCache(): void {
	validationCache.clear();
}

/**
 * Get current cache size for monitoring
 * @returns Number of cached validation results
 */
export function getValidationCacheSize(): number {
	return validationCache.size();
}
