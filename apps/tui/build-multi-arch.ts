#!/usr/bin/env bun
import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

interface Platform {
	target: string;
	outfile: string;
	description: string;
}

const platforms: Platform[] = [
	{
		target: "bun-linux-x64",
		outfile: "better-ccflare-linux-x64",
		description: "Linux x86_64",
	},
	{
		target: "bun-linux-arm64",
		outfile: "better-ccflare-linux-arm64",
		description: "Linux ARM64",
	},
	{
		target: "bun-darwin-x64",
		outfile: "better-ccflare-macos-x64",
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

	// Build worker
	execSync(
		`BETTER_CCFLARE_VERSION=${version} bun build ../../packages/proxy/src/post-processor.worker.ts --outfile dist/post-processor.worker.js --target=bun --minify`,
		{ stdio: "inherit" },
	);

	// Encode worker
	const workerCode = await Bun.file("dist/post-processor.worker.js").text();
	const encoded = Buffer.from(workerCode).toString("base64");

	// Write inline worker
	writeFileSync(
		"../../packages/proxy/src/inline-worker.ts",
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
		`--define process.env.BETTER_CCFLARE_VERSION='"${version}"'`,
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
