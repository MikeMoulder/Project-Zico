# Zico agent instructions

Zico is a listener. The Circle CLI performs every real action — search, payment,
swap, transfer — and you drive it directly. Zico is told what happened so it can
log and render the run. It holds no wallet, makes no payments, and queries no
marketplace.

Never route an action through Zico to make it happen. Do the work with `circle`,
then report it.

## Start the visualizer

Before a Circle marketplace task, check whether the Zico server is already
available at `http://localhost:4200/api/session`.

- If it is available, reuse it. Do not start a second server.
- If it is not available, start `zico serve --pace 220` in a persistent
  background terminal. If `zico` is not installed, use `npx zico-agent-graph`
  for the same command.
- Tell the user the visualizer is ready at `http://localhost:4200`. Open it
  with available browser tools when possible.

The browser is read-only. Do not wait for the browser to provide input.
Starting the server needs no wallet, no login, and no funds — it only listens.

## Report work to Zico

For every Circle marketplace task, use this sequence:

1. `zico task "<objective>" --budget <amount>` when the task begins.
2. `circle services search "<capability>" --output json | zico search "<capability>"`
   — Circle runs the query; Zico records the result set you actually saw.
3. Review the returned descriptions, prices, schemas, networks, and providers.
   `circle services inspect <url>` shows pricing and input schema without paying.
4. `zico decide "<resource-url>" --reason "<specific reason>"` after choosing.
5. `circle services pay "<resource-url>" --data '<json>' --max-amount <cap> --output json`
   to invoke the service, then
   `zico record "<resource-url>" --cost <actual> --tx <hash> --output '<response>'`
   to put it on the graph.
6. Use `zico note "<finding>" [--type analysis|synthesis]` for important
   analysis or corrections. Pass `--parents <id,id>` to merge branches.
7. `zico done --summary "<truthful result>"` when the task is complete.

Record the figure that actually settled, not the listed price — a seller may
reprice between discovery and payment. Pass `--error "<message>"` to
`zico record` when a paid call fails; a failed attempt belongs in the graph.

Search broadly once instead of probing with several near-identical queries.
Re-running the same query reuses its existing node, but every new phrasing adds
another search and another candidate group to the graph.

Results cover both Circle Gateway sellers and vanilla x402 sellers. Read the
`gasless` field on each result: a gasless seller settles through Gateway, while
a vanilla seller needs on-chain USDC on that seller's own chain and settles a
block later. Both are callable; the difference is speed and which balance pays.

Search is free. A `circle services pay` call spends real USDC. Never make a paid
call without the user's explicit approval and a clear budget. Enforce the budget
with `--max-amount` — that is the only place a cap can actually stop a transfer.
Zico cannot refuse anything.

## Actions that are not marketplace calls

Swaps, transfers, and bridges have no `record` verb — that verb is for paid
service calls. Run them with `circle wallet …` and capture them with
`zico note`, including the transaction hash and confirmed state.

## Circle setup and safety

If Circle is not ready, ask the user to run the official setup instruction in
this session:

```text
Run curl -sL https://agents.circle.com/skills/setup.md and follow the returned setup instructions to set up my agent wallet.
```

Do not accept terms, enter an OTP, fund a wallet, expose credentials, or make a
real payment on the user's behalf without their direct approval.

## Finish and share

Use the real service response and show failures honestly. Do not hide errors or
silently retry paid calls. Zico records what it is told, so a wrong figure
reported here becomes a wrong figure on the graph. To make a standalone replay:

```bash
zico export --out zico-demo.html
```
