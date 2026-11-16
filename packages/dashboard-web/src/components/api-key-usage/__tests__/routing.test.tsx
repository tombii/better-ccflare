import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as Router from "react-router-dom";
import { LegacyApiKeyUsageRedirect } from "../../../App";

describe("API Key Usage routing", () => {
	it("replaces legacy key routes with a canonical query preselection", () => {
		const location = spyOn(Router, "useLocation").mockReturnValue({
			pathname: "/api-keys/team%252Fapp",
			search: "",
			hash: "",
			state: null,
			key: "test",
		});
		try {
			const redirect = LegacyApiKeyUsageRedirect();
			expect(redirect.type).toBe(Router.Navigate);
			expect(redirect.props.replace).toBe(true);
			const target = new URL(redirect.props.to, "https://local");
			expect(target.pathname).toBe("/api-key-usage");
			expect(target.searchParams.get("key")).toBe("team%2Fapp");
		} finally {
			location.mockRestore();
		}
	});
	it("registers one usage page and redirects every old key path", () => {
		const app = readFileSync(
			new URL("../../../App.tsx", import.meta.url),
			"utf8",
		);
		expect(app.match(/path: "\/api-key-usage"/g)).toHaveLength(1);
		expect(app).not.toContain('path: "/api-keys/:keyId"');
		expect(app).toMatch(
			/<Route\s+path="\/api-keys\/\*"\s+element=\{<LegacyApiKeyUsageRedirect \/>\}/,
		);
		const navigation = readFileSync(
			new URL("../../navigation.tsx", import.meta.url),
			"utf8",
		);
		expect(navigation).not.toContain("`/api-keys/${");
	});
});
