/**
 * Namespace-based entry point for `../chain` used only by `chain.test.ts`.
 *
 * Bun's `mock.module` is process-global and rewrites the module registry, and
 * live bindings of an ES-module namespace observed before a rewrite are
 * erased. A static named import of `runWebSearchChain` then resolves to
 * nothing when another test file in the same process has mocked `../chain`
 * (which happens transiently even if that mock is later reverted). A property
 * lookup on the namespace is re-resolved at call time, so this file — which
 * never imports `../intercept` — always gets the real implementation.
 */

export async function runWebSearchChainFromModule(
	...args: Parameters<typeof import("../chain").runWebSearchChain>
): Promise<ReturnType<typeof import("../chain").runWebSearchChain>> {
	const chain = await import("../chain");
	return chain.runWebSearchChain(...args);
}
