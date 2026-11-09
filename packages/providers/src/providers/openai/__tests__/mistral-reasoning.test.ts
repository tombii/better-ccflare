import type {
	OpenAIContentPart,
	OpenAIMessage,
	OpenAIRequest,
} from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import { OpenAICompatibleProvider } from "../provider";

/**
 * Mistral's strict request schema rejects a top-level `reasoning_content`
 * field on messages (HTTP 422). Prior assistant thinking must instead be sent
 * as a typed `thinking` content chunk at the head of `content`.
 */
describe("OpenAICompatibleProvider Mistral reasoning_content", () => {
	let provider: OpenAICompatibleProvider;

	const mistralAccount = (endpoint = "https://api.mistral.ai/v1") =>
		({
			name: "test-mistral",
			provider: "openai-compatible",
			custom_endpoint: JSON.stringify({ endpoint }),
			refresh_token: "test-api-key",
			priority: 1,
			status: "active",
			created_at: Date.now(),
			updated_at: Date.now(),
		}) as Account;

	/**
	 * Build an Anthropic-format request whose final assistant turn carries a
	 * thinking block plus the given content blocks, run it through
	 * transformRequestBody, and return the resulting OpenAI body.
	 */
	async function convert(
		account: Account | undefined,
		assistantContent: Array<Record<string, unknown>>,
		leadingMessages: Array<Record<string, unknown>> = [
			{ role: "user", content: "Hi" },
		],
	): Promise<OpenAIRequest> {
		const anthropicRequest = {
			model: "claude-sonnet-4-5",
			max_tokens: 100,
			messages: [
				...leadingMessages,
				{ role: "assistant", content: assistantContent },
				{ role: "user", content: "Continue" },
			],
		};
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(anthropicRequest),
		});
		const transformed = await provider.transformRequestBody(request, account);
		return (await transformed.json()) as OpenAIRequest;
	}

	const thinking = (text: string) => ({ type: "thinking", thinking: text });
	const text = (t: string) => ({ type: "text", text: t });

	beforeEach(() => {
		provider = new OpenAICompatibleProvider();
	});

	it("moves reasoning_content into a leading thinking chunk for string content", async () => {
		const body = await convert(mistralAccount(), [
			thinking("Let me think."),
			text("The answer is 42."),
		]);
		const assistant = body.messages[1];

		expect(assistant.role).toBe("assistant");
		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.content).toEqual([
			{
				type: "thinking",
				thinking: [{ type: "text", text: "Let me think." }],
				closed: true,
			},
			{ type: "text", text: "The answer is 42." },
		]);
		const parts = assistant.content as OpenAIContentPart[];
		expect(parts).toHaveLength(2);
		expect((parts[0] as unknown as { closed: boolean }).closed).toBe(true);
	});

	it("prepends the thinking chunk to array content, preserving element order", async () => {
		// Mixed non-text blocks (text + image) force the converter to emit
		// array content, which is the shape the rewrite must prepend to.
		const image = {
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "iVBORw0KGgo=",
			},
		};
		const body = await convert(mistralAccount(), [
			thinking("Reasoning here."),
			text("Look at this."),
			image,
		]);
		const assistant = body.messages[1];

		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.content).toEqual([
			{
				type: "thinking",
				thinking: [{ type: "text", text: "Reasoning here." }],
				closed: true,
			},
			{ type: "text", text: "Look at this." },
			expect.objectContaining({ type: "image_url" }),
		]);

		// Direct helper check: an existing array is prepended to, order intact.
		const direct: OpenAIRequest = {
			model: "m",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "First part." },
						{ type: "text", text: "Second part." },
					],
					reasoning_content: "Reasoning here.",
				},
			],
		};
		provider.afterConvert(direct, mistralAccount());
		expect(direct.messages[0].content).toEqual([
			{
				type: "thinking",
				thinking: [{ type: "text", text: "Reasoning here." }],
				closed: true,
			},
			{ type: "text", text: "First part." },
			{ type: "text", text: "Second part." },
		]);
	});

	it("handles thinking-only turns with tool calls without touching tool_calls", async () => {
		const toolUse = {
			type: "tool_use",
			id: "toolu_1",
			name: "get_weather",
			input: { city: "Paris" },
		};
		const body = await convert(mistralAccount(), [
			thinking("I should call the tool."),
			toolUse,
		]);
		const assistant = body.messages[1];

		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.content).toEqual([
			{
				type: "thinking",
				thinking: [{ type: "text", text: "I should call the tool." }],
				closed: true,
			},
		]);
		expect(assistant.tool_calls).toEqual([
			{
				id: "toolu_1",
				type: "function",
				function: {
					name: "get_weather",
					arguments: JSON.stringify({ city: "Paris" }),
				},
			},
		]);
	});

	it("drops whitespace-only reasoning_content without adding a chunk", async () => {
		const assistant: OpenAIMessage = {
			role: "assistant",
			content: "Plain answer.",
			reasoning_content: "   \n\t ",
		};
		const body: OpenAIRequest = {
			model: "mistral-large-latest",
			messages: [{ role: "user", content: "Hi" }, assistant],
		};

		provider.afterConvert(body, mistralAccount());

		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.content).toBe("Plain answer.");
	});

	it("leaves non-assistant messages and assistants without reasoning_content untouched", async () => {
		const userMsg: OpenAIMessage = {
			role: "user",
			content: "Hello",
			reasoning_content: "user-side noise",
		};
		const plainAssistant: OpenAIMessage = {
			role: "assistant",
			content: "No thinking here.",
		};
		const body: OpenAIRequest = {
			model: "mistral-large-latest",
			messages: [userMsg, plainAssistant],
		};

		provider.afterConvert(body, mistralAccount());

		expect(userMsg).toEqual({
			role: "user",
			content: "Hello",
			reasoning_content: "user-side noise",
		});
		expect(plainAssistant).toEqual({
			role: "assistant",
			content: "No thinking here.",
		});
	});

	it("leaves the body unchanged for non-Mistral endpoints", async () => {
		const makeBody = (): OpenAIRequest => ({
			model: "gpt-4o",
			messages: [
				{ role: "user", content: "Hi" },
				{
					role: "assistant",
					content: "Answer.",
					reasoning_content: "deep reasoning",
				},
			],
		});
		const account = {
			...mistralAccount("https://api.openai.com/v1"),
		} as Account;
		const body = makeBody();
		const before = JSON.stringify(body);

		provider.afterConvert(body, account);

		expect(JSON.stringify(body)).toBe(before);
		expect(body.messages[1].reasoning_content).toBe("deep reasoning");
		expect(body.messages[1].content).toBe("Answer.");
	});

	it("does not treat look-alike hosts as Mistral", () => {
		const body: OpenAIRequest = {
			model: "m",
			messages: [{ role: "assistant", content: "A", reasoning_content: "r" }],
		};
		provider.afterConvert(
			body,
			mistralAccount("https://api.mistral.ai.evil.com/v1"),
		);
		expect(body.messages[0].reasoning_content).toBe("r");
	});

	it("leaves the body unchanged when the account is undefined", async () => {
		const body = await convert(undefined, [
			thinking("Some thinking."),
			text("An answer."),
		]);
		const assistant = body.messages[1];

		expect(assistant.reasoning_content).toBe("Some thinking.");
		expect(assistant.content).toBe("An answer.");
	});

	it("leaves normal Mistral requests without thinking unchanged", async () => {
		const body = await convert(mistralAccount(), [text("Just an answer.")]);
		const assistant = body.messages[1];

		expect(assistant).toEqual({
			role: "assistant",
			content: "Just an answer.",
		});
		expect(body.messages[0]).toEqual({ role: "user", content: "Hi" });
	});

	it("tolerates a Mistral endpoint with a trailing /v1 slash and is byte-deterministic", async () => {
		const first = await convert(mistralAccount("https://api.mistral.ai/v1/"), [
			thinking("Stable."),
			text("Same bytes."),
		]);
		const second = await convert(mistralAccount("https://api.mistral.ai/v1/"), [
			thinking("Stable."),
			text("Same bytes."),
		]);
		expect(first.messages[1].reasoning_content).toBeUndefined();
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});
