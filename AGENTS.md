# Zico agent instructions

Use Zico as the execution observer for Circle Agent Stack work. You are still
the planner and decision-maker; Zico records the task, marketplace search,
alternatives, decisions, calls, payments, failures, and final result.

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

## Route work through Zico

For every Circle marketplace task, use this sequence:

1. `zico task "<objective>" --budget <amount>` when the task begins.
2. `zico search "<capability>" --max-price <amount>` to find services.
3. Review the returned descriptions, prices, schemas, networks, and providers.
4. `zico decide "<resource-url>" --reason "<specific reason>"` after choosing.
5. `zico call "<resource-url>" --input '<json>'` to invoke the service.
6. Use `zico note "<finding>" [--type analysis|synthesis]` for important
   analysis or corrections. Pass `--parents <id,id>` to merge branches.
7. `zico done --summary "<truthful result>"` when the task is complete.

Search broadly once instead of probing with several near-identical queries.
Re-running the same query reuses its existing node, but every new phrasing adds
another search and another candidate group to the graph.

Results cover both Circle Gateway sellers and vanilla x402 sellers. Read the
`gasless` field on each result: a gasless seller settles through Gateway, while
a vanilla seller needs on-chain USDC on that seller's own chain and settles a
block later. Both are callable; the difference is speed and which balance pays.

Search is free. A live `zico call` can spend real USDC. Never make a live paid
call without the user's explicit approval and a clear task budget. Simulation
is the default and does not move money.

Do not call `circle services pay` directly for a task that should appear in the
graph. Use Zico's `call` command so the payment and result are recorded.

The catalog is cached for 24 hours. If a service you expect is missing, say so
plainly rather than reaching for `circle services pay` to work around it.

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
silently retry paid calls. To make a standalone replay, run:

```bash
zico export --out zico-demo.html
```
