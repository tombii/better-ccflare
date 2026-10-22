import { createHash } from "node:crypto";
import {
	type AnthropicRequest,
	convertAnthropicRequestToOpenAI,
	type OpenAIMessage,
	type OpenAITool,
	type OpenAIToolChoice,
} from "@better-ccflare/openai-formats";

/**
 * Anthropic Messages request -> Qoder's own chat request JSON (the
 * `agent_chat_generation` body).
 *
 * Qoder's gateway does not speak OpenAI: the body is a fixed envelope with a
 * conversation record, a `chat_context` mirror of the current turn, and a
 * `business` block. Only `messages`, `tools` and `system` come from the
 * client, and those are OpenAI-shaped, so the shared Anthropic→OpenAI
 * converter does the block-level mapping and this file re-homes its output.
 * Reference: QODER_INTEGRATION.md §6.3.6.
 */

/** Qoder lists no `max_output_tokens`; 32768 is the documented ceiling. */
export const QODER_DEFAULT_MAX_OUTPUT_TOKENS = 32768;

/**
 * Claude model ids are never a valid Qoder wire key. A body that still carries
 * one reached the provider unmapped — better to fail the request than to have
 * Qoder silently fall back to an `auto` model.
 */
const CLAUDE_FAMILY = /fable|opus|sonnet|haiku/i;

export interface QoderRequestBody {
	request_id: string;
	request_set_id: string;
	chat_record_id: string;
	session_id: string;
	stream: true;
	chat_task: "FREE_INPUT";
	is_reply: true;
	is_retry: false;
	source: 1;
	version: "3";
	session_type: "qodercli";
	agent_id: "agent_common";
	task_id: "common";
	code_language: "";
	chat_prompt: "";
	image_urls: null;
	aliyun_user_type: "";
	system: string;
	messages: OpenAIMessage[];
	tools: OpenAITool[];
	tool_choice?: OpenAIToolChoice;
	parameters: {
		max_tokens: number;
		temperature?: number;
		top_p?: number;
		stop?: string[];
	};
	chat_context: {
		chatPrompt: "";
		imageUrls: null;
		extra: {
			context: [];
			modelConfig: { key: string; is_reasoning: boolean };
			originalContent: string;
		};
		features: [];
		text: string;
	};
	model_config: {
		key: string;
		is_reasoning: boolean;
		max_output_tokens: number;
		source: "system";
		reasoning_effort?: string;
	};
	business: {
		product: "cli";
		version: "1.0.0";
		type: "agent";
		stage: "start";
		id: string;
		name: string;
		begin_at: number;
	};
}

type AnthropicBody = Record<string, unknown>;

function shortHash(input: string, length = 16): string {
	return createHash("sha256").update(input).digest("hex").slice(0, length);
}

/** Flatten Anthropic `system` (string or text blocks) to one string. */
function systemText(system: unknown): string {
	if (typeof system === "string") return system;
	if (!Array.isArray(system)) return "";
	const parts: string[] = [];
	for (const block of system) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("");
}

function messageText(content: OpenAIMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("");
}

/**
 * Qoder's messages are plain `{role, content}` pairs: a string, never null and
 * never a content-part array. The shared converter leaves `null` on a
 * tool-call-only assistant turn and an array where the client marked
 * cache_control, so normalise both here.
 */
function withStringContent(message: OpenAIMessage): OpenAIMessage {
	if (message.content === null) return { ...message, content: "" };
	if (Array.isArray(message.content)) {
		return { ...message, content: messageText(message.content) };
	}
	return message;
}

/**
 * Qoder refuses a whole request when a tool_result answers no call (a hard 400
 * in the reference clients). Anthropic clients can lose the id — trimming an
 * older turn, compacting, replaying a truncated transcript — so every result is
 * matched to an outstanding call: by id first, then in order. A result with no
 * call left to answer is folded into the user turn as text.
 */
