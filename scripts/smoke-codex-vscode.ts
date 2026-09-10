/**
 * Exercise the VS Code extension's Codex app-server against the real Responses
 * adapter with a local, deterministic Anthropic upstream. No credentials or
 * external inference services are used. All Codex state lives in a temporary
 * directory which is removed when the test finishes.
 *
 * bun scripts/smoke-codex-vscode.ts /path/to/vscode/extension/bin/codex
 * Add --text-only to skip the harmless apply_patch round trip.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { handleResponsesRequest } from "../packages/openai-responses-adapter/src/handler";

const binary = process.argv[2];
if (!binary || binary.startsWith("--")) {
	throw new Error(
		"Usage: bun scripts/smoke-codex-vscode.ts /path/to/codex [--text-only]",
	);
}
const textOnly = process.argv.includes("--text-only");
const temp = await mkdtemp(join(tmpdir(), "ccflare-vscode-smoke-"));
const codexState = join(temp, "codex");
const workspace = join(temp, "workspace");
await mkdir(codexState);
await mkdir(workspace);

const marker = "better-ccflare VS Code smoke passed";
const patch =
	"*** Begin Patch\n*** Add File: smoke.txt\n+local adapter smoke\n*** End Patch";
const customInput = `text(await tools.apply_patch(${JSON.stringify(patch)}));`;
let upstreamToolName = "";
const requests: Array<Record<string, unknown>> = [];
const translated: Array<Record<string, any>> = [];
const errors: string[] = [];
const completedItems: Array<Record<string, any>> = [];
const methods = new Set<string>();
const pending = new Map<
	number,
	{ resolve: (value: any) => void; reject: (error: Error) => void }
>();
let nextId = 1;
let child: ReturnType<typeof Bun.spawn> | undefined;
let resolveTurn: (value: any) => void;
const turnCompleted = new Promise<any>((resolve) => {
	resolveTurn = resolve;
});

function anthropicStream(tool: boolean): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_smoke",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: tool
				? {
						type: "tool_use",
						id: "toolu_smoke",
						name: upstreamToolName,
						input: {},
					}
				: { type: "text", text: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: tool
				? {
						type: "input_json_delta",
						partial_json: JSON.stringify({ input: customInput }),
					}
				: { type: "text_delta", text: marker },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: {
				stop_reason: tool ? "tool_use" : "end_turn",
				stop_sequence: null,
			},
			usage: { output_tokens: 10 },
		},
		{ type: "message_stop" },
	];
	const bytes = new TextEncoder().encode(
		events
			.map(
				(event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
	);
	return new Response(
		new ReadableStream({
			start(controller) {
				// Deliberately split SSE frames and JSON strings across byte chunks.
				for (let offset = 0; offset < bytes.length; offset += 17)
					controller.enqueue(bytes.slice(offset, offset + 17));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

async function decodeBody(request: Request): Promise<Record<string, unknown>> {
	let bytes = new Uint8Array(await request.arrayBuffer());
	switch (request.headers.get("content-encoding")) {
		case "zstd":
			bytes = new Uint8Array(Bun.zstdDecompressSync(bytes));
			break;
		case "gzip":
			bytes = new Uint8Array(Bun.gunzipSync(bytes));
			break;
		case "deflate":
			bytes = new Uint8Array(Bun.inflateSync(bytes));
			break;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/v1/responses") {
			return new Response("Use HTTP SSE", { status: 426 });
		}
		if (request.method !== "POST" || url.pathname !== "/v1/responses") {
			errors.push(
				`Unexpected local request: ${request.method} ${url.pathname}`,
			);
			return new Response("Unexpected endpoint", { status: 404 });
		}
		requests.push(await decodeBody(request.clone()));
		const response = await handleResponsesRequest(
			request,
			url,
			async (upstream) => {
				const body = (await upstream.json()) as Record<string, any>;
				translated.push(body);
				if (!textOnly && translated.length === 1) {
					const tool = body.tools?.find((tool: any) =>
						tool.name.endsWith("_exec"),
					);
					assert.equal(
						tool?.input_schema?.properties?.input?.type,
						"string",
						"functions.exec must be exposed to Anthropic through its custom text bridge",
					);
					upstreamToolName = tool.name;
				}
				if (!textOnly && translated.length === 2) {
					const result = body.messages
						.flatMap((message: any) => message.content)
						.find(
							(block: any) =>
								block.type === "tool_result" &&
								block.tool_use_id === "toolu_smoke",
						);
					assert.ok(
						result,
						"Codex's custom tool result must translate back to Anthropic",
					);
					assert.ok(
						Array.isArray(result.content) &&
							result.content.every((block: any) => block.type === "text"),
						"Custom tool output content must use Anthropic text blocks",
					);
				}
				return anthropicStream(!textOnly && translated.length === 1);
			},
			{},
			"local-smoke",
		);
		if (!response.ok)
			errors.push(
				`Adapter HTTP ${response.status}: ${await response.clone().text()}`,
			);
		return response;
	},
	error(error) {
		errors.push(String(error));
		return new Response(JSON.stringify({ error: { message: String(error) } }), {
			status: 500,
		});
	},
});

function send(message: Record<string, unknown>) {
	assert.ok(child && typeof child.stdin !== "number" && child.stdin);
	child.stdin.write(`${JSON.stringify(message)}\n`);
}

function rpc(method: string, params: Record<string, unknown>): Promise<any> {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		send({ id, method, params });
	});
}

async function readMessages(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		let newline: number;
		while ((newline = buffered.indexOf("\n")) !== -1) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			if (message.id !== undefined && pending.has(message.id)) {
				const waiter = pending.get(message.id)!;
				pending.delete(message.id);
				if (message.error)
					waiter.reject(new Error(JSON.stringify(message.error)));
				else waiter.resolve(message.result);
			} else if (message.method) {
				methods.add(message.method);
				if (message.method === "item/completed")
					completedItems.push(message.params.item);
				if (message.method === "turn/completed")
					resolveTurn(message.params.turn);
				if (message.method === "error")
					errors.push(JSON.stringify(message.params));
				if (message.id !== undefined) {
					errors.push(`Unexpected client request: ${message.method}`);
					send({
						id: message.id,
						error: {
							code: -32601,
							message: "Unexpected request in isolated smoke test",
						},
					});
				}
			}
		}
	}
}

let timeout: ReturnType<typeof setTimeout> | undefined;
try {
	await writeFile(
		join(codexState, "config.toml"),
		[
			'model = "gpt-6-astra"',
			'model_provider = "smoke"',
			'approval_policy = "never"',
			'sandbox_mode = "workspace-write"',
			"[model_providers.smoke]",
			'name = "Loopback adapter smoke"',
			`base_url = "http://127.0.0.1:${server.port}/v1"`,
			'wire_api = "responses"',
			'env_key = "CCFLARE_SMOKE_API_KEY"',
			"requires_openai_auth = false",
			"request_max_retries = 0",
			"stream_max_retries = 0",
			"supports_websockets = false",
			"[analytics]",
			"enabled = false",
			"[feedback]",
			"enabled = false",
		].join("\n"),
	);
	child = Bun.spawn([resolve(binary), "app-server", "--stdio"], {
		cwd: workspace,
		// Explicit child environment prevents inherited API keys or proxy settings
		// from reaching the smoke process. It never reads the user's Codex home.
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: process.env.HOME,
			CODEX_HOME: codexState,
			CCFLARE_SMOKE_API_KEY: "local-smoke-only",
			RUST_LOG: "error",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(
		child.stderr as ReadableStream<Uint8Array>,
	).text();
	const reader = readMessages(child.stdout as ReadableStream<Uint8Array>);
	const exercise = async () => {
		const initialized = await rpc("initialize", {
			clientInfo: {
				name: "codex_vscode",
				title: "Local adapter smoke",
				version: "1.0.0",
			},
			capabilities: { experimentalApi: true, requestAttestation: false },
		});
		send({ method: "initialized" });
		const started = await rpc("thread/start", {
			cwd: workspace,
			ephemeral: true,
			approvalPolicy: "never",
			sandbox: "workspace-write",
			baseInstructions:
				"This is a deterministic local protocol test. Follow the synthetic user request.",
			experimentalRawEvents: true,
		});
		await rpc("turn/start", {
			threadId: started.thread.id,
			input: [
				{
					type: "text",
					text: textOnly
						? `Reply with ${marker}.`
						: `Create smoke.txt containing local adapter smoke, then reply with ${marker}.`,
				},
			],
			responsesapiClientMetadata: { smoke: "local-only" },
		});
		const turn = await turnCompleted;
		assert.equal(
			turn.status,
			"completed",
			`Turn failed: ${JSON.stringify(turn.error)}`,
		);
		assert.deepEqual(errors, []);
		assert.equal(requests.length, textOnly ? 1 : 2);
		assert.ok(
			completedItems.some(
				(item) => item.type === "agentMessage" && item.text === marker,
			),
			"VS Code app-server must receive translated final text",
		);
		if (!textOnly)
			assert.equal(
				await readFile(join(workspace, "smoke.txt"), "utf8"),
				"local adapter smoke\n",
			);
		console.log(
			JSON.stringify(
				{
					result: "passed",
					userAgent: initialized.userAgent,
					mode: textOnly
						? "text"
						: "namespaced custom exec/apply_patch round trip",
					requestCount: requests.length,
					requestFields: Object.keys(requests[0]).sort(),
					tools: (
						requests[0].tools as Array<Record<string, unknown>> | undefined
					)?.map(({ type, name }) => ({ type, name })),
					additionalTools: (requests[0].input as Array<Record<string, any>>)
						.filter((item) => item.type === "additional_tools")
						.flatMap((item) => item.tools)
						.map((tool) => ({
							type: tool.type,
							name: tool.name,
							tools: tool.tools?.map((nested: any) => ({
								type: nested.type,
								name: nested.name,
							})),
						})),
					inputItemTypes: requests.map((request) => [
						...new Set(
							(request.input as Array<Record<string, unknown>>).map(
								(item) => item.type,
							),
						),
					]),
					completedItemTypes: completedItems.map((item) => item.type),
					translatedModel: translated[0].model,
				},
				null,
				2,
			),
		);
	};
	await Promise.race([
		exercise(),
		new Promise((_, reject) => {
			timeout = setTimeout(
				() =>
					reject(
						new Error(
							`Smoke timed out. Adapter errors: ${JSON.stringify(errors)}; notifications: ${[...methods].join(", ")}`,
						),
					),
				40_000,
			);
		}),
		child.exited.then(async (code) => {
			throw new Error(
				`Codex exited with ${code}: ${(await stderr).slice(-2000)}`,
			);
		}),
		reader.then(() => {
			throw new Error("Codex closed app-server output before test completed");
		}),
	]);
} catch (error) {
	console.error(
		JSON.stringify(
			{
				result: "failed",
				error: String(error),
				adapterErrors: errors,
				toolResults: translated.flatMap((body) =>
					body.messages
						.flatMap((message: any) => message.content)
						.filter((block: any) => block.type === "tool_result"),
				),
				completedItemTypes: completedItems.map((item) => item.type),
				requestFields: requests.map((body) => Object.keys(body).sort()),
				tools: requests.map((body) =>
					(body.tools as Array<Record<string, unknown>> | undefined)?.map(
						({ type, name }) => ({ type, name }),
					),
				),
			},
			null,
			2,
		),
	);
	process.exitCode = 1;
} finally {
	if (timeout) clearTimeout(timeout);
	child?.kill();
	if (child) await child.exited;
	server.stop(true);
	await rm(temp, { recursive: true, force: true });
}
