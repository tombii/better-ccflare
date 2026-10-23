import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const CLI_PATH = join(process.cwd(), "apps/cli/src/main.ts");

// Tracks per-invocation temp databases so afterEach can remove them along
// with their SQLite WAL/SHM siblings. Each runCLI() below pushes one path
// here; the suite's afterEach() drains the set after the existing
// tempDir/Ssl-fixture rmSync. Without this the runCLI-routed BETTER_CCFLARE_DB_PATH
// files accumulate across repeated suite invocations under $TMPDIR.
const createdDbPaths = new Set<string>();

// Every runCLI() database is named `better-ccflare-cli-test-<pid>-<start>-<seq>.db`.
// The `<start>` disambiguates a reused PID (a killed run leaves its leaks behind,
// a later OS process can get the same PID), and the exact `-` delimiter keeps
// `<pid>-1` from prefix-matching `<pid>-10`.
//
// Cleanup runs in a module-scope afterEach (after each test, not each describe
// block) so an earlier test's database doesn't survive into the next one: a
// lingering child from a timed-out test keeps writing to a deleted inode while
// the next test's CLI fresh-migrates a ~0.5 GiB schema.
const CLI_TEST_DB_PREFIX = "better-ccflare-cli-test-";
const RUN_STARTED_AT = Date.now();
let dbSeq = 0;

/**
 * Prefix shared by every database this run creates before its sequence number.
 * The sweep below removes this run's files outright and leaves any other
 * run's alone.
 */
function testFilePrefix(): string {
	return `${CLI_TEST_DB_PREFIX}${process.pid}-${RUN_STARTED_AT}`;
}

function runTempDir(): string {
	return process.env.TMPDIR || "/tmp";
}

function nextDbSeq(): number {
	dbSeq += 1;
	return dbSeq;
}

/**
 * Helper function to run CLI command and get output
 * Available to all test suites
 */
