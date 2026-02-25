#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Platform {
	target: string;
	outfile: string;
	description: string;
}

// Get project root directory (two levels up from this script)
const projectRoot = join(import.meta.dir, "../..");

const platforms: Platform[] = [
	{
		target: "bun-linux-amd64",
		outfile: "better-ccflare-linux-amd64",
		description: "Linux x86_64",
	},
	{
		target: "bun-linux-arm64",
		outfile: "better-ccflare-linux-arm64",
		description: "Linux ARM64",
	},
	{
		target: "bun-darwin-x64",
		outfile: "better-ccflare-macos-x86_64",
		description: "macOS Intel",
	},
	{
		target: "bun-darwin-arm64",
		outfile: "better-ccflare-macos-arm64",
		description: "macOS Apple Silicon",
	},
	{
		target: "bun-windows-x64",
		outfile: "better-ccflare-windows-x64.exe",
		description: "Windows x86_64",
	},
];

async function buildWorker() {
	console.log("🔨 Building worker...");

	// Get version from package.json
	const packageJson = await Bun.file("./package.json").json();
	const version = packageJson.version;

	// Encode tiktoken WASM FIRST (before building worker, since worker imports it)
	// Try multiple possible locations for the WASM file
	const possiblePaths = [
		join(projectRoot, "node_modules/@dqbd/tiktoken/lite/tiktoken_bg.wasm"),
		join(
			projectRoot,
			"packages/proxy/node_modules/@dqbd/tiktoken/lite/tiktoken_bg.wasm",
		),
	];

	let wasmPath: string | null = null;
	for (const path of possiblePaths) {
		const file = await Bun.file(path);
		if (await file.exists()) {
			wasmPath = path;
			console.log(`✓ Found tiktoken WASM at: ${path}`);
			break;
		}
	}

	if (!wasmPath) {
		console.error(`❌ tiktoken WASM file not found in any of these locations:`);
		for (const path of possiblePaths) {
			console.error(`  - ${path}`);
		}
		console.error("This likely means dependencies weren't installed properly.");
		console.error("Try running: bun install");
		throw new Error("Missing tiktoken WASM file");
	}

	const wasmFile = await Bun.file(wasmPath);

	const wasmBuffer = await wasmFile.arrayBuffer();
	const wasmEncoded = Buffer.from(wasmBuffer).toString("base64");

	// Write embedded WASM
	const embeddedWasmPath = join(
		projectRoot,
		"packages/proxy/src/embedded-tiktoken-wasm.ts",
	);
	writeFileSync(
		embeddedWasmPath,
		`export const EMBEDDED_TIKTOKEN_WASM = "${wasmEncoded}";`,
	);

	// Build worker (now that embedded-tiktoken-wasm.ts exists)
	execSync(
		`BETTER_CCFLARE_VERSION=${version} bun build ../../packages/proxy/src/post-processor.worker.ts --outfile dist/post-processor.worker.js --target=bun --minify`,
		{ stdio: "inherit" },
	);

	// Encode worker
	const workerCode = await Bun.file("dist/post-processor.worker.js").text();
	const encoded = Buffer.from(workerCode).toString("base64");

	// Write inline worker
	const inlineWorkerPath = join(
		projectRoot,
		"packages/proxy/src/inline-worker.ts",
	);
	writeFileSync(
		inlineWorkerPath,
		`export const EMBEDDED_WORKER_CODE = "${encoded}";`,
	);

	console.log("✅ Worker built and encoded\n");
}

async function buildPlatform(platform: Platform) {
	console.log(`🏗️  Building for ${platform.description}...`);

	// Get version from package.json
	const packageJson = await Bun.file("./package.json").json();
	const version = packageJson.version;

	const buildCmd = [
		"bun build src/main.ts",
		"--compile",
		`--outfile dist/${platform.outfile}`,
		`--target=${platform.target}`,
		"--minify",
		`--define __BETTER_CCFLARE_VERSION__='"${version}"'`,
	].join(" ");

	try {
		execSync(buildCmd, { stdio: "inherit" });
		console.log(`✅ ${platform.description} build complete\n`);
	} catch (error) {
		console.error(`❌ Failed to build for ${platform.description}`);
		throw error;
	}
}

async function main() {
	console.log("🚀 Starting multi-architecture build...\n");

	// Create dist directory
	mkdirSync("dist", { recursive: true });

	// Build worker first
	await buildWorker();

	// Build for all platforms
	for (const platform of platforms) {
		await buildPlatform(platform);
	}

	// Clean up temporary worker file
	execSync("rm -f dist/post-processor.worker.js");

	console.log("🎉 All builds completed successfully!");
	console.log("\n📦 Built binaries:");
	for (const platform of platforms) {
		console.log(`   - dist/${platform.outfile} (${platform.description})`);
	}
}

main().catch((error) => {
	console.error("Build failed:", error);
	process.exit(1);
});
