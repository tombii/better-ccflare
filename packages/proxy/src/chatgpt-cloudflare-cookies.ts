const ALLOWED_EXACT_HOSTS = new Set([
	"chatgpt.com",
	"chat.openai.com",
	"chatgpt-staging.com",
]);
const ALLOWED_SUFFIXES = [".chatgpt.com", ".chatgpt-staging.com"];

export function isAllowedChatGptHost(host: string): boolean {
	return (
		ALLOWED_EXACT_HOSTS.has(host) ||
		ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix))
	);
}

// WARNING: never add ChatGPT account/session/auth cookie names to this allowlist.
const ALLOWED_COOKIE_NAMES = new Set([
	"__cf_bm",
	"__cflb",
	"__cfruid",
	"__cfseq",
	"__cfwaitingroom",
	"_cfuvid",
	"cf_clearance",
	"cf_ob_info",
	"cf_use_ob",
]);

function isAllowedCloudflareCookieName(name: string): boolean {
	return ALLOWED_COOKIE_NAMES.has(name) || name.startsWith("cf_chl_");
}

function parseCookieNameValue(
	cookiePair: string,
): { name: string; value: string } | null {
	const separatorIndex = cookiePair.indexOf("=");
	if (separatorIndex === -1) return null;
	const name = cookiePair.slice(0, separatorIndex).trim();
	if (name.length === 0) return null;
	const value = cookiePair.slice(separatorIndex + 1).trim();
	return { name, value };
}

function parseSetCookieNameValue(
	setCookie: string,
): { name: string; value: string } | null {
	const attributeIndex = setCookie.indexOf(";");
	const pair =
		attributeIndex === -1 ? setCookie : setCookie.slice(0, attributeIndex);
	return parseCookieNameValue(pair);
}

function isAllowedChatGptCookieUrl(url: URL): boolean {
	return url.protocol === "https:" && isAllowedChatGptHost(url.hostname);
}

export class ChatGptCloudflareCookieJar {
	private readonly cookiesByHost = new Map<string, Map<string, string>>();

	captureFromResponse(url: string, response: Response): void {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return;
		}
		if (!isAllowedChatGptCookieUrl(parsed)) return;

		const setCookieHeaders = response.headers.getSetCookie
			? response.headers.getSetCookie()
			: [];
		if (setCookieHeaders.length === 0) return;

		let hostCookies = this.cookiesByHost.get(parsed.hostname);
		for (const setCookie of setCookieHeaders) {
			const parsedCookie = parseSetCookieNameValue(setCookie);
			if (!parsedCookie) continue;
			if (!isAllowedCloudflareCookieName(parsedCookie.name)) continue;
			if (!hostCookies) {
				hostCookies = new Map<string, string>();
				this.cookiesByHost.set(parsed.hostname, hostCookies);
			}
			hostCookies.set(parsedCookie.name, parsedCookie.value);
		}
	}

	applyCookieHeader(url: string, headers: Headers): void {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return;
		}
		if (!isAllowedChatGptCookieUrl(parsed)) return;

		const hostCookies = this.cookiesByHost.get(parsed.hostname);
		if (!hostCookies || hostCookies.size === 0) return;

		const merged = new Map<string, string>();
		const existing = headers.get("Cookie");
		if (existing) {
			for (const part of existing.split(";")) {
				const parsedExisting = parseCookieNameValue(part);
				if (parsedExisting) merged.set(parsedExisting.name, part.trim());
			}
		}
		for (const [name, value] of hostCookies) {
			merged.set(name, `${name}=${value}`);
		}

		headers.set("Cookie", Array.from(merged.values()).join("; "));
	}
}

export const chatGptCloudflareCookieJar = new ChatGptCloudflareCookieJar();
