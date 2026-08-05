/**
 * Tests for the shared project attribution extraction helper (U2).
 *
 * These tests are written BEFORE `../project-attribution` exists (or before
 * its exports are implemented) so the initial run is expected to fail (red),
 * per the plan's test-first execution note for U2. Once
 * `packages/proxy/src/project-attribution.ts` is implemented, these should
 * pass (green) without modification.
 *
 * Covers the plan's U2 scenarios (docs/plans/2026-07-08-001-feature-attribution-source-tags-plan.md):
 *  - namespaced header precedence over legacy header
 *  - legacy `x-project` header still works
 *  - control-char stripping + length cap (64) preserved
 *  - workspace path inference (/home, /Users) -> path_project
 *  - H1 heading inference -> heading_project
 *  - "claude"-prefixed heading rejected
 *  - secret-like headings rejected via isLowRiskProjectSlug -> none
 *  - no header/path/heading -> none
 *  - usage-collector base64 fallback path (extractProjectAttributionFromParts)
 *    returns the same source labels as the parsed-body path
 */
import { describe, expect, it } from "bun:test";
import {
	extractProjectAttributionFromParts,
	extractProjectAttributionFromRequest,
	extractSystemPromptFromBase64,
	isLowRiskPathSegment,
	isLowRiskProjectSlug,
} from "../project-attribution";

