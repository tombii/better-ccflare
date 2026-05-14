/** Copy `text` to the clipboard, with a fallback for non-secure contexts. */
export async function copyText(text: string): Promise<void> {
	if (
		typeof navigator !== "undefined" &&
		navigator.clipboard &&
		window.isSecureContext
	) {
		await navigator.clipboard.writeText(text);
		return;
	}

	// Fallback for plain HTTP on non-localhost hosts, where navigator.clipboard is undefined.
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.top = "0";
	textarea.style.left = "-9999px";
	document.body.appendChild(textarea);
	try {
		textarea.select();
		if (!document.execCommand("copy")) {
			throw new Error("execCommand copy failed");
		}
	} finally {
		document.body.removeChild(textarea);
	}
}
