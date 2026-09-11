import { Logger } from "@better-ccflare/logger";
import type { Account, RequestTransformer } from "@better-ccflare/types";

const log = new Logger("AccountRequestTransformer");

type TransformRequest = (request: Request) => Promise<Request>;

async function renameMaxTokens(request: Request): Promise<Request> {
	if (!request.headers.get("content-type")?.includes("application/json")) {
		return request;
	}

	let body: unknown;
	try {
		body = JSON.parse(await request.clone().text());
	} catch {
		return request;
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return request;
	}
	const jsonBody = body as Record<string, unknown>;

	if (!Object.hasOwn(jsonBody, "max_tokens")) {
		return request;
	}

	if (!Object.hasOwn(jsonBody, "max_completion_tokens")) {
		jsonBody.max_completion_tokens = jsonBody.max_tokens;
	}
	delete jsonBody.max_tokens;

	const headers = new Headers(request.headers);
	headers.delete("content-length");

	return new Request(request.url, {
		method: request.method,
		headers,
		body: JSON.stringify(jsonBody),
		signal: request.signal,
	});
}

const requestTransformers = new Map<RequestTransformer, TransformRequest>([
	["max-tokens-to-max-completion-tokens", renameMaxTokens],
]);

export async function applyAccountRequestTransformer(
	request: Request,
	account: Account,
): Promise<Request> {
	const requestTransformer = account.request_transformer;
	if (!requestTransformer) return request;

	const transform = requestTransformers.get(requestTransformer);
	if (!transform) {
		log.warn("Unknown account request transformer; request left unchanged", {
			requestTransformer,
		});
		return request;
	}

	return transform(request);
}