describe("extractProjectAttributionFromRequest", () => {
	it("prefers x-better-ccflare-project over x-project when both are present", () => {
		const headers = new Headers({
			"x-better-ccflare-project": "ns-project",
			"x-project": "legacy-project",
		});
		const result = extractProjectAttributionFromRequest(headers, null);
		expect(result.project).toBe("ns-project");
		expect(result.projectAttributionSource).toBe("header_project");
	});

	it("falls back to x-project when the namespaced header is absent", () => {
		const headers = new Headers({ "x-project": "legacy-only" });
		const result = extractProjectAttributionFromRequest(headers, null);
		expect(result.project).toBe("legacy-only");
		expect(result.projectAttributionSource).toBe("header_project");
	});

	it("strips control characters from a valid header-derived project name", () => {
		// Dash-delimited so no unbroken alnum run trips LONG_TOKEN_RE (20+), and
		// within the 64-char slug grammar bound so it passes validation.
		const slug = `${"x".repeat(15)}-`.repeat(4);
		const raw = `\x01\x02${slug}\n`;
		const headers = new Headers({ "x-project": raw });
		const result = extractProjectAttributionFromRequest(headers, null);
		expect(result.project).not.toBeNull();
		expect(result.project?.length).toBeLessThanOrEqual(64);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone
		expect(result.project ?? "").not.toMatch(/[\x00-\x1F\x7F]/);
		expect(result.projectAttributionSource).toBe("header_project");
	});

	it("rejects a header value that exceeds the 64-char slug grammar bound (no silent truncate)", () => {
		// Round-2 P1 hardening for the H1 path made >64-char values reject
		// wholesale rather than truncate-and-keep; the header path must match.
		const raw = "x".repeat(80);
		const headers = new Headers({ "x-project": raw });
		const result = extractProjectAttributionFromRequest(headers, null);
		expect(result.project).toBeNull();
		expect(result.projectAttributionSource).toBe("none");
	});

	describe("header-derived project names are validated like heading-derived ones (#373)", () => {
		it("rejects a namespaced header value that fails isLowRiskProjectSlug", () => {
			const headers = new Headers({
				"x-better-ccflare-project": "## some system prompt fragment",
			});
			const result = extractProjectAttributionFromRequest(headers, null);
			expect(result.project).toBeNull();
			expect(result.projectAttributionSource).toBe("none");
		});

		it("rejects a legacy x-project header value that fails isLowRiskProjectSlug", () => {
			const headers = new Headers({
				"x-project": "Authorization: Bearer sk_live_abc123456789",
			});
			const result = extractProjectAttributionFromRequest(headers, null);
			expect(result.project).toBeNull();
			expect(result.projectAttributionSource).toBe("none");
		});

		it("rejects a header value carrying a secret past the 64-char truncation boundary", () => {
			// Same shape as the H1 boundary-straddling test: a pre-truncation
			// validator would slice this down to a clean 64-char prefix and let
			// it through. Header path must validate the FULL value too.
			const cleanPrefix = `${"x".repeat(15)}-`.repeat(4);
			const headers = new Headers({
				"x-project": `${cleanPrefix}${"Z".repeat(25)}`,
			});
			const result = extractProjectAttributionFromRequest(headers, null);
			expect(result.project).toBeNull();
			expect(result.projectAttributionSource).toBe("none");
		});

		it("falls through to the legacy header when the namespaced header is rejected", () => {
			const headers = new Headers({
				"x-better-ccflare-project": "# leaked system prompt heading",
				"x-project": "legacy-project",
			});
			const result = extractProjectAttributionFromRequest(headers, null);
			expect(result.project).toBe("legacy-project");
			expect(result.projectAttributionSource).toBe("header_project");
		});

		it("still accepts ordinary slug-shaped header values", () => {
			const headers = new Headers({ "x-better-ccflare-project": "my-app" });
			const result = extractProjectAttributionFromRequest(headers, null);
			expect(result.project).toBe("my-app");
			expect(result.projectAttributionSource).toBe("header_project");
		});
	});

	it("infers a sanitized repo slug from a /home workspace path in the system prompt", () => {
		const headers = new Headers();
		const body = {
			system: "context at /home/will/projects/better-ccflare/foo.ts done",
		};
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBe("better-ccflare");
		expect(result.projectAttributionSource).toBe("path_project");
	});

	it("infers a sanitized repo slug from a /Users workspace path in the system prompt", () => {
		const headers = new Headers();
		const body = {
			system: "working at /Users/will/Desktop/MyProj/file.txt now",
		};
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBe("MyProj");
		expect(result.projectAttributionSource).toBe("path_project");
	});

	describe("workspace-path segments are validated like header/heading values (#373)", () => {
		it("rejects a path segment that runs on past the directory name into leaked prompt text", () => {
			// Same signature as the original report: a collapsed-newline system
			// prompt makes WORKSPACE_PATH_RE's [^/]+ capture group run on past the
			// real directory name into following prompt text, producing a
			// multi-word, `#`-containing value that must be rejected wholesale
			// rather than truncated to 64 chars and kept.
			const headers = new Headers();
			const body = {
				system:
					"/home/will/projects/better-ccflare # Some Leaked System Prompt Heading Text/more",
			};
			const result = extractProjectAttributionFromRequest(headers, body);
			expect(result.project).toBeNull();
			expect(result.projectAttributionSource).toBe("none");
		});

		it("falls through to an eligible H1 heading when the workspace path segment is rejected", () => {
			const headers = new Headers();
			const body = {
				system:
					"/home/will/projects/leaked system prompt fragment with many words/more\n# Harness\nWelcome.",
			};
			const result = extractProjectAttributionFromRequest(headers, body);
			expect(result.project).toBe("Harness");
			expect(result.projectAttributionSource).toBe("heading_project");
		});

		it("rejects a path segment carrying a secret past the 64-char truncation boundary", () => {
			const cleanPrefix = `${"x".repeat(15)}-`.repeat(4);
			const headers = new Headers();
			const body = {
				system: `/home/will/projects/${cleanPrefix}${"Z".repeat(25)}/file.ts`,
			};
			const result = extractProjectAttributionFromRequest(headers, body);
			expect(result.project).toBeNull();
			expect(result.projectAttributionSource).toBe("none");
		});

		it("rejects a short space-separated run-on rather than persisting it as the project (round-2 Greptile review on #378)", () => {
			// "repo short words" is short enough to dodge the six-word sentence
			// cap and slug-shaped enough to pass SLUG_SHAPE_RE, but a real
			// directory name never contains a literal space — this is leaked
			// prompt text riding along with the real "repo" directory, not a
			// directory name itself.
			const headers = new Headers();
			const body = {
				system: "/home/u/projects/repo short words/more",
			};
			const result = extractProjectAttributionFromRequest(headers, body);
			expect(result.project).toBeNull();
			expect(result.projectAttributionSource).toBe("none");
		});

		it("rejects a path segment where a control char fuses the real directory with leaked text (round-3 Greptile review on #378)", () => {
			// A naive strip-then-check validator deletes \n/\t before checking for
			// whitespace, silently fusing "repo" + "leaked-fragment" into the
			// clean-looking slug "repoleaked-fragment". The control char must be
			// detected in the RAW captured value before any stripping happens.
			const headers = new Headers();
			const body = {
				system: "/home/u/projects/repo\nleaked-fragment/more",
			};
			const result = extractProjectAttributionFromRequest(headers, body);
			expect(result.project).toBeNull();
			expect(result.projectAttributionSource).toBe("none");
		});

		// Regression (Greptile review on #378): isLowRiskProjectSlug's label-based
		// heuristics (credential/incident/hostname labels) are tuned for free-text
		// headings and headers, and false-positive on ordinary directory names.
		// The path-segment capture is structurally a single path component, so it
		// must use the narrower isLowRiskPathSegment validator instead.
		const legitDirNames: Array<[string, string]> = [
			["password-manager", "password-manager"],
			["customer-portal", "customer-portal"],
			["auth-token-service", "auth-token-service"],
			["account-billing", "account-billing"],
			["ui.v2", "ui.v2"],
		];
		for (const [label, dirName] of legitDirNames) {
			it(`still extracts legit workspace directory name: ${label}`, () => {
				const headers = new Headers();
				const body = {
					system: `/home/will/projects/${dirName}/file.ts`,
				};
				const result = extractProjectAttributionFromRequest(headers, body);
				expect(result.project).toBe(dirName);
				expect(result.projectAttributionSource).toBe("path_project");
			});
		}
	});

	it("uses the first eligible non-Claude H1 heading as the project when no header/path match", () => {
		const headers = new Headers();
		const body = { system: "# Harness\nWelcome to the project." };
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBe("Harness");
		expect(result.projectAttributionSource).toBe("heading_project");
	});

	it("rejects an H1 heading that starts with 'claude' (case-insensitive)", () => {
		const headers = new Headers();
		const body = { system: "# Claude Code Instructions\nSome content." };
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBeNull();
		expect(result.projectAttributionSource).toBe("none");
	});

	it("falls through a leading Claude heading to the next eligible H1 heading", () => {
		// Regression: extraction used to stop at the FIRST H1 heading rather
		// than the first ELIGIBLE one, losing valid attribution whenever a
		// Claude-prefixed heading appeared before the real project heading.
		const headers = new Headers();
		const body = {
			system: "# Claude Code Instructions\nSome content.\n# Harness\nMore.",
		};
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBe("Harness");
		expect(result.projectAttributionSource).toBe("heading_project");
	});

	it("returns none when there is no header, path, or heading", () => {
		const headers = new Headers();
		const body = { system: "Just a plain system prompt with no markers." };
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBeNull();
		expect(result.projectAttributionSource).toBe("none");
	});

	it("returns none for a completely empty request (no headers, no body)", () => {
		const headers = new Headers();
		const result = extractProjectAttributionFromRequest(headers, null);
		expect(result.project).toBeNull();
		expect(result.projectAttributionSource).toBe("none");
	});

	describe("secret-like headings are rejected (isLowRiskProjectSlug -> false)", () => {
		const cases: Array<[string, string]> = [
			["bearer-ish token", "# Authorization: Bearer sk_live_abc123456789"],
			["URL", "# https://example.com/secret-path"],
			["email address", "# Contact will@example.com for help"],
			["sk- style API key", "# sk-ABCDEFGHIJ1234567890"],
			["AKIA-style AWS key", "# AKIAIOSFODNN7EXAMPLE"],
			[
				"long random base64-ish token",
				"# aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q123456",
			],
			[
				"sentence/incident-shaped (>6 words)",
				"# This is a very long sentence about an incident that happened today",
			],
			[
				"24-char unbroken hex token (hardened LONG_TOKEN_RE)",
				"# a1b2c3d4e5f6a1b2c3d4e5f6",
			],
			["bare IPv4 address (hardened IPV4_RE)", "# 10.0.0.5"],
			[
				"20+ char unbroken alphanumeric session id (hardened LONG_TOKEN_RE)",
				"# sess1234567890qwerty",
			],
			[
				"multi-segment secret token (second separator defeats SECRET_TOKEN_RE)",
				"# sk_live_abc123456789",
			],
			[
				"short incident/customer label (dodges the six-word sentence heuristic)",
				"# Incident INC-123 Acme",
			],
		];

		for (const [label, system] of cases) {
			it(`rejects: ${label}`, () => {
				const headers = new Headers();
				const result = extractProjectAttributionFromRequest(headers, {
					system,
				});
				expect(result.project).toBeNull();
				expect(result.projectAttributionSource).toBe("none");
			});
		}
	});

	describe("round-2 P1 hardening: still-leaking heading shapes are rejected end-to-end (H1)", () => {
		const cases: Array<[string, string]> = [
			[
				"multi-segment credential label with a letters-only opaque tail",
				"# api-key-abcdefghijkl",
			],
			["16-char opaque hex/base32 token", "# deadbeefcafebabe"],
			["dotted hostname-shaped label", "# customer.example.com"],
			["round-1: sk_live-style secret", "# sk_live_abc123456789"],
			["round-1: incident/customer label", "# Incident INC-123 Acme"],
		];

		for (const [label, system] of cases) {
			it(`rejects: ${label}`, () => {
				const headers = new Headers();
				const result = extractProjectAttributionFromRequest(headers, {
					system,
				});
				expect(result.project).toBeNull();
				expect(result.projectAttributionSource).toBe("none");
			});
		}

		const legit: Array<[string, string, string]> = [
			["Harness", "# Harness\nWelcome.", "Harness"],
			[
				"attribution-source-tags",
				"# attribution-source-tags\nDetails.",
				"attribution-source-tags",
			],
			["My Cool Project", "# My Cool Project\nDetails.", "My Cool Project"],
		];

		for (const [label, system, expected] of legit) {
			it(`still extracts legit slug: ${label}`, () => {
				const headers = new Headers();
				const result = extractProjectAttributionFromRequest(headers, {
					system,
				});
				expect(result.project).toBe(expected);
				expect(result.projectAttributionSource).toBe("heading_project");
			});
		}
	});

	it("rejects an H1 heading whose secret sits past the 64-char truncation boundary end-to-end", () => {
		// Full end-to-end path (not just isLowRiskProjectSlug directly): a
		// heading that is unambiguously rejected (UUID + >6 words) must still
		// come back as no attribution, proving the full un-truncated heading
		// is what gets validated.
		const headers = new Headers();
		const body = {
			system:
				"# <a heading carrying a UUID like 550e8400-e29b-41d4-a716-446655440000>",
		};
		const result = extractProjectAttributionFromRequest(headers, body);
		expect(result.project).toBeNull();
		expect(result.projectAttributionSource).toBe("none");
	});
});

