import type { Account } from "@better-ccflare/types";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

export class OllamaProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "ollama",
			baseUrl: "http://localhost:11434",
			authHeader: "x-api-key",
			authType: "direct",
			supportsStreaming: true,
		});
	}

	getEndpoint(): string {
		return "http://localhost:11434";
	}

	buildUrl(pathname: string, search: string, account?: Account): string {
		const baseUrl = (account?.custom_endpoint || this.getEndpoint()).replace(
			/\/$/,
			"",
		);
		try {
			const parsed = new URL(baseUrl);
			const basePath = parsed.pathname.replace(/\/$/, "");
			const effectivePath =
				basePath && pathname.startsWith(basePath)
					? pathname.slice(basePath.length) || "/"
					: pathname;
			return `${baseUrl}${effectivePath}${search}`;
		} catch {
			return `${baseUrl}${pathname}${search}`;
		}
	}
}
