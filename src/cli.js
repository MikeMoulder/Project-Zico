#!/usr/bin/env node
// zico — marketplace tools + live graph. The agent driving these verbs is the planner.
//
//   zico serve [--port 4200] [--live] [--pace 130]  ms between graph emissions
//   zico init --agent codex|claude|both [--force]
//   zico task "<objective>" [--budget 0.40]
//   zico search "<query>" [--max-price 0.02] [--category FINANCIAL_ANALYSIS] [--limit 6]
//   zico decide <resource> --reason "<why>"
//   zico call <resource> --input '{"q":"..."}'
//   zico note "<text>" [--type analysis|synthesis]
//   zico done --summary "<result>"
//   zico status
//   zico export [taskId] [--out file.html] [--speed 1]   share a run as one file

import { access, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './events.js';
import { startServer } from './server.js';
import { preflight, explain } from './wallet.js';
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
  case 'note': await note(); break;
  case 'done': await done(); break;
  case 'status': await status(); break;
  case 'export': await exportCmd(); break;
  default: usage(1);
}

// ---------------------------------------------------------------------------

async function serve() {
  const live = has('live');
  const restored = await log.restore();
  const pace = flag('pace') !== null ? Number(flag('pace')) : 130;

  // Live mode spends real USDC. Verify the whole chain — CLI, login, wallet,
  // funding — before binding a port, so failures arrive with instructions
  // instead of halfway through a run the graph has already started drawing.
  let wallet = null;
  if (live) {
    process.stdout.write(dim('  checking Circle wallet… '));
    wallet = await preflight({ address: flag('address') ?? null });
    if (!wallet.ok) {
      console.log(red('failed'));
      console.log();
      console.log(explain(wallet).split(NL).map((l) => '  ' + l).join(NL));
      console.log();
      process.exit(1);
    }
    console.log(green('ok'));
  }

  const { url, catalog, mode } = await startServer({ log, port: PORT, live, pace, wallet });

  console.log();
  console.log(`  ${bold('zico')} ${dim('· live execution graph for the Circle Agent Stack')}`);
  console.log(`  ${dim('graph')}    ${cyan(url)}`);
  console.log(`  ${dim('catalog')}  ${catalog.callable} callable of ${catalog.totalListings} listings`);
  console.log(`  ${dim('mode')}     ${mode === 'circle' ? red('LIVE — real USDC on Base') : 'simulated (no payments)'}`);
  if (wallet?.ok) {
    console.log(`  ${dim('wallet')}   ${wallet.address}`);
    console.log(`  ${dim('balance')}  ${wallet.usable.toFixed(4)} USDC ${dim(`(gateway ${wallet.balances.gateway.toFixed(4)} · onchain ${wallet.balances.onchain.toFixed(4)})`)}`);
  }
  if (restored) console.log(`  ${dim('history')}  ${restored} previous run(s) restored`);
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
  if (!query) fail('usage: zico search "<query>" [--max-price 0.02] [--category X] [--limit 6]');
  const out = await api('search', {
    query,
    maxPrice: flag('max-price') ? Number(flag('max-price')) : undefined,
    category: flag('category') ?? undefined,
    limit: flag('limit') ? Number(flag('limit')) : undefined,
  });
  if (has('json')) return console.log(JSON.stringify(out, null, 2));

  console.log(`${green('found')} ${out.found} of ${out.scanned} callable services ${dim(`· "${out.query}"`)}\n`);
  for (const r of out.results) {
    console.log(`  ${gold(money(r.price).padEnd(9))} ${bold(r.brand.padEnd(16))} ${dim(r.category)}`);
    console.log(`  ${' '.repeat(9)} ${r.description.slice(0, 78)}`);
    console.log(`  ${' '.repeat(9)} ${dim(r.resource)}`);
    if (r.required?.length) console.log(`  ${' '.repeat(9)} ${dim(`required: ${r.required.join(', ')}`)}`);
    console.log();
  }
  console.log(dim('choose one:  zico decide <resource> --reason "<why>"'));
}

async function decide() {
  const choose = positional();
  if (!choose) fail('usage: zico decide <resource> --reason "<why>"');
  const out = await api('decide', { choose, reason: flag('reason') });
  if (has('json')) return console.log(JSON.stringify(out, null, 2));
  console.log(`${green('selected')} ${bold(out.chosen.brand)} ${gold(money(out.chosen.price))} ${dim(`· ${out.consideredCount} considered`)}`);
}

async function call() {
  const resource = positional();
  if (!resource) fail(`usage: zico call <resource> --input '{"q":"..."}'`);
  let input = {};
  const raw = flag('input');
  if (raw) {
    try { input = JSON.parse(raw); } catch { fail('--input must be valid JSON'); }
  }
  const out = await api('call', { resource, input });
  if (has('json')) return console.log(JSON.stringify(out, null, 2));
  if (!out.ok) fail(out.error);
  console.log(`${green('ok')} ${dim(`paid ${money(out.cost)} USDC`)}`);
  console.log(JSON.stringify(out.output, null, 2));
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
  console.log(`${dim('catalog')} ${s.catalog.callable} callable of ${s.catalog.listings}`);
  console.log(`${dim('task   ')} ${s.taskId ?? dim('none active')}`);
  console.log(`${dim('runs   ')} ${state.tasks.length} · ${state.nodes.length} nodes`);
  for (const t of state.tasks.slice(-5)) {
    console.log(`  ${t.status === 'done' ? green('✓') : cyan('▸')} ${t.id} ${gold(money(t.spent))} ${dim(t.prompt.slice(0, 50))}`);
  }
}

function usage(exitCode = 0) {
  console.log(`
  ${bold('zico')} — live execution graph for the Circle Agent Stack

  ${dim('zico serve')} [--port 4200] [--live]     start the graph server
  ${dim('zico init')} --agent codex|claude|both    add agent instructions here
  ${dim('zico task')} "<objective>" [--budget N]  begin a run
  ${dim('zico search')} "<query>" [--max-price N] search the marketplace
  ${dim('zico decide')} <resource> --reason "…"   record the choice and why
  ${dim('zico call')} <resource> --input '{…}'    pay for and invoke it
  ${dim('zico note')} "<text>" [--parents a,b]     add a reasoning node (merges branches)
  ${dim('zico done')} --summary "<result>"        close the run
  ${dim('zico status')}                           what is running

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
