import { afterEach, describe, expect, test } from "bun:test";
import {
	buildDiagnosisReplay,
	CACHE_DIAG_ENV,
	listDiagnosisSessions,
	recordDiagnosisCandidate,
	resetCacheDiagnosis,
	runCacheDiagnosis,
} from "../cache-diagnosis";

afterEach(() => {
	resetCacheDiagnosis();
	delete process.env[CACHE_DIAG_ENV];
});

const encode = (v: unknown) => {
	const bytes = new TextEncoder().encode(JSON.stringify(v));
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
};

function capture(session: string, marker: string): void {
	recordDiagnosisCandidate(
		session,
		encode({
			model: "claude-opus-4-8",
			max_tokens: 32000,
			stream: true,
			messages: [{ role: "user", content: marker }],
		}),
		new Headers({
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "existing-beta",
			authorization: "Bearer secret",
			"x-better-ccflare-request-id": "internal",
		}),
	);
}

describe("recordDiagnosisCandidate", () => {
	test("no capture when disabled", () => {
		capture("s1", "a");
		expect(listDiagnosisSessions()).toEqual([]);
	});

	test("captures pairs, shifting last to prev", () => {
		process.env[CACHE_DIAG_ENV] = "1";
		capture("s1", "first");
		expect(listDiagnosisSessions()[0].has_pair).toBe(false);
		capture("s1", "second");
		expect(listDiagnosisSessions()[0].has_pair).toBe(true);
	});

	test("evicts oldest session beyond the cap", () => {
		process.env[CACHE_DIAG_ENV] = "1";
		for (let i = 0; i < 9; i++) capture(`session-${i}`, "x");
		const sessions = listDiagnosisSessions();
		expect(sessions.length).toBe(8);
		expect(
			sessions.some((s) => s.session_preview.startsWith("session-0")),
		).toBe(false);
	});
});

describe("buildDiagnosisReplay", () => {
	test("patches replay fields and strips secrets while merging betas", () => {
		process.env[CACHE_DIAG_ENV] = "1";
		capture("s1", "first");
		const replay = buildDiagnosisReplay(
			{
				body: encode({ model: "m", max_tokens: 5, stream: true }),
				headers: [
					["anthropic-version", "2023-06-01"],
					["anthropic-beta", "existing-beta"],
				],
				capturedAt: Date.now(),
			},
			"msg_prev",
		);
		expect(replay).not.toBeNull();
		if (!replay) throw new Error("unreachable");
		const body = JSON.parse(replay.body);
		expect(body.max_tokens).toBe(1);
		expect(body.stream).toBe(false);
		expect(body.diagnostics).toEqual({ previous_message_id: "msg_prev" });
		expect(replay.headers.get("anthropic-beta")).toBe(
			"existing-beta,cache-diagnosis-2026-04-07",
		);
		expect(replay.headers.get("x-better-ccflare-keepalive")).toBe("true");
		expect(replay.headers.get("authorization")).toBeNull();
	});
});

describe("runCacheDiagnosis", () => {
	test("chains previous_message_id and returns diagnostics", async () => {
		process.env[CACHE_DIAG_ENV] = "1";
		capture("s1", "first");
		capture("s1", "second");

		const seen: Array<Record<string, unknown>> = [];
		const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			seen.push(body);
			const isSecond = seen.length === 2;
			return new Response(
				JSON.stringify({
					id: isSecond ? "msg_2" : "msg_1",
					usage: { input_tokens: 10 },
					diagnostics: isSecond ? { verdict: "prefix-divergence" } : null,
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const result = await runCacheDiagnosis({ port: 1234, fetchImpl });
		expect(seen.length).toBe(2);
		expect(seen[0].diagnostics).toEqual({ previous_message_id: null });
		expect(seen[1].diagnostics).toEqual({ previous_message_id: "msg_1" });
		// First replay uses the older snapshot, second the newer.
		expect((seen[0].messages as Array<{ content: string }>)[0].content).toBe(
			"first",
		);
		expect((seen[1].messages as Array<{ content: string }>)[0].content).toBe(
			"second",
		);
		expect(result.pair).toBe(true);
		expect(result.second.diagnostics).toEqual({
			verdict: "prefix-divergence",
		});
	});

	test("throws a helpful error with nothing captured", async () => {
		process.env[CACHE_DIAG_ENV] = "1";
		await expect(runCacheDiagnosis({ port: 1 })).rejects.toThrow(
			/no captured session/,
		);
	});
});
