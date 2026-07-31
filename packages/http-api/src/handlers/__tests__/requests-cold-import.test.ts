/**
 * Guards the requests handler against the documented `types↔core` runtime
 * cycle.
 *
 * `packages/types/src/agent.ts` imports core at runtime, while
 * `packages/core/src/strategy.ts` imports types and evaluates
 * `Object.values(StrategyName)` at module scope. Evaluating the types barrel
 * FIRST therefore throws. In the normal server the router pulls core and
 * database in earlier, which hides the problem — so the handler's own imports
 * have to stay cycle-safe on their own.
 *
 * The handler needs runtime (not type-only) imports for the column-narrowing
 * helpers, and takes them from the cycle-free `@better-ccflare/types/request`
 * subpath.
 *
 * Scope of what these tests actually prove, measured rather than assumed: the
 * first case passes with the barrel import too, because `jsonResponse` from
 * `@better-ccflare/http-common` is imported one line earlier and pulls core in
 * first. So the handler is currently safe by accident of import ORDER, not by
 * design — the subpath is what makes it safe regardless of which import sits
 * above it. These tests pin the outcome (the module loads cold), not the
 * mechanism; they would catch a regression where that accidental protection
 * disappears.
 *
 * Each import runs in its own process because module evaluation is cached per
 * process — an in-process check would pass simply because some earlier test
 * already loaded core.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");

async function coldImport(
	specifier: string,
): Promise<{ exitCode: number; stderr: string }> {
	const proc = Bun.spawn(
		["bun", "-e", `await import(${JSON.stringify(specifier)});`],
		{ cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stderr };
}

describe("requests handler — cold import", () => {
	it("loads as the first module in a fresh process", async () => {
		const { exitCode, stderr } = await coldImport(
			"./packages/http-api/src/handlers/requests.ts",
		);
		expect(stderr).not.toContain("StrategyName");
		expect(exitCode).toBe(0);
	});

	it("resolves the narrowing helpers without evaluating the types barrel", async () => {
		const { exitCode, stderr } = await coldImport(
			"@better-ccflare/types/request",
		);
		expect(stderr).not.toContain("StrategyName");
		expect(exitCode).toBe(0);
	});
});
