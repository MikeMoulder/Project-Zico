// Executes one marketplace call. Two backends:
//   simulated — real catalog metadata and real prices, no money moves. Default.
//   circle    — shells out to the Circle CLI against the user's own wallet session.
//
// The runtime does not know which is in use; both return the same shape.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function makeExecutor(mode = 'simulated', opts = {}) {
  return mode === 'circle' ? circleExecutor(opts) : simulatedExecutor(opts);
}

function simulatedExecutor({ failureRate = 0.15, seed = Date.now() } = {}) {
  let state = seed >>> 0;
  const rand = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  return {
    mode: 'simulated',
    async call(service, input) {
      const latency = 400 + rand() * 1400;
      await new Promise((r) => setTimeout(r, latency));

      if (rand() < failureRate) {
        return { ok: false, error: `${service.brand} returned 503 (upstream unavailable)`, cost: 0 };
      }

      return {
        ok: true,
        cost: service.price,
        output: {
          note: 'simulated response — real service metadata, no payment made',
          service: service.brand,
          resource: service.resource,
          input,
        },
      };
    },
  };
}

function circleExecutor({ chain = 'BASE', address = null, timeout = 180_000 } = {}) {
  return {
    mode: 'circle',
    address,
    async call(service, input, { maxAmount = Infinity } = {}) {
      const args = [
        'services', 'pay', service.resource,
        '--chain', chain,
        '--method', service.method ?? 'POST',
        '--data', JSON.stringify(input ?? {}),
        '--output', 'json',
      ];
      if (Number.isFinite(maxAmount)) args.push('--max-amount', Math.max(0, maxAmount).toFixed(6));
      if (address) args.push('--address', address);

      let stdout;
      try {
        ({ stdout } = await run('circle', args, { timeout, windowsHide: true }));
      } catch (err) {
        const raw = String(err.stderr || err.stdout || err.message || '').trim();
        return { ok: false, error: firstLine(raw) || 'circle services pay failed', cost: 0, raw };
      }

      let body;
      try {
        body = JSON.parse(stdout);
      } catch {
        // A 200 with unparseable output still means the seller was paid; losing
        // that fact would understate spend, so surface it rather than swallow it.
        return { ok: true, cost: service.price, output: { raw: stdout.slice(0, 4000) }, estimated: true };
      }

      // Charge what actually settled, not what the catalog advertised — the two
      // diverge whenever a seller reprices between discovery and payment.
      const paid = pickAmount(body);
      return {
        ok: true,
        cost: paid ?? service.price,
        estimated: paid === null,
        txHash: body.transactionHash ?? body.txHash ?? body.payment?.transactionHash ?? null,
        output: body.data ?? body.result ?? body.response ?? body,
      };
    },
  };
}

/** USDC amounts arrive as decimals or 6-dp base units depending on the seller. */
function pickAmount(body) {
  const raw = body?.payment?.amount ?? body?.amount ?? body?.cost ?? body?.paid;
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1000 ? n / 1e6 : n;
}

/** Collapse a CLI error blob to one readable line for the graph. */
const firstLine = (str) => String(str).replace(/\s+/g, ' ').trim().slice(0, 300);
