import { describe, expect, it, mock, spyOn } from "bun:test";
import type { ProxyContext } from "../handlers";
import { forwardToClient } from "../response-handler";
import * as usageCollectorModule from "../usage-collector";
import type { StartMessage } from "../worker-messages";

describe("native codex observability", () => {
	it("records client path, upstream path, and routing mode in collector start message", async () => {
		const starts: StartMessage[] = [];
		const collector = {
			handleStart: mock((msg: StartMessage) => {
				starts.push(msg);
			}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		};

		spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		const ctx = {
			provider: {
				name: "codex",
				isStreamingResponse: () => false,
			},
			config: { getStorePayloads: () => false },
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

		expect(starts).toHaveLength(1);
		expect(starts[0]?.path).toBe("/v1/codex/responses");
		expect(starts[0]?.clientPath).toBe("/v1/codex/responses");
		expect(starts[0]?.upstreamPath).toBe("/responses");
		expect(starts[0]?.routingMode).toBe("native");
		expect(starts[0]?.providerName).toBe("codex");
	});
});
