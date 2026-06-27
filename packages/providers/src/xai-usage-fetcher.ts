import { Logger } from "@better-ccflare/logger";
import type { XaiUsageData } from "@better-ccflare/types";

export type { XaiUsageData, XaiUsageWindow } from "@better-ccflare/types";

const log = new Logger("XaiUsageFetcher");

export const XAI_GROK_CREDITS_ENDPOINT =
	"https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

const EMPTY_GRPC_WEB_FRAME = new Uint8Array([0, 0, 0, 0, 0]);

interface ProtobufScan {
	fixed32: Array<{ path: number[]; value: number; order: number }>;
	varints: Array<{ path: number[]; value: number }>;
}

function mergeScan(target: ProtobufScan, source: ProtobufScan): void {
	target.fixed32.push(...source.fixed32);
	target.varints.push(...source.varints);
}

function readVarint(
	bytes: Uint8Array,
	cursor: { index: number },
): number | null {
	let value = 0;
	let multiplier = 1;
	let shift = 0;

	while (cursor.index < bytes.length && shift < 64) {
		const byte = bytes[cursor.index++];
		value += (byte & 0x7f) * multiplier;
		if ((byte & 0x80) === 0) return value;
		multiplier *= 128;
		shift += 7;
	}

	return null;
}

function scanProtobuf(
	bytes: Uint8Array,
	depth = 0,
	path: number[] = [],
	order = 0,
): { scan: ProtobufScan; nextOrder: number } {
	const scan: ProtobufScan = { fixed32: [], varints: [] };
	let index = 0;
	let nextOrder = order;

	while (index < bytes.length) {
		const start = index;
		const keyCursor = { index };
		const key = readVarint(bytes, keyCursor);
		if (key === null || key === 0) {
			index = start + 1;
			continue;
		}
		index = keyCursor.index;

		const fieldNumber = Math.floor(key / 8);
		const wireType = key & 0x07;
		const fieldPath = [...path, fieldNumber];

		switch (wireType) {
			case 0: {
				const valueCursor = { index };
				const value = readVarint(bytes, valueCursor);
				if (value === null) {
					index = start + 1;
					break;
				}
				index = valueCursor.index;
				scan.varints.push({ path: fieldPath, value });
				break;
			}
			case 1: {
				index = index + 8 <= bytes.length ? index + 8 : start + 1;
				break;
			}
			case 2: {
				const lengthCursor = { index };
				const length = readVarint(bytes, lengthCursor);
				if (
					length === null ||
					length < 0 ||
					length > bytes.length - lengthCursor.index
				) {
					index = start + 1;
					break;
				}
				index = lengthCursor.index;
				const sub = bytes.subarray(index, index + length);
				if (depth < 4) {
					const nested = scanProtobuf(sub, depth + 1, fieldPath, nextOrder);
					mergeScan(scan, nested.scan);
					nextOrder = nested.nextOrder;
				}
				index += length;
				break;
			}
			case 5: {
				if (index + 4 > bytes.length) {
					index = start + 1;
					break;
				}
				const view = new DataView(bytes.buffer, bytes.byteOffset + index, 4);
				scan.fixed32.push({
					path: fieldPath,
					value: view.getFloat32(0, true),
					order: nextOrder++,
				});
				index += 4;
				break;
			}
			default:
				index = start + 1;
				break;
		}
	}

	return { scan, nextOrder };
}

function looksLikeProtobufPayload(bytes: Uint8Array): boolean {
	if (bytes.length === 0) return false;
	const field = bytes[0] >> 3;
	const wire = bytes[0] & 0x07;
	return field > 0 && (wire === 0 || wire === 1 || wire === 2 || wire === 5);
}

function grpcWebDataFrames(bytes: Uint8Array): Uint8Array[] {
	const frames: Uint8Array[] = [];
	let index = 0;

	while (index + 5 <= bytes.length) {
		const flags = bytes[index];
		const length =
			(bytes[index + 1] << 24) |
			(bytes[index + 2] << 16) |
			(bytes[index + 3] << 8) |
			bytes[index + 4];
		if (length < 0 || index + 5 + length > bytes.length) return [];
		if ((flags & 0x80) === 0) {
			frames.push(bytes.subarray(index + 5, index + 5 + length));
		}
		index += 5 + length;
	}

	return frames;
}

function grpcWebTrailerFields(bytes: Uint8Array): Record<string, string> {
	const fields: Record<string, string> = {};
	const decoder = new TextDecoder();
	let index = 0;

	while (index + 5 <= bytes.length) {
		const flags = bytes[index];
		const length =
			(bytes[index + 1] << 24) |
			(bytes[index + 2] << 16) |
			(bytes[index + 3] << 8) |
			bytes[index + 4];
		if (length < 0 || index + 5 + length > bytes.length) break;
		if ((flags & 0x80) !== 0) {
			const text = decoder.decode(
				bytes.subarray(index + 5, index + 5 + length),
			);
			for (const line of text.split("\n")) {
				if (!line) continue;
				const sep = line.indexOf(":");
				if (sep <= 0) continue;
				fields[line.slice(0, sep).trim().toLowerCase()] = line
					.slice(sep + 1)
					.trim();
			}
		}
		index += 5 + length;
	}

	return fields;
}

