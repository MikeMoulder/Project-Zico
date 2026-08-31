// zico serve — holds the graph, serves the visualizer, and acts as the tool backend
// for the CLI verbs. The agent (Claude Code, Codex, any host) drives it over HTTP;
// every verb it calls becomes nodes and edges in the live graph.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { EV, NODE } from './events.js';
import { loadCatalog, search as searchCatalog } from './catalog.js';
import { makeExecutor } from './executor.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const shortId = () => randomUUID().slice(0, 8);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Terminal node of a closed run, so an amendment attaches to its end. */
function lastNodeOf(log, taskId) {
  const ns = log.project().nodes.filter((n) => n.taskId === taskId);
  if (!ns.length) return [];
  const result = ns.filter((n) => n.type === 'result').pop();
  return [(result ?? ns[ns.length - 1]).id];
}

export async function startServer({ log, port = 4200, live = false, pace = 130, wallet = null } = {}) {
  const clients = new Set();
  const catalog = await loadCatalog();
  const executor = live
    ? makeExecutor('circle', { address: wallet?.address ?? null, chain: wallet?.chain ?? 'BASE' })
    : makeExecutor('simulated');

  // Session state so CLI verbs chain without the caller tracking node ids.
  const session = {
    taskId: null,
    budget: null,
    planNode: null,
    lastSearchNode: null,
    lastDecisionNode: null,
    candidateNodes: new Map(), // resource -> nodeId, every candidate this run
    candidates: new Map(),     // resource -> normalized service, every candidate this run
    lastSearch: new Map(),     // resource -> service, the most recent search only
    searchCache: new Map(),    // normalized query -> {searchNode, groupNode, results}
  };

  log.on('event', (ev) => {
    const frame = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(frame);
  });

  // ---- verbs ------------------------------------------------------------

  const shapeResult = (s) => ({
    resource: s.resource, brand: s.brand, provider: s.provider,
    category: s.category, price: s.price, description: s.description,
    network: s.network, gasless: s.gasless,
    required: s.required, params: Object.keys(s.params ?? {}),
  });

  const verbs = {
    async task({ objective, budget }) {
      const taskId = `task_${shortId()}`;
      session.taskId = taskId;
      session.budget = budget ?? null;
      session.candidateNodes.clear();
      session.candidates.clear();
      session.lastSearch.clear();
      session.searchCache.clear();

      await log.emitEvent(EV.TASK_CREATED, {
        taskId, prompt: objective, budget: budget ?? null, mode: executor.mode,
      });

      const planNode = `node_${shortId()}`;
      session.planNode = planNode;
      await log.emitEvent(EV.NODE_ADDED, {
        taskId, nodeId: planNode, parents: [],
        nodeType: NODE.PLAN, name: 'Plan',
        description: budget ? `budget $${Number(budget).toFixed(2)} USDC` : 'no budget set',
      });
      await log.emitEvent(EV.NODE_STARTED, { taskId, nodeId: planNode });

      return { taskId, planNode, budget: session.budget };
    },

    async search({ query, maxPrice, category, limit = 6 }) {
      requireTask();
      const { taskId } = session;

      // Re-running a query used to emit a fresh search node and a fresh block of
      // candidates, so probing the marketplace a few times fanned the graph out
      // sideways. Same query, same node.
      const cacheKey = [
        String(query).trim().toLowerCase().replace(/\s+/g, ' '),
        maxPrice ?? '', category ?? '',
      ].join('|');
      const cached = session.searchCache.get(cacheKey);
      if (cached) {
        session.lastSearchNode = cached.searchNode;
        session.lastSearch = new Map(cached.results.map((s) => [s.resource, s]));
        return {
          query, reused: true, found: cached.results.length, scanned: catalog.callable,
          results: cached.results.map(shapeResult),
        };
      }

      const searchNode = `node_${shortId()}`;
      session.lastSearchNode = searchNode;
      await log.emitEvent(EV.NODE_ADDED, {
        taskId, nodeId: searchNode, parents: [session.planNode].filter(Boolean),
        nodeType: NODE.SEARCH, name: 'Marketplace search',
        description: query,
        meta: { query, maxPrice: maxPrice ?? null, category: category ?? null },
      });
      await log.emitEvent(EV.NODE_STARTED, { taskId, nodeId: searchNode });

      // Candidates from the previous search that were never chosen would otherwise
      // sit pending forever and make the graph look stuck. Retire them.
      const superseded = new Set();
      for (const resource of session.lastSearch.keys()) {
        const prev = session.candidateNodes.get(resource);
        if (prev) superseded.add(prev);
      }
      for (const nodeId of superseded) {
        await log.emitEvent(EV.NODE_REJECTED, { taskId, nodeId, reason: 'superseded by a later search' });
      }
      session.lastSearch.clear();

      const results = searchCatalog(catalog, query, {
        maxPrice: maxPrice ?? Infinity,
        category: category ?? null,
        gaslessOnly: false,
        limit,
      });

      // A result set is one node, not one node per hit. Thirty boxes reading
      // "agentmail" told the operator nothing that "5 candidates" does not, and
      // they crowded out the two nodes that actually did work.
      let groupNode = null;
      if (results.length) {
        groupNode = `node_${shortId()}`;
        await sleep(pace);
        const brands = [...new Set(results.map((s) => s.brand))];
        await log.emitEvent(EV.NODE_ADDED, {
          taskId, nodeId: groupNode, parents: [searchNode],
          nodeType: NODE.CANDIDATE,
          name: results.length === 1 ? results[0].brand : `${results.length} candidates`,
          description: brands.slice(0, 3).join(', ') + (brands.length > 3 ? ` +${brands.length - 3} more` : ''),
          estCost: Math.min(...results.map((s) => s.price)),
          service: slim(results[0]),
          meta: {
            group: true,
            count: results.length,
            candidates: results.map((s) => ({
              brand: s.brand, price: s.price, resource: s.resource, gasless: s.gasless,
            })),
          },
        });
      }
      for (const s of results) {
        session.candidateNodes.set(s.resource, groupNode);
        session.candidates.set(s.resource, s);
        session.lastSearch.set(s.resource, s);
      }
      session.searchCache.set(cacheKey, { searchNode, groupNode, results });

      await log.emitEvent(EV.NODE_COMPLETED, {
        taskId, nodeId: searchNode,
        output: { query, found: results.length, scanned: catalog.callable },
      });

      return {
        query,
        found: results.length,
        scanned: catalog.callable,
        results: results.map(shapeResult),
      };
    },

    async decide({ choose, reason }) {
      requireTask();
      const { taskId } = session;
      const chosen = session.candidates.get(choose);
      if (!chosen) throw new Error(`no candidate for resource ${choose} — run "zico search" first`);

      // Alternatives are the options from the search this choice came out of —
      // not every service seen so far this run.
      const pool = session.lastSearch.has(choose) ? session.lastSearch : session.candidates;
      const considered = [...pool.values()];
      const decisionNode = `node_${shortId()}`;
      session.lastDecisionNode = decisionNode;

      // The chosen candidate is resolved, not left hanging in pending.
      const chosenNode = session.candidateNodes.get(choose);
      if (chosenNode) await log.emitEvent(EV.NODE_COMPLETED, { taskId, nodeId: chosenNode });

      await log.emitEvent(EV.NODE_ADDED, {
        taskId, nodeId: decisionNode,
        parents: [session.candidateNodes.get(choose)].filter(Boolean),
        nodeType: NODE.DECISION,
        name: `Selected ${chosen.brand}`,
        description: reason ?? 'no reason given',
        estCost: chosen.price,
        service: slim(chosen),
        meta: {
          reason: reason ?? null,
          consideredCount: considered.length,
          alternatives: considered
            .filter((s) => s.resource !== choose)
            .map((s) => ({ brand: s.brand, price: s.price, resource: s.resource })),
        },
      });
      await sleep(pace * 3);   // a beat of deliberation, so the choice reads as a moment
      await log.emitEvent(EV.NODE_COMPLETED, { taskId, nodeId: decisionNode });

      // Grey out the rest of *this* search, so the graph shows the road not taken
      // without retroactively rejecting candidates from earlier steps.
      // Every resource in a group points at the same node, so rejecting per
      // resource would grey out the node the choice was just attached to.
      const dropped = new Set();
      for (const resource of pool.keys()) {
        if (resource === choose) continue;
        const nodeId = session.candidateNodes.get(resource);
        if (!nodeId || nodeId === chosenNode) continue;
        dropped.add(nodeId);
      }
      for (const nodeId of dropped) {
        await sleep(Math.round(pace * 0.45));
        await log.emitEvent(EV.NODE_REJECTED, { taskId, nodeId, reason: 'not selected' });
      }

      return { decisionNode, chosen: slim(chosen), consideredCount: considered.length };
    },

    async call({ resource, input }) {
      requireTask();
      const { taskId } = session;
      const service = session.candidates.get(resource)
        ?? catalog.services.find((s) => s.resource === resource);
      if (!service) throw new Error(`unknown service ${resource}`);

      const parents = [session.lastDecisionNode ?? session.candidateNodes.get(resource) ?? session.planNode]
        .filter(Boolean);

      const nodeId = `node_${shortId()}`;
      await log.emitEvent(EV.NODE_ADDED, {
        taskId, nodeId, parents,
        nodeType: NODE.TOOL_CALL, name: service.brand,
        description: service.description,
        estCost: service.price, service: slim(service), input: input ?? null,
      });
      await log.emitEvent(EV.NODE_STARTED, { taskId, nodeId });

      const task = log.project().tasks.find((t) => t.id === taskId);
      const remaining = session.budget === null || session.budget === undefined
        ? Infinity
        : Number(session.budget) - Number(task?.spent ?? 0);
      if (service.price > remaining + 1e-9) {
        const error = `budget cap reached: ${service.brand} costs $${service.price.toFixed(4)}, only $${Math.max(0, remaining).toFixed(4)} remains`;
        await log.emitEvent(EV.NODE_FAILED, { taskId, nodeId, error });
        return { ok: false, error, nodeId };
      }

      // Circle's CLI enforces this cap at payment time too. Keep it tight to
      // the discovered price so a stale listing cannot spend the whole budget.
      const maxAmount = Math.min(service.price, remaining);
      const res = await executor.call(service, input ?? {}, { maxAmount });

      if (!res.ok) {
        await log.emitEvent(EV.NODE_FAILED, { taskId, nodeId, error: res.error });
        return { ok: false, error: res.error, nodeId };
      }

      if (res.cost > 0) {
        const payNode = `node_${shortId()}`;
        await log.emitEvent(EV.NODE_ADDED, {
          taskId, nodeId: payNode, parents: [nodeId],
          nodeType: NODE.PAYMENT,
          name: executor.mode === 'circle'
            ? `$${res.cost.toFixed(4)} USDC`
            : `estimate $${res.cost.toFixed(4)} USDC`,
          description: executor.mode === 'circle'
            ? (service.gasless ? 'circle gateway · gasless' : 'x402 · onchain')
            : 'simulation · no payment',
          service: slim(service),
        });
        await log.emitEvent(EV.PAYMENT, {
          taskId, nodeId: payNode,
          amount: res.cost, currency: 'USDC',
          service: service.brand, network: service.network,
          rail: service.gasless ? 'circle-gateway' : 'x402',
          mode: executor.mode, txHash: res.txHash ?? null,
        });
        await log.emitEvent(EV.NODE_COMPLETED, { taskId, nodeId: payNode });
      }

      await log.emitEvent(EV.NODE_COMPLETED, { taskId, nodeId, output: res.output });
      return { ok: true, nodeId, cost: res.cost, output: res.output };
    },

    async note({ text, type = NODE.ANALYSIS, parents, task }) {
      if (!task) requireTask();
      const taskId = task ?? session.taskId;
      if (!taskId) throw new Error('no active task — pass --task <id> to amend a closed run');
      if (task && !log.project().tasks.some((t) => t.id === task))
        throw new Error(`unknown task ${task}`);
      const nodeId = `node_${shortId()}`;
      await log.emitEvent(EV.NODE_ADDED, {
        taskId, nodeId,
        parents: parents ?? (task
          ? lastNodeOf(log, task)
          : [session.lastDecisionNode ?? session.planNode].filter(Boolean)),
        nodeType: type, name: type.charAt(0).toUpperCase() + type.slice(1),
        description: text,
      });
      await log.emitEvent(EV.NODE_COMPLETED, { taskId, nodeId, output: { text } });
      return { nodeId };
    },

    async done({ summary }) {
      requireTask();
      const { taskId } = session;
      if (session.planNode) {
        await log.emitEvent(EV.NODE_COMPLETED, { taskId, nodeId: session.planNode });
      }
      const nodeId = `node_${shortId()}`;
      await log.emitEvent(EV.NODE_ADDED, {
        taskId, nodeId, parents: [session.lastDecisionNode ?? session.planNode].filter(Boolean),
        nodeType: NODE.RESULT, name: 'Result', description: summary ?? '',
      });
      await log.emitEvent(EV.NODE_COMPLETED, { taskId, nodeId, output: { summary } });

      const state = log.project();
      const task = state.tasks.find((t) => t.id === taskId);
      await log.emitEvent(EV.TASK_COMPLETED, {
        taskId,
        summary: { text: summary ?? null, spent: task?.spent ?? 0, calls: task?.calls ?? 0 },
      });

      const out = { taskId, spent: task?.spent ?? 0, calls: task?.calls ?? 0 };
      session.taskId = null;
      return out;
    },
  };

  function requireTask() {
    if (!session.taskId) throw new Error('no active task — run "zico task \'<objective>\'" first');
  }

  const slim = (s) => ({
    brand: s.brand, provider: s.provider, resource: s.resource,
    category: s.category, network: s.network, gasless: s.gasless, price: s.price,
    method: s.method ?? 'POST',
  });

  // ---- http -------------------------------------------------------------

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const since = Number(url.searchParams.get('since') ?? 0);
      for (const ev of log.since(since)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      res.write(': connected\n\n');

      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (url.pathname === '/api/state') return json(res, 200, log.project());
    // Raw log, for exporting a run to a standalone file.
    if (url.pathname === '/api/events') return json(res, 200, { events: log.events });
    if (url.pathname === '/api/session') {
      return json(res, 200, {
        taskId: session.taskId, budget: session.budget,
        catalog: { callable: catalog.callable, listings: catalog.totalListings },
        mode: executor.mode,
      });
    }

    const verb = /^\/api\/(task|search|decide|call|note|done)$/.exec(url.pathname);
    if (verb) {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      try {
        const body = await readBody(req);
        const out = await verbs[verb[1]](body);
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
    try {
      const buf = await readFile(join(WEB, rel));
      res.writeHead(200, {
        'content-type': MIME[extname(rel)] ?? 'application/octet-stream',
        // the visualizer changes constantly during development; a cached copy
        // silently hides every fix behind a hard refresh
        'cache-control': 'no-store, must-revalidate',
      });
      res.end(buf);
    } catch {
      json(res, 404, { error: 'not found' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve({
      server, port, url: `http://localhost:${port}`,
      catalog, mode: executor.mode,
    }));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
  });
  res.end(buf);
}
