/**
 * token-usage-report.ts — compare Claude Code token usage across time periods.
 *
 * WHY THIS SCRIPT EXISTS
 *   "We are burning far more tokens than last week — why?" cannot be answered
 *   from the proxy database. `requests` is retention-pruned (a busy instance
 *   keeps only a couple of days), and `usage_snapshots` stores rate-limit
 *   *utilization*, not token counts. The only local record that reaches back
 *   weeks is the Claude Code transcript tree in ~/.claude/projects.
 *
 *   This script aggregates those transcripts into period buckets (day or ISO
 *   week), shows the delta against the previous period, and — with --by —
 *   attributes each period to the models, projects or subagent types that
 *   caused it. That last part usually holds the answer: a single fan-out agent
 *   type can dominate a whole week.
 *
 * WHAT IT COUNTS
 *   Every assistant message that carries a `usage` block: one API call each,
 *   with input, output, cache-read and cache-creation tokens. Messages are
 *   deduped by message id, because resumed and forked sessions copy earlier
 *   history into a new transcript file.
 *
 *   Subagent transcripts live in <project>/<session>/subagents/agent-*.jsonl
 *   with a sibling .meta.json naming the agentType; they are attributed to
 *   their parent project and to that agent type.
 *
 * LIMITS
 *   * Local transcripts only — sessions on other machines, other clients and
 *     non-Claude-Code traffic through the proxy are invisible here.
 *   * The proxy counts more HTTP requests than this counts calls: retries and
 *     token-counting requests never appear in a transcript.
 *   * Periods are bucketed in the machine's local timezone.
 *
 * Usage:
 *   bun run scripts/token-usage-report.ts
 *   bun run scripts/token-usage-report.ts --group day --since 2026-08-01
 *   bun run scripts/token-usage-report.ts --by agent --top 5
 *   bun run scripts/token-usage-report.ts --json > usage.json
 */
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

type Counters = {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheCreate: number;
};

type Dimension =
	| "model"
	| "project"
	| "agent"
	| "kind"
	| "version"
	| "context";

type Options = {
	dir: string;
	since: Date;
	group: "day" | "week";
	by: Dimension | null;
	top: number;
	json: boolean;
};

const DIMENSIONS: Dimension[] = [
	"model",
	"project",
	"agent",
	"kind",
	"version",
	"context",
];

const USAGE_MARKER = '"cache_read_input_tokens"';

/**
 * Context size of one call: everything the model had to read, output excluded.
 * The buckets matter because anything above ~200k can only happen in an
 * extended context window — the share of those calls is what makes a session
 * expensive per turn.
 */
function contextBucket(tokens: number): string {
	if (tokens > 500_000) return "ctx >500k";
	if (tokens > 200_000) return "ctx 200-500k";
	if (tokens > 50_000) return "ctx 50-200k";
	return "ctx <50k";
}

function emptyCounters(): Counters {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

function total(c: Counters): number {
	return c.input + c.output + c.cacheRead + c.cacheCreate;
}

function add(target: Map<string, Counters>, key: string, c: Counters): void {
	let bucket = target.get(key);
	if (!bucket) {
		bucket = emptyCounters();
		target.set(key, bucket);
	}
	bucket.calls += c.calls;
	bucket.input += c.input;
	bucket.output += c.output;
	bucket.cacheRead += c.cacheRead;
	bucket.cacheCreate += c.cacheCreate;
}

function parseArgs(argv: string[]): Options {
	const opts: Options = {
		dir: join(homedir(), ".claude", "projects"),
		since: new Date(Date.now() - 56 * 86400_000),
		group: "week",
		by: null,
		top: 5,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) {
				console.error(`${arg} needs a value`);
				process.exit(2);
			}
			return value;
		};
		switch (arg) {
			case "--dir":
				opts.dir = next();
				break;
			case "--since": {
				const value = next();
				const parsed = new Date(value);
				if (Number.isNaN(parsed.getTime())) {
					console.error(`--since: not a date: ${value}`);
					process.exit(2);
				}
				opts.since = parsed;
				break;
			}
			case "--group": {
				const value = next();
				if (value !== "day" && value !== "week") {
					console.error("--group must be day or week");
					process.exit(2);
				}
				opts.group = value;
				break;
			}
			case "--by": {
				const value = next();
				if (!DIMENSIONS.includes(value as Dimension)) {
					console.error(`--by must be one of: ${DIMENSIONS.join(", ")}`);
					process.exit(2);
				}
				opts.by = value as Dimension;
				break;
			}
			case "--top":
				opts.top = Number.parseInt(next(), 10);
				break;
			case "--json":
				opts.json = true;
				break;
			case "--help":
			case "-h":
				console.log(
					[
						"Usage: bun run scripts/token-usage-report.ts [options]",
						"",
						"  --dir <path>      transcript root (default ~/.claude/projects)",
						"  --since <date>    ignore entries before this date (default: 8 weeks ago)",
						"  --group day|week  period length (default week, ISO Mon-Sun)",
						`  --by <dimension>  breakdown per period: ${DIMENSIONS.join(" | ")}`,
						"  --top <n>         breakdown rows per period (default 5)",
						"  --json            machine-readable output",
					].join("\n"),
				);
				process.exit(0);
				break;
			default:
				console.error(`unknown option: ${arg} (try --help)`);
				process.exit(2);
		}
	}
	return opts;
}

