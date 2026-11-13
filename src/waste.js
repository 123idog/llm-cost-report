'use strict';

const { sum, mean, percentile } = require('./stats');

// Each detector returns zero or more findings:
//   { id, title, cost, saving, detail, hint }
// `cost` is spend that the finding touches. `saving` is an estimate (null when prices are unknown).
// Findings can overlap, so their costs are not additive.

function groupBy(xs, keyFn) {
  const m = new Map();
  for (const x of xs) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function failedCalls({ gens }) {
  const failed = gens.filter((g) => g.error);
  if (!failed.length) return [];
  const bySteps = [...groupBy(failed, (g) => g.step)].map(([s, xs]) => `${s} ×${xs.length}`).join(', ');
  return [{
    id: 'W01',
    title: 'Failed calls you still paid for',
    cost: sum(failed.map((g) => g.cost)),
    saving: sum(failed.map((g) => g.cost)),
    detail: `${failed.length.toLocaleString('en-US')} of ${gens.length.toLocaleString('en-US')} calls ended in an error (${bySteps}). Each was billed and then usually retried.`,
    hint: 'Look at why they fail (timeouts, malformed output, rate limits). A shorter timeout plus a fallback model is cheaper than a slow failure plus a full retry.',
  }];
}

function uncachedPrompt({ gens }, { prices, minCalls = 20, minInput = 1500, maxCachedRatio = 0.2 } = {}) {
  const out = [];
  for (const [key, xs] of groupBy(gens, (g) => `${g.step}\u0000${g.model}`)) {
    if (xs.length < minCalls) continue;
    const totals = xs.map((g) => g.input + g.cached);
    const avgIn = mean(totals);
    const cachedRatio = sum(xs.map((g) => g.cached)) / (sum(totals) || 1);
    if (avgIn < minInput || cachedRatio >= maxCachedRatio) continue;
    // The smallest prompts of a step are roughly its fixed part (system prompt, tools, examples).
    const fixed = percentile(totals, 5);
    if (fixed < minInput * 0.5) continue;
    const [step, model] = key.split('\u0000');
    const p = prices && prices[model];
    const saving = p && p.cachedInput != null ? sum(xs.map((g) => Math.min(fixed, g.input))) * (p.input - p.cachedInput) / 1e6 : null;
    out.push({
      id: 'W02',
      title: `"${step}" resends the same long prompt without caching`,
      cost: sum(xs.map((g) => g.cost)),
      saving,
      detail: `${xs.length.toLocaleString('en-US')} calls on ${model}, ~${Math.round(avgIn).toLocaleString('en-US')} input tokens each, of which ~${Math.round(fixed).toLocaleString('en-US')} look fixed. ${Math.round(cachedRatio * 100)}% served from cache.`,
      hint: 'Put the fixed part (system prompt, tool definitions, examples) first and unchanged, and turn on prompt caching for this model.',
    });
  }
  return out;
}

function oversizedModel({ gens }, { prices, maxAvgOutput = 30, minCalls = 20 } = {}) {
  if (!prices) return [];
  const priced = Object.entries(prices).filter(([, p]) => p.input != null && p.output != null);
  if (priced.length < 2) return [];
  const rate = (p) => p.input + p.output;
  const [cheapName, cheap] = priced.reduce((a, b) => (rate(b[1]) < rate(a[1]) ? b : a));
  const out = [];
  for (const [key, xs] of groupBy(gens, (g) => `${g.step}\u0000${g.model}`)) {
    const [step, model] = key.split('\u0000');
    const p = prices[model];
    if (!p || model === cheapName || xs.length < minCalls) continue;
    const avgOut = mean(xs.map((g) => g.output));
    if (avgOut > maxAvgOutput || rate(p) <= rate(cheap) * 2) continue;
    const cost = sum(xs.map((g) => g.cost));
    const cheapCachedRate = cheap.cachedInput != null ? cheap.cachedInput : cheap.input;
    const onCheap = sum(xs.map((g) => (g.input * cheap.input + g.cached * cheapCachedRate + g.output * cheap.output) / 1e6));
    out.push({
      id: 'W03',
      title: `"${step}" uses ${model} for a ~${Math.round(avgOut)}-token answer`,
      cost,
      saving: cost - onCheap,
      detail: `${xs.length.toLocaleString('en-US')} calls with short outputs (labels, yes/no, routing). The same tokens on ${cheapName} would cost ~${Math.round((onCheap / cost) * 100)}% as much.`,
      hint: `Candidate for ${cheapName}. Run your eval suite on it first: a cheaper classifier that misroutes costs more than it saves.`,
    });
  }
  return out;
}

function runaways({ traces }, { loopThreshold = 20 } = {}) {
  const long = traces.filter((t) => t.gens.length > loopThreshold);
  if (!long.length) return [];
  const cost = sum(long.map((t) => t.cost));
  return [{
    id: 'W04',
    title: `Conversations with more than ${loopThreshold} model calls`,
    cost,
    saving: null,
    detail: `${long.length} of ${traces.length} conversations (avg ${Math.round(mean(long.map((t) => t.gens.length)))} calls each). Usually a loop, a user stuck repeating themselves, or a bot that never hands off.`,
    hint: 'Read a few of them. Then cap turns per conversation and hand off to a human before the cap, not after.',
  }];
}

const DETECTORS = [failedCalls, uncachedPrompt, oversizedModel, runaways];

function findWaste(data, opts = {}) {
  const total = sum(data.gens.map((g) => g.cost)) || 1;
  return DETECTORS.flatMap((d) => d(data, opts))
    .map((f) => ({ ...f, share: f.cost / total }))
    // Below 1% of spend is not worth anyone's afternoon.
    .filter((f) => (f.saving ?? f.cost) / total >= (opts.minShare ?? 0.01))
    // Estimated savings first (largest first), then findings without an estimate by the spend they touch.
    .sort((a, b) => (a.saving == null) - (b.saving == null) || (b.saving ?? b.cost) - (a.saving ?? a.cost));
}

module.exports = { findWaste, failedCalls, uncachedPrompt, oversizedModel, runaways };
