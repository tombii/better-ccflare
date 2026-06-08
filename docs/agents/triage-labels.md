# Agent Triage Labels

Use the repo's actual GitHub label vocabulary. Do not invent duplicate labels.

Canonical roles for Matt Pocock-style engineering skills:

| Role | GitHub label | Meaning |
| --- | --- | --- |
| Needs triage | `needs-triage` | Maintainer needs to evaluate the issue. Create only if the repo adopts this label. |
| Needs info | `needs-info` | Waiting on reporter/user clarification. Create only if the repo adopts this label. |
| Ready for agent | `ready-for-agent` | Fully specified, AFK-ready issue. This label exists in current local issues. |
| Ready for human | `ready-for-human` | Requires human implementation/review. Create only if the repo adopts this label. |
| Won't fix | `wontfix` | Maintainer decided not to action. Create only if the repo adopts this label. |

Current observed labels on `omcdowell/the-best-ccflare` are sparse; `ready-for-agent` is the only canonical label seen on closed issue work as of 2026-06-08. If a workflow needs the other labels, ask before creating them.
