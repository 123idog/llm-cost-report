'use strict';

const fs = require('fs');

// Accepts the shape written by `llm-cost fetch` (and by the demo generator):
//   { meta, traces: [...], observations: [...], scores: [...] }
// Field names follow the Langfuse public API. Older and newer spellings are both accepted.

function readExport(input) {
  const raw = typeof input === 'string' ? JSON.parse(fs.readFileSync(input, 'utf8')) : input;
  if (!raw || typeof raw !== 'object') throw new Error('export is not an object');
  const pick = (k) => (Array.isArray(raw[k]) ? raw[k] : Array.isArray(raw[k]?.data) ? raw[k].data : []);
  const out = { meta: raw.meta || {}, traces: pick('traces'), observations: pick('observations'), scores: pick('scores') };
  if (!out.traces.length && !out.observations.length) throw new Error('export has no traces and no observations');
  return out;
}

const num = (...xs) => {
  for (const x of xs) if (typeof x === 'number' && Number.isFinite(x)) return x;
  return undefined;
};

function tokensOf(o) {
  const u = o.usageDetails || o.usage || {};
  const cached = num(u.cache_read_input_tokens, u.input_cached_tokens, u.cached_input, u.cache_read, u.cached) || 0;
  const input = num(u.input, u.promptTokens, u.prompt_tokens, u.input_tokens, o.promptTokens) || 0;
  const output = num(u.output, u.completionTokens, u.completion_tokens, u.output_tokens, o.completionTokens) || 0;
  return { input, output, cached };
}

// Prices are USD per 1M tokens: { "model": { "input": 2.5, "cachedInput": 0.25, "output": 10 } }
function priceCall(model, t, prices) {
  const p = prices && prices[model];
  if (!p) return null;
  const cachedRate = p.cachedInput != null ? p.cachedInput : p.input;
  return (t.input * p.input + t.cached * cachedRate + t.output * p.output) / 1e6;
}

function normalize(exp, { prices } = {}) {
  const warnings = [];
  const traces = new Map();
  for (const t of exp.traces) {
    traces.set(t.id, {
      id: t.id,
      name: t.name || '(unnamed)',
      timestamp: t.timestamp,
      tags: t.tags || [],
      metadata: t.metadata || {},
      scores: {},
      gens: [],
    });
  }

  const gens = [];
  let missingCost = 0;
  let pricedLocally = 0;
  let orphan = 0;
  for (const o of exp.observations) {
    if (o.type && o.type !== 'GENERATION') continue;
    const t = tokensOf(o);
    let cost = num(o.costDetails?.total, o.calculatedTotalCost, o.totalCost, o.totalPrice, o.cost);
    let costSource = 'langfuse';
    if (cost === undefined) {
      const c = priceCall(o.model, t, prices);
      if (c == null) {
        missingCost++;
        cost = 0;
        costSource = 'missing';
      } else {
        pricedLocally++;
        cost = c;
        costSource = 'prices';
      }
    }
    const start = o.startTime ? Date.parse(o.startTime) : NaN;
    const end = o.endTime ? Date.parse(o.endTime) : NaN;
    const g = {
      id: o.id,
      traceId: o.traceId,
      step: o.name || '(unnamed)',
      model: o.model || '(unknown)',
      start,
      ms: Number.isFinite(start) && Number.isFinite(end) ? end - start : num(o.latency) != null ? o.latency * 1000 : null,
      ...t,
      cost,
      costSource,
      error: o.level === 'ERROR',
    };
    gens.push(g);
    let tr = traces.get(o.traceId);
    if (!tr) {
      orphan++;
      tr = { id: o.traceId, name: '(trace not in export)', tags: [], metadata: {}, scores: {}, gens: [] };
      traces.set(o.traceId, tr);
    }
    tr.gens.push(g);
  }

  for (const s of exp.scores) {
    const tr = traces.get(s.traceId);
    if (tr) tr.scores[s.name] = s.value;
  }
  for (const tr of traces.values()) {
    tr.gens.sort((a, b) => (a.start || 0) - (b.start || 0));
    tr.cost = tr.gens.reduce((a, g) => a + g.cost, 0);
  }

  if (missingCost) warnings.push(`${missingCost} of ${gens.length} generations have no cost and no price for their model: counted as $0. Pass --prices to fill them in.`);
  if (pricedLocally) warnings.push(`${pricedLocally} generations priced from --prices, not from Langfuse.`);
  if (orphan) warnings.push(`${orphan} generations belong to traces missing from the export.`);
  const r = exp.meta.retrieved;
  const a = exp.meta.available;
  if (r && a) {
    for (const k of Object.keys(a)) {
      if (r[k] != null && a[k] != null && r[k] < a[k]) warnings.push(`INCOMPLETE EXPORT: retrieved ${r[k]} of ${a[k]} ${k}. Numbers below describe a partial set.`);
    }
  }

  return { meta: exp.meta, traces: [...traces.values()], gens, warnings, missingCost };
}

module.exports = { readExport, normalize, tokensOf, priceCall };
