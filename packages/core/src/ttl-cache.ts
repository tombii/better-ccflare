export class TtlCache<T> {
	private ttlMs: number;
	private value: T | undefined;
	private timestamp: number = 0;
	private now: () => number;

	constructor(ttlMs: number, now?: () => number) {
		this.ttlMs = ttlMs;
		this.now = now ?? (() => Date.now());
	}

	set(value: T): void {
		this.value = value;
		this.timestamp = this.now();
	}

	get(): T | undefined {
		if (this.value === undefined) return undefined;
		if (this.now() - this.timestamp > this.ttlMs) {
			this.clear();
			return undefined;
		}
		return this.value;
	}

	isStale(): boolean {
		return this.get() === undefined;
	}

	clear(): void {
		this.value = undefined;
		this.timestamp = 0;
	}

	get size(): number {
		return this.value !== undefined && this.now() - this.timestamp <= this.ttlMs
			? 1
			: 0;
	}
}
