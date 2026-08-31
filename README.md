# Zico

Zico is a live visualizer for AI agents that discover services, make decisions,
use paid APIs, and report their result through Circle’s Agent Stack.

The agent does the work. Zico gives you a clear window into what happened:
what it searched, what it considered, what it chose, what it paid, and what it
learned.

## Try it without a wallet

Simulation uses the real Circle marketplace catalog and prices, but never
makes a payment.

Requirements: Node.js 20.18.2 or newer.

When the package is published, install it globally:

```bash
npm install --global zico-agent-graph
zico serve --pace 220
```

When running directly from this repository, use:

```bash
node src/cli.js serve --pace 220
```

Open [http://localhost:4200](http://localhost:4200), then use a second terminal:

```bash
node src/cli.js task "Research the current price of ETH" --budget 0.40
node src/cli.js search "token price"
```

Copy a resource URL from the search results and continue:

```bash
node src/cli.js decide "<resource-url>" --reason "best fit for the question"
node src/cli.js call "<resource-url>" --input '{"symbol":"ETH"}'
node src/cli.js done --summary "Finished the research."
```

Search is free. In simulation, calls show estimated cost and do not move money.

## Use real Circle services

Live mode uses a real Agent Wallet and real USDC. Do not use it until you are
ready to authorize and fund a wallet.

In your coding agent, paste:

```text
Run curl -sL https://agents.circle.com/skills/setup.md and follow the returned setup instructions to set up my agent wallet.
```

Follow Circle’s instructions to install the CLI, accept the terms, authenticate
with the email OTP, create or select an Agent Wallet, and fund it. Then start
Zico in live mode:

```bash
node src/cli.js serve --live --pace 220
```

Zico checks the Circle CLI, login, wallet, and balance before it starts. It
also enforces the task budget defensively and sends Circle a maximum payment
cap. Circle remains the authoritative spending-policy layer.

The browser labels live activity separately from simulation. Successful
payments show their payment rail and transaction hash in the inspector.

## Share a finished run

Create a standalone replay that needs no Node.js, wallet, server, or network:

```bash
node src/cli.js export --out zico-demo.html
```

Send `zico-demo.html` to anyone. They can open it directly in a browser and
watch the run with play, pause, seek, and speed controls.

## Commands

| Command | Purpose |
|---|---|
| `node src/cli.js serve` | Start the visualizer in simulation mode |
| `node src/cli.js serve --live` | Start with real Circle payments |
| `node src/cli.js task "<objective>" --budget 0.40` | Start a run |
| `node src/cli.js search "<query>"` | Find callable services; free |
| `node src/cli.js decide "<resource>" --reason "<why>"` | Record a choice |
| `node src/cli.js call "<resource>" --input '<json>'` | Call a service |
| `node src/cli.js note "<text>"` | Add an analysis or synthesis note |
| `node src/cli.js done --summary "<result>"` | Finish the run |
| `node src/cli.js export --out demo.html` | Create a shareable replay |

## Important

Zico is an observer, not the agent or planner. For the graph to update, the
agent must drive the Zico commands above. The browser is read-only; commands
and decisions stay in the terminal.

For a different port:

```bash
node src/cli.js serve --port 4201
```

For faster playback while testing:

```bash
node src/cli.js serve --pace 0
```

More Circle documentation:

- [Circle Agent Stack](https://developers.circle.com/agent-stack)
- [Agent Wallet quickstart](https://developers.circle.com/agent-stack/agent-wallets/quickstart)
- [Circle CLI command reference](https://developers.circle.com/agent-stack/circle-cli/command-reference)
