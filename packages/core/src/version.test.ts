import { describe, expect, it } from "bun:test";
import {
	extractClaudeVersion,
	getClientVersion,
	trackClientVersion,
} from "./version";

describe("extractClaudeVersion", () => {
	it("should extract version from standard claude-cli user-agent", () => {
		const userAgent = "claude-cli/2.0.55 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55");
	});

	it("should extract version from newer claude-cli user-agent", () => {
		const userAgent = "claude-cli/2.0.60 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.60");
	});

	it("should extract version with prerelease metadata", () => {
		const userAgent = "claude-cli/2.1.0-beta.1 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.1.0-beta.1");
	});

	it("should extract version with build metadata", () => {
		const userAgent = "claude-cli/2.0.55+build.123 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55+build.123");
	});

	it("should extract version with both prerelease and build metadata", () => {
		const userAgent = "claude-cli/2.1.0-rc.1+build.456 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.1.0-rc.1+build.456");
	});

	it("should handle case-insensitive matching", () => {
		const userAgent = "Claude-CLI/2.0.55 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55");
	});

	it("should return null for non-claude-cli user-agent", () => {
		const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
		expect(extractClaudeVersion(userAgent)).toBeNull();
	});

	it("should return null for null user-agent", () => {
		expect(extractClaudeVersion(null)).toBeNull();
	});

	it("should return null for empty string", () => {
		expect(extractClaudeVersion("")).toBeNull();
	});

	it("should return null for malformed version", () => {
		const userAgent = "claude-cli/invalid (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBeNull();
	});

	it("should extract version when embedded in longer user-agent string", () => {
		const userAgent =
			"some-prefix claude-cli/2.0.55 (external, cli) some-suffix";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55");
	});

	it("should handle version without suffix text", () => {
		const userAgent = "claude-cli/2.0.55";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55");
	});

	it("should extract first occurrence if multiple versions present", () => {
		const userAgent = "claude-cli/2.0.55 claude-cli/2.0.60";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55");
	});
});

describe("trackClientVersion and getClientVersion", () => {
	it("should track and return client version", () => {
		trackClientVersion("claude-cli/2.0.60 (external, cli)");
		expect(getClientVersion()).toBe("2.0.60");
	});

	it("should update to newer client version", () => {
		trackClientVersion("claude-cli/2.0.55 (external, cli)");
		expect(getClientVersion()).toBe("2.0.55");

		trackClientVersion("claude-cli/2.0.65 (external, cli)");
		expect(getClientVersion()).toBe("2.0.65");
	});

	it("should ignore non-claude-cli user-agents", () => {
		trackClientVersion("claude-cli/2.0.55 (external, cli)");
		const beforeVersion = getClientVersion();

		trackClientVersion("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
		expect(getClientVersion()).toBe(beforeVersion);
	});

	it("should handle null user-agent gracefully", () => {
		trackClientVersion("claude-cli/2.0.55 (external, cli)");
		const beforeVersion = getClientVersion();

		trackClientVersion(null);
		expect(getClientVersion()).toBe(beforeVersion);
	});
});
