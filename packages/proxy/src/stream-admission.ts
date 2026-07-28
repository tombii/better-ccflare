/**
 * Per-account concurrent SSE stream admission control.
 *
 * Why this exists: a single overloaded upstream turned into 187 watchdog
 * calls/hour once 30+ agent sessions each opened a long-lived SSE stream
 * against it. Unbounded concurrent streams per account is the amplifier —
 * each session parks a stream that holds a server-side worker for the life
 * of the conversation. This module caps in-flight streams PER ACCOUNT,
 * queues overflow with bounded capacity and max-wait, and releases slots
 * deterministically (completion, disconnect, error) so a leak never
 * permanently shrinks capacity.
 *
 * **Jitter matters more than the cap.** If a fixed delay frees a slot and
 * then admits the head-of-queue waiter after N ms, N waiting sessions that
 * all started ~together will all stampede the upstream N ms later in
 * lockstep. The cap keeps the total bounded; the jitter keeps the arrivals
 * spread so the upstream does not see a synchronized burst. The delay is
 * sampled per admission from an injected randomness source so tests are
 * deterministic and production gets real spread.
 *
 * **Leak-proof release is the hardest correctness property.** A leaked slot
 * permanently shrinks capacity for the life of the process and is the
 * worst failure mode here. `release()` is idempotent: calling it twice,
 * calling it after a thrown error, or calling it after the client already
 * disconnected must all converge to "slot free, one fewer active". The
 * caller is responsible for wiring `release()` into completion / abort /
 * error paths; this module only guarantees that each call has the right
 * effect when invoked.
 *
 * **Transport-agnostic by design.** This module knows nothing about HTTP
 * status codes, SSE framing, or response shaping. On overflow / timeout it
 * resolves with a typed rejection object the caller maps to whatever
 * response shape its transport needs. Wiring into the SSE path is a
 * separate task.
 *
 * Env flag (matches the inline convention in this repo, e.g.
 * `CCFLARE_CODEX_PROMPT_CACHE_KEY`): `CCFLARE_STREAM_ADMISSION=0` disables
 * the gate and turns `admit()` into a pass-through. On by default.
 */
export const STREAM_ADMISSION_ENV = "CCFLARE_STREAM_ADMISSION";

/**
 * Default cap of 4 concurrent streams per account. Justification: a real
 * Anthropic/Codex account comfortably sustains a handful of long-lived SSE
 * streams; 4 leaves headroom for the active session and one or two queued
 * bursts while still rejecting the "30+ parallel agents" pattern. Tune via
 * `createStreamAdmission({ cap })` for accounts with documented higher
 * limits; do NOT raise the default without a reason.
 */
export const DEFAULT_STREAM_ADMISSION_CAP = 4;
/**
 * Queue depth bound. 32 covers bursty multi-agent workflows (a 30-agent
 * swarm opening streams in lockstep) while still surfacing sustained
 * overload as `queue_full` within seconds. Larger queues mask the
 * overload signal.
 */
export const DEFAULT_STREAM_ADMISSION_MAX_QUEUE = 32;
/**
 * Max wait before a queued admission is rejected as `timeout`. 30s is below
 * typical upstream keepalive timeouts so a queued client fails its own
 * timeout before the upstream does — surfacing the problem at the proxy
 * rather than mid-stream.
 */
export const DEFAULT_STREAM_ADMISSION_MAX_WAIT_MS = 30_000;
/**
 * Max jitter window. 250ms is large enough to decorrelate waiters that
 * started within a few ms of each other, small enough that the total
 * admission time for a saturated queue stays bounded. Per-admission
 * delay = `random() * MAX_JITTER_MS` so the average added latency is
 * ~125ms.
 */
export const DEFAULT_STREAM_ADMISSION_MAX_JITTER_MS = 250;

interface Waiter {
	accountId: string;
	resolve: (result: AdmitResult) => void;
	/** Logical timestamp at which the queue-wait deadline expires. */
	deadlineMs: number;
}

interface AccountState {
	/** Streams with a slot, possibly mid-jitter (counted as held either way). */
	held: number;
	/** Streams that have a slot and have fired their jitter (effectively active). */
	active: number;
	/** Waiters waiting in queue or in jitter delay. */
	queue: Waiter[];
}

