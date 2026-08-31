// Circle Agent Wallet preflight.
//
// Live mode spends real USDC on Base mainnet — the marketplace publishes no
// testnet listings, so there is no free path to a real call. Everything that
// can be checked before the first payment is checked here, once, at startup:
// failing at `zico serve` with instructions beats failing mid-run after the
// graph has already told the user a call is in flight.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CHAIN = 'BASE';

async function circle(args, { timeout = 30_000 } = {}) {
  const { stdout } = await run('circle', args, { timeout, windowsHide: true, shell: process.platform === 'win32' });
  return stdout;
}

function parse(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

/**
 * Walks the chain of things that must be true before a payment can succeed.
 * Returns {ok:true, address, balance} or {ok:false, step, problem, fix}.
 */
export async function preflight({ chain = CHAIN, address = null } = {}) {
  // 1. CLI present
  try {
    await circle(['--version'], { timeout: 15_000 });
  } catch {
    return {
      ok: false,
      step: 'cli',
      problem: 'Circle CLI is not installed',
      fix: 'npm install -g @circle-fin/cli',
    };
  }

  // 2. Logged in. `wallet list` can succeed while logged out, so use status.
  let status;
  try {
    status = await circle(['wallet', 'status']);
  } catch (err) {
    const msg = String(err.stderr || err.stdout || err.message);
    if (/terms/i.test(msg)) {
      return {
        ok: false,
        step: 'terms',
        problem: 'Circle CLI terms of use have not been accepted on this machine',
        fix: 'Run `circle terms accept` yourself — read them first; Zico will not accept them on your behalf.',
      };
    }
    return {
      ok: false,
      step: 'login',
      problem: 'not logged in to the Circle CLI',
      fix: 'circle wallet login <your-email> --init   then   circle wallet login --request <id> --otp <code>',
    };
  }

  // 3. An agent wallet exists on the paying chain
  let wallets = [];
  try {
    wallets = parse(await circle(['wallet', 'list', '--chain', chain, '--type', 'agent', '--output', 'json'])) ?? [];
    if (!Array.isArray(wallets)) {
      wallets = wallets.data?.wallets ?? wallets.wallets
        ?? (Array.isArray(wallets.data) ? wallets.data : []);
    }
  } catch { /* fall through to the empty-wallet branch */ }

  if (!wallets.length) {
    return {
      ok: false,
      step: 'wallet',
      problem: `no agent wallet on ${chain}`,
      fix: 'circle wallet create',
      status: status.trim(),
    };
  }

  const wallet = address
    ? wallets.find((w) => (w.address ?? '').toLowerCase() === address.toLowerCase())
    : wallets[0];
  if (!wallet) {
    return { ok: false, step: 'wallet', problem: `wallet ${address} not found on ${chain}`, fix: 'circle wallet list --chain BASE --type agent' };
  }

  // 4. Funded. Gateway balance is what nanopayments actually draw on, so check
  //    it first and fall back to the on-chain balance for vanilla x402 sellers.
  const balances = {};
  for (const [key, args] of [
    ['gateway', ['gateway', 'balance', '--address', wallet.address, '--chain', chain, '--output', 'json']],
    ['onchain', ['wallet', 'balance', '--address', wallet.address, '--chain', chain, '--output', 'json']],
  ]) {
    try {
      const b = parse(await circle(args));
      const d = b?.data ?? b;
      const rows = Array.isArray(d?.balances) ? d.balances : null;
      balances[key] = rows?.length
        ? rows
            .filter((x) => String(x?.token?.symbol ?? x?.token ?? '').toUpperCase() === 'USDC')
            .reduce((sum, x) => sum + (Number(x?.amount) || 0), 0)
        : Number(d?.total ?? d?.balance ?? d?.usdc ?? d?.amount ?? 0) || 0;
    } catch { balances[key] = 0; }
  }

  const usable = Math.max(balances.gateway, balances.onchain);
  if (usable <= 0) {
    return {
      ok: false,
      step: 'funding',
      problem: `wallet ${wallet.address} holds no USDC on ${chain}`,
      fix: `circle wallet fund --address ${wallet.address} --chain ${chain} --amount 5 --token usdc --method fiat --open`,
      address: wallet.address,
    };
  }

  return { ok: true, address: wallet.address, chain, balances, usable };
}

/** Human-readable preflight failure, for the terminal. */
export function explain(result) {
  const lines = [
    `live mode unavailable — ${result.problem}`,
    '',
    `  fix:  ${result.fix}`,
  ];
  if (result.step === 'login') {
    lines.push(
      '',
      '  The CLI sends a one-time code to your email and returns a request id.',
      '  Zico never sees your credentials — it drives your own logged-in session.',
    );
  }
  if (result.step === 'funding') {
    lines.push(
      '',
      '  The marketplace publishes no testnet listings, so live calls settle in',
      '  real USDC on Base. Typical calls cost $0.0004–$0.0075, so a few dollars',
      '  covers hundreds of them.',
    );
  }
  lines.push('', '  Or stay in simulated mode: omit --live.');
  return lines.join('\n');
}
