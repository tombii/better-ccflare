import { Logger } from "@better-ccflare/logger";
import { EMBEDDED_WORKER_CODE } from "./inline-worker";
import type {
	OutgoingWorkerMessage,
	SummaryMessage,
	WorkerMessage,
} from "./worker-messages";

const log = new Logger("UsageWorkerController");

type WorkerState = "starting" | "ready" | "shutting_down" | "stopped";

export interface UsageWorkerHealth {
	state: WorkerState;
	pendingAcks: number;
	lastError: string | null;
	startedAt: number | null;
}

interface PendingAck {
	timer: Timer;
}

const MAX_RESTARTS = 3;
const SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

/**
 * Resolve the worker startup timeout from `CF_WORKER_STARTUP_TIMEOUT_MS`,
 * falling back to {@link DEFAULT_STARTUP_TIMEOUT_MS}.
 *
 * The worker opens its own SQLite handle on startup; on operators with large
 * (multi-GB) databases the per-handle PRAGMA work can blow past the historical
 * 10 s timeout and silently strand request analytics. 60 s gives that path
 * headroom; ops with massive DBs or slow disks can raise it further via env.
 */
function resolveStartupTimeoutMs(): number {
	const raw = process.env.CF_WORKER_STARTUP_TIMEOUT_MS;
	if (raw === undefined || raw === "") return DEFAULT_STARTUP_TIMEOUT_MS;
	// Number() rejects trailing garbage that Number.parseInt would silently
	// accept ("100ms" → 100 was a real foot-gun); isInteger catches NaN,
	// Infinity, and fractional values in one check.
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		log.warn(
			`CF_WORKER_STARTUP_TIMEOUT_MS="${raw}" is not a positive integer — falling back to default ${DEFAULT_STARTUP_TIMEOUT_MS}ms`,
		);
		return DEFAULT_STARTUP_TIMEOUT_MS;
	}
	return parsed;
}

export class UsageWorkerController {
	private state: WorkerState = "stopped";
	private worker: Worker | null = null;
	private pendingAcks = new Map<string, PendingAck>();
	private lastError: string | null = null;
	private startedAt: number | null = null;
	private restartCount = 0;
	private startupTimer: Timer | null = null;
	private shutdownResolve: (() => void) | null = null;

	constructor(
		private readonly onSummary: (msg: SummaryMessage) => void,
		private readonly onReady?: () => void,
		private readonly startupTimeoutMs = resolveStartupTimeoutMs(),
		private readonly ackTimeoutMs = 30_000,
	) {}

	start(): void {
		// Idempotent guard — don't double-start
		if (this.state === "starting" || this.state === "ready") return;

		this.state = "starting";
		this.worker = this.createWorker();

		this.worker.onmessage = (ev: MessageEvent) => {
			this.handleMessage(ev.data as OutgoingWorkerMessage);
		};

		this.worker.onerror = (error: ErrorEvent) => {
			const msg = error.message ?? "unknown worker error";
			log.error("Worker error", {
				message: msg,
				filename: error.filename,
				lineno: error.lineno,
			});
			this.lastError = msg;

			if (this.state === "ready") {
				this.attemptRestart();
			}
		};

		this.startupTimer = setTimeout(() => {
			log.error(
				`Worker did not become ready within ${this.startupTimeoutMs}ms`,
			);
			this.lastError = "startup timeout";
			this.attemptRestart();
		}, this.startupTimeoutMs);
	}

	postMessage(msg: WorkerMessage): void {
		if (this.state !== "ready") {
			throw new Error(
				`Cannot post message: worker state is "${this.state}", expected "ready"`,
			);
		}

		if (msg.type === "start") {
			const { messageId } = msg;
			const timer = setTimeout(() => {
				if (this.pendingAcks.has(messageId)) {
					log.warn(`Ack timeout for messageId=${messageId}`);
					this.pendingAcks.delete(messageId);
				}
			}, this.ackTimeoutMs);

			this.pendingAcks.set(messageId, { timer });
		}

		this.worker?.postMessage(msg);
	}

	terminate(): Promise<void> {
		if (this.state === "stopped") return Promise.resolve();

		this.state = "shutting_down";

		const promise = new Promise<void>((resolve) => {
			this.shutdownResolve = resolve;

			// Fallback: terminate after grace period regardless of shutdown-complete
			setTimeout(() => {
				resolve();
			}, SHUTDOWN_GRACE_MS);
		});

		try {
			this.worker?.postMessage({ type: "shutdown" });
		} catch {
			// Worker already gone
		}

		return promise.then(() => {
			this.destroyWorker();
			this.state = "stopped";
		});
	}

	getHealth(): UsageWorkerHealth {
		return {
			state: this.state,
			pendingAcks: this.pendingAcks.size,
			lastError: this.lastError,
			startedAt: this.startedAt,
		};
	}

	isReady(): boolean {
		return this.state === "ready";
	}

	// ===== Internal =====

	private handleMessage(data: OutgoingWorkerMessage): void {
		switch (data.type) {
			case "ready":
				clearTimeout(this.startupTimer!);
				this.startupTimer = null;
				this.state = "ready";
				this.startedAt = Date.now();
				this.onReady?.();
				break;

			case "ack": {
				const pending = this.pendingAcks.get(data.messageId);
				if (pending) {
					clearTimeout(pending.timer);
					this.pendingAcks.delete(data.messageId);
				}
				break;
			}

			case "shutdown-complete":
				if (this.state === "shutting_down" && this.shutdownResolve) {
					this.shutdownResolve();
					this.shutdownResolve = null;
				}
				break;

			case "summary":
				this.onSummary(data);
				break;
		}
	}

	private attemptRestart(): void {
		this.destroyWorker();

		if (this.restartCount >= MAX_RESTARTS) {
			log.error(`Worker failed after ${MAX_RESTARTS} restarts — giving up`);
			this.state = "stopped";
			return;
		}

		this.restartCount++;
		log.warn(
			`Restarting worker (attempt ${this.restartCount}/${MAX_RESTARTS})`,
		);

		// Reset to stopped so start() accepts the call
		this.state = "stopped";
		this.start();
	}

	private destroyWorker(): void {
		if (this.startupTimer !== null) {
			clearTimeout(this.startupTimer);
			this.startupTimer = null;
		}

		for (const { timer } of this.pendingAcks.values()) {
			clearTimeout(timer);
		}
		this.pendingAcks.clear();

		try {
			this.worker?.terminate();
		} catch {
			// Ignore
		}
		this.worker = null;
	}

	private createWorker(): Worker {
		let w: Worker;

		if (EMBEDDED_WORKER_CODE) {
			const workerCode = Buffer.from(EMBEDDED_WORKER_CODE, "base64").toString(
				"utf8",
			);
			const blob = new Blob([workerCode], { type: "text/javascript" });
			const workerUrl = URL.createObjectURL(blob);
			w = new Worker(workerUrl, { smol: true });
		} else {
			const workerPath = new URL("./post-processor.worker.ts", import.meta.url)
				.href;
			w = new Worker(workerPath, { smol: true });
		}

		// Bun extension — don't keep the process alive for the worker alone
		if (
			"unref" in w &&
			typeof (w as { unref?: () => void }).unref === "function"
		) {
			(w as { unref: () => void }).unref();
		}

		return w;
	}
}
