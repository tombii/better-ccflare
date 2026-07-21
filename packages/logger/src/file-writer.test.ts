import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "@better-ccflare/types";
import { LogFileWriter } from "./file-writer";
import { Logger, LogLevel, logBus } from "./index";

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
});
