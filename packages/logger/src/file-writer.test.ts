import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "@better-ccflare/types";
import { LogFileWriter } from "./file-writer";
import { Logger, LogLevel, logBus, setConsoleLogging } from "./index";

describe("LogFileWriter.write — non-serializable payloads", () => {
	let logDir: string;
	let savedLogDir: string | undefined;
	let writer: LogFileWriter;

	beforeEach(() => {
		savedLogDir = process.env.BETTER_CCFLARE_LOG_DIR;
		logDir = mkdtempSync(join(tmpdir(), "better-ccflare-logger-test-"));
		process.env.BETTER_CCFLARE_LOG_DIR = logDir;
		writer = new LogFileWriter();
	});

	afterEach(() => {
		writer.close();
		if (savedLogDir === undefined) delete process.env.BETTER_CCFLARE_LOG_DIR;
		else process.env.BETTER_CCFLARE_LOG_DIR = savedLogDir;
		rmSync(logDir, { recursive: true, force: true });
	});

	// createWriteStream() buffers writes asynchronously, so a synchronous
	// readFileSync() right after write() can race the flush to disk. Poll
	// briefly instead of asserting on a fixed delay.
	async function readLastLine(): Promise<LogEvent> {
		const logFile = join(logDir, "app.log");
		for (let attempt = 0; attempt < 50; attempt++) {
			if (existsSync(logFile)) {
				const content = readFileSync(logFile, "utf-8");
				const lines = content.trim().split("\n").filter(Boolean);
				if (lines.length > 0) {
					return JSON.parse(lines[lines.length - 1]) as LogEvent;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("Timed out waiting for log file write to flush");
	}

	it("does not throw and preserves ts/level/msg for a circular data reference", async () => {
		const circular: Record<string, unknown> = { foo: "bar" };
		circular.self = circular;
		const event: LogEvent = {
			ts: 1700000000000,
			level: "ERROR",
			msg: "circular payload",
			data: circular,
		};

		expect(() => writer.write(event)).not.toThrow();

		const parsed = await readLastLine();
		expect(parsed.ts).toBe(event.ts);
		expect(parsed.level).toBe("ERROR");
		expect(parsed.msg).toBe("circular payload");
		expect(typeof parsed.data).toBe("string");
		expect(String(parsed.data)).toContain("unserializable");
	});

	it("does not throw and preserves ts/level/msg for a BigInt in data", async () => {
		const event: LogEvent = {
			ts: 1700000000001,
			level: "WARN",
			msg: "bigint payload",
			data: { amount: 10n },
		};

		expect(() => writer.write(event)).not.toThrow();

		const parsed = await readLastLine();
		expect(parsed.ts).toBe(event.ts);
		expect(parsed.level).toBe("WARN");
		expect(parsed.msg).toBe("bigint payload");
		expect(typeof parsed.data).toBe("string");
		expect(String(parsed.data)).toContain("unserializable");
	});

	it("does not throw when the thrown error itself is not stringifiable", async () => {
		// toJSON throwing a value whose Symbol.toPrimitive also throws means
		// the catch block's `String(e)` would itself throw if unguarded.
		const hostile = {
			toJSON() {
				throw {
					[Symbol.toPrimitive]() {
						throw new Error("nope");
					},
				};
			},
		};
		const event: LogEvent = {
			ts: 1700000000003,
			level: "ERROR",
			msg: "hostile payload",
			data: hostile,
		};

		expect(() => writer.write(event)).not.toThrow();

		const parsed = await readLastLine();
		expect(parsed.ts).toBe(event.ts);
		expect(parsed.level).toBe("ERROR");
		expect(parsed.msg).toBe("hostile payload");
		expect(typeof parsed.data).toBe("string");
		expect(String(parsed.data)).toContain("unserializable");
	});

	it("leaves normal serializable events byte-identical", async () => {
		const event: LogEvent = {
			ts: 1700000000002,
			level: "INFO",
			msg: "normal",
			data: { foo: "bar", n: 42 },
		};

		writer.write(event);

		// Poll for the flush, then assert the exact bytes are unchanged
		// (the fix must not alter the happy-path output).
		const parsed = await readLastLine();
		expect(parsed).toEqual(event);

		const content = readFileSync(join(logDir, "app.log"), "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines[lines.length - 1]).toBe(JSON.stringify(event));
	});
});

describe("Logger.error — non-serializable data does not crash the caller", () => {
	let captured: LogEvent[] = [];
	const handler = (event: LogEvent) => {
		captured.push(event);
	};

	beforeEach(() => {
		captured = [];
		logBus.on("log", handler);
	});

	afterEach(() => {
		logBus.off("log", handler);
	});

	it("does not throw when logging a circular-reference payload", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => logger.error("boom", circular)).not.toThrow();
		expect(captured.length).toBe(1);
	});

	it("does not throw when logging a BigInt payload", () => {
		const logger = new Logger("Test", LogLevel.ERROR);

		expect(() => logger.error("boom", { n: 5n })).not.toThrow();
		expect(captured.length).toBe(1);
	});

	it("does not throw when the thrown error itself is not stringifiable", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		const hostile = {
			toJSON() {
				throw {
					[Symbol.toPrimitive]() {
						throw new Error("nope");
					},
				};
			},
		};

		expect(() => logger.error("boom", hostile)).not.toThrow();
		expect(captured.length).toBe(1);
	});
});

describe("LogFileWriter.readLogs — tail reading", () => {
	let logDir: string;
	let savedLogDir: string | undefined;
	let writer: LogFileWriter;

	beforeEach(() => {
		savedLogDir = process.env.BETTER_CCFLARE_LOG_DIR;
		logDir = mkdtempSync(join(tmpdir(), "better-ccflare-logger-tail-"));
		process.env.BETTER_CCFLARE_LOG_DIR = logDir;
		writer = new LogFileWriter();
	});

	afterEach(() => {
		writer.close();
		if (savedLogDir === undefined) delete process.env.BETTER_CCFLARE_LOG_DIR;
		else process.env.BETTER_CCFLARE_LOG_DIR = savedLogDir;
		rmSync(logDir, { recursive: true, force: true });
	});

	function seed(lines: string[]): void {
		writer.close();
		writeFileSync(join(logDir, "app.log"), `${lines.join("\n")}\n`);
	}

	const ev = (i: number, pad = 0): string =>
		JSON.stringify({ ts: i, level: "INFO", msg: `m${i}${"x".repeat(pad)}` });

	it("returns the last N events from a file larger than the read window", async () => {
		seed(Array.from({ length: 3000 }, (_, i) => ev(i, 200)));
		const logs = await writer.readLogs(5);
		expect(logs.map((l) => l.ts)).toEqual([2995, 2996, 2997, 2998, 2999]);
	});

	it("returns everything when the file has fewer lines than the limit", async () => {
		seed(Array.from({ length: 3 }, (_, i) => ev(i)));
		const logs = await writer.readLogs(1000);
		expect(logs.map((l) => l.ts)).toEqual([0, 1, 2]);
	});

	it("skips unparseable lines like before", async () => {
		seed([ev(1), "not json", ev(3)]);
		const logs = await writer.readLogs(10);
		expect(logs.map((l) => l.ts)).toEqual([1, 3]);
	});

	it("handles limit larger than the window on a large file", async () => {
		seed(Array.from({ length: 3000 }, (_, i) => ev(i, 200)));
		const logs = await writer.readLogs(2500);
		expect(logs.length).toBe(2500);
		expect(logs[0].ts).toBe(500);
		expect(logs[2499].ts).toBe(2999);
	});
});

describe("Logger — console formatting laziness", () => {
	it("does not emit on logBus when there are no listeners and still logs to console when enabled", () => {
		const l = new Logger("t", LogLevel.INFO);
		const spy: string[] = [];
		const emitSpy = spyOn(logBus, "emit");
		const orig = console.log;
		console.log = (m: string) => spy.push(m);
		try {
			setConsoleLogging(true);
			l.info("hello", { a: 1 });
		} finally {
			setConsoleLogging(null);
			console.log = orig;
		}
		const emitCalls = emitSpy.mock.calls.length;
		emitSpy.mockRestore();
		expect(emitCalls).toBe(0);
		expect(spy.length).toBe(1);
		expect(spy[0]).toContain("INFO: [t] hello");
	});
});