describe("isLowRiskProjectSlug", () => {
	it("accepts ordinary repo-name-shaped labels", () => {
		expect(isLowRiskProjectSlug("better-ccflare")).toBe(true);
		expect(isLowRiskProjectSlug("Harness")).toBe(true);
		expect(isLowRiskProjectSlug("eval-suite")).toBe(true);
		expect(isLowRiskProjectSlug("My Project")).toBe(true);
	});

	it("rejects URL-shaped, email-shaped, and secret-shaped values", () => {
		expect(isLowRiskProjectSlug("https://example.com")).toBe(false);
		expect(isLowRiskProjectSlug("www.example.com")).toBe(false);
		expect(isLowRiskProjectSlug("me@example.com")).toBe(false);
		expect(isLowRiskProjectSlug("Bearer sk_live_abc123456789")).toBe(false);
	});

	describe("hardened LONG_TOKEN_RE / IPV4_RE (unbroken 20+ alphanumeric run, bare IPv4)", () => {
		it("rejects a 24-char unbroken hex token", () => {
			expect(isLowRiskProjectSlug("a1b2c3d4e5f6a1b2c3d4e5f6")).toBe(false);
		});

		it("rejects a bare IPv4 address", () => {
			expect(isLowRiskProjectSlug("10.0.0.5")).toBe(false);
		});

		it("rejects a 20+ char unbroken alphanumeric session id", () => {
			expect(isLowRiskProjectSlug("sess1234567890qwerty")).toBe(false);
		});

		it("still accepts hyphen-broken slugs over 20 chars total (no over-rejection regression)", () => {
			// Total length > 20 chars, but every hyphen-delimited segment is well
			// under the 20-char unbroken-run threshold — must NOT be rejected.
			expect(isLowRiskProjectSlug("attribution-source-tags")).toBe(true);
			expect(isLowRiskProjectSlug("my-really-long-project-name")).toBe(true);
		});
	});

	describe("rejects multi-segment secret shapes and customer/incident labels (P1 privacy)", () => {
		it("rejects a multi-segment secret token where a second separator defeats SECRET_TOKEN_RE", () => {
			// "sk_live_" + a digit-bearing tail: each underscore-delimited segment
			// stays under LONG_TOKEN_RE's 20-char threshold, and the second
			// separator ("_live_") means the single-separator SECRET_TOKEN_RE
			// never matches either. Must still be rejected as a secret shape.
			expect(isLowRiskProjectSlug("sk_live_abc123456789")).toBe(false);
		});

		it("rejects other known secret-token prefixes with a second separator", () => {
			expect(isLowRiskProjectSlug("ghp_9f8e7d6c5b4a3210")).toBe(false);
			expect(isLowRiskProjectSlug("xoxb-1234-5678-abcdefgh")).toBe(false);
			expect(isLowRiskProjectSlug("api-key-9f8e7d6c5b4a")).toBe(false);
		});

		it("rejects a short incident/customer label that dodges the six-word sentence heuristic", () => {
			expect(isLowRiskProjectSlug("Incident INC-123 Acme")).toBe(false);
		});

		it("rejects other customer/ticket-shaped labels", () => {
			expect(isLowRiskProjectSlug("Ticket CASE-42")).toBe(false);
			expect(isLowRiskProjectSlug("Customer Acme Corp")).toBe(false);
			expect(isLowRiskProjectSlug("PROJ-4821")).toBe(false);
			expect(isLowRiskProjectSlug("acct-88213")).toBe(false);
		});

		it("does not over-reject ordinary hyphenated slugs with word-only tails", () => {
			expect(isLowRiskProjectSlug("attribution-source-tags")).toBe(true);
			expect(isLowRiskProjectSlug("my-really-long-project-name")).toBe(true);
			expect(isLowRiskProjectSlug("better-ccflare")).toBe(true);
		});
	});

	describe("rejects trace-id, URL, and path shapes (hardened heading validator)", () => {
		const rejectedCases: Array<[string, string]> = [
			["UUID / raw trace id", "550e8400-e29b-41d4-a716-446655440000"],
			["uppercase host (case-insensitive)", "WWW.EXAMPLE.COM"],
			["URI scheme", "file:/etc/passwd"],
			["Windows drive path", "C:/Users/alice/acme"],
			["traversal path", "../../etc/passwd"],
			["absolute path", "/etc/passwd"],
			[
				"host:port/path (slash+colon excluded from slug grammar)",
				"host:8080/path",
			],
		];

		for (const [label, value] of rejectedCases) {
			it(`rejects: ${label}`, () => {
				expect(isLowRiskProjectSlug(value)).toBe(false);
			});
		}

		it("still accepts ordinary slug-shaped labels (no over-rejection regression)", () => {
			expect(isLowRiskProjectSlug("better-ccflare")).toBe(true);
			expect(isLowRiskProjectSlug("Harness")).toBe(true);
			expect(isLowRiskProjectSlug("eval-suite")).toBe(true);
			expect(isLowRiskProjectSlug("My Project")).toBe(true);
			expect(isLowRiskProjectSlug("attribution-source-tags")).toBe(true);
			expect(isLowRiskProjectSlug("my-really-long-project-name")).toBe(true);
		});
	});

	describe("round-2 P1 hardening: dotted hostnames, opaque tokens, credential labels", () => {
		it("rejects dotted hostname-shaped labels", () => {
			expect(isLowRiskProjectSlug("customer.example.com")).toBe(false);
			expect(isLowRiskProjectSlug("*.example.com")).toBe(false);
			expect(isLowRiskProjectSlug("foo.bar")).toBe(false);
		});

		it("rejects a 16-char opaque hex/base32-shaped token below the 20-char LONG_TOKEN_RE floor", () => {
			expect(isLowRiskProjectSlug("deadbeefcafebabe")).toBe(false);
		});

		it("rejects a 16+ char opaque alnum token that mixes letters and digits", () => {
			expect(isLowRiskProjectSlug("aB3dE7gH9jK1mN5p")).toBe(false);
		});

		it("rejects a credential-labeled value with a letters-only opaque tail", () => {
			expect(isLowRiskProjectSlug("api-key-abcdefghijkl")).toBe(false);
			expect(isLowRiskProjectSlug("apikey-abcdefghijkl")).toBe(false);
			expect(isLowRiskProjectSlug("access-key-abcdefghijkl")).toBe(false);
			expect(isLowRiskProjectSlug("password-abcdefghijkl")).toBe(false);
		});

		it("does not over-reject legit slugs (no embedded dots, no 16+ char single segment)", () => {
			expect(isLowRiskProjectSlug("Harness")).toBe(true);
			expect(isLowRiskProjectSlug("attribution-source-tags")).toBe(true);
			expect(isLowRiskProjectSlug("My Cool Project")).toBe(true);
			expect(isLowRiskProjectSlug("better-ccflare")).toBe(true);
		});
	});

	describe("validates the FULL value, not a 64-char-truncated prefix (R10a)", () => {
		// Pre-boundary prefix: exactly 64 chars, slug-clean (dash-delimited
		// 15-char runs, so no unbroken alnum run reaches the 20-char
		// LONG_TOKEN_RE threshold) and ending in a dash so nothing can merge
		// across the boundary with whatever follows.
		const CLEAN_64_PREFIX = `${"x".repeat(15)}-`.repeat(4);

		it("sanity: the clean 64-char prefix alone is accepted", () => {
			expect(CLEAN_64_PREFIX.length).toBe(64);
			expect(isLowRiskProjectSlug(CLEAN_64_PREFIX)).toBe(true);
		});

		it("rejects wholesale once a 25-char high-entropy token sits entirely past char 64", () => {
			// A pre-truncation validator (64-char cap applied BEFORE validation,
			// the bug this hardening fixes) would have sliced this value down to
			// CLEAN_64_PREFIX and returned true, because the secret only exists
			// past the truncation boundary. The hardened validator sees the
			// full, untruncated value and rejects it — both via LONG_TOKEN_RE
			// matching the trailing run and via the slug grammar's length bound.
			const boundaryStraddlingSecret = `${CLEAN_64_PREFIX}${"Z".repeat(25)}`;
			expect(isLowRiskProjectSlug(boundaryStraddlingSecret)).toBe(false);
		});
	});
});

