import type { DatabaseOperations } from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";

export interface FinalRequestUsage {
	model?: string;
	inputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	tokensPerSecond?: number;
}

export interface FinalRequestPersistenceInput {
	requestId: string;
	timestamp: number;
	method: string;
	path: string;
	clientPath?: string | null;
	accountId: string | null;
	statusCode: number | null;
	success: boolean;
	error: string | null;
	responseTimeMs: number;
	failoverAttempts: number;
	usage: FinalRequestUsage;
	agentUsed?: string;
	apiKeyId?: string;
	apiKeyName?: string;
	project?: string | null;
	billingType?: string;
	comboName?: string | null;
	upstreamPath?: string | null;
	routingMode?: string | null;
}

export interface RequestPersistenceWriter {
	enqueue(job: () => Promise<void> | void): void;
}

export type SaveRequest = Pick<DatabaseOperations, "saveRequest">;

export function buildRequestSummary(
	input: FinalRequestPersistenceInput,
): RequestResponse {
	return {
		id: input.requestId,
		timestamp: new Date(input.timestamp).toISOString(),
		method: input.method,
		path: input.path,
		accountUsed: input.accountId,
		statusCode: input.statusCode,
		success: input.success,
		errorMessage: input.error,
		responseTimeMs: input.responseTimeMs,
		failoverAttempts: input.failoverAttempts,
		model: input.usage.model,
		promptTokens: input.usage.inputTokens,
		completionTokens: input.usage.outputTokens,
		totalTokens: input.usage.totalTokens,
		inputTokens: input.usage.inputTokens,
		cacheReadInputTokens: input.usage.cacheReadInputTokens,
		cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
		outputTokens: input.usage.outputTokens,
		costUsd: input.usage.costUsd,
		agentUsed: input.agentUsed,
		tokensPerSecond: input.usage.tokensPerSecond,
		apiKeyId: input.apiKeyId,
		apiKeyName: input.apiKeyName,
		project: input.project ?? undefined,
		billingType: input.billingType,
		comboName: input.comboName || undefined,
	};
}

export function enqueueFinalRequestPersistence(
	input: FinalRequestPersistenceInput,
	dbOps: SaveRequest,
	asyncWriter: RequestPersistenceWriter,
	onPersistedSummary: (summary: RequestResponse) => void,
	onError: (error: unknown) => void,
): void {
	const summary = buildRequestSummary(input);
	asyncWriter.enqueue(async () => {
		try {
			await dbOps.saveRequest(
				input.requestId,
				input.method,
				input.clientPath ?? input.path,
				input.accountId,
				input.statusCode,
				input.success,
				input.error,
				input.responseTimeMs,
				input.failoverAttempts,
				input.usage.model
					? {
							model: input.usage.model,
							promptTokens:
								(input.usage.inputTokens || 0) +
								(input.usage.cacheReadInputTokens || 0) +
								(input.usage.cacheCreationInputTokens || 0),
							completionTokens: input.usage.outputTokens,
							totalTokens: input.usage.totalTokens,
							costUsd: input.usage.costUsd,
							inputTokens: input.usage.inputTokens,
							outputTokens: input.usage.outputTokens,
							cacheReadInputTokens: input.usage.cacheReadInputTokens,
							cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
							tokensPerSecond: input.usage.tokensPerSecond,
						}
					: undefined,
				input.agentUsed,
				input.apiKeyId,
				input.apiKeyName,
				input.project ?? null,
				input.billingType,
				input.comboName || null,
				input.upstreamPath ?? null,
				input.routingMode ?? null,
			);
			onPersistedSummary(summary);
		} catch (error) {
			onError(error);
		}
	});
}
