import { describe, expect, it } from "bun:test";
import type { ProxyContext } from "../handlers";
import { forwardToClient } from "../response-handler";
import type { StartMessage } from "../worker-messages";

describe("native codex observability", () => {
	it("records client path, upstream path, and routing mode in worker start message", async () => {
		const posted: StartMessage[] = [];
		const ctx = {
			provider: {
				name: "codex",
				isStreamingResponse: () => false,
			},
			config: { getStorePayloads: () => false },
			usageWorker: {
				postMessage: (msg: StartMessage) => {
					if (msg.type === "start") posted.push(msg);
				},
			},
		} as unknown as ProxyContext;

		await forwardToClient(
			{
				requestId: "req-1",
				method: "POST",
				path: "/responses",
				clientPath: "/v1/codex/responses",
				upstreamPath: "/responses",
				routingMode: "native",
				account: {
					id: "codex-1",
					name: "codex",
					provider: "codex",
				} as never,
				requestHeaders: new Headers(),
				requestBody: null,
				response: new Response(JSON.stringify({ object: "response" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		expect(posted).toHaveLength(1);
		expect(posted[0]?.path).toBe("/v1/codex/responses");
		expect(posted[0]?.clientPath).toBe("/v1/codex/responses");
		expect(posted[0]?.upstreamPath).toBe("/responses");
		expect(posted[0]?.routingMode).toBe("native");
		expect(posted[0]?.providerName).toBe("codex");
	});
});
