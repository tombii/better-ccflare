/**
 * Regression tests for convertPlaceholders, the SQLite->PostgreSQL binder.
 *
 * Production incident this guards (PR #554 review): a prose apostrophe inside
 * a `--` comment — "excluded by the getSessionStats' window" — toggled the
 * converter's string-literal tracking, so every later `?` in UPDATE
 * incrementUsage stayed a `?`. PostgreSQL rejects positional `?`, which took
 * account usage and session counts down until the comment was reworded.
 *
 * The mirror case matters too: a `?` inside a comment must not consume a
 * parameter number, or every real placeholder after it shifts by one.
 */
import { describe, expect, it } from "bun:test";
import { convertPlaceholders } from "../bun-sql-adapter";

describe("convertPlaceholders", () => {
	it("converts sequential placeholders", () => {
		expect(convertPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
			"SELECT * FROM t WHERE a = $1 AND b = $2",
		);
	});

	it("converts positional placeholders", () => {
		expect(convertPlaceholders("SELECT * FROM t WHERE a = ?2 AND b = ?1")).toBe(
			"SELECT * FROM t WHERE a = $2 AND b = $1",
		);
	});

	it("leaves a ? inside a string literal alone", () => {
		expect(convertPlaceholders("SELECT '?' AS q, ? AS p")).toBe(
			"SELECT '?' AS q, $1 AS p",
		);
	});

	it("does not let an apostrophe in a line comment break later placeholders", () => {
		// The exact shape that broke incrementUsage on PostgreSQL.
		const sql = `UPDATE accounts
			SET session_start = CASE WHEN session_start IS NULL OR ? - ? >= ? THEN ? ELSE session_start END,
				-- excluded by the getSessionStats' window
				session_request_count = CASE WHEN ? >= ? THEN ? ELSE session_request_count END
			WHERE id = ?`;
		expect(convertPlaceholders(sql)).toBe(`UPDATE accounts
			SET session_start = CASE WHEN session_start IS NULL OR $1 - $2 >= $3 THEN $4 ELSE session_start END,
				-- excluded by the getSessionStats' window
				session_request_count = CASE WHEN $5 >= $6 THEN $7 ELSE session_request_count END
			WHERE id = $8`);
	});

	it("does not consume a parameter number for a ? inside a line comment", () => {
		expect(convertPlaceholders("SELECT ? -- what about ? and ?\n, ?")).toBe(
			"SELECT $1 -- what about ? and ?\n, $2",
		);
	});

	it("leaves block comments untouched, including apostrophes and placeholders", () => {
		expect(
			convertPlaceholders("SELECT ? /* caller's ? placeholder */ , ?"),
		).toBe("SELECT $1 /* caller's ? placeholder */ , $2");
	});

	it("handles nested block comments", () => {
		expect(
			convertPlaceholders("SELECT ? /* outer /* inner' ? */ still ? */ , ?"),
		).toBe("SELECT $1 /* outer /* inner' ? */ still ? */ , $2");
	});

	it("treats doubled quotes as an escaped quote, not two delimiters", () => {
		// `''` must not expose the `?` between them as a real placeholder.
		expect(convertPlaceholders("SELECT 'it''s ?' , ?")).toBe(
			"SELECT 'it''s ?' , $1",
		);
	});
});
