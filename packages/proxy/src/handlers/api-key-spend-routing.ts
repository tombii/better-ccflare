import type { RequestMeta } from "@better-ccflare/types";

/** Process-local admission hook; request headers/body cannot manufacture it. */
const checks = new WeakMap<
	RequestMeta,
	(model: string) => Promise<Response | null>
>();
export function setApiKeyRoutedSpendCheck(
	meta: RequestMeta,
	check: (model: string) => Promise<Response | null>,
): void {
	checks.set(meta, check);
}
export function getApiKeyRoutedSpendCheck(
	meta: RequestMeta,
): ((model: string) => Promise<Response | null>) | undefined {
	return checks.get(meta);
}
export class ApiKeyRoutedSpendRefusal {
	constructor(readonly response: Response) {}
}
