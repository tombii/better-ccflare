export const BETTER_CCFLARE_INTERNAL_HEADER_PREFIX = "x-better-ccflare-";

export function isBetterCcflareInternalHeaderName(headerName: string): boolean {
	return headerName
		.toLowerCase()
		.startsWith(BETTER_CCFLARE_INTERNAL_HEADER_PREFIX);
}
