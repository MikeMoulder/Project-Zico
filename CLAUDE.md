# Zico session instructions for Claude Code

Use Zico as the execution observer for Circle Agent Stack work. Claude Code
remains the planner and operator; Zico records the task graph, service search,
decisions, calls, payments, failures, and final result.

## Prepare the visualizer

Before starting a Circle marketplace task, check
`http://localhost:4200/api/session`.

- Reuse the server if it responds.
- Otherwise start `zico serve --pace 220` in a persistent background terminal.
- If the global command is unavailable, use `npx zico-agent-graph` with the
  same arguments.
- Tell the user to open `http://localhost:4200`, or open it with available
  browser tools.

Do not start duplicate servers. The visualizer is a read-only window; all
conversation and control stay in Claude Code.

## Instrument every marketplace task

Use Zico for the complete task lifecycle:

```text
zico task "<objective>" --budget <amount>
zico search "<capability>" --max-price <amount>
zico decide "<resource-url>" --reason "<why this service fits>"
zico call "<resource-url>" --input '<json>'
zico note "<important finding>" [--type analysis|synthesis]
zico done --summary "<truthful result>"
```

Adapt the commands to the actual task. Inspect search results and input
schemas before calling. Search costs nothing; live calls may spend real USDC.
Ask for explicit approval before any live paid call, and always set a clear
budget. Use `zico call`, not direct `circle services pay`, so the graph stays
complete.

Search broadly once rather than probing with several near-identical queries.
A repeated query reuses its node, but each new phrasing adds another search and
another candidate group to the graph.

Results include vanilla x402 sellers as well as Circle Gateway sellers. Check
the `gasless` field: a vanilla seller needs on-chain USDC on its own chain and
settles a block later, where a gasless seller settles through Gateway. The
catalog is cached for 24 hours, so report a missing service rather than
bypassing Zico to reach it.

## If Circle setup is missing

Ask the user to paste this official setup request into the current Claude Code
session and follow its returned instructions:

```text
Run curl -sL https://agents.circle.com/skills/setup.md and follow the returned setup instructions to set up my agent wallet.
```

Keep terms acceptance, email OTP, wallet funding, credentials, and live payment
authorization user-controlled.

## Honest completion

Use actual responses, preserve useful reasoning with `zico note`, and show
service errors instead of concealing them or silently retrying payment calls.
For a shareable replay:

```bash
zico export --out zico-demo.html
```
