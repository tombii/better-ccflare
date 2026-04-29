export type RequestJsonBody = Record<string, unknown>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function encodeJson(body: RequestJsonBody): ArrayBuffer {
	const encoded = encoder.encode(JSON.stringify(body));
	const buffer = new ArrayBuffer(encoded.byteLength);
	new Uint8Array(buffer).set(encoded);
	return buffer;
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

	getParsedJson(): RequestJsonBody | null {
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

	getModel(): string | null {
		const body = this.getParsedJson();
		const model = body?.model;
		return typeof model === "string" ? model : null;
	}

	setModel(model: string): boolean {
		const body = this.getParsedJson();
		if (!body) return false;

		body.model = model;
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

	withPatchedModel(model: string): RequestBodyContext | null {
		const body = this.getParsedJson();
		if (!body) return null;

		return RequestBodyContext.fromParsed(this.getBuffer(), {
			...body,
			model,
		});
	}
}
