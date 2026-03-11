import type { Account } from "@better-ccflare/types";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

const ALIBABA_CODING_PLAN_DEFAULT_ENDPOINT =
	"https://coding-intl.dashscope.aliyuncs.com/apps/anthropic";

export class AlibabaCodingPlanProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "alibaba-coding-plan",
			baseUrl: ALIBABA_CODING_PLAN_DEFAULT_ENDPOINT,
			authHeader: "x-api-key",
			authType: "direct",
			supportsStreaming: true,
		});
	}

	getEndpoint(): string {
		return this.config.baseUrl || ALIBABA_CODING_PLAN_DEFAULT_ENDPOINT;
	}

	override buildUrl(path: string, query: string, account?: Account): string {
		const endpoint = (
			account?.custom_endpoint || ALIBABA_CODING_PLAN_DEFAULT_ENDPOINT
		).replace(/\/$/, "");

		return `${endpoint}${path}${query}`;
	}
}
