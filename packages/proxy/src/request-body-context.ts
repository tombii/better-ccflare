import {
	type ModelRouting,
	providerSupportsProviderRouting,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";

export type RequestJsonBody = Record<string, unknown>;

/**
 * Whether the request being served by this ACCOUNT accepts an upstream
 * `provider` routing object.
 *
 * The provider instance is consulted first: a host-aware adapter (NanoGPT on a
 * third-party custom endpoint) answers per account, and the provider-name list
 * alone would wrongly say yes. The name check is the fallback only when no
 * instance is reachable.
 */
export type RoutingCapability = () => boolean;

export function accountSupportsProviderRouting(
	account: Account,
	capability?: RoutingCapability,
): boolean {
	if (capability) return capability();
	return providerSupportsProviderRouting(account.provider);
}

/**
 * The slot (combo override) pin that survives to the outgoing body: the pin
 * itself when this account's upstream accepts routing, null otherwise. A null
 * answer means the override must neither set body.provider nor hand the pin to
 * unpinned fallback entries (they would re-introduce it).
 */
export function resolveSlotRouting(
	account: Account,
	routing?: ModelRouting | null,
	capability?: RoutingCapability,
): ModelRouting | null {
	if (!routing) return null;
	return accountSupportsProviderRouting(account, capability) ? routing : null;
}

/** Stable comparison that cannot throw on values JSON cannot serialise. */
function routingSignature(body: RequestJsonBody): string | null {
	try {
		return JSON.stringify({ model: body.model, provider: body.provider });
	} catch {
		return null;
	}
}

/**
 * Set the fallback model AND its provider routing on a parsed body. Routing is
 * per model-list entry: the entry's routing replaces whatever `provider` the
 * body carried (the previous entry's pin), and when the entry has none the
 * field is removed rather than left pointing at the old model's provider —
 * unless `inherit` supplies the slot's own configured pin, which an entry
 * without a suffix keeps (the slot pin is the operator's default for it).
 *
 * `supportsRouting`, when given, decides whether this account's upstream
 * accepts `provider`; when it answers false the field is removed rather than
 * set (or written back after the provider transform stripped it).
 * @returns true when the body was modified
 */
export function applyModelAndRouting(
	body: RequestJsonBody,
	model: string,
	routing: ModelRouting | null,
	inherit: ModelRouting | null = null,
	supportsRouting?: RoutingCapability,
): boolean {
	const before = routingSignature(body);
	if (model) body.model = model;
	const effective =
		supportsRouting && !supportsRouting() ? null : (routing ?? inherit);
	if (effective) body.provider = effective;
	else delete body.provider;
	const after = routingSignature(body);
	// A serialisation we cannot compare (BigInt, cycles) is treated as
	// "changed": sending the patched body is correct, skipping it is not.
	return before === null || after === null || before !== after;
}

/**
 * ArrayBuffer counterpart of applyModelAndRouting for RequestBodyContext.
 * Returns the SAME context when nothing changed, so a fallback step does not
 * re-serialise an untouched body. Never throws: an unparsable body yields null
 * and the caller keeps the body it already had.
 */
export function patchModelAndRouting(
	context: RequestBodyContext,
	model: string,
	routing: ModelRouting | null,
	inherit: ModelRouting | null = null,
	supportsRouting?: RoutingCapability,
): RequestBodyContext | null {
	try {
		const body = context.getParsedJson();
		if (!body) return null;
		const patched = { ...body };
		if (
			!applyModelAndRouting(patched, model, routing, inherit, supportsRouting)
		) {
			return context;
		}
		return RequestBodyContext.fromParsed(context.getBuffer(), patched);
	} catch {
		return null;
	}
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function encodeJson(body: RequestJsonBody): ArrayBuffer {
	const encoded = encoder.encode(JSON.stringify(body));
	// .buffer may be shared/oversized in some runtimes; slice to exact range
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	);
}

export class RequestBodyContext {
	readonly originalBuffer: ArrayBuffer | null;

	private currentBuffer: ArrayBuffer | null;
	private parsedBody: RequestJsonBody | null = null;
	private parseAttempted = false;
	private parseFailed = false;
	private dirty = false;

	constructor(buffer: ArrayBuffer | null) {
		this.originalBuffer = buffer;
		this.currentBuffer = buffer;
	}

	static fromParsed(
		originalBuffer: ArrayBuffer | null,
		body: RequestJsonBody,
	): RequestBodyContext {
		const context = new RequestBodyContext(originalBuffer);
		context.parsedBody = body;
		context.parseAttempted = true;
		context.parseFailed = false;
		context.markDirty();
		return context;
	}

	get isDirty(): boolean {
		return this.dirty;
	}

	get hasParseFailed(): boolean {
		this.getParsedJson();
		return this.parseFailed;
	}

	getParsedJson(): Readonly<RequestJsonBody> | null {
		if (this.parseAttempted) {
			return this.parsedBody;
		}

		this.parseAttempted = true;
		if (!this.currentBuffer) {
			return null;
		}

		try {
			const parsed = JSON.parse(decoder.decode(this.currentBuffer));
			if (typeof parsed !== "object" || parsed === null) {
				this.parseFailed = true;
				return null;
			}
			this.parsedBody = parsed as RequestJsonBody;
			return this.parsedBody;
		} catch {
			this.parseFailed = true;
			return null;
		}
	}

	/** Best-effort client/session id from metadata.user_id. Telemetry/routing only. */
	getClientId(): string | null {
		const body = this.getParsedJson();
		const meta = body?.metadata;
		if (meta && typeof meta === "object") {
			const uid = (meta as Record<string, unknown>).user_id;
			if (typeof uid === "string" && uid.length > 0) return uid;
		}
		return null;
	}

	getModel(): string | null {
		const body = this.getParsedJson();
		const model = body?.model;
		return typeof model === "string" ? model : null;
	}

	setModel(model: string): boolean {
		if (!this.parsedBody) {
			this.getParsedJson();
		}
		if (!this.parsedBody) return false;

		this.parsedBody.model = model;
		this.markDirty();
		return true;
	}

	/** Mutate the parsed body in-place via callback and mark dirty. */
	mutateParsedJson(fn: (body: RequestJsonBody) => void): boolean {
		const body =
			this.parsedBody ?? (this.getParsedJson() as RequestJsonBody | null);
		if (!body) return false;
		fn(body);
		this.markDirty();
		return true;
	}

	markDirty(): void {
		this.dirty = true;
	}

	getBuffer(): ArrayBuffer | null {
		if (!this.dirty) {
			return this.currentBuffer;
		}

		if (!this.parsedBody) {
			return this.currentBuffer;
		}

		this.currentBuffer = encodeJson(this.parsedBody);
		this.dirty = false;
		return this.currentBuffer;
	}

	// NOTE: shallow spread — nested objects (e.g. messages, system) are shared
	// references between parent and child contexts. Mutations to nested content
	// on the returned context will alias back into this context's parsedBody.
	// Safe as long as callers treat the child as write-once and discard the parent.
	withPatchedModel(model: string): RequestBodyContext | null {
		const body = this.getParsedJson();
		if (!body) return null;

		return RequestBodyContext.fromParsed(this.getBuffer(), {
			...body,
			model,
		});
	}
}

export interface OutgoingBody {
	text: string;
	model: string;
	getJson(): RequestJsonBody | null;
}

/**
 * Reads the body of the request about to be sent upstream. When the provider
 * returned `sourceRequest` untouched its body is exactly `sourceBuffer`, so the
 * model comes from the already-parsed context and the JSON is only parsed if
 * `getJson()` is called.
 */
export async function readOutgoingBody(
	request: Request,
	sourceRequest: Request,
	sourceContext: RequestBodyContext,
	sourceBuffer: ArrayBuffer | null,
): Promise<OutgoingBody> {
	const untouchedModel =
		request === sourceRequest && sourceBuffer ? sourceContext.getModel() : null;
	if (sourceBuffer && untouchedModel !== null) {
		const text = decoder.decode(sourceBuffer);
		let json: RequestJsonBody | null | undefined;
		return {
			text,
			model: untouchedModel,
			getJson() {
				if (json === undefined) {
					try {
						json = JSON.parse(text);
					} catch {
						json = null;
					}
				}
				return json ?? null;
			},
		};
	}

	const text = await request.clone().text();
	let json: RequestJsonBody | null = null;
	try {
		json = JSON.parse(text);
	} catch {
		// ignore
	}
	return {
		text,
		model: (json?.model as string | undefined) ?? "",
		getJson: () => json,
	};
}