describe("isLowRiskPathSegment", () => {
	it("accepts ordinary directory names that isLowRiskProjectSlug's label heuristics would reject", () => {
		// These are all real, unremarkable workspace directory names that
		// CREDENTIAL_LABEL_RE / INCIDENT_LABEL_RE / DOTTED_HOSTNAME_LABEL_RE
		// false-positive on when applied to free text (Greptile review on #378).
		expect(isLowRiskPathSegment("password-manager")).toBe(true);
		expect(isLowRiskPathSegment("customer-portal")).toBe(true);
		expect(isLowRiskPathSegment("auth-token-service")).toBe(true);
		expect(isLowRiskPathSegment("account-billing")).toBe(true);
		expect(isLowRiskPathSegment("ui.v2")).toBe(true);
		expect(isLowRiskPathSegment("better-ccflare")).toBe(true);
		expect(isLowRiskPathSegment("MyProj")).toBe(true);
	});

	it("still rejects a runaway sentence-shaped capture (the #373 leak signature)", () => {
		expect(
			isLowRiskPathSegment(
				"better-ccflare # Some Leaked System Prompt Heading Text",
			),
		).toBe(false);
		expect(
			isLowRiskPathSegment("leaked system prompt fragment with many words"),
		).toBe(false);
	});

	it("rejects any whitespace, even a short run-on that dodges the sentence heuristic (round-2 Greptile review on #378)", () => {
		// A real directory name is never space-separated, so a short capture
		// like "repo short words" must be rejected outright rather than only
		// once it crosses a word-count threshold.
		expect(isLowRiskPathSegment("repo short words")).toBe(false);
		expect(isLowRiskPathSegment("two words")).toBe(false);
		expect(isLowRiskPathSegment("a b")).toBe(false);
	});

	it("rejects a control-char-fused value rather than silently deleting the separator (round-3 Greptile review on #378)", () => {
		// The raw value must be checked for control chars BEFORE they're
		// stripped, or "repo\nleaked" silently fuses into "repoleaked" and
		// passes the whitespace/shape checks.
		expect(isLowRiskPathSegment("repo\nleaked-fragment")).toBe(false);
		expect(isLowRiskPathSegment("repo\tleaked-fragment")).toBe(false);
		expect(isLowRiskPathSegment("repo\rleaked-fragment")).toBe(false);
	});

	it("still rejects secrets, keys, IPs, and opaque high-entropy tokens", () => {
		expect(isLowRiskPathSegment("Bearer sk_live_abc123456789")).toBe(false);
		expect(isLowRiskPathSegment("AKIAIOSFODNN7EXAMPLE")).toBe(false);
		expect(isLowRiskPathSegment("10.0.0.5")).toBe(false);
		expect(isLowRiskPathSegment("sess1234567890qwerty")).toBe(false);
		expect(isLowRiskPathSegment("deadbeefcafebabe")).toBe(false);
	});

	it("still rejects URL/URI-scheme and traversal shapes", () => {
		expect(isLowRiskPathSegment("https://example.com")).toBe(false);
		expect(isLowRiskPathSegment("www.example.com")).toBe(false);
		expect(isLowRiskPathSegment("..")).toBe(false);
	});

	it("rejects the FULL value rather than a 64-char-truncated prefix", () => {
		const cleanPrefix = `${"x".repeat(15)}-`.repeat(4);
		const boundaryStraddlingSecret = `${cleanPrefix}${"Z".repeat(25)}`;
		expect(isLowRiskPathSegment(boundaryStraddlingSecret)).toBe(false);
	});
});

