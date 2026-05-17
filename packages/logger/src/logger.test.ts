import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Logger, LogLevel } from "./index";

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
