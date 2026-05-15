import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LogEvent } from "@better-ccflare/types";
import { Logger, LogLevel, logBus } from "./index";

describe("Logger error serialization", () => {
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
