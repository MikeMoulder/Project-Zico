// Parses x402 listings that the Circle CLI reported to us.
//
// Zico does not discover. It has no discovery client, no catalog cache and no
// network calls: `circle services search` is the only thing that talks to the
// marketplace, and its output is handed here to be understood and drawn. That
// keeps one source of truth — whatever the operator actually saw is exactly
// what the graph shows, with no second cache to drift out of step.

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

/** Normalize one raw listing into something the graph can render. */
export function normalize(item) {
  if (!item || typeof item !== 'object' || !item.resource) return null;

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
    price: priceOf(item) ?? 0,
    network: rail?.network ?? null,
    asset: rail?.asset ?? null,
    payTo: rail?.payTo ?? null,
    gasless: Boolean(meta.supportsCircleGateway),
    vanilla: Boolean(meta.supportsVanillax402),
    params: paramsOf(item) ?? {},
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
 * from the URL so the graph shows something meaningful.
 */
function brandOf(resource, provider) {
  const m = /^https:\/\/np\.orthogonal\.com\/([^/]+)\//.exec(resource);
  if (m) return m[1];
  return provider ?? hostOf(resource);
}

export function hostOf(u) {
  try { return new URL(u).host; } catch { return String(u).slice(0, 60); }
}

/**
 * Unwrap whatever `circle services search` produced. The CLI wraps its payload
 * in {data:{items}}, but a caller may reasonably hand us the inner object or a
 * bare array, so accept all three rather than making the operator reshape it.
 */
export function itemsFrom(reported) {
  if (Array.isArray(reported)) return reported;
  if (!reported || typeof reported !== 'object') return [];
  return reported.data?.items ?? reported.items ?? reported.data?.results
    ?? reported.results ?? [];
}

/**
 * Normalize a reported result set.
 *
 * Nothing is filtered out. The old discovery client dropped any listing without
 * declared params or a readable price, because it was choosing what the agent
 * could call. A log does not get that vote: if the operator saw a row, the graph
 * shows that row, degrading to a minimal descriptor rather than hiding it.
 */
export function fromReported(reported) {
  return itemsFrom(reported)
    .map((item) => normalize(item) ?? minimal(item))
    .filter(Boolean);
}

/** Last-resort descriptor for a row we could not parse but must still show. */
function minimal(item) {
  const resource = typeof item === 'string' ? item : item?.resource;
  if (!resource) return null;
  return {
    id: resource,
    resource,
    provider: 'unknown',
    brand: hostOf(resource),
    category: 'UNPARSED',
    tags: [],
    description: 'reported by Circle CLI · shape not recognized',
    providerDescription: '',
    method: 'POST',
    price: 0,
    network: null,
    asset: null,
    payTo: null,
    gasless: false,
    vanilla: false,
    params: {},
    required: [],
    docsUrl: null,
  };
}
