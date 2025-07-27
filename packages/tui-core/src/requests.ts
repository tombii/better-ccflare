import { DatabaseOperations } from "@claudeflare/database";

export interface RequestPayload {
	id: string;
	request: {
		headers: Record<string, string>;
		body: string | null;
	};
	response: {
		status: number;
		headers: Record<string, string>;
		body: string | null;
	} | null;
	error?: string;
	meta: {
		accountId?: string;
		retry?: number;
		timestamp: number;
		success?: boolean;
		rateLimited?: boolean;
		accountsAttempted?: number;
	};
}

export async function getRequests(limit = 100): Promise<RequestPayload[]> {
	const dbOps = new DatabaseOperations();
	const rows = dbOps.listRequestPayloads(limit);

	const parsed = rows.map((r: { id: string; json: string }) => {
		try {
			const data = JSON.parse(r.json);
			return { id: r.id, ...data } as RequestPayload;
		} catch {
			return {
				id: r.id,
				error: "Failed to parse payload",
				request: { headers: {}, body: null },
				response: null,
				meta: { timestamp: Date.now() },
			} as RequestPayload;
		}
	});

	return parsed;
}
