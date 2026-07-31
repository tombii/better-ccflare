/**
 * Keeps the requests handler clear of the documented `types↔core` runtime
 * cycle.
 *
 * `packages/types/src/agent.ts` imports core at runtime, while
 * `packages/core/src/strategy.ts` imports types and evaluates
 * `Object.values(StrategyName)` at module scope. Evaluating the types barrel
 * FIRST therefore throws — `query-filters.test.ts` documents the same thing and
 * works around it with a side-effect import.
 *
 * The handler needs runtime (not type-only) imports for the column-narrowing
 * helpers and takes them from the cycle-free `@better-ccflare/types/request`
 * subpath.
 *
 * Why the first test is a SOURCE check and not just a cold import: measured,
 * the handler loads fine with the barrel import too, because `jsonResponse`
 * from `@better-ccflare/http-common` sits one line above and pulls core in
 * first. A cold import alone therefore passes either way and would guard
 * nothing — it only proves the module loads today, by accident of import
 * ORDER. Asserting the import specifier is what actually catches a revert; the
 * cold import is kept as the outcome check for the case where that accidental
 * protection disappears.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const HANDLER_SOURCE = join(import.meta.dir, "..", "requests.ts");
const COLD_IMPORT_TIMEOUT_MS = 30_000;

async function coldImport(specifier: string): Promise<{
	exitCode: number | null;
	stderr: string;
	timedOut: boolean;
}> {
	const proc = Bun.spawn(
		["bun", "-e", `await import(${JSON.stringify(specifier)});`],
		{ cwd: REPO_ROOT, stdout: "ignore", stderr: "pipe" },
	);
	const timer = setTimeout(() => proc.kill(), COLD_IMPORT_TIMEOUT_MS);
	try {
		const [exitCode, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stderr, timedOut: proc.killed && exitCode !== 0 };
	} finally {
		clearTimeout(timer);
	}
}

describe("requests handler — cycle-free imports", () => {
	it("takes the narrowing helpers from the subpath, never the package barrel", async () => {
		const source = await Bun.file(HANDLER_SOURCE).text();

		expect(source).toContain('from "@better-ccflare/types/request"');
		// A bare `from "@better-ccflare/types"` (barrel) would reintroduce the
		// dependency on some earlier import happening to load core first.
		expect(source).not.toMatch(/from ["']@better-ccflare\/types["']/);
	});

	it("loads as the first module in a fresh process", async () => {
		const { exitCode, stderr, timedOut } = await coldImport(
			"./packages/http-api/src/handlers/requests.ts",
		);

		expect(timedOut).toBe(false);
		expect(stderr).not.toContain("StrategyName");
		expect(exitCode).toBe(0);
	});

	it("resolves the subpath without evaluating the types barrel", async () => {
		const { exitCode, stderr, timedOut } = await coldImport(
			"@better-ccflare/types/request",
		);

		expect(timedOut).toBe(false);
		expect(stderr).not.toContain("StrategyName");
		expect(exitCode).toBe(0);
	});
});
