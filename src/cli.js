#!/usr/bin/env node
// zico — the graph. The agent driving these verbs is the planner; the Circle
// CLI is the operator. Every verb here records something that already happened.
//
//   zico serve [--port 4200] [--pace 130]  ms between graph emissions
//   zico init --agent codex|claude|both [--force]
//   zico task "<objective>" [--budget 0.40]
//   zico search "<query>" [--results-file <path>] [--max-price 0.02] [--limit 6]
//   zico decide <resource> --reason "<why>"
//   zico record <resource> --cost 0.02 [--tx 0x…] [--output '{…}']
//   zico note "<text>" [--type analysis|synthesis]
//   zico done --summary "<result>"
//   zico status
//   zico export [taskId] [--out file.html] [--speed 1]   share a run as one file

import { access, copyFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, DATA_ROOT } from './events.js';
import { startServer } from './server.js';
import { exportRun } from './export.js';

const NL = String.fromCharCode(10);

const argv = process.argv.slice(2);
const verb = argv[0];
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

// First non-flag argument after the verb, skipping any flag values.
function positional() {
  const skip = new Set();
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) skip.add(i + 1);
  }
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith('--') && !skip.has(i)) return argv[i];
  }
  return null;
}

const PORT = Number(flag('port', process.env.ZICO_PORT ?? '4200'));
const BASE = `http://localhost:${PORT}`;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const gold = (s) => `\x1b[33m${s}\x1b[0m`;

