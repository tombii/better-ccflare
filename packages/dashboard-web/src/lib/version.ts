// Read version directly from package.json at build time
import packageJson from "../../../../apps/tui/package.json";

export function getVersion(): string {
	const version = packageJson.version;
	return version.startsWith("v") ? version : `v${version}`;
}

export const version = getVersion();
