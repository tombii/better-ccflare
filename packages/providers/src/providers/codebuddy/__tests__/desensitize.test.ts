import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	desensitizeBody,
	desensitizeMessages,
	desensitizeText,
	isCodeBuddyDesensitizeEnabled,
	isCodeBuddyModerationBlock,
	SENSITIVE_TERMS,
} from "../desensitize";

const ZWSP = "\u200b";

/** Remove the inserted zero-width spaces so visible text can be compared. */
const visible = (text: string) => text.replaceAll(ZWSP, "");

describe("desensitizeText", () => {
	it("inserts a zero-width space into a matching term", () => {
		expect(desensitizeText("Refuse DoS attacks.")).toBe(
			`Refuse D${ZWSP}oS att${ZWSP}acks.`,
		);
	});

	it("is case-insensitive and preserves the original casing", () => {
		const out = desensitizeText("EXPLOIT development");
		expect(out).toContain(ZWSP);
		expect(visible(out)).toBe("EXPLOIT development");
	});

	it("handles multi-word terms as one unit", () => {
		const out = desensitizeText("credential testing is dual-use");
		expect(out).toContain(ZWSP);
		expect(visible(out)).toBe("credential testing is dual-use");
		// The whole phrase is split once, not term-by-term.
		expect(out.split(ZWSP)).toHaveLength(2);
	});

	it("prefers the longest matching term", () => {
		// "DDoS" must win over "DoS".
		const out = desensitizeText("DDoS");
		expect(out).toHaveLength("DDoS".length + 1);
		expect(visible(out)).toBe("DDoS");
	});

	it("leaves text without matching terms untouched", () => {
		const text = "这是一段正常的中文，不含任何触发词。";
		expect(desensitizeText(text)).toBe(text);
		expect(desensitizeText("")).toBe("");
	});

	it("does not alter visible characters", () => {
		const original = "C2 frameworks and privilege escalation";
		const out = desensitizeText(original);
		expect(visible(out)).toBe(original);
	});

	it("is deterministic for the same input", () => {
		const input = "Refuse DoS, exploit development and C2 frameworks.";
		expect(desensitizeText(input)).toBe(desensitizeText(input));
	});

	it("matches whole words only", () => {
		// "kill" must not fire inside "skill", nor "omp" inside "complete".
		expect(desensitizeText("skill")).toBe("skill");
		expect(desensitizeText("complete")).toBe("complete");
		expect(desensitizeText("kill")).toBe(`ki${ZWSP}ll`);
	});

	it("splits terms that start with punctuation", () => {
		const out = desensitizeText("see [CC] and skill://");
		expect(visible(out)).toBe("see [CC] and skill://");
		expect(out).toContain(ZWSP);
	});

	it("covers every declared term", () => {
		for (const term of SENSITIVE_TERMS) {
			const out = desensitizeText(term);
			expect(out).toContain(ZWSP);
			expect(visible(out)).toBe(term);
		}
	});
});

describe("desensitizeMessages", () => {
	it("only touches system messages by default", () => {
		const messages = [
			{
				role: "system",
				content: "Refuse DoS attacks and exploit development.",
			},
			{ role: "user", content: "explain DoS attacks" },
			{ role: "assistant", content: "malware" },
		];

		const out = desensitizeMessages(messages);

		expect(out[0].content).toContain(ZWSP);
		expect(out[1].content).toBe("explain DoS attacks");
		expect(out[2].content).toBe("malware");
	});

	it("handles content block arrays", () => {
		const messages = [
			{
				role: "system",
				content: [
					{ type: "text", text: "Refuse C2 frameworks." },
					{ type: "image", source: { type: "url", url: "x" } },
				],
			},
		];

		const out = desensitizeMessages(messages);
		const blocks = out[0].content as Array<Record<string, unknown>>;

		expect(blocks[0].text).toContain(ZWSP);
		expect(visible(blocks[0].text as string)).toBe("Refuse C2 frameworks.");
		expect(blocks[1]).toStrictEqual({
			type: "image",
			source: { type: "url", url: "x" },
		});
	});

	it("does not mutate the caller's objects", () => {
		const messages = [{ role: "system", content: "exploit" }];
		const out = desensitizeMessages(messages);

		expect(messages[0].content).toBe("exploit");
		expect(out[0].content).toContain(ZWSP);
	});

	it("accepts a wider role set when asked", () => {
		const messages = [{ role: "user", content: "DoS" }];
		const out = desensitizeMessages(messages, ["system", "user"]);
		expect(out[0].content).toContain(ZWSP);
	});
});

describe("desensitizeBody", () => {
	it("returns a new body with desensitized messages", () => {
		const body = {
			model: "primary-model",
			messages: [
				{ role: "system", content: "Refuse DoS." },
				{ role: "user", content: "DoS" },
			],
		};

		const out = desensitizeBody(body);

		expect(out).not.toBe(body);
		expect(body.messages[0].content).toBe("Refuse DoS.");
		expect((out.messages as Array<{ content: string }>)[0].content).toContain(
			ZWSP,
		);
		expect((out.messages as Array<{ content: string }>)[1].content).toBe("DoS");
		expect(out.model).toBe("primary-model");
	});

	it("returns the body unchanged when there are no messages", () => {
		const body = { model: "x" };
		expect(desensitizeBody(body)).toBe(body);
	});
});

describe("isCodeBuddyDesensitizeEnabled", () => {
	const original = process.env.CCFLARE_CODEBUDDY_DESENSITIZE;

	beforeEach(() => {
		delete process.env.CCFLARE_CODEBUDDY_DESENSITIZE;
	});

	afterEach(() => {
		if (original === undefined) {
			delete process.env.CCFLARE_CODEBUDDY_DESENSITIZE;
		} else {
			process.env.CCFLARE_CODEBUDDY_DESENSITIZE = original;
		}
	});

	it("defaults to enabled", () => {
		expect(isCodeBuddyDesensitizeEnabled()).toBe(true);
	});

	it.each(["0", "false", "FALSE", " false "])("is disabled by %p", (value) => {
		process.env.CCFLARE_CODEBUDDY_DESENSITIZE = value;
		expect(isCodeBuddyDesensitizeEnabled()).toBe(false);
	});

	it.each(["1", "true", "yes"])("stays enabled for %p", (value) => {
		process.env.CCFLARE_CODEBUDDY_DESENSITIZE = value;
		expect(isCodeBuddyDesensitizeEnabled()).toBe(true);
	});
});

describe("isCodeBuddyModerationBlock", () => {
	it("recognises the Chinese interception marker", () => {
		expect(isCodeBuddyModerationBlock("⚠️内容审核拦截")).toBe(true);
	});

	it("recognises English review markers", () => {
		expect(
			isCodeBuddyModerationBlock("Request blocked by content review"),
		).toBe(true);
		expect(isCodeBuddyModerationBlock("sensitive content detected")).toBe(true);
	});

	it("ignores ordinary errors", () => {
		expect(isCodeBuddyModerationBlock("rate limit exceeded")).toBe(false);
		expect(isCodeBuddyModerationBlock("")).toBe(false);
	});
});
