/**
 * Attempt to open a URL in the default browser (best-effort, cross-platform)
 */
export async function openBrowser(url: string): Promise<boolean> {
	try {
		const platform = process.platform;
		if (platform === "darwin") {
			await Bun.spawn(["open", url]);
		} else if (platform === "win32") {
			await Bun.spawn(["cmd", "/c", "start", "", url]);
		} else if (platform === "linux") {
			await Bun.spawn(["xdg-open", url]);
		} else {
			return false; // Unsupported platform
		}
		return true;
	} catch {
		return false;
	}
}