async function api(path, body) {
  let res;
  try {
    res = await fetch(`${BASE}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    fail(`no zico server on ${BASE} — start one with ${bold('zico serve')}`);
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) fail(out.error ?? `${res.status} ${res.statusText}`);
  return out;
}

function fail(msg) {
  console.error(`${red('error')} ${msg}`);
  process.exit(1);
}

const money = (n) => `$${Number(n).toFixed(4)}`;

switch (verb) {
  case 'serve': await serve(); break;
  case 'init': await init(); break;
  case 'task': await task(); break;
  case 'search': await search(); break;
  case 'decide': await decide(); break;
  case 'call': await call(); break;
  case 'record': await record(); break;
  case 'note': await note(); break;
  case 'done': await done(); break;
  case 'status': await status(); break;
  case 'export': await exportCmd(); break;
  default: usage(1);
}

// ---------------------------------------------------------------------------

async function serve() {
  const restored = await log.restore();
  const pace = flag('pace') !== null ? Number(flag('pace')) : 130;

  // No preflight, no wallet, no executor. Zico logs what the Circle CLI reports;
  // it has nothing to verify before it can start listening.
  const { url } = await startServer({ log, port: PORT, pace });

  console.log();
  console.log(`  ${bold('zico')} ${dim('· execution graph for the Circle Agent Stack')}`);
  console.log(`  ${dim('graph')}    ${cyan(url)}`);
  console.log(`  ${dim('role')}     observer — the Circle CLI executes, Zico records`);
  // Always shown: an unexpected store is the difference between "no history"
  // and "history you are not looking at", and only the path tells them apart.
  console.log(`  ${dim('data')}     ${DATA_ROOT}`);
  console.log(`  ${dim('history')}  ${restored ? `${restored} previous run(s) restored` : dim('no previous runs here')}`);
  console.log();
  console.log(dim('  waiting for an agent to drive it — zico task "<objective>"'));
  console.log();

  const names = new Map();
  log.on('event', (ev) => {
    const t = new Date(ev.ts).toTimeString().slice(0, 8);
    const label = (id) => names.get(id) ?? id;
    switch (ev.type) {
      case 'task_created':
        console.log(`  ${dim(t)} ${bold('task')} ${ev.prompt}`);
        break;
      case 'node_added':
        names.set(ev.nodeId, ev.name);
        break;
      case 'node_started':
        console.log(`  ${dim(t)} ${cyan('▸')} ${label(ev.nodeId)}`);
        break;
      case 'node_completed':
        console.log(`  ${dim(t)} ${green('✓')} ${label(ev.nodeId)}`);
        break;
      case 'node_failed':
        console.log(`  ${dim(t)} ${red('✗')} ${label(ev.nodeId)} ${dim(ev.error ?? '')}`);
        break;
      case 'payment':
        console.log(`  ${dim(t)} ${gold('$')} ${money(ev.amount)} USDC → ${ev.service} ${dim(ev.rail)}`);
        break;
      case 'task_completed':
        console.log(`  ${dim(t)} ${bold('done')} ${money(ev.summary?.spent ?? 0)} over ${ev.summary?.calls ?? 0} call(s)`);
        break;
    }
  });
}

async function init() {
  const agent = flag('agent')?.toLowerCase();
  const targets = {
    codex: 'AGENTS.md',
    claude: 'CLAUDE.md',
  };

  if (!agent || !['codex', 'claude', 'both'].includes(agent)) {
    fail('usage: zico init --agent codex|claude|both [--force]');
  }

  const names = agent === 'both' ? Object.values(targets) : [targets[agent]];
  const force = has('force');
  const destination = process.cwd();
  const copied = [];
  const skipped = [];

  for (const name of names) {
    const source = join(PACKAGE_ROOT, name);
    const target = join(destination, name);
    try {
      await access(source);
    } catch {
      fail(`the published package is missing its ${name} template`);
    }

    try {
      await access(target);
      if (!force) {
        skipped.push(name);
        continue;
      }
    } catch {
      // The destination does not exist yet.
    }

    await copyFile(source, target);
    copied.push(name);
  }

  if (copied.length) {
    console.log(`${green('initialized')} ${copied.join(', ')} ${dim(`in ${destination}`)}`);
  }
  if (skipped.length) {
    console.log(`${dim('kept')} ${skipped.join(', ')} ${dim('(already exists; use --force to replace)')}`);
  }
  if (!copied.length && !skipped.length) {
    console.log(dim('nothing to initialize'));
  }
}

async function task() {
  const objective = positional();
  if (!objective) fail('usage: zico task "<objective>" [--budget 0.40]');
  const budget = flag('budget') ? Number(flag('budget')) : null;
  const out = await api('task', { objective, budget });
  if (has('json')) return console.log(JSON.stringify(out, null, 2));
  console.log(`${green('task')} ${out.taskId}${budget ? dim(` · budget ${money(budget)} USDC`) : ''}`);
  console.log(dim(`graph  ${BASE}`));
}

async function search() {
  const query = positional();
  if (!query) {
    fail('usage: circle services search "<query>" --output json | zico search "<query>"'
      + `${NL}         (or: zico search "<query>" --results-file <path> | --results '<json>')`);
  }

  // Zico does not query the marketplace. The operator runs `circle services
  // search` and reports the result, so the graph shows exactly the list the
  // decision was made from.
  const results = await readReported();
  if (results === null) {
    fail('no search results on stdin — run `circle services search "' + query + '" --output json`'
      + `${NL}       and pipe it here, or pass --results-file <path>`);
  }

  const out = await api('search', {
    query,
    results,
    maxPrice: flag('max-price') ? Number(flag('max-price')) : undefined,
    category: flag('category') ?? undefined,
    limit: flag('limit') ? Number(flag('limit')) : undefined,
  });
  if (has('json')) return console.log(JSON.stringify(out, null, 2));

  console.log(`${green('recorded')} ${out.found} of ${out.reportedCount} reported services ${dim(`· "${out.query}"`)}\n`);
  for (const r of out.results) {
    console.log(`  ${gold(money(r.price).padEnd(9))} ${bold(r.brand.padEnd(16))} ${dim(r.category)}`);
    console.log(`  ${' '.repeat(9)} ${r.description.slice(0, 78)}`);
    console.log(`  ${' '.repeat(9)} ${dim(r.resource)}`);
    if (r.required?.length) console.log(`  ${' '.repeat(9)} ${dim(`required: ${r.required.join(', ')}`)}`);
    console.log();
  }
  console.log(dim('choose one:  zico decide <resource> --reason "<why>"'));
}

/**
 * Collect a reported result set from --results, --results-file, or a pipe.
 * Returns null when the operator gave us nothing, so the caller can explain
 * what to run rather than recording an empty search as though it found nothing.
 */
async function readReported() {
  const inline = flag('results');
  if (inline) {
    try { return JSON.parse(inline); } catch { fail('--results must be valid JSON'); }
  }

  const file = flag('results-file');
  if (file) {
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch (e) { fail(`cannot read ${file}: ${e.code ?? e.message}`); }
    try { return JSON.parse(text); } catch { fail(`${file} is not valid JSON`); }
  }

  // A TTY means nothing is piped in; reading would hang waiting for the user.
  if (process.stdin.isTTY) return null;

  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { fail('piped input is not valid JSON'); }
}

async function decide() {
  const choose = positional();
  if (!choose) fail('usage: zico decide <resource> --reason "<why>"');
  const out = await api('decide', { choose, reason: flag('reason') });
  if (has('json')) return console.log(JSON.stringify(out, null, 2));
  console.log(`${green('selected')} ${bold(out.chosen.brand)} ${gold(money(out.chosen.price))} ${dim(`· ${out.consideredCount} considered`)}`);
}

// `zico call` used to pay for the service itself. It no longer exists: Zico
// does not hold a wallet and does not transact. Kept as a signpost so the old
// command explains the split instead of dying on "unknown verb".
function call() {
  const resource = positional() ?? '<resource>';
  fail([
    'zico no longer executes calls — the Circle CLI pays, Zico records.',
    '',
    '  1. ' + bold(`circle services pay ${resource} --data '{…}' --max-amount <cap>`),
    '  2. ' + bold(`zico record ${resource} --cost <actual> --tx <hash> --output '<response>'`),
    '',
    dim('  The cap is enforced by Circle at payment time, which is the only place'),
    dim('  it can actually stop a transfer.'),
  ].join(NL));
}

async function record() {
  const resource = positional();
  if (!resource) fail(`usage: zico record <resource> --cost 0.02 [--tx 0x…] [--input '{…}'] [--output '{…}'] [--error "…"]`);
  const parse = (name) => {
    const raw = flag(name);
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { fail(`--${name} must be valid JSON`); }
  };
  const cost = flag('cost') !== null ? Number(flag('cost')) : undefined;
  if (cost !== undefined && !Number.isFinite(cost)) fail('--cost must be a number');

  const out = await api('record', {
    resource,
    input: parse('input') ?? {},
    output: parse('output') ?? null,
    cost,
    txHash: flag('tx') ?? undefined,
    error: flag('error') ?? undefined,
  });
  if (has('json')) return console.log(JSON.stringify(out, null, 2));
  if (!out.ok) return console.log(`${red('recorded failure')} ${dim(out.error)}`);
  console.log(`${green('recorded')} ${dim(`${money(out.cost)} USDC — executed externally`)}`);
}

async function note() {
  const text = positional();
  if (!text) fail('usage: zico note "<text>" [--type analysis|synthesis] [--parents id,id]');
  const parents = flag('parents') ? flag('parents').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  await api('note', { text, type: flag('type', 'analysis'), parents, task: flag('task') ?? undefined });
  console.log(`${green('noted')} ${dim(text.slice(0, 60))}`);
}

async function done() {
  const summary = flag('summary') ?? positional();
  const out = await api('done', { summary });
  if (has('json')) return console.log(JSON.stringify(out, null, 2));
  console.log(`${bold('complete')} ${out.taskId} ${dim(`· ${money(out.spent)} USDC over ${out.calls} call(s)`)}`);
}

async function status() {
  const s = await api('session');
  const state = await api('state');
  console.log(`${dim('server ')} ${BASE} ${dim(`· ${s.mode}`)}`);
  console.log(`${dim('task   ')} ${s.taskId ?? dim('none active')}`);
  console.log(`${dim('runs   ')} ${state.tasks.length} · ${state.nodes.length} nodes`);
  for (const t of state.tasks.slice(-5)) {
    console.log(`  ${t.status === 'done' ? green('✓') : cyan('▸')} ${t.id} ${gold(money(t.spent))} ${dim(t.prompt.slice(0, 50))}`);
  }
}

function usage(exitCode = 0) {
  console.log(`
  ${bold('zico')} — execution graph for the Circle Agent Stack

  ${dim('The Circle CLI does the work. Zico records it and draws the graph.')}
  ${dim('Zico holds no wallet, makes no payments, and queries no marketplace.')}

  ${dim('zico serve')} [--port 4200] [--pace N]    start the graph server
  ${dim('zico init')} --agent codex|claude|both    add agent instructions here
  ${dim('zico task')} "<objective>" [--budget N]  begin a run
  ${dim('zico search')} "<query>"                 record a search you already ran
  ${dim('zico decide')} <resource> --reason "…"   record the choice and why
  ${dim('zico record')} <resource> --cost N [--tx …]  record a payment Circle already made
  ${dim('zico note')} "<text>" [--parents a,b]     add a reasoning node (merges branches)
  ${dim('zico done')} --summary "<result>"        close the run
  ${dim('zico status')}                           what is running

  ${dim('Reporting a search and a payment:')}
    circle services search "email" --output json | zico search "email"
    circle services pay <resource> --data '{…}' --max-amount 0.05 --output json
    zico record <resource> --cost 0.02 --tx 0x… --output '<response>'

  Add --json to any verb for machine-readable output.
`);
  if (exitCode) process.exit(exitCode);
}

async function exportCmd() {
  const { events } = await api('events');
  const res = await exportRun({
    events,
    taskId: positional(),
    out: flag('out') ?? undefined,
    speed: flag('speed') !== null ? Number(flag('speed')) : 1,
  });
  console.log();
  console.log(`  ${green('exported')} ${bold(res.file)}`);
  console.log(`  ${dim('run')}      ${res.taskId}  ${dim(`${res.events} events`)}`);
  console.log(`  ${dim('objective')} ${res.title}`);
  console.log();
  console.log(dim('  Self-contained: no server, no wallet, no network. Send the file or host it anywhere.'));
  console.log();
}
