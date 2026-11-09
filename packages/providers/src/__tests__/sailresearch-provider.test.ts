import { describe, expect, it } from "bun:test";
import { getProviderFromMode, PROVIDER_NAMES } from "@better-ccflare/types";
import { getProvider } from "../index";

describe("sailresearch provider registration", () => {
	it("is a known provider name", () => {
		expect(PROVIDER_NAMES.SAILRESEARCH).toBe("sailresearch");
	});

	it("maps the account mode to the provider name", () => {
		expect(getProviderFromMode("sailresearch")).toBe("sailresearch");
	});

	it("is returned by the registry", () => {
		const provider = getProvider("sailresearch");
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("sailresearch");
	});

	it("builds the Sail messages URL", () => {
		const provider = getProvider("sailresearch");
		expect(provider?.buildUrl("/v1/messages", "", undefined)).toBe(
			"https://api.sailresearch.com/v1/v1/messages",
		);
	});

	it("authenticates with a Bearer Authorization header, not x-api-key", () => {
		const provider = getProvider("sailresearch");
		const headers = provider?.prepareHeaders(
			new Headers(),
			"secret",
			undefined,
		);
		expect(headers?.get("authorization")).toBe("Bearer secret");
		expect(headers?.get("x-api-key")).toBeNull();
	});
});
