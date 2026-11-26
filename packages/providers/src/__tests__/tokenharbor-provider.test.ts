import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { getProvider } from "../index";

const TOKENHARBOR_BASE = "https://tokenharbor.ai";

describe("tokenharbor provider URL", () => {
	it("defaults to the TokenHarbor endpoint", () => {
		const provider = getProvider("tokenharbor");
		expect(provider?.getEndpoint()).toBe(TOKENHARBOR_BASE);
		expect(provider?.buildUrl("/v1/messages", "", undefined)).toBe(
			`${TOKENHARBOR_BASE}/v1/messages`,
		);
	});

	it("lets an account custom_endpoint win", () => {
		const provider = getProvider("tokenharbor");
		const account = {
			custom_endpoint: "https://mirror.example",
		} as Account;
		expect(provider?.buildUrl("/v1/messages", "", account)).toBe(
			"https://mirror.example/v1/messages",
		);
	});

	it("does not duplicate a /v1 base path", () => {
		const provider = getProvider("tokenharbor");
		const account = {
			custom_endpoint: "https://mirror.example/v1",
		} as Account;
		const url = provider?.buildUrl("/v1/messages", "", account);
		expect(url).toBe("https://mirror.example/v1/messages");
		expect(url?.match(/\/v1\//g)?.length).toBe(1);
	});
});
