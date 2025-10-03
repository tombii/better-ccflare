#!/usr/bin/env bun
/**
 * Generates TypeScript code that embeds dashboard assets as base64 strings
 * This allows the assets to be bundled directly into the compiled binary
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const distDir = join(import.meta.dir, "dist");

interface AssetData {
	content: string; // base64 encoded
	contentType: string;
}

const assets: Record<string, AssetData> = {};

async function embedAssets() {
	const files = await readdir(distDir);

	for (const file of files) {
		if (file === "manifest.json") continue;

		const filePath = join(distDir, file);
		const content = await readFile(filePath);
		const base64 = content.toString("base64");

		let contentType = "text/plain";
		if (file.endsWith(".js")) contentType = "application/javascript";
		else if (file.endsWith(".css")) contentType = "text/css";
		else if (file.endsWith(".html")) contentType = "text/html";
		else if (file.endsWith(".json")) contentType = "application/json";
		else if (file.endsWith(".svg")) contentType = "image/svg+xml";
		else if (file.endsWith(".map")) contentType = "application/json";

		assets[`/${file}`] = {
			content: base64,
			contentType,
		};
	}

	// Generate TypeScript module
	const tsCode = `// Auto-generated - do not edit
// Generated from dashboard build artifacts

export interface EmbeddedAsset {
	content: string; // base64 encoded
	contentType: string;
}

export const embeddedDashboard: Record<string, EmbeddedAsset> = ${JSON.stringify(assets, null, 2)};

export const dashboardManifest = ${JSON.stringify(
		Object.keys(assets).reduce(
			(acc, key) => {
				acc[key] = key;
				return acc;
			},
			{} as Record<string, string>,
		),
		null,
		2,
	)};
`;

	return tsCode;
}

// Run if executed directly
if (import.meta.main) {
	const code = await embedAssets();
	console.log(code);
}

export { embedAssets };