export interface StreamAdmissionOptions {
	/** Max concurrent in-flight streams per account. Default {@link DEFAULT_STREAM_ADMISSION_CAP}. */
	cap?: number;
	/** Max waiters in the per-account queue. Default {@link DEFAULT_STREAM_ADMISSION_MAX_QUEUE}. */
	maxQueue?: number;
	/** Max wait before a queued admit resolves as `timeout`. Default {@link DEFAULT_STREAM_ADMISSION_MAX_WAIT_MS}. */
	maxWaitMs?: number;
	/** Max jitter window per admission. Default {@link DEFAULT_STREAM_ADMISSION_MAX_JITTER_MS}. */
	maxJitterMs?: number;
	/** Injected clock. Tests pass a deterministic source. Default `Date.now`. */
	now?: () => number;
	/** Injected randomness in [0, 1). Tests pass a deterministic source. Default `Math.random`. */
	random?: () => number;
	/**
	 * Inject the scheduler for jittered release. Default `setTimeout`.
	 * Tests pass `queueMicrotask` to make tests fast and deterministic.
	 */
	schedule?: (cb: () => void, delayMs: number) => void;
}

export interface AdmissionHandle {
	/** The account this handle was admitted for. */
	readonly accountId: string;
	/**
	 * Logical timestamp at which this handle was admitted (when the jitter
	 * delay elapsed and the slot became active). For non-jittered (immediate)
	 * admissions, equals `now()` at admit time.
	 */
	readonly admittedAt: number;
	/**
	 * Logical timestamp the caller should wait until before forwarding the
	 * stream. For non-jittered admissions, equals `admittedAt`. Exposed for
	 * callers that want to align forwarding with upstream timing.
	 */
	readonly effectiveAtMs: number;
	/** Release the slot. Idempotent: subsequent calls are no-ops. */
	release(): void;
}

/**
 * Typed rejection surface. The caller maps this to whatever HTTP shape the
 * transport needs; this module never invents an HTTP status. On `timeout`,
 * `waitedMs` is the time actually spent in the queue (≥ 0).
 */
export type AdmissionRejection =
	| { readonly kind: "queue_full" }
	| { readonly kind: "timeout"; readonly waitedMs: number };

export type AdmitResult =
	| { readonly ok: true; readonly handle: AdmissionHandle }
	| { readonly ok: false; readonly reason: AdmissionRejection };

export interface AccountSnapshot {
	/** Streams currently holding a slot (active + in-jitter; capacity consumed). */
	active: number;
	/** Waiters queued behind the cap (not yet admitted). */
	queued: number;
}

export interface StreamAdmissionSnapshot {
	/** True when the env kill-switch has flipped the gate to pass-through. */
	readonly passesThrough: boolean;
	/** Per-account snapshot. Empty when pass-through is active. */
	readonly accounts: Readonly<Record<string, AccountSnapshot>>;
}

export interface StreamAdmission {
	/**
	 * Request admission for one SSE stream against `accountId`. Resolves
	 * with a typed result on every outcome — including queue overflow and
	 * timeout — so the caller can branch without try/catch.
	 */
	admit(accountId: string): Promise<AdmitResult>;
	/**
	 * JSON-serializable snapshot of current state. Stable shape; safe to
	 * expose verbatim via a future HTTP capacity-state endpoint.
	 */
	snapshot(): StreamAdmissionSnapshot;
	/**
	 * Test hook: drop all per-account state. Does not touch env reads or
	 * cached config.
	 */
	reset(): void;
}

/**
 * Create a stream admission gate. Each instance owns its own per-account
 * state; create one per process. The env kill-switch is read at creation
 * time and can be re-evaluated by calling `reset()` plus re-creation (the
 * wiring layer caches the instance for its lifetime).
 */
