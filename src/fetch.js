'use strict';

// Read-only export from the Langfuse public API. Only GET requests are made.
// Every list is paginated to the end, and the export records how many items were
// retrieved versus how many the API says exist, so a truncated export is visible.

async function getAll(path, params, { host, auth, fetchImpl, limit, maxPages }) {
  const items = [];
  let available = null;
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({ ...params, page: String(page), limit: String(limit) });
    const res = await fetchImpl(`${host}${path}?${qs}`, { method: 'GET', headers: { authorization: auth, accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${path} page ${page}: HTTP ${res.status}`);
    const body = await res.json();
    const data = Array.isArray(body.data) ? body.data : [];
    items.push(...data);
    if (body.meta && typeof body.meta.totalItems === 'number') available = body.meta.totalItems;
    const totalPages = body.meta?.totalPages;
    if (!data.length || (typeof totalPages === 'number' && page >= totalPages)) break;
  }
  return { items, available: available ?? items.length };
}

async function fetchExport(opts = {}) {
  const host = (opts.host || process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com').replace(/\/+$/, '');
  const pk = opts.publicKey || process.env.LANGFUSE_PUBLIC_KEY;
  const sk = opts.secretKey || process.env.LANGFUSE_SECRET_KEY;
  if (!pk || !sk) throw new Error('set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY (a read-only project key is enough)');
  const ctx = {
    host,
    auth: `Basic ${Buffer.from(`${pk}:${sk}`).toString('base64')}`,
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    limit: opts.limit || 100,
    maxPages: opts.maxPages || 10000,
  };
  const range = {};
  if (opts.from) range.from = new Date(opts.from).toISOString();
  if (opts.to) range.to = new Date(opts.to).toISOString();

  const traceParams = {};
  if (range.from) traceParams.fromTimestamp = range.from;
  if (range.to) traceParams.toTimestamp = range.to;
  if (opts.name) traceParams.name = opts.name;
  const obsParams = { type: 'GENERATION' };
  if (range.from) obsParams.fromStartTime = range.from;
  if (range.to) obsParams.toStartTime = range.to;

  const traces = await getAll('/api/public/traces', traceParams, ctx);
  const observations = await getAll('/api/public/observations', obsParams, ctx);
  const scores = await getAll('/api/public/scores', { ...(range.from && { fromTimestamp: range.from }), ...(range.to && { toTimestamp: range.to }) }, ctx);

  // When filtering by trace name, keep only the generations and scores of those traces.
  const keep = opts.name ? new Set(traces.items.map((t) => t.id)) : null;
  const obs = keep ? observations.items.filter((o) => keep.has(o.traceId)) : observations.items;
  const sc = keep ? scores.items.filter((s) => keep.has(s.traceId)) : scores.items;

  return {
    meta: {
      source: host,
      exportedAt: new Date().toISOString(),
      range,
      retrieved: { traces: traces.items.length, observations: observations.items.length, scores: scores.items.length },
      available: { traces: traces.available, observations: observations.available, scores: scores.available },
    },
    traces: traces.items,
    observations: obs,
    scores: sc,
  };
}

module.exports = { fetchExport };
