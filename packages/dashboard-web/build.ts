#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import plugin from "bun-plugin-tailwind";

console.log("\n🚀 Building dashboard...\n");

const outdir = path.join(process.cwd(), "dist");

if (existsSync(outdir)) {
	console.log(`🗑️ Cleaning previous build at ${outdir}`);
	await rm(outdir, { recursive: true, force: true });
}

const start = performance.now();

const entrypoints = ["src/index.html"];
console.log(`📄 Building dashboard from ${entrypoints[0]}\n`);

// Read the CLI's version from package.json so the dashboard bundle reports the same
// version string as the server/CLI. Honors CCFLARE_BUILD_SUFFIX: when set, the
// suffix is appended (e.g. "3.5.44+zp2"); unset -> byte-identical to today's "3.5.44".
const cliPackageJson = await Bun.file(
	new URL("../../apps/cli/package.json", import.meta.url),
).json();
const buildSuffix = process.env.CCFLARE_BUILD_SUFFIX;
const bundleVersion = buildSuffix
	? `${cliPackageJson.version}+${buildSuffix}`
	: cliPackageJson.version;

const result = await Bun.build({
	entrypoints,
	outdir,
	plugins: [plugin],
	minify: true,
	target: "browser",
	sourcemap: "linked",
	splitting: true,
	define: {
		"process.env.NODE_ENV": JSON.stringify("production"),
		__BETTER_CCFLARE_VERSION__: JSON.stringify(bundleVersion),
	},
});

// Generate manifest.json with asset mappings
const manifest: Record<string, string> = {};
for (const output of result.outputs) {
	const relativePath = path.relative(outdir, output.path);
	const publicPath = `/${relativePath}`;
	manifest[publicPath] = publicPath;
}

await writeFile(
	path.join(outdir, "manifest.json"),
	JSON.stringify(manifest, null, 2),
);

const end = performance.now();
const buildTime = (end - start).toFixed(2);

console.log(`✅ Dashboard build completed in ${buildTime}ms\n`);
console.log(`📦 Output files:`);
result.outputs.forEach((output) => {
	console.log(`   - ${path.relative(process.cwd(), output.path)}`);
});

// Generate embedded assets TypeScript file
console.log(`\n📦 Generating embedded assets...`);
const { embedAssets } = await import("./embed.ts");
const embeddedCode = await embedAssets();
await writeFile(path.join(process.cwd(), "dist", "embedded.ts"), embeddedCode);
console.log(`✅ Embedded assets generated at dist/embedded.ts`);
