import type { Account } from "@better-ccflare/types";
import { OpenAICompatibleProvider } from "../openai/provider";

const ALIBABA_CODING_PLAN_DEFAULT_ENDPOINT =
	"https://coding-intl.dashscope.aliyuncs.com/v1";

export class AlibabaCodingPlanProvider extends OpenAICompatibleProvider {
	override name = "alibaba-coding-plan";

	override buildUrl(path: string, query: string, account?: Account): string {
		const endpoint = (
			account?.custom_endpoint || ALIBABA_CODING_PLAN_DEFAULT_ENDPOINT
		).replace(/\/$/, "");

		// Convert Anthropic /v1/messages → OpenAI /v1/chat/completions
		let openaiPath = path;
		if (path === "/v1/messages") {
			openaiPath = "/v1/chat/completions";
		} else if (path.startsWith("/v1/")) {
			openaiPath = path; // keep /v1/ prefix for Alibaba
		}

		return `${endpoint}${openaiPath}${query}`;
	}
}
