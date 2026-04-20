import { describe, expect, it } from "bun:test";
import { injectSystemCacheTtl } from "../proxy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBuffer(obj: unknown): ArrayBuffer {
	return new TextEncoder().encode(JSON.stringify(obj)).buffer as ArrayBuffer;
}

function fromBuffer(buf: ArrayBuffer): unknown {
	return JSON.parse(new TextDecoder().decode(buf));
}

// ---------------------------------------------------------------------------

describe("injectSystemCacheTtl", () => {
	// -----------------------------------------------------------------------
	// Returns null — no modification cases
	// -----------------------------------------------------------------------

	it("returns null when system is a plain string", () => {
		const buf = toBuffer({ system: "plain string", messages: [] });
		expect(injectSystemCacheTtl(buf)).toBeNull();
	});

	it("returns null when system blocks have no cache_control", () => {
		const buf = toBuffer({
			system: [{ type: "text", text: "Hello" }],
			messages: [],
		});
		expect(injectSystemCacheTtl(buf)).toBeNull();
	});

	it("returns null when ttl is already set on all ephemeral blocks", () => {
		const buf = toBuffer({
			system: [
				{
					type: "text",
					text: "Hello",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
			messages: [],
		});
		expect(injectSystemCacheTtl(buf)).toBeNull();
	});

	it("returns null when system field is absent", () => {
		const buf = toBuffer({ messages: [{ role: "user", content: "hi" }] });
		expect(injectSystemCacheTtl(buf)).toBeNull();
	});

	it("returns null for invalid JSON input", () => {
		const bad = new TextEncoder().encode("not-json-{{{").buffer as ArrayBuffer;
		expect(injectSystemCacheTtl(bad)).toBeNull();
	});

	it("returns null for non-ephemeral cache_control type", () => {
		const buf = toBuffer({
			system: [
				{
					type: "text",
					text: "Hello",
					cache_control: { type: "other" },
				},
			],
			messages: [],
		});
		expect(injectSystemCacheTtl(buf)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// Injects ttl
	// -----------------------------------------------------------------------

	it("injects ttl on a single ephemeral block", () => {
		const buf = toBuffer({
			system: [
				{
					type: "text",
					text: "You are helpful.",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [],
		});
		const result = injectSystemCacheTtl(buf);
		if (!result) throw new Error("Expected non-null result");
		const body = fromBuffer(result) as {
			system: Array<{ cache_control: { type: string; ttl: string } }>;
		};
		expect(body.system[0].cache_control.ttl).toBe("1h");
	});

	it("injects ttl on multiple ephemeral blocks", () => {
		const buf = toBuffer({
			system: [
				{
					type: "text",
					text: "Block 1",
					cache_control: { type: "ephemeral" },
				},
				{
					type: "text",
					text: "Block 2",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [],
		});
		const result = injectSystemCacheTtl(buf);
		if (!result) throw new Error("Expected non-null result");
		const body = fromBuffer(result) as {
			system: Array<{ cache_control: { type: string; ttl: string } }>;
		};
		expect(body.system[0].cache_control.ttl).toBe("1h");
		expect(body.system[1].cache_control.ttl).toBe("1h");
	});

	it("only modifies system blocks, not messages with cache_control", () => {
		const buf = toBuffer({
			system: [
				{
					type: "text",
					text: "System",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "Hello",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		});
		const result = injectSystemCacheTtl(buf);
		if (!result) throw new Error("Expected non-null result");
		const body = fromBuffer(result) as {
			system: Array<{ cache_control: { ttl?: string } }>;
			messages: Array<{ content: Array<{ cache_control: { ttl?: string } }> }>;
		};
		// System block gets the ttl
		expect(body.system[0].cache_control.ttl).toBe("1h");
		// Message content block is untouched
		expect(body.messages[0].content[0].cache_control.ttl).toBeUndefined();
	});

	it("preserves other fields on a system block after injection", () => {
		const buf = toBuffer({
			system: [
				{
					type: "text",
					text: "You are a helpful assistant.",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [],
		});
		const result = injectSystemCacheTtl(buf);
		if (!result) throw new Error("Expected non-null result");
		const body = fromBuffer(result) as {
			system: Array<{
				type: string;
				text: string;
				cache_control: { type: string; ttl: string };
			}>;
		};
		expect(body.system[0].type).toBe("text");
		expect(body.system[0].text).toBe("You are a helpful assistant.");
		expect(body.system[0].cache_control.type).toBe("ephemeral");
		expect(body.system[0].cache_control.ttl).toBe("1h");
	});

	it("does not inject ttl on block whose ttl is already set even when other blocks need it", () => {
		const buf = toBuffer({
			system: [
				{
					type: "text",
					text: "Already cached",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
				{
					type: "text",
					text: "Needs ttl",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [],
		});
		const result = injectSystemCacheTtl(buf);
		if (!result) throw new Error("Expected non-null result");
		const body = fromBuffer(result) as {
			system: Array<{ cache_control: { ttl: string } }>;
		};
		// First block still has its original ttl (not double-injected)
		expect(body.system[0].cache_control.ttl).toBe("1h");
		// Second block gets ttl injected
		expect(body.system[1].cache_control.ttl).toBe("1h");
	});
});
