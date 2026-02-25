import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	canUseInferenceProfile,
	clearInferenceProfileCache,
	getFallbackMode,
} from "../inference-profile-cache";

// Mock AWS SDK
const mockSend = mock();
const mockBedrockClient = mock(() => ({ send: mockSend }));

mock.module("@aws-sdk/client-bedrock", () => ({
	BedrockClient: mockBedrockClient,
	ListInferenceProfilesCommand: mock((input: any) => input),
}));

// Mock credentials and config parsers
mock.module("../index", () => ({
	createBedrockCredentialChain: mock(() => ({})),
	parseBedrockConfig: mock((endpoint: string) => {
		if (endpoint?.startsWith("bedrock:")) {
			const parts = endpoint.split(":");
			return {
				profile: parts[1] || "default",
				region: parts[2] || "us-east-1",
			};
		}
		return null;
	}),
}));

describe("Inference Profile Cache", () => {
	const mockAccount: Account = {
		id: "test-account-id",
		name: "Test Bedrock Account",
		provider: "bedrock",
		custom_endpoint: "bedrock:default:us-east-1",
		api_key: "",
		priority: 0,
		created_at: Date.now(),
		paused: false,
	};

	beforeEach(() => {
		// Clear cache before each test
		clearInferenceProfileCache();
		mockSend.mockClear();
		mockBedrockClient.mockClear();
	});

	describe("canUseInferenceProfile", () => {
		it("should return true for geographic mode when profile supports it", async () => {
			// Mock API response with geographic profiles
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "us.anthropic.claude-opus-4-6-v1:0",
						inferenceProfileName: "Claude Opus 4.6 (US)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
					{
						inferenceProfileId: "eu.anthropic.claude-opus-4-6-v1:0",
						inferenceProfileName: "Claude Opus 4.6 (EU)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			const result = await canUseInferenceProfile(
				"claude-opus-4-6",
				"geographic",
				mockAccount,
			);

			expect(result).toBe(true);
			expect(mockSend).toHaveBeenCalledTimes(1);
		});

		it("should return false for global mode when profile doesn't support it", async () => {
			// Mock API response without global profile
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "us.anthropic.claude-opus-4-6-v1:0",
						inferenceProfileName: "Claude Opus 4.6 (US)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			const result = await canUseInferenceProfile(
				"claude-opus-4-6",
				"global",
				mockAccount,
			);

			expect(result).toBe(false);
		});

		it("should return true for global mode when profile supports it", async () => {
			// Mock API response with global profile
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "global.anthropic.claude-opus-4-6-v1:0",
						inferenceProfileName: "Claude Opus 4.6 (Global)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			const result = await canUseInferenceProfile(
				"claude-opus-4-6",
				"global",
				mockAccount,
			);

			expect(result).toBe(true);
		});

		it("should return true for regional mode when profile supports it", async () => {
			// Mock API response with regional (no prefix) profile
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "anthropic.claude-opus-4-6-v1:0",
						inferenceProfileName: "Claude Opus 4.6",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			const result = await canUseInferenceProfile(
				"claude-opus-4-6",
				"regional",
				mockAccount,
			);

			expect(result).toBe(true);
		});

		it("should use cached profiles on second call", async () => {
			// Mock API response
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "us.anthropic.claude-opus-4-6-v1:0",
						inferenceProfileName: "Claude Opus 4.6 (US)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			// First call - should fetch from API
			await canUseInferenceProfile(
				"claude-opus-4-6",
				"geographic",
				mockAccount,
			);

			// Second call - should use cache
			await canUseInferenceProfile(
				"claude-opus-4-6",
				"geographic",
				mockAccount,
			);

			// API should only be called once
			expect(mockSend).toHaveBeenCalledTimes(1);
		});

		it("should normalize model IDs with version suffixes", async () => {
			// Mock API response
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
						inferenceProfileName: "Claude 3.5 Sonnet",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			// Request with version suffix should match
			const result = await canUseInferenceProfile(
				"claude-3-5-sonnet-20241022-v2:0",
				"geographic",
				mockAccount,
			);

			expect(result).toBe(true);
		});

		it("should handle unknown models optimistically", async () => {
			// Mock API response with no profiles
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [],
			});

			const result = await canUseInferenceProfile(
				"claude-unknown-model",
				"geographic",
				mockAccount,
			);

			// Should return true to allow Bedrock to validate
			expect(result).toBe(true);
		});

		it("should handle API errors gracefully", async () => {
			// Mock API error
			mockSend.mockRejectedValueOnce(
				new Error("AccessDeniedException: Not authorized"),
			);

			const result = await canUseInferenceProfile(
				"claude-opus-4-6",
				"geographic",
				mockAccount,
			);

			// Should return true to allow request to proceed
			expect(result).toBe(true);
		});

		it("should aggregate geographic support from multiple profiles", async () => {
			// Mock API response with multiple geographic regions
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
						inferenceProfileName: "Claude 3.5 Sonnet (US)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
					{
						inferenceProfileId: "eu.anthropic.claude-3-5-sonnet-20241022-v2:0",
						inferenceProfileName: "Claude 3.5 Sonnet (EU)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
					{
						inferenceProfileId:
							"apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
						inferenceProfileName: "Claude 3.5 Sonnet (APAC)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			const result = await canUseInferenceProfile(
				"claude-3-5-sonnet-20241022",
				"geographic",
				mockAccount,
			);

			expect(result).toBe(true);
		});
	});

	describe("getFallbackMode", () => {
		it("should return null when requested mode is supported", async () => {
			// Mock API response with geographic profile
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "us.anthropic.claude-opus-4-6-v1:0",
						inferenceProfileName: "Claude Opus 4.6 (US)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			const fallback = await getFallbackMode(
				"claude-opus-4-6",
				"geographic",
				mockAccount,
			);

			expect(fallback).toBeNull();
		});

		it("should return global fallback when geographic not supported", async () => {
			// Mock API response with only global profile
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "global.anthropic.claude-opus-4-6-v1:0",
						inferenceProfileName: "Claude Opus 4.6 (Global)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			const fallback = await getFallbackMode(
				"claude-opus-4-6",
				"geographic",
				mockAccount,
			);

			expect(fallback).toBe("global");
		});

		it("should return geographic fallback when global not supported", async () => {
			// Mock API response with only geographic profile
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "us.anthropic.claude-opus-4-6-v1:0",
						inferenceProfileName: "Claude Opus 4.6 (US)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			const fallback = await getFallbackMode(
				"claude-opus-4-6",
				"global",
				mockAccount,
			);

			expect(fallback).toBe("geographic");
		});

		it("should return regional fallback as last resort", async () => {
			// Mock API response with only regional profile
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "anthropic.claude-opus-4-6-v1:0",
						inferenceProfileName: "Claude Opus 4.6",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			const fallback = await getFallbackMode(
				"claude-opus-4-6",
				"global",
				mockAccount,
			);

			expect(fallback).toBe("regional");
		});

		it("should return null when no fallback exists", async () => {
			// Mock API response with no profiles
			mockSend.mockResolvedValueOnce({
				inferenceProfileSummaries: [],
			});

			const fallback = await getFallbackMode(
				"claude-unknown-model",
				"geographic",
				mockAccount,
			);

			// Unknown model returns true optimistically, so no fallback needed
			expect(fallback).toBeNull();
		});
	});

	describe("Cache behavior", () => {
		it("should clear cache when clearInferenceProfileCache is called", async () => {
			// Mock API response
			mockSend.mockResolvedValue({
				inferenceProfileSummaries: [
					{
						inferenceProfileId: "us.anthropic.claude-opus-4-6-v1:0",
						inferenceProfileName: "Claude Opus 4.6 (US)",
						status: "ACTIVE",
						type: "SYSTEM_DEFINED",
					},
				],
			});

			// First call
			await canUseInferenceProfile(
				"claude-opus-4-6",
				"geographic",
				mockAccount,
			);

			// Clear cache
			clearInferenceProfileCache();

			// Second call should fetch from API again
			await canUseInferenceProfile(
				"claude-opus-4-6",
				"geographic",
				mockAccount,
			);

			expect(mockSend).toHaveBeenCalledTimes(2);
		});
	});

	describe("Error handling", () => {
		it("should show ListInferenceProfiles permission error message", async () => {
			// Mock permission error
			mockSend.mockRejectedValueOnce(
				new Error(
					"AccessDeniedException: User is not authorized to perform: bedrock:ListInferenceProfiles",
				),
			);

			const result = await canUseInferenceProfile(
				"claude-opus-4-6",
				"geographic",
				mockAccount,
			);

			// Should still return true to allow request to proceed
			expect(result).toBe(true);
		});

		it("should retry on throttling errors", async () => {
			// Mock throttling error followed by success
			mockSend
				.mockRejectedValueOnce(new Error("ThrottlingException: Rate exceeded"))
				.mockResolvedValueOnce({
					inferenceProfileSummaries: [
						{
							inferenceProfileId: "us.anthropic.claude-opus-4-6-v1:0",
							inferenceProfileName: "Claude Opus 4.6 (US)",
							status: "ACTIVE",
							type: "SYSTEM_DEFINED",
						},
					],
				});

			const result = await canUseInferenceProfile(
				"claude-opus-4-6",
				"geographic",
				mockAccount,
			);

			expect(result).toBe(true);
			expect(mockSend).toHaveBeenCalledTimes(2);
		});

		it("should handle invalid account config", async () => {
			const invalidAccount: Account = {
				...mockAccount,
				custom_endpoint: "invalid-config",
			};

			const result = await canUseInferenceProfile(
				"claude-opus-4-6",
				"geographic",
				invalidAccount,
			);

			expect(result).toBe(false);
			expect(mockSend).not.toHaveBeenCalled();
		});
	});
});