/** All *.jsonl below root whose mtime is at or after `since`. */
function collectTranscripts(root: string, since: Date): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				// A file cannot hold entries newer than its own mtime, so an
				// older file can be skipped without reading it.
				try {
					if (statSync(path).mtimeMs >= since.getTime()) found.push(path);
				} catch {
					// vanished between readdir and stat — ignore
				}
			}
		}
	};
	walk(root);
	return found;
}

/**
 * Attribution of one transcript file: which project it belongs to, whether it
 * is a subagent run, and (for subagents) which agent type produced it.
 */
function attribute(
	path: string,
	root: string,
): { project: string; kind: "main" | "subagent"; agent: string } {
	const relative = path.slice(root.length).replace(/^\/+/, "");
	const parts = relative.split("/");
	const project = parts[0] ?? "?";
	if (!parts.includes("subagents")) {
		return { project, kind: "main", agent: "(main session)" };
	}
	let agent = "?";
	try {
		const meta = JSON.parse(
			readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8"),
		);
		if (typeof meta?.agentType === "string") agent = meta.agentType;
	} catch {
		// no meta file (older transcripts) — fall back to the file name
		agent = basename(path).replace(/^agent-/, "").replace(/\.jsonl$/, "");
	}
	return { project, kind: "subagent", agent };
}

function dayKey(d: Date): string {
	const month = `${d.getMonth() + 1}`.padStart(2, "0");
	const day = `${d.getDate()}`.padStart(2, "0");
	return `${d.getFullYear()}-${month}-${day}`;
}

/** Monday of the ISO week containing `d`, in local time. */
function weekKey(d: Date): string {
	const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
	const mondayOffset = (start.getDay() + 6) % 7;
	start.setDate(start.getDate() - mondayOffset);
	return dayKey(start);
}