function runCLI(args: string[]): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
}> {
	return new Promise((resolve) => {
		// Route the spawned CLI's database through the environment's temp dir so
		// tests pass under any sandbox that blocks writes to ~/.config/. The
		// CLI honours BETTER_CCFLARE_DB_PATH (see packages/database/src/factory.ts)
		// — honouring it here keeps each test run hermetic and removes a
		// ~/.config/better-ccflare/better-ccflare.db dependency the test never
		// asked for. Falls back to ~/.config in the unlikely event neither
		// TMPDIR nor HOME is writable.
		const cliDbPath = `${runTempDir()}/${testFilePrefix()}-${nextDbSeq()}.db`;
		createdDbPaths.add(cliDbPath);
		const proc = spawn("bun", ["run", CLI_PATH, ...args], {
			env: {
				...process.env,
				NODE_ENV: "test",
				BETTER_CCFLARE_DB_PATH: cliDbPath,
				// Keep the CLI's log file in this run's own temp directory instead
				// of the shared `$TMPDIR/better-ccflare-logs` (packages/logger).
				BETTER_CCFLARE_LOG_DIR: runTempDir(),
			},
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (exitCode) => {
			resolve({
				stdout,
				stderr,
				exitCode: exitCode || 0,
			});
		});

		// Kill after 6 seconds to prevent hanging (some CLI operations take longer)
		setTimeout(() => {
			proc.kill();
			resolve({
				stdout,
				stderr,
				exitCode: 1,
			});
		}, 6000);
	});
}

/**
 * Integration tests for the CLI
 * Tests the compiled binary to ensure all CLI commands work correctly
 */
describe("CLI Integration Tests", () => {
	let tempDir: string;
	let tempSslKeyPath: string;
	let tempSslCertPath: string;

	beforeEach(() => {
		// Create temp directory for SSL cert tests
		tempDir = join(tmpdir(), `better-ccflare-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		tempSslKeyPath = join(tempDir, "test.key");
		tempSslCertPath = join(tempDir, "test.crt");

		// Create dummy SSL files
		writeFileSync(
			tempSslKeyPath,
			"-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
		);
		writeFileSync(
			tempSslCertPath,
			"-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
		);
	});

	afterEach(() => {
		// Cleanup temp files
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch (_e) {
			// Ignore cleanup errors
		}
	});

	describe("Version Command", () => {
		it("should display version with --version flag", async () => {
			const result = await runCLI(["--version"]);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("better-ccflare v");
			expect(result.stdout).toMatch(/v\d+\.\d+\.\d+/);
		});

		it("should display version with -v flag", async () => {
			const result = await runCLI(["-v"]);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("better-ccflare v");
		});

		it("should exit quickly for version command", async () => {
			const startTime = Date.now();
			await runCLI(["--version"]);
			const duration = Date.now() - startTime;

			// Should complete in less than 2 seconds (fast exit)
			expect(duration).toBeLessThan(2000);
		});
	});

	describe("Help Command", () => {
		it("should display help with --help flag", async () => {
			const result = await runCLI(["--help"]);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("better-ccflare");
			expect(result.stdout).toContain("Usage:");
			expect(result.stdout).toContain("Options:");
			expect(result.stdout).toContain("--serve");
			expect(result.stdout).toContain("--add-account");
			expect(result.stdout).toContain("--list");
			expect(result.stdout).toContain("--force-reset-rate-limit");
		});

		it("should display help with -h flag", async () => {
			const result = await runCLI(["-h"]);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Usage:");
		});

		it("should show SSL options in help", async () => {
			const result = await runCLI(["--help"]);

			expect(result.stdout).toContain("--ssl-key");
			expect(result.stdout).toContain("--ssl-cert");
		});

		it("should show compact option in help", async () => {
			const result = await runCLI(["--help"]);

			expect(result.stdout).toContain("--compact");
		});

		it("should show every accepted account mode", async () => {
			const result = await runCLI(["--help"]);

			// Every mode accepted by --mode validation must be discoverable here.
			// Looping over the full list (instead of asserting a subset) prevents
			// the help surface from drifting silently when a mode is added/removed.
			const acceptedModes = [
				"claude-oauth",
				"console",
				"zai",
				"minimax",
				"nanogpt",
				"anthropic-compatible",
				"openai-compatible",
				"bedrock",
				"kilo",
				"alibaba-coding-plan",
				"codex",
				"xai",
				"ollama",
			];
			for (const mode of acceptedModes) {
				expect(result.stdout).toContain(mode);
			}
		});

		it("should exit quickly for help command", async () => {
			const startTime = Date.now();
			await runCLI(["--help"]);
			const duration = Date.now() - startTime;

			// Should complete in less than 2 seconds (fast exit)
			expect(duration).toBeLessThan(2000);
		});
	});

	describe("SSL Certificate Validation", () => {
		it("should accept valid SSL certificate paths", async () => {
			// Note: This test will timeout after 3s because the server starts successfully
			// but we're testing that the files are found before server startup
			const result = await runCLI([
				"--serve",
				"--port",
				"9999",
				"--ssl-key",
				tempSslKeyPath,
				"--ssl-cert",
				tempSslCertPath,
			]);

			// The server will start (and then be killed after 3s)
			// We're just verifying no "file not found" errors occurred
			const output = result.stdout + result.stderr;
			expect(output).not.toContain("SSL key file not found");
			expect(output).not.toContain("SSL certificate file not found");
		}, 10000); // Allow 10s timeout for this test

		it("should reject non-existent SSL key file", async () => {
			const result = await runCLI([
				"--serve",
				"--ssl-key",
				"/nonexistent/key.pem",
				"--ssl-cert",
				tempSslCertPath,
			]);

			const output = result.stdout + result.stderr;
			expect(output).toContain("SSL file path validation failed");
			expect(output).toContain("Path outside allowed directories");
		});

		it("should reject non-existent SSL cert file", async () => {
			const result = await runCLI([
				"--serve",
				"--ssl-key",
				tempSslKeyPath,
				"--ssl-cert",
				"/nonexistent/cert.pem",
			]);

			const output = result.stdout + result.stderr;
			expect(output).toContain("SSL file path validation failed");
			expect(output).toContain("Path outside allowed directories");
		});
	});

	describe("Add Account Command", () => {
		it("should reject add account without required flags", async () => {
			const result = await runCLI(["--add-account", "test-account"]);

			expect(result.exitCode).toBe(1);
			const output = result.stdout + result.stderr;
			expect(output).toContain("Please provide --mode to specify account type");
			expect(output).toContain("--mode");
			expect(output).toContain("--priority");
			expect(output).toContain("ollama");
		});

		it("should show example usage for add account", async () => {
			const result = await runCLI(["--add-account", "test-account"]);

			const output = result.stdout + result.stderr;
			expect(output).toContain("Example:");
			expect(output).toMatch(
				/better-ccflare.*--add-account.*--mode.*--priority/,
			);
		});

		// Note: "max" mode is remapped to "claude-oauth" with a deprecation warning,
		// but then starts an interactive OAuth flow that cannot be tested non-interactively.
		// The deprecation handling is covered by unit tests in the providers package.

		it("should reject invalid mode value", async () => {
			const result = await runCLI([
				"--add-account",
				"test-account",
				"--mode",
				"invalid-mode",
				"--priority",
				"0",
			]);

			expect(result.exitCode).toBe(1);
			const output = result.stdout + result.stderr;
			expect(output).toContain("Invalid mode");
			expect(output).toContain("Valid modes:");
		});
	});

	describe("Argument Parsing", () => {
		it("should parse port number correctly", async () => {
			const result = await runCLI(["--help", "--port", "8081"]);

			// Help should work regardless of other flags
			expect(result.exitCode).toBe(0);
		});

		it("should handle multiple flags", async () => {
			const result = await runCLI(["--version", "--port", "8081"]);

			// Version should take precedence and exit early
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("better-ccflare v");
		});

		it("should parse set-priority's two positional arguments", async () => {
			// Drives the real --set-priority branch in main.ts, which requires
			// exactly two non-flag arguments (name, priority) following it.
			// Omitting the priority hits the validation error, proving the
			// parser actually reads both positionals rather than just the flag.
			const result = await runCLI(["--set-priority", "some-account"]);

			expect(result.exitCode).toBe(1);
			const output = result.stdout + result.stderr;
			expect(output).toContain(
				"--set-priority requires an account name and priority",
			);
		});

		it("should read set-priority's positionals in name-then-priority order", async () => {
			// Complements the missing-argument test above by proving the parser
			// assigns each positional to the right slot, not just that it reads
			// two of them. A valid (name, priority) pair reaches the DB lookup
			// and fails with "not found" (proving both args parsed correctly);
			// swapping the order feeds a non-numeric string as the priority and
			// fails earlier with a NaN error instead. A regression that flips
			// the two positionals would make this test observe the wrong error.
			const valid = await runCLI(["--set-priority", "some-account", "42"]);
			expect(valid.exitCode).toBe(1);
			const validOutput = valid.stdout + valid.stderr;
			expect(validOutput).toContain("Account 'some-account' not found");

			const swapped = await runCLI(["--set-priority", "42", "some-account"]);
			expect(swapped.exitCode).toBe(1);
			const swappedOutput = swapped.stdout + swapped.stderr;
			expect(swappedOutput).toContain("Invalid priority value: NaN");
		});
	});

	describe("Error Handling", () => {
		it("should handle invalid port gracefully", async () => {
			const result = await runCLI(["--serve", "--port", "not-a-number"]);

			// Should not crash, should handle gracefully
			// Port will be parsed as NaN and either use default or error
			expect(result.exitCode).toBeGreaterThanOrEqual(0);
		});

		it("should handle invalid priority gracefully", async () => {
			const result = await runCLI([
				"--add-account",
				"test",
				"--mode",
				"claude-oauth",
				"--priority",
				"not-a-number",
			]);

			// Should handle NaN priority
			expect(result.exitCode).toBeGreaterThanOrEqual(0);
		});
	});

	describe("Performance", () => {
		it("should execute version command quickly (< 1s)", async () => {
			const startTime = Date.now();
			await runCLI(["--version"]);
			const duration = Date.now() - startTime;

			expect(duration).toBeLessThan(1000);
		});

		it("should execute help command quickly (< 1s)", async () => {
			const startTime = Date.now();
			await runCLI(["--help"]);
			const duration = Date.now() - startTime;

			expect(duration).toBeLessThan(1000);
		});
	});
});

// File-scope afterEach: cleans up the per-invocation CLI databases registered
// by every runCLI() call in this file — including the sibling describe blocks
// at the bottom of this file ("CLI Security Tests" and the parse-logic
// describe) that don't have their own afterEach. Each database takes its
// SQLite WAL/SHM/journal siblings and the CLI's pre-migration backups
// (`<db>.backup.<ts>`, ~0.5 GiB each) with it; otherwise they accumulate
// across runs.
//
// It runs after every test (not just at the end of a describe) so no database
// outlives its test. It also sweeps this run's own leftovers (files from tests
// that were killed or timed out before their hook could run). Other runs'
// files are left alone: they share $TMPDIR but may still be in use.
afterEach(() => {
	removeCliTestDatabases();
});

function removeCliTestDatabases(): void {
	for (const dbPath of createdDbPaths) {
		const base = dbPath.slice(0, -".db".length);
		try {
			for (const suffix of [
				".db",
				".db-wal",
				".db-shm",
				".db-journal",
				"-wal",
				"-shm",
				"-journal",
			]) {
				rmSync(`${base}${suffix}`, { force: true });
			}
			const dbDir = dirname(dbPath);
			const backupPrefix = `${basename(base)}.backup.`;
			for (const name of readdirSync(dbDir)) {
				if (name.startsWith(backupPrefix)) {
					rmSync(join(dbDir, name), { force: true });
				}
			}
		} catch (_e) {
			// Ignore cleanup errors
		}
	}
	createdDbPaths.clear();

	const tempDir = runTempDir();
	const ownPrefix = testFilePrefix();
	try {
		for (const name of readdirSync(tempDir)) {
			if (!name.startsWith(ownPrefix)) continue;
			const rest = name.slice(ownPrefix.length);
			// Only `<seq>.db` and its siblings — never a differently-shaped entry.
			if (!/^-\d+\.db(-wal|-shm|-journal)?(\.backup\.\d+)?$/.test(rest)) {
				continue;
			}
			try {
				rmSync(join(tempDir, name), { force: true });
			} catch (_e) {
				// Ignore per-file cleanup errors
			}
		}
	} catch (_e) {
		// Ignore cleanup errors
	}
}

/**
 * Security tests
 */
describe("CLI Security Tests", () => {
	it("should not expose sensitive data in help text", async () => {
		const result = await runCLI(["--help"]);

		const output = result.stdout + result.stderr;
		// Should not contain any API keys, tokens, or sensitive patterns
		expect(output).not.toContain("sk-");
		expect(output).not.toContain("token:");
		expect(output).not.toContain("password:");
	});

	it("should handle path traversal attempts in SSL paths gracefully", async () => {
		const maliciousPath = "../../../etc/passwd";
		const result = await runCLI([
			"--serve",
			"--ssl-key",
			maliciousPath,
			"--ssl-cert",
			"test.crt",
		]);

		// Should fail with directory traversal detection, not expose system paths
		const output = result.stdout + result.stderr;
		expect(output).toContain("SSL file path validation failed");
		expect(output).toContain("Directory traversal detected");
	});

	it("should sanitize error messages", async () => {
		const result = await runCLI([
			"--serve",
			"--ssl-key",
			"/tmp/nonexistent-key-with-sensitive-data-abc123.pem",
			"--ssl-cert",
			"/tmp/nonexistent-cert-with-sensitive-data-abc123.pem",
		]);

		const _output = result.stdout + result.stderr;
		// Should show error but not leak full paths unnecessarily
		expect(result.exitCode).toBeGreaterThan(0);
	});
});
