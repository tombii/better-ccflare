import { describe, expect, it } from "bun:test";

/**
 * The dashboard imports the `@better-ccflare/core` barrel, which re-exports
 * force-account-model, so this module ships inside the browser bundle. Bun's
 * browser target has no `node:async_hooks`: it rewrites the import into a
 * destructure from an empty stub, leaving `AsyncLocalStorage` undefined. Any
 * module-scope `new AsyncLocalStorage()` then throws "is not a constructor"
 * while the chunk is still initialising, and because that chunk carries the
 * dashboard's React bootstrap, the entire UI fails to mount.
 *
 * Bundling the module the same way the dashboard does and running it is the
 * only faithful reproduction — `mock.module("node:async_hooks", () => ({}))`
 * cannot stand in for it, because a named ESM import of a missing export fails
 * to link instead of yielding undefined.
 */
const ENTRY = new URL("./force-account-model.ts", import.meta.url).pathname;

async function bundleForBrowser(): Promise<string> {
	const built = await Bun.build({
		entrypoints: [ENTRY],
		target: "browser",
		format: "iife",
	});
	if (!built.success) {
		throw new AggregateError(built.logs, "browser bundle failed");
	}
	return await built.outputs[0].text();
}

describe("force-account-model in a browser bundle", () => {
	it("evaluates with node:async_hooks stubbed out", async () => {
		const code = await bundleForBrowser();
		expect(() => {
			new Function(code)();
		}).not.toThrow();
	});
});