/** True while the period starting at `key` has not finished yet. */
function isPartial(key: string, group: "day" | "week"): boolean {
	const start = new Date(`${key}T00:00:00`);
	const end = new Date(start);
	end.setDate(end.getDate() + (group === "week" ? 7 : 1));
	return end.getTime() > Date.now();
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const files = collectTranscripts(opts.dir, opts.since);
	process.stderr.write(
		`scanning ${files.length} transcripts in ${opts.dir}\n`,
	);

	const periods = new Map<string, Counters>();
	const breakdown = new Map<string, Map<string, Counters>>();
	const seen = new Set<string>();
	let scanned = 0;

	for (const path of files) {
		if (++scanned % 500 === 0) {
			process.stderr.write(`  ${scanned}/${files.length}\n`);
		}
		const where = attribute(path, opts.dir);
		const lines = createInterface({
			input: createReadStream(path, { encoding: "utf8" }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		for await (const line of lines) {
			// Cheap pre-filter: only usage blocks carry this key, and they are a
			// small minority of the lines in a transcript.
			if (!line.includes(USAGE_MARKER)) continue;
			let record: {
				timestamp?: string;
				uuid?: string;
				version?: string;
				message?: {
					id?: string;
					model?: string;
					usage?: Record<string, number>;
				};
			};
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			const usage = record.message?.usage;
			if (!usage || !record.timestamp) continue;
			const id = record.message?.id ?? record.uuid;
			if (!id || seen.has(id)) continue;
			seen.add(id);

			const at = new Date(record.timestamp);
			if (Number.isNaN(at.getTime()) || at < opts.since) continue;

			const counters: Counters = {
				calls: 1,
				input: usage.input_tokens ?? 0,
				output: usage.output_tokens ?? 0,
				cacheRead: usage.cache_read_input_tokens ?? 0,
				cacheCreate: usage.cache_creation_input_tokens ?? 0,
			};
			const period = opts.group === "week" ? weekKey(at) : dayKey(at);
			add(periods, period, counters);

			if (opts.by) {
				let dimension: string;
				switch (opts.by) {
					case "model":
						dimension = record.message?.model ?? "?";
						break;
					case "project":
						dimension = where.project;
						break;
					case "agent":
						dimension = where.agent;
						break;
					case "version":
						dimension = record.version ?? "?";
						break;
					case "context":
						dimension = contextBucket(
							counters.input + counters.cacheRead + counters.cacheCreate,
						);
						break;
					default:
						dimension = where.kind;
				}
				let inner = breakdown.get(period);
				if (!inner) {
					inner = new Map();
					breakdown.set(period, inner);
				}
				add(inner, dimension, counters);
			}
		}
	}

	const keys = [...periods.keys()].sort();

	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					group: opts.group,
					since: opts.since.toISOString(),
					periods: keys.map((key) => ({
						period: key,
						partial: isPartial(key, opts.group),
						...periods.get(key),
						total: total(periods.get(key) as Counters),
						breakdown: opts.by
							? Object.fromEntries(breakdown.get(key) ?? [])
							: undefined,
					})),
				},
				null,
				2,
			),
		);
		return;
	}

	const M = 1_000_000;
	const fmt = (n: number) => n.toLocaleString("en-US");
	console.log(
		`\n${opts.group === "week" ? "week (Mon)" : "day".padEnd(10)}   ${"calls".padStart(8)} ${"in M".padStart(7)} ${"out M".padStart(7)} ${"cacheRd M".padStart(10)} ${"cacheCr M".padStart(10)} ${"total M".padStart(9)} ${"tok/call".padStart(9)}  vs prev`,
	);
	let previous: number | null = null;
	for (const key of keys) {
		const c = periods.get(key) as Counters;
		const sum = total(c);
		const perCall = c.calls ? Math.round(sum / c.calls / 1000) : 0;
		const delta =
			previous && previous > 0
				? `${sum >= previous ? "+" : ""}${Math.round(((sum - previous) / previous) * 100)}%`
				: "—";
		const flag = isPartial(key, opts.group) ? " *" : "  ";
		console.log(
			`${key}${flag} ${fmt(c.calls).padStart(9)} ${(c.input / M).toFixed(1).padStart(7)} ${(c.output / M).toFixed(1).padStart(7)} ${(c.cacheRead / M).toFixed(0).padStart(10)} ${(c.cacheCreate / M).toFixed(0).padStart(10)} ${(sum / M).toFixed(0).padStart(9)} ${`${perCall}k`.padStart(9)}  ${delta.padStart(6)}`,
		);
		if (opts.by) {
			const rows = [...(breakdown.get(key) ?? new Map())]
				.sort((a, b) => total(b[1]) - total(a[1]))
				.slice(0, opts.top);
			for (const [name, c2] of rows) {
				const share = sum ? Math.round((total(c2) / sum) * 100) : 0;
				// tokens per call per row: comparing rows WITHIN one period is what
				// separates a real effect from a shifted mix.
				const rowPerCall = c2.calls
					? Math.round(total(c2) / c2.calls / 1000)
					: 0;
				console.log(
					`             ${name.slice(0, 34).padEnd(34)} ${fmt(c2.calls).padStart(8)} calls ${(total(c2) / M).toFixed(0).padStart(7)}M ${`${share}%`.padStart(5)} ${`${rowPerCall}k/call`.padStart(11)}`,
				);
			}
		}
		previous = sum;
	}
	console.log(
		"\n* period still running — not comparable to the completed ones.",
	);
	console.log(
		`${fmt(seen.size)} distinct calls, ${fmt(files.length)} transcripts scanned.`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
