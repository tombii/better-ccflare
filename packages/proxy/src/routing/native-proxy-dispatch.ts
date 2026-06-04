import type { ProviderPrefixError } from "./provider-prefixed-path";

export function createNativeRouteErrorResponse(
	error: ProviderPrefixError,
): Response {
	const status = error.code === "unknown_provider" ? 404 : 400;
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type:
					error.code === "unknown_provider"
						? "not_found_error"
						: "invalid_request_error",
				message: error.message,
			},
		}),
		{
			status,
			headers: { "Content-Type": "application/json" },
		},
	);
}

export const NATIVE_PASSTHROUGH_HEADER = "x-better-ccflare-native-passthrough";

export function createNativeProxyRequest(
	req: Request,
	providerName: string,
): Request {
	const headers = new Headers(req.headers);
	headers.set(NATIVE_PASSTHROUGH_HEADER, "true");
	headers.set("x-better-ccflare-include-providers", providerName);
	return new Request(req, { headers });
}
