import { afterEach, describe, expect, it } from "bun:test";
import {
	QODER_DEFAULT_GATEWAY_ENDPOINT,
	QODER_DEFAULT_OPENAPI_ENDPOINT,
	QODER_OPENAPI_ENDPOINT_ENV,
	resolveQoderGatewayEndpoint,
	resolveQoderOpenApiEndpoint,
} from "../endpoints";

afterEach(() => {
	delete process.env[QODER_OPENAPI_ENDPOINT_ENV];
});

describe("resolveQoderGatewayEndpoint", () => {
	it("defaults to the international gateway", () => {
		expect(resolveQoderGatewayEndpoint(null)).toBe(
			QODER_DEFAULT_GATEWAY_ENDPOINT,
		);
		expect(QODER_DEFAULT_GATEWAY_ENDPOINT).toBe("https://api3.qoder.sh");
	});

	it("takes a plain URL as the gateway host", () => {
		expect(
			resolveQoderGatewayEndpoint({
				custom_endpoint: "https://gateway.qoder.com.cn/",
			}),
		).toBe("https://gateway.qoder.com.cn");
	});

	it("takes the endpoint member of a JSON custom endpoint", () => {
		expect(
			resolveQoderGatewayEndpoint({
				custom_endpoint: JSON.stringify({
					endpoint: "https://gateway.example.com",
					modelMappings: { sonnet: "dfmodel" },
				}),
			}),
		).toBe("https://gateway.example.com");
	});

	it("falls back to the default for an unusable custom endpoint", () => {
		expect(resolveQoderGatewayEndpoint({ custom_endpoint: "{not json" })).toBe(
			QODER_DEFAULT_GATEWAY_ENDPOINT,
		);
		expect(
			resolveQoderGatewayEndpoint({ custom_endpoint: JSON.stringify({}) }),
		).toBe(QODER_DEFAULT_GATEWAY_ENDPOINT);
	});
});

describe("resolveQoderOpenApiEndpoint", () => {
	it("defaults to the international OpenAPI host", () => {
		expect(resolveQoderOpenApiEndpoint(null)).toBe(
			QODER_DEFAULT_OPENAPI_ENDPOINT,
		);
		expect(QODER_DEFAULT_OPENAPI_ENDPOINT).toBe("https://openapi.qoder.sh");
	});

	it("derives the documented CN pair from the gateway host", () => {
		expect(
			resolveQoderOpenApiEndpoint({
				custom_endpoint: "https://gateway.qoder.com.cn",
			}),
		).toBe("https://openapi.qoder.com.cn");
	});

	it("derives the pair from a JSON custom endpoint too", () => {
		expect(
			resolveQoderOpenApiEndpoint({
				custom_endpoint: JSON.stringify({
					endpoint: "https://gateway.qoder.com.cn",
				}),
			}),
		).toBe("https://openapi.qoder.com.cn");
	});

	it("prefers an explicit openapiEndpoint member", () => {
		expect(
			resolveQoderOpenApiEndpoint({
				custom_endpoint: JSON.stringify({
					endpoint: "https://gateway.qoder.com.cn",
					openapiEndpoint: "https://openapi.example.com/",
				}),
			}),
		).toBe("https://openapi.example.com");
	});

	it("prefers the environment over the derived pair", () => {
		process.env[QODER_OPENAPI_ENDPOINT_ENV] = "https://env.example.com/";
		expect(
			resolveQoderOpenApiEndpoint({
				custom_endpoint: "https://gateway.qoder.com.cn",
			}),
		).toBe("https://env.example.com");
	});

	it("keeps an account that already names the OpenAPI host working", () => {
		expect(
			resolveQoderOpenApiEndpoint({
				custom_endpoint: "https://openapi.qoder.com.cn",
			}),
		).toBe("https://openapi.qoder.com.cn");
	});

	it("accepts a bare endpoint string", () => {
		expect(resolveQoderOpenApiEndpoint("https://gateway.qoder.com.cn")).toBe(
			"https://openapi.qoder.com.cn",
		);
	});
});
