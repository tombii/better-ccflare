import {
	deleteApiKey,
	disableApiKey,
	enableApiKey,
	generateApiKey,
	listApiKeys,
} from "@better-ccflare/cli-commands";
import type { DatabaseOperations } from "@better-ccflare/database";
import { BadRequest } from "@better-ccflare/errors";
import type { ApiKeyGenerationResult } from "@better-ccflare/types";
import { errorResponse } from "../utils/http-error";

export function createApiKeysListHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const apiKeys = await listApiKeys(dbOps);
			const response = {
				success: true,
				data: apiKeys,
				count: apiKeys.length,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeysGenerateHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();
			const { name } = body;

			if (!name || typeof name !== "string" || name.trim().length === 0) {
				return errorResponse(
					BadRequest("Name is required and must be a non-empty string"),
				);
			}

			const result = await generateApiKey(dbOps, name.trim());
			const response: ApiKeyGenerationResult = {
				id: result.id,
				name: result.name,
				apiKey: result.apiKey, // Full key shown only once
				prefixLast8: result.prefixLast8,
				createdAt: result.createdAt,
			};

			return new Response(JSON.stringify({ success: true, data: response }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyDisableHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, name: string): Promise<Response> => {
		try {
			await disableApiKey(dbOps, name);
			const response = {
				success: true,
				message: `API key '${name}' disabled successfully`,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyEnableHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, name: string): Promise<Response> => {
		try {
			await enableApiKey(dbOps, name);
			const response = {
				success: true,
				message: `API key '${name}' enabled successfully`,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyDeleteHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, name: string): Promise<Response> => {
		try {
			await deleteApiKey(dbOps, name);
			const response = {
				success: true,
				message: `API key '${name}' deleted successfully`,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeysStatsHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const total = await dbOps.countAllApiKeys();
			const active = await dbOps.countActiveApiKeys();
			const inactive = total - active;

			const response = {
				success: true,
				data: {
					total,
					active,
					inactive,
				},
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}
