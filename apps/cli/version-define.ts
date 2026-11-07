#!/usr/bin/env bun
/**
 * Computes the `--define __BETTER_CCFLARE_VERSION__=...` argument for the CLI
 * build, without any shell logic.
 *
 * The `build` and `build:*` scripts in package.json used `case ... esac` and
 * `[ -n "$VAR" ]`, which Bun's built-in shell (used for package.json scripts
 * on Windows) cannot run correctly — see issue #544.
 *
 * Usage, from apps/cli/package.json:
 *
 *   bun run version-define.ts --check   # validate only, prints nothing
 *   bun build ... $(bun run version-define.ts)
 *
 * The script prints the *whole* `--define=__BETTER_CCFLARE_VERSION__="3.6.4"`
 * argv token, and the calling script interpolates it unquoted. That means no
 * quoting has to survive a command substitution: whatever the script prints
 * is word-split into exactly one argument. The printed value is JSON-quoted
 * because `--define` needs a string literal (`3.6.4` alone is not valid JS).
 *
 * Note: this file is inlined into the compiled binary like any other source
 * file, so it must stay side-effect free when imported.
 */
import { join } from "node:path";

const DEFINE_KEY = "__BETTER_CCFLARE_VERSION__";

/** Suffix characters allowed after the version, e.g. `3.6.4+abc.1`. */
export const BUILD_SUFFIX_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const BUILD_SUFFIX_ERROR_MESSAGE =
	"CCFLARE_BUILD_SUFFIX must only contain alphanumeric characters, dots, underscores, and hyphens";

/**
 * Returns `version`, or `version+suffix` when a non-empty suffix is set.
 * Throws when the suffix contains characters outside `BUILD_SUFFIX_PATTERN`.
 */
export function buildVersionString(
	suffix: string | undefined,
	version: string,
): string {
	if (!suffix) {
		return version;
	}
	if (!BUILD_SUFFIX_PATTERN.test(suffix)) {
		throw new Error(BUILD_SUFFIX_ERROR_MESSAGE);
	}
	return `${version}+${suffix}`;
}

/**
 * Returns the complete `--define=<key>="<version>"` argv token.
 * Throws when `CCFLARE_BUILD_SUFFIX` is invalid.
 */
export function buildVersionDefine(
	env: Record<string, string | undefined>,
	version: string,
): string {
	const versionString = buildVersionString(env.CCFLARE_BUILD_SUFFIX, version);
	return `--define=${DEFINE_KEY}=${JSON.stringify(versionString)}`;
}

/** Reads the version from apps/cli/package.json, relative to this file. */
export async function readPackageVersion(): Promise<string> {
	const pkg = (await Bun.file(
		join(import.meta.dir, "package.json"),
	).json()) as {
		version: string;
	};
	return pkg.version;
}

async function main(argv: string[]): Promise<number> {
	const checkOnly = argv.includes("--check");
	try {
		const define = buildVersionDefine(process.env, await readPackageVersion());
		if (!checkOnly) {
			console.log(define);
		}
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
