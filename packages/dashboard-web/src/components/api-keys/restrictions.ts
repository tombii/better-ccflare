import type { ApiKeyRestrictions } from "@better-ccflare/types";

/**
 * Family names the backend accepts alongside concrete model ids. A family
 * matches every model in it, so a key restricted to "opus" keeps working when
 * the next Opus ships - pinning the id would silently lock the key out of it.
 */
export const MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

/** All three fields null: the zero-effort default, and what an omitted POST field means. */
export const UNRESTRICTED_RESTRICTIONS: ApiKeyRestrictions = {
	allowedAccounts: null,
	allowedModels: null,
	allowedProviders: null,
};

/**
 * Pull just the restriction triple off an API key row.
 *
 * Missing fields are read as null (unrestricted), not left undefined: a
 * dashboard build can reach a server that predates the feature, and the rest
 * of this module distinguishes null from [] by identity.
 */
export function restrictionsOf(
	key: Partial<ApiKeyRestrictions>,
): ApiKeyRestrictions {
	return {
		allowedAccounts: key.allowedAccounts ?? null,
		allowedModels: key.allowedModels ?? null,
		allowedProviders: key.allowedProviders ?? null,
	};
}

/** Enough of an id to recognise it, without pasting 36 characters into a badge. */
export function shortId(id: string): string {
	return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

/**
 * Label for an account id held by a key.
 *
 * `allowedAccounts` stores raw ids, and an account can be deleted after a key
 * is restricted to it. The dangling id then matches nothing - safe, but
 * invisible if it is rendered as nothing at all. Name it explicitly so the
 * operator can see it and remove it.
 */
export function accountLabel(id: string, names: Map<string, string>): string {
	return names.get(id) ?? `Unknown account (${shortId(id)})`;
}

export interface RestrictionSummary {
	/** Terse text for the row badge. */
	text: string;
	/** Full listing for the title= tooltip. */
	detail: string;
	/** At least one list is [] - the key can never be used. */
	deniesAll: boolean;
	/** At least one list is non-null. */
	restricted: boolean;
}

function countLabel(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * One-line summary of a key's restrictions, plus the full detail for a tooltip.
 *
 * `[]` is reported first and on its own: an empty allow-list denies every
 * request, and that outcome dwarfs whatever the other two fields say.
 */
export function summarizeRestrictions(
	restrictions: Partial<ApiKeyRestrictions>,
	accountNames: Map<string, string>,
): RestrictionSummary {
	const { allowedAccounts, allowedModels, allowedProviders } =
		restrictionsOf(restrictions);
	const lists = [allowedAccounts, allowedModels, allowedProviders];
	const restricted = lists.some((list) => list !== null);
	const deniesAll = lists.some((list) => list !== null && list.length === 0);

	const detailLine = (
		title: string,
		list: string[] | null,
		label: (value: string) => string,
	): string => {
		if (list === null) return `${title}: any`;
		if (list.length === 0) return `${title}: none - denies every request`;
		return `${title}: ${list.map(label).join(", ")}`;
	};

	const detail = [
		detailLine("Accounts", allowedAccounts, (id) =>
			accountLabel(id, accountNames),
		),
		detailLine("Models", allowedModels, (model) => model),
		detailLine("Providers", allowedProviders, (provider) => provider),
	].join("\n");

	if (!restricted) {
		return {
			text: "unrestricted",
			detail,
			deniesAll: false,
			restricted: false,
		};
	}
	if (deniesAll) {
		return { text: "denies all requests", detail, deniesAll: true, restricted };
	}

	const parts: string[] = [];
	if (allowedAccounts) {
		parts.push(
			allowedAccounts.length === 1
				? `${accountLabel(allowedAccounts[0], accountNames)} only`
				: countLabel(allowedAccounts.length, "account"),
		);
	}
	if (allowedModels) {
		parts.push(
			allowedModels.length === 1
				? `${allowedModels[0]} only`
				: countLabel(allowedModels.length, "model"),
		);
	}
	if (allowedProviders) {
		parts.push(
			allowedProviders.length === 1
				? `${allowedProviders[0]} only`
				: countLabel(allowedProviders.length, "provider"),
		);
	}

	return { text: parts.join(", "), detail, deniesAll: false, restricted };
}
