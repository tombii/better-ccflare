import { afterEach, beforeEach } from "bun:test";

/** Restore only the environment entries a suite changes, including absence. */
export function preserveTestEnv(names: string[]): void {
	let saved: Array<[string, string | undefined]> = [];
	beforeEach(() => {
		saved = names.map((name) => [name, process.env[name]]);
	});
	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
}
