import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { LogEvent } from "@better-ccflare/types";
import { Logger, LogLevel, logBus, setConsoleLogging } from "./index";

describe("Logger error serialization", () => {
	let captured: LogEvent[] = [];
	const handler = (event: LogEvent) => {
		captured.push(event);
	};
	let savedLogLevel: string | undefined;

	beforeEach(() => {
		captured = [];
		savedLogLevel = process.env.LOG_LEVEL;
		delete process.env.LOG_LEVEL;
		logBus.on("log", handler);
	});

	afterEach(() => {
		logBus.off("log", handler);
		if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = savedLogLevel;
	});

	it("emits Error name, message, and stack as plain object data", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		const err = new Error("boom");
		logger.error("Failed:", err);

		expect(captured.length).toBe(1);
		const data = captured[0].data as {
			name?: string;
			message?: string;
			stack?: string;
		};
		expect(data.name).toBe("Error");
		expect(data.message).toBe("boom");
		expect(typeof data.stack).toBe("string");
	});

	it("survives JSON.stringify roundtrip (the file writer's actual path)", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		logger.error("Failed:", new Error("disk-bound"));

		const roundtripped = JSON.parse(JSON.stringify(captured[0])) as LogEvent;
		const data = roundtripped.data as { message?: string };
		expect(data.message).toBe("disk-bound");
	});

	it("recursively serializes Error.cause", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		const inner = new Error("inner cause");
		const outer = new Error("outer", { cause: inner });
		logger.error("wrapped:", outer);

		const data = captured[0].data as { cause?: { message?: string } };
		expect(data.cause?.message).toBe("inner cause");
	});

	it("preserves non-Error data unchanged", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		logger.error("payload:", { foo: "bar" });

		expect(captured[0].data).toEqual({ foo: "bar" });
	});

	it("preserves Error serialization across all log levels (roundtrip)", () => {
		const logger = new Logger("Test", LogLevel.DEBUG);
		logger.warn("warn-path:", new Error("warned"));
		logger.info("info-path:", new Error("informed"));
		logger.debug("debug-path:", new Error("debugged"));

		expect(captured.length).toBe(3);
		const round = captured.map(
			(e) => JSON.parse(JSON.stringify(e)) as LogEvent,
		);
		expect((round[0].data as { message?: string }).message).toBe("warned");
		expect((round[1].data as { message?: string }).message).toBe("informed");
		expect((round[2].data as { message?: string }).message).toBe("debugged");
	});

	it("omits data when no second argument is passed", () => {
		const logger = new Logger("Test", LogLevel.ERROR);
		logger.error("just a message");
		expect("data" in captured[0]).toBe(false);
	});
});

describe("Logger env LOG_LEVEL handling", () => {
	const original = process.env.LOG_LEVEL;

	beforeEach(() => {
		delete process.env.LOG_LEVEL;
	});

	afterEach(() => {
		if (original === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = original;
	});

	it("defaults to INFO when LOG_LEVEL is unset", () => {
		expect(new Logger().getLevel()).toBe(LogLevel.INFO);
	});

	it("respects LOG_LEVEL=DEBUG (regression: || vs ?? on LogLevel.DEBUG === 0)", () => {
		process.env.LOG_LEVEL = "DEBUG";
		expect(new Logger().getLevel()).toBe(LogLevel.DEBUG);
	});

	it("respects LOG_LEVEL=WARN", () => {
		process.env.LOG_LEVEL = "WARN";
		expect(new Logger().getLevel()).toBe(LogLevel.WARN);
	});

	it("respects LOG_LEVEL=ERROR", () => {
		process.env.LOG_LEVEL = "ERROR";
		expect(new Logger().getLevel()).toBe(LogLevel.ERROR);
	});

	it("ignores unknown LOG_LEVEL values and falls back to constructor default", () => {
		process.env.LOG_LEVEL = "BANANA";
		expect(new Logger("", LogLevel.WARN).getLevel()).toBe(LogLevel.WARN);
	});

	it("emits debug() output to console when LOG_LEVEL=DEBUG (silentConsole side-effect)", () => {
		process.env.LOG_LEVEL = "DEBUG";
		const spy = spyOn(console, "log").mockImplementation(() => {});
		try {
			new Logger("Test").debug("hello");
			expect(spy).toHaveBeenCalledTimes(1);
			expect(String(spy.mock.calls[0][0])).toContain("DEBUG");
			expect(String(spy.mock.calls[0][0])).toContain("hello");
		} finally {
			spy.mockRestore();
		}
	});

	it("suppresses debug() console output by default (LOG_LEVEL unset)", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		try {
			new Logger("Test").debug("hello");
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});

describe("setConsoleLogging override", () => {
	beforeEach(() => {
		setConsoleLogging(null);
	});

	afterEach(() => {
		setConsoleLogging(null);
		delete process.env.LOG_LEVEL;
	});

	it("silences console by default outside debug mode, override restores it", () => {
		process.env.LOG_LEVEL = "warn";
		const logger = new Logger("test");
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			logger.warn("invisible by default");
			expect(warnSpy).toHaveBeenCalledTimes(0);

			// Headless serve mode: warnings must reach the console/journal.
			setConsoleLogging(true);
			logger.warn("visible with override");
			expect(warnSpy).toHaveBeenCalledTimes(1);

			setConsoleLogging(null);
			logger.warn("silent again");
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
