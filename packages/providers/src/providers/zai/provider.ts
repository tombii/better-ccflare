import { Logger } from "@better-ccflare/logger";
import type { RateLimitInfo } from "../../types";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

const log = new Logger("ZaiProvider");

export class ZaiProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "zai",
			authHeader: "x-api-key",
			authType: "direct",
			supportsStreaming: true,
		});
	}

	getEndpoint(): string {
		// Zai provider only supports the official API endpoint
		return "https://api.z.ai/api/anthropic";
	}

	/**
	 * Parse rate limit information from response body for Zai-specific format
	 * Zai returns rate limit info in JSON response body with Singapore time
	 */
	async parseRateLimitFromBody(
		response: Response,
	): Promise<number | undefined> {
		try {
			const clone = response.clone();
			const body = await clone.json();

			// Check for Zai rate limit error format
			// {
			//   "type": "error",
			//   "error": {
			//     "type": "1308",
			//     "message": "Usage limit reached for 5 hour. Your limit will reset at 2025-10-03 08:23:14"
			//   }
			// }
			if (
				body?.type === "error" &&
				body?.error?.type === "1308" &&
				body?.error?.message
			) {
				const message = body.error.message as string;
				// Extract timestamp from message like "Your limit will reset at 2025-10-03 08:23:14"
				const match = message.match(
					/reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/,
				);
				if (match) {
					const resetTimeStr = match[1];
					// Parse as Singapore time (UTC+8) and convert to UTC
					const [datePart, timePart] = resetTimeStr.split(" ");
					const [year, month, day] = datePart.split("-").map(Number);
					const [hour, minute, second] = timePart.split(":").map(Number);

					// Create date in Singapore time (UTC+8)
					// We need to subtract 8 hours to get UTC
					const singaporeDate = new Date(
						Date.UTC(year, month - 1, day, hour, minute, second),
					);
					const utcTime = singaporeDate.getTime() - 8 * 60 * 60 * 1000;

					log.info(
						`Parsed Zai rate limit reset time: ${resetTimeStr} Singapore time -> ${new Date(utcTime).toISOString()} UTC`,
					);

					return utcTime;
				}
			}
		} catch (error) {
			log.debug("Failed to parse rate limit from response body:", error);
		}
		return undefined;
	}

	/**
	 * Override parseRateLimit to handle Zai-specific body parsing
	 */
	parseRateLimit(response: Response): RateLimitInfo {
		// Check for standard rate limit headers first
		if (response.status !== 429) {
			return { isRateLimited: false };
		}

		// Try to extract reset time from headers first
		const retryAfter = response.headers.get("retry-after");
		let resetTime: number | undefined;

		if (retryAfter) {
			// Retry-After can be seconds or HTTP date
			const seconds = Number(retryAfter);
			if (!Number.isNaN(seconds)) {
				resetTime = Date.now() + seconds * 1000;
			} else {
				resetTime = new Date(retryAfter).getTime();
			}
		}

		// If no header-based reset time and this is a 429,
		// we need to parse the body - but parseRateLimit is sync
		// So we'll return the basic rate limit info and let the caller
		// parse the body if needed
		return { isRateLimited: true, resetTime };
	}
}
