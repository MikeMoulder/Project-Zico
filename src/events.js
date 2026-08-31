// Append-only event log. The task graph is *derived* from this, never stored directly.
// Everything the UI shows — nodes, edges, status, cost, timing — is a fold over these
// events, which is what makes replay free.
//
// Nodes carry `parents: []`, not a single parent, so verification/merge steps can
// converge two branches into one node.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_ROOT = process.env.ZICO_DATA_DIR ?? join(process.cwd(), '.zico');
const RUNS = join(DATA_ROOT, 'runs');

export const EV = {
  TASK_CREATED:   'task_created',
  NODE_ADDED:     'node_added',
  NODE_STARTED:   'node_started',
  NODE_COMPLETED: 'node_completed',
  NODE_FAILED:    'node_failed',
  NODE_REJECTED:  'node_rejected',
  PAYMENT:        'payment',
  LOG:            'log',
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED:    'task_failed',
};

/** Node types, mirroring concept.md section 8. */
export const NODE = {
  TASK:      'task',
  PLAN:      'plan',
  SEARCH:    'search',
  CANDIDATE: 'candidate',
  DECISION:  'decision',
  TOOL_CALL: 'tool_call',
  PAYMENT:   'payment',
  ANALYSIS:  'analysis',
  SYNTHESIS: 'synthesis',
  RESULT:    'result',
};

export class EventLog extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.events = [];
    this.seq = 0;
    // Appends must be serialised: two concurrent appendFile calls can land out of
    // order, and a node_completed written before its node_added corrupts replay.
    this.writeChain = Promise.resolve();
  }

  async emitEvent(type, payload = {}) {
    const ev = {
      seq: ++this.seq,
      id: randomUUID(),
      ts: Date.now(),
      type,
      ...payload,
    };
    this.events.push(ev);
    this.emit('event', ev);
    if (ev.taskId) {
      this.writeChain = this.writeChain.then(() => this.persist(ev)).catch(() => {});
    }
    return ev;
  }

  /** Wait for every queued append to land — call before reading the log back. */
  async flush() {
    await this.writeChain;
  }

  async persist(ev) {
    try {
      await mkdir(RUNS, { recursive: true });
      await appendFile(join(RUNS, `${ev.taskId}.jsonl`), JSON.stringify(ev) + '\n');
    } catch { /* persistence is best-effort; the live graph is the source of truth */ }
  }

  /** Rehydrate previous runs from disk so the browser shows run history. */
  async restore() {
    try {
      const files = (await readdir(RUNS)).filter((f) => f.endsWith('.jsonl'));
      const all = [];
      for (const f of files) {
        const text = await readFile(join(RUNS, f), 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { all.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
        }
      }
      // seq is the authoritative order within a run; ts collides at millisecond
      // resolution for events emitted back to back.
      all.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
      // Renumber so seq stays monotonic across restored runs and the live session.
      this.events = all.map((e, i) => ({ ...e, seq: i + 1 }));
      this.seq = this.events.length;
      return files.length;
    } catch {
      return 0;
    }
  }

  since(seq = 0) {
    return this.events.filter((e) => e.seq > seq);
  }

  /** Fold the log into current graph state. Pure function of the log. */
  project() {
    const tasks = new Map();
    const nodes = new Map();

    for (const e of this.events) {
      const t = tasks.get(e.taskId);

      switch (e.type) {
        case EV.TASK_CREATED:
          tasks.set(e.taskId, {
          id: e.taskId,
          prompt: e.prompt,
          budget: e.budget ?? null,
          mode: e.mode ?? null,
          status: 'running',
            createdAt: e.ts,
            spent: 0,
            calls: 0,
          });
          break;

        case EV.NODE_ADDED:
          nodes.set(e.nodeId, {
            id: e.nodeId,
            taskId: e.taskId,
            parents: e.parents ?? [],
            type: e.nodeType,
            name: e.name,
            description: e.description ?? '',
            service: e.service ?? null,
            meta: e.meta ?? null,
            estCost: e.estCost ?? 0,
            status: e.status ?? 'pending',
            cost: 0,
            input: e.input ?? null,
            output: null,
            error: null,
            startedAt: null,
            endedAt: null,
          });
          break;

        case EV.NODE_STARTED: {
          const n = nodes.get(e.nodeId);
          if (n) { n.status = 'running'; n.startedAt = e.ts; }
          break;
        }

        case EV.NODE_COMPLETED: {
          const n = nodes.get(e.nodeId);
          if (n) { n.status = 'done'; n.endedAt = e.ts; n.output = e.output ?? null; }
          break;
        }

        case EV.NODE_FAILED: {
          const n = nodes.get(e.nodeId);
          if (n) { n.status = 'failed'; n.endedAt = e.ts; n.error = e.error ?? 'unknown error'; }
          break;
        }

        case EV.NODE_REJECTED: {
          const n = nodes.get(e.nodeId);
          if (n) { n.status = 'rejected'; n.error = e.reason ?? null; }
          break;
        }

        case EV.PAYMENT: {
          const n = nodes.get(e.nodeId);
          if (n) {
            n.cost += Number(e.amount) || 0;
            n.mode = e.mode ?? n.mode ?? null;
            n.txHash = e.txHash ?? n.txHash ?? null;
            n.rail = e.rail ?? n.rail ?? null;
          }
          if (t) {
            t.spent += Number(e.amount) || 0;
            t.calls += 1;
            t.mode = e.mode ?? t.mode ?? null;
          }
          break;
        }

        case EV.TASK_COMPLETED:
          if (t) { t.status = 'done'; t.summary = e.summary; t.completedAt = e.ts; }
          break;

        case EV.TASK_FAILED:
          if (t) { t.status = 'failed'; t.error = e.error; t.completedAt = e.ts; }
          break;
      }
    }

    return {
      tasks: [...tasks.values()],
      nodes: [...nodes.values()].map((n) => ({
        ...n,
        durationMs: n.startedAt && n.endedAt ? n.endedAt - n.startedAt : null,
      })),
    };
  }
}

export const log = new EventLog();
