import { EMBEDDED_WAL_TRUNCATE_WORKER_CODE } from "./inline-wal-truncate-worker";
import type {
	WalTruncateRequest,
	WalTruncateResponse,
} from "./wal-truncate-worker";

export type { WalTruncateRequest, WalTruncateResponse };

/**
 * Default hard cap on a worker run. A TRUNCATE checkpoint on a WAL with a
 * large backlog can take a while on a slow disk; the cap exists so a
 * wedged worker (unresponsive NFS, failing disk) can't leak a thread
 * forever — the runner terminates the worker and reports the failure, and
 * the next tick tries again.
 */
const DEFAULT_WORKER_TIMEOUT_MS = 60 * 1000;

/**
 * Spawn the `wal-truncate-worker` against a given DB file and return the
 * checkpoint outcome. Mirrors `runIntegrityCheckInWorker` (inline blob URL
 * when the compiled worker is embedded, file URL when running source-mode
 * from a checkout).
 *
 * The worker opens its own `bun:sqlite` handle: `bun:sqlite` is synchronous,
 * and a TRUNCATE checkpoint copies the whole WAL backlog into the database
 * file. Running that on the main connection would freeze the proxy's event
 * loop for the duration — the same reason the integrity check and the
 * vacuum run off-thread.
 */
export async function runWalTruncateInWorker(
	dbPath: string,
	options?: {
		busyTimeoutMs?: number;
		journalSizeLimitBytes?: number;
		timeoutMs?: number;
	},
): Promise<WalTruncateResponse> {
	let worker: Worker;
	// The blob URL is registered with the parent thread's URL registry and
	// keeps the worker code alive until it is revoked. Terminating the worker
	// does not release it, so every checkpoint would retain another copy —
	// this job runs every few minutes, so the URL has to be revoked.
	let blobUrl: string | undefined;
	if (EMBEDDED_WAL_TRUNCATE_WORKER_CODE) {
		const workerCode = Buffer.from(
			EMBEDDED_WAL_TRUNCATE_WORKER_CODE,
			"base64",
		).toString("utf8");
		const blob = new Blob([workerCode], { type: "text/javascript" });
		blobUrl = URL.createObjectURL(blob);
		worker = new Worker(blobUrl, { smol: true });
	} else {
		worker = new Worker(
			new URL("./wal-truncate-worker.ts", import.meta.url).href,
		);
	}

	const timeoutMs = resolveTimeoutMs(options?.timeoutMs);
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	try {
		return await new Promise<WalTruncateResponse>((resolve) => {
			worker.onmessage = (event: MessageEvent) => resolve(event.data);
			worker.onerror = (event: ErrorEvent) =>
				resolve({
					ok: false,
					error: event.message ?? "wal truncate worker error",
					busy: false,
				});
			timeoutHandle = setTimeout(() => {
				resolve({
					ok: false,
					error: `wal truncate worker timed out after ${timeoutMs}ms`,
					busy: false,
				});
			}, timeoutMs);
			worker.postMessage({
				dbPath,
				busyTimeoutMs: options?.busyTimeoutMs ?? 0,
				journalSizeLimitBytes: options?.journalSizeLimitBytes,
			} satisfies WalTruncateRequest);
		});
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		worker.terminate();
		// Release the blob URL (and with it the worker code) after the worker
		// is gone.
		if (blobUrl !== undefined) URL.revokeObjectURL(blobUrl);
	}
}

function resolveTimeoutMs(override?: number): number {
	if (override !== undefined && Number.isInteger(override) && override > 0) {
		return override;
	}
	const raw = process.env.CCFLARE_WAL_TRUNCATE_TIMEOUT_MS;
	if (raw === undefined || raw === "") return DEFAULT_WORKER_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return DEFAULT_WORKER_TIMEOUT_MS;
	}
	return parsed;
}
