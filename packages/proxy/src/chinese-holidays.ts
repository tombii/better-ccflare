/**
 * Chinese public-holiday lookup used for DeepSeek's off-peak pricing.
 *
 * Holiday dates change every year (State Council notice), so they are pulled
 * from the community-maintained https://github.com/NateScarlet/holiday-cn feed
 * (one `YYYY.json` per year) and cached in memory. An embedded table covers
 * 2026 so lookups work offline and before the first refresh. A year that has
 * been fetched successfully overrides the embedded data for that year; years
 * with neither fall back to the plain weekday rule.
 */
import { Logger } from "@better-ccflare/logger";

const log = new Logger("ChineseHolidays");

const FEED_BASE_URL =
	"https://raw.githubusercontent.com/NateScarlet/holiday-cn/master";
const FETCH_TIMEOUT_MS = 10_000;

/** Inclusive [start, end] ranges of Beijing calendar dates (YYYY-MM-DD). */
const EMBEDDED_HOLIDAYS: ReadonlyArray<readonly [string, string]> = [
	["2026-01-01", "2026-01-03"],
	["2026-02-15", "2026-02-23"],
	["2026-04-04", "2026-04-06"],
	["2026-05-01", "2026-05-05"],
	["2026-06-19", "2026-06-21"],
	["2026-09-25", "2026-09-27"],
	["2026-10-01", "2026-10-07"],
];

/** Off-day dates per year, from the feed. Takes precedence over embedded data. */
const feedDaysByYear = new Map<number, Set<string>>();

export function isChinesePublicHoliday(date: string): boolean {
	const feed = feedDaysByYear.get(Number(date.slice(0, 4)));
	if (feed) return feed.has(date);
	return EMBEDDED_HOLIDAYS.some(([from, to]) => date >= from && date <= to);
}

/**
 * Fetch the holiday feed for the given years. Failures (network, 404 for a
 * year not yet published) are logged and leave the previous data in place.
 */
export async function refreshChineseHolidays(
	years: number[] = [
		new Date().getUTCFullYear(),
		new Date().getUTCFullYear() + 1,
	],
	fetchFn: typeof fetch = fetch,
): Promise<void> {
	for (const year of years) {
		try {
			const res = await fetchFn(`${FEED_BASE_URL}/${year}.json`, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) {
				log.debug(`No holiday feed for ${year} (HTTP ${res.status})`);
				continue;
			}
			const body = (await res.json()) as {
				days?: Array<{ date?: string; isOffDay?: boolean }>;
			};
			if (!Array.isArray(body.days)) continue;
			feedDaysByYear.set(
				year,
				new Set(
					body.days
						.filter((d) => d.isOffDay === true && typeof d.date === "string")
						.map((d) => d.date as string),
				),
			);
			log.info(`Loaded Chinese holiday calendar for ${year}`);
		} catch (error) {
			log.warn(
				`Failed to refresh Chinese holiday calendar for ${year}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/** Test helper: drop cached feed data. */
export function resetChineseHolidayCache(): void {
	feedDaysByYear.clear();
}
