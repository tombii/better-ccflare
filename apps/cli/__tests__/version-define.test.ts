import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUILD_SUFFIX_ERROR_MESSAGE,
	BUILD_SUFFIX_PATTERN,
	buildVersionDefine,
	buildVersionString,
} from "../version-define";

// The script prints the *whole* `--define` argv token so that neither bash nor
// Bun's built-in shell (used for package.json scripts on Windows) has to
// preserve quotes across a command substitution. The token is meant to be
// interpolated unquoted: `bun build ... $(bun run version-define.ts)`.
const DEFINE_PREFIX = "--define=__BETTER_CCFLARE_VERSION__=";

function expectDefine(actual: string, version: string) {
	expect(actual).toBe(`${DEFINE_PREFIX}"${version}"`);
	// The part after `=` must itself be the JSON-quoted define value.
	expect(JSON.parse(actual.slice(DEFINE_PREFIX.length))).toBe(version);
}

const SCRIPT_PATH = join(import.meta.dir, "..", "version-define.ts");
const APP_DIR = join(import.meta.dir, "..");
// Run from the repo root (two levels up from apps/cli) to prove the script
// resolves package.json relative to itself, not to process.cwd().
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

// Read, never hardcode: the release workflow bumps apps/cli/package.json on
// every release, and a pinned version here would fail the next one.
async function readAppVersion(): Promise<string> {
	const pkg = (await Bun.file(join(APP_DIR, "package.json")).json()) as {
		version: string;
	};
	return pkg.version;
}

async function runScript(args: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawn(["bun", "run", SCRIPT_PATH, ...args], {
		cwd: REPO_ROOT,
		env: { ...process.env, CCFLARE_BUILD_SUFFIX: "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("buildVersionString", () => {
	it("returns the bare version when no suffix is set", () => {
		expect(buildVersionString(undefined, "3.6.4")).toBe("3.6.4");
	});

	it("treats an empty string suffix as no suffix", () => {
		expect(buildVersionString("", "3.6.4")).toBe("3.6.4");
	});

	it("appends a valid suffix with a plus", () => {
		expect(buildVersionString("foo", "3.6.4")).toBe("3.6.4+foo");
		expect(buildVersionString("1.2.3-beta_rc", "3.6.4")).toBe(
			"3.6.4+1.2.3-beta_rc",
		);
		expect(buildVersionString("a.b-c_1", "3.6.4")).toBe("3.6.4+a.b-c_1");
	});

	it("rejects suffixes with characters outside the allow-list", () => {
		for (const suffix of [
			"has space",
			"a/b",
			"a;b",
			"a+b",
			"$(rm -rf /)",
			"a`b`",
			'a"b',
			"a'b",
			"a\nb",
		]) {
			expect(() => buildVersionString(suffix, "3.6.4")).toThrow(
				BUILD_SUFFIX_ERROR_MESSAGE,
			);
		}
	});
});

describe("buildVersionDefine", () => {
	it("emits the whole --define token with a JSON-quoted value", () => {
		expectDefine(buildVersionDefine({}, "3.6.4"), "3.6.4");
		expectDefine(
			buildVersionDefine({ CCFLARE_BUILD_SUFFIX: "foo" }, "3.6.4"),
			"3.6.4+foo",
		);
	});

	it("treats an empty env suffix as no suffix", () => {
		expectDefine(
			buildVersionDefine({ CCFLARE_BUILD_SUFFIX: "" }, "3.6.4"),
			"3.6.4",
		);
	});

	it("rejects an invalid env suffix", () => {
		expect(() =>
			buildVersionDefine({ CCFLARE_BUILD_SUFFIX: "a b" }, "3.6.4"),
		).toThrow(BUILD_SUFFIX_ERROR_MESSAGE);
	});
});

describe("BUILD_SUFFIX_PATTERN", () => {
	it("matches the previous shell validation", () => {
		for (const ok of ["foo", "1.2.3-beta_rc", "a.b-c_1", "A9"]) {
			expect(BUILD_SUFFIX_PATTERN.test(ok)).toBe(true);
		}
		for (const bad of ["a b", "a/b", "a;b", "a+b", "$(x)", "a\nb"]) {
			expect(BUILD_SUFFIX_PATTERN.test(bad)).toBe(false);
		}
	});

	it("is not anchored with the global flag (no lastIndex state)", () => {
		expect(BUILD_SUFFIX_PATTERN.global).toBe(false);
	});
});

describe("version-define.ts CLI entry", () => {
	it("prints the define token for the package version, from any cwd", async () => {
		const { stdout, stderr, exitCode } = await runScript([]);
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toBe(`${DEFINE_PREFIX}"${await readAppVersion()}"\n`);
	});

	it("appends an env suffix", async () => {
		const { stdout, exitCode } = await runScript([], {
			CCFLARE_BUILD_SUFFIX: "abc",
		});
		expect(exitCode).toBe(0);
		expect(stdout).toBe(`${DEFINE_PREFIX}"${await readAppVersion()}+abc"\n`);
	});

	it("--check prints nothing and exits 0 for a valid or absent suffix", async () => {
		for (const env of [
			{},
			{ CCFLARE_BUILD_SUFFIX: "" },
			{ CCFLARE_BUILD_SUFFIX: "ok_1.2" },
		]) {
			const { stdout, stderr, exitCode } = await runScript(["--check"], env);
			expect(exitCode).toBe(0);
			expect(stdout).toBe("");
			expect(stderr).toBe("");
		}
	});

	it("--check exits 1 with the message and nothing on stdout for a bad suffix", async () => {
		const { stdout, stderr, exitCode } = await runScript(["--check"], {
			CCFLARE_BUILD_SUFFIX: "a b",
		});
		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr.trim()).toBe(BUILD_SUFFIX_ERROR_MESSAGE);
	});

	it("exits 1 with the message for a bad suffix when printing", async () => {
		const { stdout, stderr, exitCode } = await runScript([], {
			CCFLARE_BUILD_SUFFIX: "a;b",
		});
		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr.trim()).toBe(BUILD_SUFFIX_ERROR_MESSAGE);
	});

	it("reads its own package.json, not ./package.json in the cwd", async () => {
		// Run the real script from a directory whose ./package.json has a
		// different version: the output must still be apps/cli's version.
		const appVersion = await readAppVersion();
		const decoyDir = mkdtempSync(join(tmpdir(), "version-define-decoy-"));
		try {
			writeFileSync(
				join(decoyDir, "package.json"),
				JSON.stringify({ name: "decoy", version: "0.0.1-decoy" }),
			);
			const proc = Bun.spawn(["bun", "run", SCRIPT_PATH], {
				cwd: decoyDir,
				env: { ...process.env, CCFLARE_BUILD_SUFFIX: "" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(proc.stdout).text();
			expect(await proc.exited).toBe(0);
			expect(stdout).toBe(`${DEFINE_PREFIX}"${appVersion}"\n`);
			expect(stdout).not.toContain("decoy");
		} finally {
			rmSync(decoyDir, { recursive: true, force: true });
		}
	});
});