function repairToolResults(messages: OpenAIMessage[]): OpenAIMessage[] {
	// Pass 1: every call id, in conversation order. A result keeps the id of a
	// call that precedes it; one that matches no earlier call is reassigned
	// below rather than being left unmatched.
	const callIds = new Set<string>();
	for (const message of messages) {
		for (const call of message.tool_calls ?? []) {
			if (call.id) callIds.add(call.id);
		}
	}
	const outstanding: string[] = [];

	// Pass 2: walk the transcript. A result answers the call it names when that
	// call exists anywhere in the request; otherwise it takes the oldest call
	// still outstanding, or — with none — becomes text in the next user turn.
	// (Parallel results legitimately arrive out of order, so there is no FIFO.)
	const out: OpenAIMessage[] = [];
	const pendingOrphans: string[] = [];
	const flushOrphansInto = (message: OpenAIMessage): OpenAIMessage => {
		if (pendingOrphans.length === 0) return message;
		const text = messageText(message.content);
		const joined = [...pendingOrphans, text].filter(Boolean).join("\n");
		pendingOrphans.length = 0;
		return { ...message, content: joined };
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			for (const call of message.tool_calls ?? []) {
				if (call.id) outstanding.push(call.id);
			}
		}
		if (message.role === "tool") {
			const id = message.tool_call_id ?? "";
			// A result that names no call this request carries (an id the client
			// lost or invented) answers the oldest unmatched one under that call's
			// id — Qoder refuses a result whose id matches no tool_call.
			// A call id later in the transcript still names a call (the client
			// simply reordered turns); only an id that is nowhere is lost.
			const match =
				id && callIds.has(id) ? id : (outstanding[0] ?? null);
			if (match) {
				if (outstanding.includes(match)) {
					outstanding.splice(outstanding.indexOf(match), 1);
				}
				out.push({ ...message, tool_call_id: match });
				continue;
			}
			const text = messageText(message.content);
			if (text) pendingOrphans.push(text);
			continue;
		}

		if (message.role === "assistant" && pendingOrphans.length > 0) {
			out.push({ role: "user", content: pendingOrphans.join("\n") });
			pendingOrphans.length = 0;
		}
		out.push(flushOrphansInto(message));
	}
	if (pendingOrphans.length > 0) {
		out.push({ role: "user", content: pendingOrphans.join("\n") });
	}

	// Drop assistant turns left without content, tool calls or reasoning — Qoder
	// rejects an empty turn.
	return out.filter(
		(m) =>
			m.role !== "assistant" ||
			messageText(m.content).length > 0 ||
			(m.tool_calls?.length ?? 0) > 0 ||
			Boolean(m.reasoning_content),
	);
}

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Both free models default to "medium"; budgets scale across the range. */
function effortForBudget(budget: number): string {
	if (budget < 2048) return "low";
	if (budget < 8192) return "medium";
	if (budget < 16384) return "high";
	return "xhigh";
}

function resolveReasoning(anthropicBody: AnthropicBody): {
	isReasoning: boolean;
	effort?: string;
} {
	const thinking = anthropicBody.thinking as
		| { type?: string; budget_tokens?: number; effort?: string }
		| undefined;
	if (thinking?.type === "disabled") return { isReasoning: false };

	const requested =
		typeof thinking?.effort === "string"
			? thinking.effort.toLowerCase()
			: typeof thinking?.budget_tokens === "number"
				? effortForBudget(thinking.budget_tokens)
				: undefined;

	// Qoder's free models reason by default (is_reasoning: true); an explicit
	// client request is passed through when it is one Qoder names.
	const effort =
		requested &&
		(REASONING_EFFORTS as readonly string[]).includes(requested as string)
			? requested
			: requested && requested === "minimal"
				? "low"
				: undefined;
	return { isReasoning: true, effort };
}

export interface BuildQoderRequestOptions {
	/** Opaque per-account key (uid or account id) for the session hash. */
	sessionScope: string;
}

/**
 * @param anthropicBody - The client's Anthropic Messages body
 * @throws when the body carries no model, or a Claude model id
 */
