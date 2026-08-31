# Zico

Zico is a live visualizer for AI agents that discover services, make decisions,
use paid APIs, and report their result through Circle’s Agent Stack.

The agent does the work. Zico gives you a clear window into what happened:
what it searched, what it considered, what it chose, what it paid, and what it
learned.

Zico is a listener. The Circle CLI performs every real action, and the agent
reports it here to be logged and drawn. Zico holds no wallet, makes no
payments, and queries no marketplace — so it can never show you something
different from what actually happened.

## Install

Requirements: Node.js 20.18.2 or newer. No wallet is needed to run the server.

Install it globally:

```bash
npm install --global zico-agent-graph
zico serve --pace 220
```

When running directly from this repository, use:

```bash
node src/cli.js serve --pace 220
```

## Connect Zico to your coding agent

From the project folder you want Codex or Claude Code to work in, install or
run Zico and copy the matching instructions into that folder:

```bash
# Claude Code
npx zico-agent-graph@0.2.0 init --agent claude

# Codex
npx zico-agent-graph@0.2.0 init --agent codex
```

You can use `--agent both` when the project will be opened by either tool.
Then open that same folder in your coding agent. Existing `AGENTS.md` or
`CLAUDE.md` files are kept unchanged; add `--force` only when you intend to
replace one with Zico’s instructions.

Open [http://localhost:4200](http://localhost:4200), then use a second terminal:

```bash
node src/cli.js task "Research the current price of ETH" --budget 0.40
circle services search "token price" --output json | node src/cli.js search "token price"
```

Circle runs the search; Zico records the result set you actually saw. Copy a
resource URL from it and continue:

```bash
node src/cli.js decide "<resource-url>" --reason "best fit for the question"

circle services pay "<resource-url>" --data '{"symbol":"ETH"}' --max-amount 0.05 --output json
node src/cli.js record "<resource-url>" --cost <actual> --tx <hash> --output '<response>'

node src/cli.js done --summary "Finished the research."
```

Search is free. `circle services pay` spends real USDC; Zico records only the
figure that settled.

## Use real Circle services

Paid calls use a real Agent Wallet and real USDC. Set that up before you run
one — Zico itself needs nothing.

In your coding agent, paste:

```text
Run curl -sL https://agents.circle.com/skills/setup.md and follow the returned setup instructions to set up my agent wallet.
```

Follow Circle’s instructions to install the CLI, accept the terms, authenticate
with the email OTP, create or select an Agent Wallet, and fund it. Zico needs no
setup of its own — the same `serve` command covers every run:

```bash
node src/cli.js serve --pace 220
```

Enforce budgets with `circle services pay --max-amount`. That is the only place
a cap can actually stop a transfer, and Circle remains the authoritative
spending-policy layer. Zico cannot refuse a payment; it only records one.

Recorded payments show their payment rail and transaction hash in the inspector.

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
| `node src/cli.js serve` | Start the visualizer |
| `zico init --agent claude` | Add Claude Code instructions to the current project |
| `zico init --agent codex` | Add Codex instructions to the current project |
| `node src/cli.js task "<objective>" --budget 0.40` | Start a run |
| `circle services search "<q>" --output json \| node src/cli.js search "<q>"` | Record a search Circle ran |
| `node src/cli.js decide "<resource>" --reason "<why>"` | Record a choice |
| `node src/cli.js record "<resource>" --cost N --tx 0x…` | Record a payment Circle made |
| `node src/cli.js note "<text>"` | Add an analysis or synthesis note |
| `node src/cli.js done --summary "<result>"` | Finish the run |
| `node src/cli.js export --out demo.html` | Create a shareable replay |

## Important

Zico is an observer, not the agent, planner, or operator. For the graph to
update, the agent must report each step with the commands above. The browser is
read-only; commands and decisions stay in the terminal.

Because Zico only ever records what it is told, a figure reported incorrectly
becomes a figure shown incorrectly. The graph is exactly as honest as the agent
writing to it.

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
