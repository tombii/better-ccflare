import { EMBEDDED_INTEGRITY_CHECK_WORKER_CODE } from "./inline-integrity-check-worker";

/**
 * Default hard cap on a worker run. A `PRAGMA integrity_check` on a multi-GB
 * DB is normally tens of seconds; the cap exists to defend against the
 * worker hanging forever on a failing disk / unresponsive NFS / etc, which
 * would otherwise leave `markIntegrityCheckRunning("full")` permanently set
 * and silently disable integrity checking for the lifetime of the process.
 */
const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60 * 1000;

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
 *
 * Race the worker promise against a configurable timeout (default 10 min,
 * env override `CCFLARE_INTEGRITY_CHECK_WORKER_TIMEOUT_MS`). On timeout the
 * worker is terminated and the runner returns
 * `{ ok: false, error: "worker timed out" }` — callers translate that to a
 * `corrupt` result, which releases the scheduler mutex and keeps the next
 * tick eligible to run. Without this cap a stuck I/O syscall in the worker
 * would freeze integrity checking for the entire process lifetime
 * (potentially weeks between restarts).
 */
export async function runIntegrityCheckInWorker(
	dbPath: string,
	options?: { busyTimeoutMs?: number; timeoutMs?: number },
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

	const timeoutMs = resolveTimeoutMs(options?.timeoutMs);
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	try {
		const result = await new Promise<
			{ ok: true } | { ok: false; error: string }
		>((resolve, reject) => {
			worker.onmessage = (event: MessageEvent) => resolve(event.data);
			worker.onerror = (event: ErrorEvent) =>
				reject(new Error(event.message ?? "integrity worker error"));
			timeoutHandle = setTimeout(() => {
				// resolve (not reject) — we want this to look like any other
				// "non-ok" result so callers (recordIntegrityResult, the
				// on-demand endpoint) treat it uniformly and release the mutex.
				resolve({
					ok: false,
					error: `worker timed out after ${timeoutMs}ms — bun:sqlite call likely hung on disk I/O; check filesystem health`,
				});
			}, timeoutMs);
			worker.postMessage({
				dbPath,
				busyTimeoutMs: options?.busyTimeoutMs ?? 10_000,
			});
		});
		return result;
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		worker.terminate();
	}
}

function resolveTimeoutMs(override?: number): number {
	if (override !== undefined && Number.isInteger(override) && override > 0) {
		return override;
	}
	const raw = process.env.CCFLARE_INTEGRITY_CHECK_WORKER_TIMEOUT_MS;
	if (raw === undefined || raw === "") return DEFAULT_WORKER_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return DEFAULT_WORKER_TIMEOUT_MS;
	}
	return parsed;
}
