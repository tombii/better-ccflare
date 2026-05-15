import { EMBEDDED_INTEGRITY_CHECK_WORKER_CODE } from "./inline-integrity-check-worker";

/**
 * Spawn the `integrity-check-worker` against a given DB file, return the
 * verdict. Mirrors `runVacuumInWorker` in `database-operations.ts` (inline
 * blob URL when the compiled worker is embedded, file URL when running
 * source-mode from a checkout).
 *
 * The worker opens its own `bun:sqlite` handle — required because
 * `bun:sqlite` is synchronous and a `PRAGMA integrity_check` on a multi-GB
 * DB blocks the JS event loop for tens of seconds. We don't want the proxy
 * stalled during that window.
 */
export async function runIntegrityCheckInWorker(
	dbPath: string,
	options?: { busyTimeoutMs?: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
	let worker: Worker;
	if (EMBEDDED_INTEGRITY_CHECK_WORKER_CODE) {
		const workerCode = Buffer.from(
			EMBEDDED_INTEGRITY_CHECK_WORKER_CODE,
			"base64",
		).toString("utf8");
		const blob = new Blob([workerCode], { type: "text/javascript" });
		worker = new Worker(URL.createObjectURL(blob), { smol: true });
	} else {
		worker = new Worker(
			new URL("./integrity-check-worker.ts", import.meta.url).href,
		);
	}

	try {
		const result = await new Promise<
			{ ok: true } | { ok: false; error: string }
		>((resolve, reject) => {
			worker.onmessage = (event: MessageEvent) => resolve(event.data);
			worker.onerror = (event: ErrorEvent) =>
				reject(new Error(event.message ?? "integrity worker error"));
			worker.postMessage({
				dbPath,
				busyTimeoutMs: options?.busyTimeoutMs ?? 10_000,
			});
		});
		return result;
	} finally {
		worker.terminate();
	}
}