function grpcStatusFromHeaders(
	headers: Headers,
): { status: number; message: string } | null {
	const raw = headers.get("grpc-status");
	if (!raw) return null;
	const status = Number.parseInt(raw, 10);
	if (!Number.isFinite(status)) return null;
	return { status, message: headers.get("grpc-message") ?? "" };
}

function grpcStatusFromBody(
	bytes: Uint8Array,
): { status: number; message: string } | null {
	const fields = grpcWebTrailerFields(bytes);
	const raw = fields["grpc-status"];
	if (!raw) return null;
	const status = Number.parseInt(raw, 10);
	if (!Number.isFinite(status)) return null;
	return { status, message: fields["grpc-message"] ?? "" };
}

export function parseXaiGrokCreditsResponse(
	bytes: Uint8Array,
	nowMs = Date.now(),
): XaiUsageData | null {
	const grpcStatus = grpcStatusFromBody(bytes);
	if (grpcStatus && grpcStatus.status !== 0) {
		log.warn(
			`xAI Grok credits gRPC-web response returned grpc-status=${grpcStatus.status}${grpcStatus.message ? ` ${grpcStatus.message}` : ""}`,
		);
		return null;
	}

	let payloads = grpcWebDataFrames(bytes);
	if (payloads.length === 0 && looksLikeProtobufPayload(bytes)) {
		payloads = [bytes];
	}
	if (payloads.length === 0) return null;

	const merged: ProtobufScan = { fixed32: [], varints: [] };
	for (const payload of payloads) {
		const { scan } = scanProtobuf(payload);
		mergeScan(merged, scan);
	}

	let bestPercent: { value: number; depth: number } | null = null;
	for (const field of merged.fixed32) {
		if (field.path.length === 0) continue;
		if (field.path[field.path.length - 1] !== 1) continue;
		if (!Number.isFinite(field.value) || field.value < 0 || field.value > 100) {
			continue;
		}
		const depth = field.path.length;
		if (!bestPercent || depth < bestPercent.depth) {
			bestPercent = { value: field.value, depth };
		}
	}

	const now = new Date(nowMs);
	const futureResetTimes: Array<{ path: number[]; time: Date }> = [];
	for (const field of merged.varints) {
		if (field.value < 1_700_000_000 || field.value > 2_100_000_000) continue;
		const time = new Date(field.value * 1000);
		if (time.getTime() > now.getTime()) {
			futureResetTimes.push({ path: field.path, time });
		}
	}

	let resetTime: Date | null = null;
	const preferredReset = futureResetTimes.find(
		(field) =>
			field.path.length === 3 &&
			field.path[0] === 1 &&
			field.path[1] === 5 &&
			field.path[2] === 1,
	);
	if (preferredReset) {
		resetTime = preferredReset.time;
	} else if (futureResetTimes.length > 0) {
		resetTime = futureResetTimes.reduce((earliest, current) =>
			current.time.getTime() < earliest.time.getTime() ? current : earliest,
		).time;
	}

	let hasUsagePeriod = false;
	for (const field of merged.varints) {
		if (field.path.length >= 2 && field.path[0] === 1 && field.path[1] === 6) {
			hasUsagePeriod = true;
			break;
		}
		if (
			field.path.length === 3 &&
			field.path[0] === 1 &&
			field.path[1] === 8 &&
			field.path[2] === 1 &&
			(field.value === 1 || field.value === 2)
		) {
			hasUsagePeriod = true;
			break;
		}
	}

	let utilization = bestPercent?.value;
	if (utilization === undefined) {
		const noUsageYet =
			merged.fixed32.length === 0 && resetTime && hasUsagePeriod;
		if (!noUsageYet) return null;
		utilization = 0;
	}

	return {
		credits: {
			utilization,
			resets_at: resetTime ? resetTime.toISOString() : null,
		},
	};
}

export async function fetchXaiUsageData(
	accessToken: string,
): Promise<XaiUsageData | null> {
	const token = accessToken.trim();
	if (!token) return null;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);
	try {
		const response = await fetch(XAI_GROK_CREDITS_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Origin: "https://grok.com",
				Referer: "https://grok.com/?_s=usage",
				Accept: "*/*",
				"Content-Type": "application/grpc-web+proto",
				"x-grpc-web": "1",
				"x-user-agent": "connect-es/2.1.1",
				"User-Agent": "better-ccflare/xai-usage",
			},
			body: EMPTY_GRPC_WEB_FRAME,
			signal: controller.signal,
		});

		if (!response.ok) {
			log.warn(
				`Failed to fetch xAI Grok credits: HTTP ${response.status} ${response.statusText}`,
			);
			return null;
		}

		const headerStatus = grpcStatusFromHeaders(response.headers);
		if (headerStatus && headerStatus.status !== 0) {
			log.warn(
				`xAI Grok credits returned grpc-status=${headerStatus.status}${headerStatus.message ? ` ${headerStatus.message}` : ""}`,
			);
			return null;
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		const data = parseXaiGrokCreditsResponse(bytes);
		if (!data) {
			log.warn("Failed to parse xAI Grok credits response");
		}
		return data;
	} catch (error) {
		log.warn(
			"Error fetching xAI Grok credits:",
			error instanceof Error ? error.message : String(error),
		);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

export function getRepresentativeXaiUtilization(
	usage: XaiUsageData | null,
): number | null {
	return usage?.credits?.utilization ?? null;
}

export function getRepresentativeXaiWindow(
	usage: XaiUsageData | null,
): string | null {
	return usage ? "credits" : null;
}
