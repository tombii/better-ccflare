import type {
	ApiKeyLimitInput,
	ApiKeyLimitStatus,
	ApiKeyLimitWindowMode,
} from "@better-ccflare/types";

export interface LimitDraft {
	id: string;
	scopeModel: string;
	window: ApiKeyLimitInput["window"];
	usd: string;
	enforce: ApiKeyLimitInput["enforce"];
}

export function limitDraftsOf(limits: ApiKeyLimitStatus[]): LimitDraft[] {
	return limits.map((limit) => ({
		id: limit.id,
		scopeModel: limit.scopeModel ?? "",
		window: limit.window,
		usd: String(limit.limitUsd),
		enforce: limit.enforce,
	}));
}

export function serializeLimits(
	mode: ApiKeyLimitWindowMode,
	drafts: LimitDraft[],
): { mode: ApiKeyLimitWindowMode; limits: ApiKeyLimitInput[] } {
	const seen = new Set<string>();
	const limits = drafts.map((draft) => {
		const limitUsd = Number(draft.usd);
		if (!draft.usd.trim() || !Number.isFinite(limitUsd) || limitUsd <= 0) {
			throw new Error("Every limit must have a USD amount greater than zero.");
		}
		const scopeModel = draft.scopeModel.trim() || null;
		const identity = JSON.stringify([scopeModel, draft.window]);
		if (seen.has(identity)) {
			throw new Error("Use one limit for each model scope and window.");
		}
		seen.add(identity);
		return {
			scopeModel,
			window: draft.window,
			limitUsd,
			enforce: draft.enforce,
		};
	});
	return { mode, limits };
}
