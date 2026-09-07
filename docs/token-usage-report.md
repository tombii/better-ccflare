# Token Usage Report

How to find out **why token consumption jumped** — which period, which model,
which project, which subagent type — by comparing Claude Code transcripts
across days or weeks.

Script: [`scripts/token-usage-report.ts`](../scripts/token-usage-report.ts)

## The question this answers

> "We are burning far more tokens than a few days ago. More requests than the
> weeks before, or just more expensive ones?"

The report separates those two causes. It buckets every API call into periods,
shows the delta against the previous period, and can attribute each period to
the models, projects or subagent types behind it.

## Why not the proxy database

better-ccflare records every request, but it cannot answer a *week-over-week*
question:

| Table | Holds | Why it does not answer this |
| --- | --- | --- |
| `requests` | full per-request token counts | retention-pruned — a busy instance keeps only a couple of days |
| `usage_snapshots` | rate-limit utilization per account | months of history, but **no token counts** — only how full the 5-hour and 7-day windows were |

`usage_snapshots` is still worth a look as an independent cross-check: rising
average utilization confirms a consumption trend without touching transcripts.

The one local source that reaches back weeks *with* token counts is the Claude
Code transcript tree in `~/.claude/projects`. That is what this script reads.

## Prerequisites

- Bun (already required by this repo)
- Claude Code transcripts on the machine you run it on — by default
  `~/.claude/projects`, override with `--dir`

The script only reads files. It never writes to the transcripts and never
contacts the proxy or any API.

## Run it

Week-over-week overview, the default:

```bash
bun run scripts/token-usage-report.ts
```

A specific window, day by day:

```bash
bun run scripts/token-usage-report.ts --since 2026-08-01 --group day
```

Attribution — the step that usually finds the cause:

```bash
bun run scripts/token-usage-report.ts --by agent --top 5
bun run scripts/token-usage-report.ts --by project --group day --since 2026-09-01
```

Machine-readable, for a chart or a diff between two runs:

```bash
bun run scripts/token-usage-report.ts --json > usage.json
```

All options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--dir <path>` | `~/.claude/projects` | transcript root |
| `--since <date>` | 8 weeks ago | ignore entries before this date |
| `--group day\|week` | `week` | period length (ISO week, Mon–Sun) |
| `--by <dimension>` | none | breakdown per period: `model`, `project`, `agent`, `kind` |
| `--top <n>` | `5` | breakdown rows per period |
| `--json` | off | machine-readable output |

`--by kind` splits main sessions from subagent runs — the fastest way to see
whether fan-outs are driving the bill.

## Reading the output

Example shape (numbers illustrative):

```
week (Mon)     calls    in M   out M  cacheRd M  cacheCr M   total M  tok/call  vs prev
2026-08-17    33,290     0.5     3.2      10,300        220     10,522      316k       —
2026-08-24    53,495     6.4     4.7      16,300        350     16,652      311k     +58%
2026-08-31    88,904     2.4     6.9      25,400        700     25,971      292k     +56%
2026-09-07 *  12,000     0.2     1.4       3,500         90      3,600      300k     -86%
```

- **`calls` vs `tok/call`** is the whole point of the comparison. Rising calls
  at a flat `tok/call` means *more work*, not more expensive work; a rising
  `tok/call` at flat calls means longer contexts (bigger prompts, longer
  sessions, larger context windows).
- **`cacheRd` dominates everything.** In agent-heavy usage the cache-read
  column is routinely 90–95 % of all tokens: every turn re-reads the whole
  context from the prompt cache. Session length therefore costs roughly
  quadratically — a worker with twice the turns reads its context twice as
  often at twice the size.
- **`*` marks a period that has not finished yet.** Its `vs prev` value is
  meaningless — never compare a running week against a completed one.
- **`vs prev`** compares total tokens against the previous row, not against
  the same weekday or the same calendar period last month.

## Finding the cause

A workflow that gets there in three commands:

1. `--by kind` — main sessions or subagents?
2. `--by agent --top 5` — if subagents: which agent type, and since when?
3. `--by project --group day --since <the day it started>` — which work
   caused it.

Fan-outs are the usual answer: one agent type running many parallel lanes for
a few days can outweigh every interactive session combined.

## What it does not see

- **Only this machine.** Sessions on other hosts, other clients, and any
  non-Claude-Code traffic through the proxy are missing entirely.
- **Fewer entries than the proxy counts.** Retries and token-counting requests
  never reach a transcript, so proxy request counts run well above the call
  counts here. Compare trends between the two, not absolute numbers.
- **No costs.** Token counts only — pricing is deliberately not hardcoded.

## How it works

- Walks `--dir` for `*.jsonl`, skipping files whose mtime predates `--since`
  (a file cannot contain entries newer than itself).
- Keeps every assistant message carrying a `usage` block, deduped by message
  id — resumed and forked sessions copy earlier history into new files, and
  without dedupe those turns would be counted twice.
- Attributes subagent transcripts
  (`<project>/<session>/subagents/agent-*.jsonl`) to their parent project and
  to the `agentType` recorded in the sibling `.meta.json`.
- Buckets timestamps in the machine's local timezone.
