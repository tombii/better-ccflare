import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsPg = readFileSync(join(here, "migrations-pg.ts"), "utf8");

describe("PostgreSQL migration shape", () => {
	it("defines request_payloads.compressed in ensureSchemaPg and runMigrationsPg", () => {
		expect(migrationsPg).toContain("compressed INTEGER NOT NULL DEFAULT 0");
		expect(migrationsPg).toContain('column: "compressed"');
		expect(migrationsPg).toContain("request_payloads");
	});
});