describe("extractSystemPromptFromBase64", () => {
	it("tolerates a null element in a system array without throwing (parity with the parsed-body path)", () => {
		const requestBodyBase64 = Buffer.from(
			JSON.stringify({
				system: [
					null,
					{ type: "text", text: "context /home/u/projects/acme/x.ts" },
				],
			}),
		).toString("base64");

		let result: string | null = null;
		expect(() => {
			result = extractSystemPromptFromBase64(requestBodyBase64);
		}).not.toThrow();
		expect(result).toContain("/home/u/projects/acme/x.ts");
	});
});

describe("extractProjectAttributionFromParts (usage-collector base64 fallback)", () => {
	it("returns header_project from a lowercased Record<string,string> header map", () => {
		const result = extractProjectAttributionFromParts(
			{ "X-Better-Ccflare-Project": "MyProj" },
			null,
		);
		expect(result.project).toBe("MyProj");
		expect(result.projectAttributionSource).toBe("header_project");
	});

	it("returns path_project from a base64-encoded body, matching the parsed-body path", () => {
		const body = {
			system: "context at /home/will/repos/eval-suite/index.ts done",
		};
		const requestBodyBase64 = Buffer.from(JSON.stringify(body)).toString(
			"base64",
		);
		const result = extractProjectAttributionFromParts({}, requestBodyBase64);
		expect(result.project).toBe("eval-suite");
		expect(result.projectAttributionSource).toBe("path_project");
	});

	it("returns heading_project from a base64-encoded body, matching the parsed-body path", () => {
		const body = { system: "# eval-suite\nDetails here." };
		const requestBodyBase64 = Buffer.from(JSON.stringify(body)).toString(
			"base64",
		);
		const result = extractProjectAttributionFromParts({}, requestBodyBase64);
		expect(result.project).toBe("eval-suite");
		expect(result.projectAttributionSource).toBe("heading_project");
	});

	it("returns none when headers are null/undefined and body is null", () => {
		const result = extractProjectAttributionFromParts(null, null);
		expect(result.project).toBeNull();
		expect(result.projectAttributionSource).toBe("none");
	});

	it("resolves path_project from a base64 body whose system array contains a null element (parity with the parsed-body path)", () => {
		const requestBodyBase64 = Buffer.from(
			JSON.stringify({
				system: [
					null,
					{ type: "text", text: "context /home/u/projects/acme/x.ts" },
				],
			}),
		).toString("base64");

		const result = extractProjectAttributionFromParts({}, requestBodyBase64);
		expect(result.project).toBe("acme");
		expect(result.projectAttributionSource).toBe("path_project");
	});
});
