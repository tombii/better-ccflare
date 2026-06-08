# Agent Domain Docs

This repo currently uses a single-context layout for agent instructions.

## Current layout

- Primary agent standards: `CLAUDE.md`.
- Product/technical docs: `README.md` and `docs/*.md`.
- No root `CONTEXT.md` exists yet.
- No `CONTEXT-MAP.md` exists yet.
- No `docs/adr/` decision-record directory exists yet.

## Sensitive access information

Do not commit remote-machine access details to this public repo. Keep SSH aliases, hostnames, usernames, IP addresses, Tailscale/WireGuard names, database paths on personal machines, API keys, and tokens in private operator notes or a secret manager.

If an agent needs remote access, the public docs should say only: "ask the maintainer for remote access details" or use generic placeholders like `your-server.example.com`.

## Consumer rules

When doing architecture, diagnosis, TDD, review, or issue implementation:

1. Read `CLAUDE.md` first; it contains hard safety rules and repo-specific workflow rules.
2. Read the relevant `docs/*.md` pages for the area being changed.
3. Treat `docs/agents/*.md` as operational guidance for agent workflows, issue tracking, triage, and upstream sync.
4. If a future `CONTEXT.md` or `docs/adr/` appears, treat it as in-force domain/decision context and read it before implementation.
5. Do not convert speculative plans into in-force ADRs. Only add decision records when the maintainer confirms the decision is accepted.
