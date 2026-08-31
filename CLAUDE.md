# Zico session instructions for Claude Code

Zico is a listener. The Circle CLI performs every real action — search, payment,
swap, transfer — and Claude Code drives it directly. Zico is told what happened
so it can log and render the run. It holds no wallet, makes no payments, and
queries no marketplace.

Never route an action through Zico to make it happen. Do the work with `circle`,
then report it.

## Prepare the visualizer

Before starting a Circle marketplace task, check
`http://localhost:4200/api/session`.

- Reuse the server if it responds.
- Otherwise start `zico serve --pace 220` in a persistent background terminal.
- If the global command is unavailable, use `npx zico-agent-graph` with the
  same arguments.
- Tell the user to open `http://localhost:4200`, or open it with available
  browser tools.

Do not start duplicate servers. Starting the server needs no wallet, no login,
and no funds — it only listens.

## Instrument every marketplace task

Run the real command first, then record its result:

```text
zico task "<objective>" --budget <amount>

circle services search "<capability>" --output json | zico search "<capability>"

zico decide "<resource-url>" --reason "<why this service fits>"

circle services pay "<resource-url>" --data '<json>' --max-amount <cap> --output json
zico record "<resource-url>" --cost <actual> --tx <hash> --output '<response>'

zico note "<important finding>" [--type analysis|synthesis]
zico done --summary "<truthful result>"
```

Report the figure that actually settled, not the listed price — a seller may
reprice between discovery and payment, and the graph should show what left the
wallet. Pass `--error "<message>"` to `zico record` when a paid call fails; a
failed attempt is part of the run and belongs in the graph.

`circle services inspect <url>` shows pricing and input schema without paying.
Its health probe returns false negatives, so a service reported "unavailable"
may still be live — probe the endpoint before ruling it out.

Enforce budgets with `circle services pay --max-amount`. That is the only place
a cap can actually stop a transfer; Zico cannot refuse anything. Ask for explicit
approval before any live paid call.

Search broadly once rather than probing with several near-identical queries.
A repeated query reuses its node, but each new phrasing adds another search and
another candidate group to the graph.

Results include vanilla x402 sellers as well as Circle Gateway sellers. Check
the `gasless` field: a vanilla seller needs on-chain USDC on its own chain and
settles a block later, where a gasless seller settles through Gateway.

## Actions that are not marketplace calls

Swaps, transfers, and bridges have no `record` verb — that verb is for paid
service calls. Run them with `circle wallet …` and capture them with
`zico note`, including the transaction hash and confirmed state.

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
Zico records what it is told, so a wrong figure reported here becomes a wrong
figure on the graph. For a shareable replay:

```bash
zico export --out zico-demo.html
```
