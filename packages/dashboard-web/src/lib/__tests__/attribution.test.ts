import { describe, expect, it } from "bun:test";
import { attributionSourceLabel } from "../attribution";

describe("attributionSourceLabel", () => {
	it("maps header_project to 'header'", () => {
		expect(attributionSourceLabel("header_project")).toBe("header");
	});

	it("maps header_agent to 'header'", () => {
		expect(attributionSourceLabel("header_agent")).toBe("header");
	});

	it("maps path_project to 'path'", () => {
		expect(attributionSourceLabel("path_project")).toBe("path");
	});

	it("maps heading_project to 'heading'", () => {
		expect(attributionSourceLabel("heading_project")).toBe("heading");
	});

	it("maps prompt_agent to 'prompt'", () => {
		expect(attributionSourceLabel("prompt_agent")).toBe("prompt");
	});

	it("maps 'none' to null", () => {
		expect(attributionSourceLabel("none")).toBeNull();
	});

	it("maps undefined to null", () => {
		expect(attributionSourceLabel(undefined)).toBeNull();
	});
});
