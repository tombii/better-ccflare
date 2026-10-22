import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { decodeQoderAccessToken } from "@better-ccflare/providers/qoder";
import { createQoderAccountAddHandler } from "../accounts";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-qoder-handler.db`;

const originalFetch = globalThis.fetch;

/** Mock the job-token exchange endpoint. */
function mockJobTokenExchange(response: { status?: number; body?: unknown }) {
	const calls: Array<{ url: string; body: unknown }> = [];
	globalThis.fetch = mock(async (input: RequestInfo, init?: RequestInit) => {
		const url = String(input);
		let body: unknown = null;
		try {
			body = JSON.parse(String(init?.body ?? "null"));
		} catch {
			body = null;
		}
		calls.push({ url, body });
		return new Response(JSON.stringify(response.body ?? {}), {
			status: response.status ?? 200,
			statusText: response.status && response.status >= 400 ? "Error" : "OK",
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return calls;
}

describe("Qoder Account Add Handler", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;

	beforeAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createQoderAccountAddHandler(dbOps);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
		DatabaseFactory.reset();
	});

	function addRequest(body: Record<string, unknown>) {
		return new Request("http://localhost/api/accounts/qoder", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function rowFor(name: string) {
		const db = dbOps.getDatabase();
		return db
			.query<
				{
					provider: string;
					api_key: string | null;
					refresh_token: string | null;
					access_token: string | null;
					expires_at: number | null;
				},
				[string]
			>(
				"SELECT provider, api_key, refresh_token, access_token, expires_at FROM accounts WHERE name = ?",
			)
			.get(name);
	}

	it("stores the PAT as refresh_token and the minted job token as access_token", async () => {
		const mintedExpiresAt = new Date(
			Date.now() + 12 * 60 * 60 * 1000,
		).toISOString();
		const calls = mockJobTokenExchange({
			body: { token: "jt-minted-token", expires_at: mintedExpiresAt },
		});

		const response = await handler(
			addRequest({
				name: "qoder-happy",
				personalToken: "pt-0123456789abcdef",
				priority: 3,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.account.provider).toBe("qoder");
		expect(data.account.priority).toBe(3);

		// The PAT was exchanged against the default OpenAPI endpoint.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://openapi.qoder.sh/api/v1/jobToken/exchange",
		);
		expect(calls[0]?.body).toEqual({ personal_token: "pt-0123456789abcdef" });

		const row = rowFor("qoder-happy");
		expect(row?.provider).toBe("qoder");
		expect(row?.api_key).toBeNull();
		expect(row?.refresh_token).toBe("pt-0123456789abcdef");
		expect(row?.access_token).toBe("__qoder_jwt.pat.jt-minted-token");
		expect(decodeQoderAccessToken(row?.access_token)).toEqual({
			token: "jt-minted-token",
			mode: "pat",
		});
		expect(row?.expires_at).toBe(Date.parse(mintedExpiresAt));
	});

	it("honours a custom endpoint for the exchange", async () => {
		const calls = mockJobTokenExchange({
			body: { token: "jt-cn", expires_at: Date.now() + 3_600_000 },
		});
		const response = await handler(
			addRequest({
				name: "qoder-cn",
				personalToken: "pt-cn",
				customEndpoint: "https://openapi.qoder.com.cn",
			}),
		);
		expect(response.status).toBe(200);
		expect(calls[0]?.url).toBe(
			"https://openapi.qoder.com.cn/api/v1/jobToken/exchange",
		);
	});

	it("rejects an invalid PAT with 400 and inserts nothing", async () => {
		mockJobTokenExchange({ status: 401, body: { error: "unauthorized" } });

		const response = await handler(
			addRequest({
				name: "qoder-bad-pat",
				personalToken: "pt-vejfmygczv1xjnjawtioacyi8pwqrkyc",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toContain("Invalid Qoder Personal Access Token");
		// The PAT must never be echoed back.
		expect(JSON.stringify(data)).not.toContain("pt-vejfmyg");
		expect(rowFor("qoder-bad-pat")).toBeNull();
	});

	it("rejects a missing name with 400", async () => {
		const calls = mockJobTokenExchange({ body: { token: "jt-x" } });
		const response = await handler(
			addRequest({ personalToken: "pt-whatever" }),
		);
		const data = await response.json();
		expect(response.status).toBe(400);
		expect(data.error).toContain("name is required");
		expect(calls).toHaveLength(0);
	});

	it("rejects a missing Personal Access Token with 400", async () => {
		const calls = mockJobTokenExchange({ body: { token: "jt-x" } });
		const response = await handler(addRequest({ name: "qoder-no-pat" }));
		expect(response.status).toBe(400);
		expect(calls).toHaveLength(0);
	});
});
