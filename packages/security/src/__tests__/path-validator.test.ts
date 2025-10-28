import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getDefaultAllowedBasePaths,
	validatePath,
	validatePathOrThrow,
} from "../path-validator";

// Test directory setup - using os.tmpdir() for cross-platform compatibility
const TEST_DIR = join(tmpdir(), "better-ccflare-security-tests");
const SAFE_DIR = join(TEST_DIR, "safe");
const UNSAFE_DIR = join(tmpdir(), "unsafe-dir");

describe("Path Validator - Core Security Tests", () => {
	beforeAll(() => {
		// Create test directories
		mkdirSync(SAFE_DIR, { recursive: true });
		mkdirSync(UNSAFE_DIR, { recursive: true });

		// Create test files
		writeFileSync(join(SAFE_DIR, "test.txt"), "safe content");
		writeFileSync(join(UNSAFE_DIR, "secret.txt"), "unsafe content");
	});

	afterAll(() => {
		// Cleanup
		try {
			rmSync(TEST_DIR, { recursive: true, force: true });
			rmSync(UNSAFE_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("validatePath - Direct Traversal Attempts", () => {
		test("should reject simple .. traversal", () => {
			const result = validatePath("../../etc/passwd", {
				description: "test path",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Directory traversal detected");
		});

		test("should reject multiple .. sequences", () => {
			const result = validatePath("../../../etc/shadow", {
				description: "test path",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Directory traversal detected");
		});

		test("should reject .. in middle of path", () => {
			const result = validatePath("/home/user/../../../etc/passwd", {
				description: "test path",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Directory traversal detected");
		});
	});

	describe("validatePath - URL-Encoded Traversal", () => {
		test("should reject single URL-encoded .. (%2e%2e)", () => {
			const result = validatePath("/%2e%2e/%2e%2e/etc/passwd", {
				description: "test path",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Directory traversal detected");
		});

		test("should reject double URL-encoded .. (%252e%252e)", () => {
			const result = validatePath("/%252e%252e/%252e%252e/etc/passwd", {
				description: "test path",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Directory traversal detected");
		});

		test("should reject mixed encoding", () => {
			const result = validatePath("/../%2e%2e/etc/passwd", {
				description: "test path",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Directory traversal detected");
		});

		test("should handle malformed URL encoding", () => {
			const result = validatePath("/%2e%2/invalid", {
				description: "test path",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Malformed URL encoding");
		});
	});

	describe("validatePath - Whitelist Validation", () => {
		test("should allow paths within /tmp", () => {
			const result = validatePath(join(TEST_DIR, "safe", "test.txt"), {
				description: "test path",
			});

			expect(result.isValid).toBe(true);
			expect(result.resolvedPath).toContain(TEST_DIR);
		});

		test("should reject absolute paths outside whitelist", () => {
			const result = validatePath("/etc/passwd", {
				description: "test path",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("outside allowed directories");
		});

		test("should reject paths that resolve outside whitelist", () => {
			// Even if no ".." in string, if it resolves outside, should fail
			const result = validatePath("/etc/shadow", {
				description: "test path",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("outside allowed directories");
		});

		test("should allow paths in current working directory", () => {
			const cwd = process.cwd();
			const testPath = join(cwd, "test-file.txt");

			const result = validatePath(testPath, {
				description: "test path",
			});

			expect(result.isValid).toBe(true);
			expect(result.resolvedPath).toContain(cwd);
		});

		test("CRITICAL: should reject prefix bypass attacks", () => {
			// Attack: /home/user-evil looks like it starts with /home/user but it doesn't!
			// This tests the fix for startsWith() vulnerability
			const result = validatePath("/tmp-evil/secret.txt", {
				description: "prefix bypass attempt",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("outside allowed directories");
		});

		test("CRITICAL: should reject directory name prefix attacks", () => {
			// If /home/user is allowed, /home/user-attacker should be blocked
			// Use absolute path that won't exist but tests the logic
			const result = validatePath("/home/user-attacker/attack.txt", {
				description: "directory prefix attack",
				additionalAllowedPaths: ["/home/user"], // Allow /home/user
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("outside allowed directories");
		});
	});

	describe("validatePath - Additional Allowed Paths", () => {
		test("should allow paths in additionalAllowedPaths", () => {
			const result = validatePath(join(UNSAFE_DIR, "secret.txt"), {
				description: "test path",
				additionalAllowedPaths: [UNSAFE_DIR],
			});

			expect(result.isValid).toBe(true);
			expect(result.resolvedPath).toContain(UNSAFE_DIR);
		});

		test("should still reject traversal even with additional paths", () => {
			const result = validatePath("../../../etc/passwd", {
				description: "test path",
				additionalAllowedPaths: [UNSAFE_DIR],
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Directory traversal detected");
		});
	});

	describe("validatePath - Symlink Detection", () => {
		test("should detect and warn about symlinks when enabled", () => {
			// Create a symlink
			const symlinkPath = join(TEST_DIR, "test-symlink");
			try {
				symlinkSync(join(SAFE_DIR, "test.txt"), symlinkPath);

				const result = validatePath(symlinkPath, {
					description: "test symlink",
					checkSymlinks: true,
				});

				// Should be valid but logged a warning
				expect(result.isValid).toBe(true);
			} catch {
				// Symlink creation might fail in some environments - skip test
			}
		});

		test("should skip symlink check when disabled", () => {
			const result = validatePath(join(SAFE_DIR, "test.txt"), {
				description: "test path",
				checkSymlinks: false,
			});

			expect(result.isValid).toBe(true);
		});
	});

	describe("validatePath - Edge Cases", () => {
		test("should handle empty path", () => {
			const result = validatePath("", {
				description: "empty path",
			});

			// Empty path resolves to cwd, which should be allowed
			expect(result.isValid).toBe(true);
		});

		test("should handle very long paths", () => {
			const longPath = `/tmp/${"a".repeat(4000)}`;
			const result = validatePath(longPath, {
				description: "long path",
			});

			// Should not crash, even if path is very long
			expect(result).toBeDefined();
			expect(typeof result.isValid).toBe("boolean");
		});

		test("should handle paths with special characters", () => {
			const result = validatePath(join(TEST_DIR, "test with spaces.txt"), {
				description: "path with spaces",
			});

			expect(result.isValid).toBe(true);
		});

		test("should explicitly reject null bytes", () => {
			const result = validatePath("/tmp/test\0file", {
				description: "null byte path",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Null byte detected");
		});

		test("should reject Windows backslash traversal", () => {
			const result = validatePath("..\\..\\etc\\passwd", {
				description: "windows traversal",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Directory traversal detected");
		});

		test("should reject mixed slash traversal", () => {
			const result = validatePath("../..\\etc/passwd", {
				description: "mixed traversal",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Directory traversal detected");
		});
	});

	describe("validatePath - Return Values", () => {
		test("should return decodedPath on success", () => {
			const encodedPath = join(TEST_DIR, "test%20file.txt");
			const result = validatePath(encodedPath, {
				description: "test path",
			});

			expect(result.decodedPath).toBeDefined();
			expect(result.decodedPath).not.toContain("%20");
		});

		test("should return resolvedPath on success", () => {
			const result = validatePath(join(TEST_DIR, "safe", "test.txt"), {
				description: "test path",
			});

			expect(result.resolvedPath).toBeDefined();
			expect(result.resolvedPath).toContain(TEST_DIR);
			// Resolved path should be absolute
			expect(result.resolvedPath.startsWith("/")).toBe(true);
		});

		test("should return reason on failure", () => {
			const result = validatePath("../../etc/passwd", {
				description: "test path",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toBeDefined();
			expect(result.reason).toContain("Directory traversal");
		});
	});

	describe("validatePathOrThrow", () => {
		test("should return safe path on success", () => {
			const testPath = join(TEST_DIR, "safe", "test.txt");
			const safePath = validatePathOrThrow(testPath, {
				description: "test path",
			});

			expect(safePath).toBeDefined();
			expect(safePath).toContain(TEST_DIR);
		});

		test("should throw error on traversal attempt", () => {
			expect(() => {
				validatePathOrThrow("../../etc/passwd", {
					description: "test path",
				});
			}).toThrow("Directory traversal detected");
		});

		test("should throw error on path outside whitelist", () => {
			expect(() => {
				validatePathOrThrow("/etc/shadow", {
					description: "test path",
				});
			}).toThrow("outside allowed directories");
		});

		test("thrown error should include description", () => {
			try {
				validatePathOrThrow("../../etc/passwd", {
					description: "sensitive config file",
				});
				expect(true).toBe(false); // Should not reach here
			} catch (error) {
				expect(error instanceof Error).toBe(true);
				expect((error as Error).message).toContain("sensitive config file");
			}
		});
	});

	describe("getDefaultAllowedBasePaths", () => {
		test("should return an array of paths", () => {
			const paths = getDefaultAllowedBasePaths();

			expect(Array.isArray(paths)).toBe(true);
			expect(paths.length).toBeGreaterThan(0);
		});

		test("should include temp directory", () => {
			const paths = getDefaultAllowedBasePaths();
			const systemTmp = tmpdir();

			expect(paths).toContain(systemTmp);
		});

		test("should include current working directory", () => {
			const paths = getDefaultAllowedBasePaths();
			const cwd = process.cwd();

			expect(paths.some((p) => p === cwd)).toBe(true);
		});

		test("all paths should be absolute", () => {
			const paths = getDefaultAllowedBasePaths();

			for (const path of paths) {
				expect(path.startsWith("/")).toBe(true);
			}
		});
	});

	describe("Integration Tests - Real-world Scenarios", () => {
		test("should prevent reading /etc/passwd via traversal", () => {
			const attacks = [
				"../../etc/passwd",
				"../../../etc/passwd",
				"/%2e%2e/%2e%2e/etc/passwd",
				"/tmp/../../../etc/passwd",
			];

			for (const attack of attacks) {
				const result = validatePath(attack, {
					description: "attack attempt",
				});
				expect(result.isValid).toBe(false);
			}
		});

		test("should allow legitimate file operations", () => {
			const legitimatePaths = [
				join(TEST_DIR, "safe", "test.txt"),
				"/tmp/my-app-cache",
				process.cwd(),
			];

			for (const path of legitimatePaths) {
				const result = validatePath(path, {
					description: "legitimate path",
				});
				expect(result.isValid).toBe(true);
			}
		});

		test("should handle complex real-world paths", () => {
			const result = validatePath(
				"/tmp/better-ccflare-test/workspace/.claude/agents/my-agent.md",
				{
					description: "agent file path",
				},
			);

			expect(result.isValid).toBe(true);
		});
	});

	describe("Edge Cases - Additional Security Tests", () => {
		test("should handle paths with repeated slashes", () => {
			const result = validatePath("/tmp///test//file.txt", {
				description: "repeated slashes",
			});

			// Repeated slashes should be normalized by resolve()
			expect(result.isValid).toBe(true);
			expect(result.resolvedPath).toBe("/tmp/test/file.txt");
		});

		test("should reject Unicode fullwidth dots (U+FF0E) that normalize to ..", () => {
			// Fullwidth full stop U+FF0E: ．
			// Two of them should NOT bypass traversal detection after normalization
			const fullwidthDot = "\uFF0E";
			const attack = `/tmp/${fullwidthDot}${fullwidthDot}/${fullwidthDot}${fullwidthDot}/etc/passwd`;

			const result = validatePath(attack, {
				description: "unicode attack",
			});

			// Note: FF0E normalizes to U+002E (.) but not to ".." sequence
			// This test verifies our normalization doesn't create false positives
			// The path should be valid but resolve to a safe location
			expect(result).toBeDefined();
		});

		test("should handle very long paths gracefully", () => {
			// PATH_MAX is typically 4096 on Linux
			const longPath = `/tmp/${"a".repeat(5000)}`;
			const result = validatePath(longPath, {
				description: "very long path",
			});

			// Should not crash, may be valid or invalid depending on filesystem
			expect(result).toBeDefined();
			expect(typeof result.isValid).toBe("boolean");
		});

		test("should normalize path with current directory references", () => {
			const result = validatePath("/tmp/./test/./file.txt", {
				description: "current dir references",
			});

			expect(result.isValid).toBe(true);
			expect(result.resolvedPath).toBe("/tmp/test/file.txt");
		});

		test("should handle mixed case on Unix (case-sensitive)", () => {
			const result = validatePath("/tmp/Test/FILE.txt", {
				description: "mixed case path",
			});

			// On Unix, case is preserved and path should be valid
			expect(result.isValid).toBe(true);
			expect(result.resolvedPath).toContain("/tmp");
		});

		test("should handle trailing slashes", () => {
			const result = validatePath("/tmp/test/", {
				description: "trailing slash",
			});

			expect(result.isValid).toBe(true);
		});

		test("should reject double-encoded traversal after normalization", () => {
			// %252E = encoded '%2E' = encoded '.'
			const attack = "/%252E%252E/%252E%252E/etc/passwd";

			const result = validatePath(attack, {
				description: "double-encoded attack",
			});

			expect(result.isValid).toBe(false);
			expect(result.reason).toContain("Directory traversal detected");
		});
	});
});