export function buildQoderRequest(
	anthropicBody: AnthropicBody,
	options: BuildQoderRequestOptions = { sessionScope: "default" },
): QoderRequestBody {
	const model = anthropicBody.model;
	if (typeof model !== "string" || !model) {
		throw new Error("Qoder requires a model in the request body");
	}
	if (CLAUDE_FAMILY.test(model)) {
		throw new Error(
			`Qoder model "${model}" is a Claude model id, not a Qoder wire key (expected qfmodel, dfmodel, ...)`,
		);
	}

	// The system prompt is lifted to Qoder's top-level `system` member (leaving
	// it in place would push a system message into `messages`), Qoder is always
	// streamed, and its reasoning knobs live on `model_config` (below) rather
	// than the OpenAI `reasoning` field the converter would emit.
	const { system: _system, reasoning: _reasoning, ...messagesAndParams } =
		anthropicBody;
	void _system;
	void _reasoning;
	const openai = convertAnthropicRequestToOpenAI({
		...messagesAndParams,
		stream: true,
	} as unknown as AnthropicRequest);

	const messages = repairToolResults(
		(openai.messages ?? []).map(withStringContent),
	);
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const lastUserText = lastUser ? messageText(lastUser.content) : "";

	const maxTokens = Math.min(
		typeof anthropicBody.max_tokens === "number" && anthropicBody.max_tokens > 0
			? Math.floor(anthropicBody.max_tokens)
			: QODER_DEFAULT_MAX_OUTPUT_TOKENS,
		QODER_DEFAULT_MAX_OUTPUT_TOKENS,
	);

	const parameters: QoderRequestBody["parameters"] = { max_tokens: maxTokens };
	if (typeof anthropicBody.temperature === "number") {
		parameters.temperature = anthropicBody.temperature;
	}
	if (typeof anthropicBody.top_p === "number") {
		parameters.top_p = anthropicBody.top_p;
	}
	if (
		Array.isArray(anthropicBody.stop_sequences) &&
		anthropicBody.stop_sequences.length > 0
	) {
		parameters.stop = anthropicBody.stop_sequences.filter(
			(s): s is string => typeof s === "string",
		);
	}

	const { isReasoning, effort } = resolveReasoning(anthropicBody);

	// The conversation identity is stable for a transcript so follow-up turns
	// continue it, and distinct per conversation so parallel sessions do not.
	const requestSetId = shortHash(
		JSON.stringify({
			system: systemText(anthropicBody.system),
			messages: anthropicBody.messages ?? [],
		}),
	);
	const sessionId = shortHash(`qoder-session:${options.sessionScope}`);

	return {
		request_id: crypto.randomUUID(),
		request_set_id: requestSetId,
		chat_record_id: requestSetId,
		session_id: sessionId,
		stream: true,
		chat_task: "FREE_INPUT",
		is_reply: true,
		is_retry: false,
		source: 1,
		version: "3",
		session_type: "qodercli",
		agent_id: "agent_common",
		task_id: "common",
		code_language: "",
		chat_prompt: "",
		image_urls: null,
		aliyun_user_type: "",
		system: systemText(anthropicBody.system),
		messages,
		tools: openai.tools ?? [],
		...(openai.tool_choice !== undefined && (openai.tools?.length ?? 0) > 0
			? { tool_choice: openai.tool_choice }
			: {}),
		parameters,
		chat_context: {
			chatPrompt: "",
			imageUrls: null,
			extra: {
				context: [],
				modelConfig: { key: model, is_reasoning: isReasoning },
				originalContent: lastUserText,
			},
			features: [],
			text: lastUserText,
		},
		model_config: {
			key: model,
			is_reasoning: isReasoning,
			max_output_tokens: maxTokens,
			source: "system",
			...(effort ? { reasoning_effort: effort } : {}),
		},
		business: {
			product: "cli",
			version: "1.0.0",
			type: "agent",
			stage: "start",
			id: crypto.randomUUID(),
			name: lastUserText.slice(0, 30),
			begin_at: Date.now(),
		},
	};
}