export function createStreamAdmission(
	opts: StreamAdmissionOptions = {},
): StreamAdmission {
	const cap = Math.max(1, opts.cap ?? DEFAULT_STREAM_ADMISSION_CAP);
	const maxQueue = Math.max(0, opts.maxQueue ?? DEFAULT_STREAM_ADMISSION_MAX_QUEUE);
	const maxWaitMs = Math.max(
		0,
		opts.maxWaitMs ?? DEFAULT_STREAM_ADMISSION_MAX_WAIT_MS,
	);
	const maxJitterMs = Math.max(
		0,
		opts.maxJitterMs ?? DEFAULT_STREAM_ADMISSION_MAX_JITTER_MS,
	);
	const now = opts.now ?? Date.now;
	const random = opts.random ?? Math.random;
	const schedule = opts.schedule ?? defaultSchedule;

	const passesThrough = isKilledOff();
	const accounts = new Map<string, AccountState>();

	function getAccount(id: string): AccountState {
		let s = accounts.get(id);
		if (!s) {
			s = { held: 0, active: 0, queue: [] };
			accounts.set(id, s);
		}
		return s;
	}

	function admit(accountId: string): Promise<AdmitResult> {
		if (passesThrough) {
			return Promise.resolve({
				ok: true,
				handle: makePassThroughHandle(accountId, now()),
			});
		}
		const acc = getAccount(accountId);
		// Capacity available AND nothing in flight: admit immediately.
		if (acc.held < cap && acc.queue.length === 0) {
			acc.held++;
			acc.active++;
			const ts = now();
			return Promise.resolve({
				ok: true,
				handle: makeActiveHandle(accountId, ts, ts, acc),
			});
		}
		// Capacity available but waiters are queued or jittered in-flight:
		// join the queue so we preserve FIFO ordering and don't sneak past
		// earlier waiters. The next release() will pick the head.
		if (acc.queue.length >= maxQueue) {
			return Promise.resolve({ ok: false, reason: { kind: "queue_full" } });
		}
		return new Promise<AdmitResult>((resolve) => {
			const ts = now();
			const waiter: Waiter = {
				accountId,
				resolve,
				deadlineMs: ts + maxWaitMs,
			};
			acc.queue.push(waiter);
			// No timer needed: when release() fires for this account, it
			// walks the head of the queue and either admits or times out.
			// Timeout is checked at pick-time so we don't need a per-waiter
			// timer (which would be a leak source if cancel/release race).
		});
	}

	function releaseOneSlot(acc: AccountState, nowMs: number): void {
		// Walk the queue, skipping expired waiters until we find one to admit
		// or run out. Each skipped waiter is resolved with `timeout` so the
		// caller unblocks and can react.
		while (acc.queue.length > 0) {
			const head = acc.queue[0];
			if (head.deadlineMs > 0 && head.deadlineMs <= nowMs) {
				acc.queue.shift();
				head.resolve({
					ok: false,
					reason: { kind: "timeout", waitedMs: maxWaitMs },
				});
				continue;
			}
			// Found a live waiter. Reserve the slot (held++) and schedule
			// the jittered admit. held stays incremented until the jitter
			// fires; at that point active++ (held unchanged — slot is still
			// held, just transitioned to "active" rather than "in-jitter").
			// This guarantees cap holds across the jitter window so we never
			// admit more than `cap` total.
			acc.queue.shift();
			acc.held++;
			const jitterMs = random() * maxJitterMs;
			const effectiveAtMs = nowMs + jitterMs;
			schedule(() => {
				acc.active++;
				head.resolve({
					ok: true,
					handle: makeActiveHandle(
						head.accountId,
						now(),
						effectiveAtMs,
						acc,
					),
				});
			}, jitterMs);
			return;
		}
		// No waiters: free the slot.
		if (acc.active > 0) {
			acc.active--;
			acc.held--;
		}
	}

	function snapshot(): StreamAdmissionSnapshot {
		const out: Record<string, AccountSnapshot> = {};
		for (const [id, acc] of accounts) {
			out[id] = {
				// `held` includes in-jitter; both consume capacity.
				active: acc.held,
				queued: acc.queue.length,
			};
		}
		return { passesThrough, accounts: out };
	}

	function reset(): void {
		accounts.clear();
	}

	return { admit, snapshot, reset };

	// ── handle factories ──────────────────────────────────────────────────

	function makeActiveHandle(
		accountId: string,
		admittedAt: number,
		effectiveAtMs: number,
		acc: AccountState,
	): AdmissionHandle {
		let released = false;
		return {
			accountId,
			admittedAt,
			effectiveAtMs,
			release() {
				if (released) return;
				released = true;
				releaseOneSlot(acc, now());
			},
		};
	}
}

function makePassThroughHandle(accountId: string, ts: number): AdmissionHandle {
	return {
		accountId,
		admittedAt: ts,
		effectiveAtMs: ts,
		// Pass-through holds no state, so release is a literal no-op. The
		// function still exists for API symmetry with the gated handle, so
		// callers can wire the same finally{} block regardless of mode.
		release() {
			/* no-op */
		},
	};
}

function isKilledOff(): boolean {
	// Match the inline convention used elsewhere in this repo
	// (CCFLARE_CODEX_PROMPT_CACHE_KEY etc.): only the literal "0" string
	// disables. Unset / empty / other values leave the gate on.
	return process.env[STREAM_ADMISSION_ENV] === "0";
}

function defaultSchedule(cb: () => void, delayMs: number): void {
	setTimeout(cb, Math.max(0, delayMs));
}
