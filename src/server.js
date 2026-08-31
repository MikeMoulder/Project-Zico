// zico serve — holds the graph and serves the visualizer.
//
// Zico is a listener. It does not search the marketplace, does not hold a
// wallet, does not pay, and cannot veto. The Circle CLI performs every real
// action independently, and the agent driving it reports what happened here to
// be logged and drawn. Nothing in this file may move money or reach the network:
// if a verb ever needs to *do* something rather than record it, it belongs in
// the operator, not the observer.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { EV, NODE } from './events.js';
import { fromReported, hostOf } from './listings.js';

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

export async function startServer({ log, port = 4200, pace = 130 } = {}) {
  const clients = new Set();

  // Every payment node this server draws was executed elsewhere and reported in.
  // There is no other mode, so nothing downstream has to ask which one is active.
  const MODE = 'recorded';

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
        taskId, prompt: objective, budget: budget ?? null, mode: MODE,
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

    // Records a search the operator already ran. `results` is whatever
    // `circle services search --output json` printed; Zico parses and draws it
    // but never issues the query itself.
    async search({ query, results: reported, maxPrice, category, limit = 6 }) {
      requireTask();
      const { taskId } = session;

      if (reported === undefined || reported === null) {
        throw new Error(
          'search results must be reported — run `circle services search "<query>" --output json` '
          + 'and pass its output (zico search "<query>" --results-file <path>, or pipe it in)',
        );
      }

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
          query, reused: true, found: cached.results.length, reportedCount: cached.reportedCount,
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

      // The operator's filters are applied only so the graph matches what they
      // saw on screen — they are presentation, not gatekeeping. Ordering is left
      // exactly as reported: Circle already ranked these, and re-sorting would
      // show a different list than the one the decision was actually made from.
      const all = fromReported(reported);
      const reportedCount = all.length;
      const results = all
        .filter((s) => (maxPrice == null ? true : s.price <= maxPrice))
        .filter((s) => (category ? s.category === category : true))
        .slice(0, limit);

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
      session.searchCache.set(cacheKey, { searchNode, groupNode, results, reportedCount });

      await log.emitEvent(EV.NODE_COMPLETED, {
        taskId, nodeId: searchNode,
        output: { query, found: results.length, reported: reportedCount },
      });

      return {
        query,
        found: results.length,
        reportedCount,
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

    // The only payment path. The operator (Circle CLI) already paid and holds
    // the true cost, txHash and response; Zico draws the node from that report.
    async record({ resource, input, output, cost, txHash, error, brand, network, gasless }) {
      requireTask();
      const { taskId } = session;

      // A logger records what it is told. A resource the run never searched for
      // is routine — the operator may pay something it found elsewhere — and is
      // never grounds to refuse an event describing money that already moved.
      const known = session.candidates.get(resource);
      const service = known ?? {
        resource,
        brand: brand ?? hostOf(resource),
        provider: brand ?? hostOf(resource),
        category: 'UNREPORTED',
        network: network ?? null,
        gasless: gasless ?? false,
        price: Number(cost) || 0,
        description: 'executed by Circle CLI · not seen in this run’s search',
        method: 'POST',
      };

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

      // A reported failure is still a real outcome — surface it, don't drop it.
      if (error) {
        await log.emitEvent(EV.NODE_FAILED, { taskId, nodeId, error: String(error) });
        return { ok: false, error: String(error), nodeId };
      }

      // Trust the reported figure: it is what actually settled onchain, which
      // is the whole point of recording rather than estimating. The listed price
      // is only a fallback for a caller that supplies nothing — the two diverge
      // whenever a seller reprices between discovery and payment.
      const spent = Number(cost ?? service.price) || 0;

      if (spent > 0) {
        const payNode = `node_${shortId()}`;
        await log.emitEvent(EV.NODE_ADDED, {
          taskId, nodeId: payNode, parents: [nodeId],
          nodeType: NODE.PAYMENT,
          name: `$${spent.toFixed(4)} USDC`,
          description: service.gasless ? 'circle gateway · gasless' : 'x402 · onchain',
          service: slim(service),
        });
        await log.emitEvent(EV.PAYMENT, {
          taskId, nodeId: payNode,
          amount: spent, currency: 'USDC',
          service: service.brand, network: service.network,
          rail: service.gasless ? 'circle-gateway' : 'x402',
          mode: 'recorded', txHash: txHash ?? null,
        });
        await log.emitEvent(EV.NODE_COMPLETED, { taskId, nodeId: payNode });
      }

      await log.emitEvent(EV.NODE_COMPLETED, { taskId, nodeId, output: output ?? null });
      return { ok: true, nodeId, cost: spent, output: output ?? null };
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

  const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u).slice(0, 60); } };

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
        mode: MODE,
      });
    }

    // No `call`: Zico has no execution path. Payments are made by the Circle CLI
    // and arrive here through `record`.
    const verb = /^\/api\/(task|search|decide|record|note|done)$/.exec(url.pathname);
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
      server, port, url: `http://localhost:${port}`, mode: MODE,
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
