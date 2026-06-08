import { expect, test } from "bun:test";
import type { RequestResponse } from "@better-ccflare/types";
import {
	buildRequestSummary,
	enqueueFinalRequestPersistence,
	type FinalRequestPersistenceInput,
	type RequestPersistenceWriter,
	type SaveRequest,
} from "../request-persistence-summary";

function baseInput(): FinalRequestPersistenceInput {
	return {
		requestId: "req-live-1",
		timestamp: 1_700_000_000_000,
		method: "POST",
		path: "/v1/messages",
		clientPath: "/v1/messages",
		accountId: "acct-1",
		statusCode: 200,
		success: true,
		error: null,
		responseTimeMs: 123,
		failoverAttempts: 0,
		usage: {
			model: "claude-test",
			inputTokens: 10,
			cacheReadInputTokens: 2,
			cacheCreationInputTokens: 3,
			outputTokens: 5,
			totalTokens: 20,
			costUsd: 0.001,
			tokensPerSecond: 42,
		},
		agentUsed: "agent-a",
		apiKeyId: "key-1",
		apiKeyName: "test key",
		project: "project-a",
		billingType: "plan",
		comboName: "combo-a",
		upstreamPath: "/messages",
		routingMode: "native",
	};
}

test("buildRequestSummary preserves the live summary shape", () => {
	const summary = buildRequestSummary(baseInput());

	expect(summary).toEqual({
		id: "req-live-1",
		timestamp: new Date(1_700_000_000_000).toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acct-1",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 123,
		failoverAttempts: 0,
		model: "claude-test",
		promptTokens: 10,
		completionTokens: 5,
		totalTokens: 20,
		inputTokens: 10,
		cacheReadInputTokens: 2,
		cacheCreationInputTokens: 3,
		outputTokens: 5,
		costUsd: 0.001,
		agentUsed: "agent-a",
		tokensPerSecond: 42,
		apiKeyId: "key-1",
		apiKeyName: "test key",
		project: "project-a",
		billingType: "plan",
		comboName: "combo-a",
	} satisfies RequestResponse);
});

test("completed SSE summary is emitted only after saveRequest succeeds", async () => {
	let capturedJob: (() => Promise<void> | void) | null = null;
	const writer: RequestPersistenceWriter = {
		enqueue: (job) => {
			capturedJob = job;
		},
	};

	let resolveSave: (() => void) | null = null;
	const saveRequestCalls: unknown[][] = [];
	const dbOps: SaveRequest = {
		saveRequest: (...args) => {
			saveRequestCalls.push(args);
			return new Promise<void>((resolve) => {
				resolveSave = resolve;
			});
		},
	};

	const summaries: RequestResponse[] = [];
	enqueueFinalRequestPersistence(
		baseInput(),
		dbOps,
		writer,
		(summary) => summaries.push(summary),
		() => {},
	);

	expect(summaries).toHaveLength(0);
	expect(capturedJob).toBeFunction();

	const jobPromise = capturedJob?.();
	expect(summaries).toHaveLength(0);
	expect(saveRequestCalls).toHaveLength(1);
	expect(saveRequestCalls[0][0]).toBe("req-live-1");
	expect(saveRequestCalls[0][2]).toBe("/v1/messages");
	expect(saveRequestCalls[0][9]).toEqual({
		model: "claude-test",
		promptTokens: 15,
		completionTokens: 5,
		totalTokens: 20,
		costUsd: 0.001,
		inputTokens: 10,
		outputTokens: 5,
		cacheReadInputTokens: 2,
		cacheCreationInputTokens: 3,
		tokensPerSecond: 42,
	});

	resolveSave?.();
	await jobPromise;

	expect(summaries).toHaveLength(1);
	expect(summaries[0].id).toBe("req-live-1");
});

test("failed saveRequest does not emit a completed SSE summary", async () => {
	let capturedJob: (() => Promise<void> | void) | null = null;
	const writer: RequestPersistenceWriter = {
		enqueue: (job) => {
			capturedJob = job;
		},
	};
	const error = new Error("db busy");
	const dbOps: SaveRequest = {
		saveRequest: () => Promise.reject(error),
	};
	const summaries: RequestResponse[] = [];
	const errors: unknown[] = [];

	enqueueFinalRequestPersistence(
		baseInput(),
		dbOps,
		writer,
		(summary) => summaries.push(summary),
		(err) => errors.push(err),
	);

	await capturedJob?.();

	expect(summaries).toHaveLength(0);
	expect(errors).toEqual([error]);
});
