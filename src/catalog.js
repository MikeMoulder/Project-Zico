// Circle Agent Marketplace — Discovery API client.
// Public endpoint: no API key, no account. https://api.circle.com/v2/x402/discovery/resources

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_ROOT = process.env.ZICO_DATA_DIR ?? join(process.cwd(), '.zico');
const CACHE = join(DATA_ROOT, 'catalog.json');
const DISCOVERY = process.env.CIRCLE_DISCOVERY_URL
  ?? 'https://api.circle.com/v2/x402/discovery/resources';

const PAGE = 200;

/** Pull every listing, paging until we've seen `total`. */
export async function fetchCatalog() {
  const items = [];
  const seen = new Set();
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url = `${DISCOVERY}?limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
    if (!res.ok) throw new Error(`discovery ${res.status} ${res.statusText}`);
    const body = await res.json();

    total = body.pagination?.total ?? body.items?.length ?? 0;
    for (const it of body.items ?? []) {
      if (seen.has(it.resource)) continue;
      seen.add(it.resource);
      items.push(it);
    }
    if (!body.items?.length) break;
    offset += PAGE;
  }

  return items;
}

/** Lowest price across all accepted rails, in USDC. */
export function priceOf(item) {
  const amounts = (item.accepts ?? [])
    .map((a) => Number(a.amount))
    .filter((n) => Number.isFinite(n));
  return amounts.length ? Math.min(...amounts) / 1e6 : null;
}

/** Named input params across body / query / path. Empty means we can't call it blind. */
export function paramsOf(item) {
  const input = item.metadata?.input;
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const section of ['body', 'queryParams', 'pathParams']) {
    const props = input[section]?.properties;
    if (props) Object.assign(out, props);
  }
  return out;
}

/**
 * Normalize a raw listing into something a planner can reason about.
 * Returns null for anything the agent could not actually invoke.
 */
export function normalize(item) {
  const params = paramsOf(item);
  if (!params || Object.keys(params).length === 0) return null;

  const price = priceOf(item);
  if (price === null) return null;

  const meta = item.metadata ?? {};
  const provider = meta.provider ?? {};
  const rail = (item.accepts ?? []).find((a) => a.network?.startsWith('eip155:8453'))
    ?? item.accepts?.[0];

  return {
    id: item.resource,
    resource: item.resource,
    provider: provider.name ?? 'unknown',
    brand: brandOf(item.resource, provider.name),
    category: provider.category ?? 'UNCATEGORIZED',
    tags: provider.tags ?? [],
    description: meta.description || provider.description || '',
    providerDescription: provider.description ?? '',
    method: meta.method ?? 'POST',
    price,
    network: rail?.network ?? null,
    asset: rail?.asset ?? null,
    payTo: rail?.payTo ?? null,
    gasless: Boolean(meta.supportsCircleGateway),
    vanilla: Boolean(meta.supportsVanillax402),
    params,
    required: requiredOf(item),
    docsUrl: provider.docsUrl ?? null,
  };
}

function requiredOf(item) {
  const input = item.metadata?.input ?? {};
  const req = [];
  for (const section of ['body', 'queryParams', 'pathParams']) {
    if (Array.isArray(input[section]?.required)) req.push(...input[section].required);
  }
  return req;
}

/**
 * Orthogonal is a nanopayment proxy fronting ~30 upstream APIs; the provider name
 * is always "Orthogonal" and the description is boilerplate. Recover the real brand
 * from the URL so the planner (and the graph) show something meaningful.
 */
function brandOf(resource, provider) {
  const m = /^https:\/\/np\.orthogonal\.com\/([^/]+)\//.exec(resource);
  if (m) return m[1];
  return provider ?? 'unknown';
}

/** Fetch + normalize + cache. Callable services only. */
export async function loadCatalog({ refresh = false } = {}) {
  if (!refresh) {
    try {
      const cached = JSON.parse(await readFile(CACHE, 'utf8'));
      if (Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) return cached;
    } catch { /* cache miss — fall through to network */ }
  }

  const raw = await fetchCatalog();
  const services = raw.map(normalize).filter(Boolean);

  const cat = {
    fetchedAt: Date.now(),
    totalListings: raw.length,
    callable: services.length,
    services,
  };

  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(cat, null, 2));
  return cat;
}

/**
 * Keyword search over the callable set, with the constraints the agent cares about.
 * Scoring is deliberately dumb for now — an embedding index replaces this later.
 */
export function search(catalog, query, opts = {}) {
  const { maxPrice = Infinity, gaslessOnly = true, category = null, limit = 10 } = opts;
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);

  const scored = [];
  for (const s of catalog.services) {
    if (gaslessOnly && !s.gasless) continue;
    if (s.price > maxPrice) continue;
    if (category && s.category !== category) continue;

    const hay = `${s.brand} ${s.provider} ${s.category} ${s.tags.join(' ')} ${s.description}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (s.brand.toLowerCase() === t) score += 6;
      else if (hay.includes(t)) score += 2;
    }
    if (!score) continue;
    score -= s.price * 2; // nudge toward cheaper options when relevance ties
    scored.push({ ...s, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
