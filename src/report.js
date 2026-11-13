'use strict';

const { sum, mean, percentile, topShare, usd, pct, signedPct, ms } = require('./stats');
const { findWaste } = require('./waste');

// ---- success definition ---------------------------------------------------
// "score:qualified"        score exists and is truthy / > 0
// "score:csat>=4"          numeric comparison (>=, >, <=, <, =)
// "tag:qualified"          trace has the tag
// "meta:outcome=resolved"  trace metadata equals a value
function parseSuccess(spec) {
  if (!spec) return null;
  if (typeof spec === 'function') return { label: 'custom', test: spec };
  const m = /^(score|tag|meta):([^<>=!]+)(?:(>=|<=|=|>|<)(.+))?$/.exec(String(spec).trim());
  if (!m) throw new Error(`cannot parse success "${spec}". Use score:NAME[>=N], tag:NAME or meta:KEY=VALUE`);
  const [, kind, name, op, rawVal] = m;
  const truthy = (v) => v === true || (typeof v === 'number' && v > 0) || ['true', 'yes', '1'].includes(String(v).toLowerCase());
  const cmp = (v) => {
    if (!op) return truthy(v);
    const n = Number(rawVal);
    const x = Number(v);
    switch (op) {
      case '>=': return x >= n;
      case '<=': return x <= n;
      case '>': return x > n;
      case '<': return x < n;
      default: return String(v) === rawVal;
    }
  };
  let test;
  let covered;
  if (kind === 'score') {
    test = (t) => t.scores[name] !== undefined && cmp(t.scores[name]);
    covered = (t) => t.scores[name] !== undefined;
  } else if (kind === 'tag') {
    test = (t) => t.tags.includes(name);
    covered = () => true;
  } else {
    test = (t) => t.metadata[name] !== undefined && cmp(t.metadata[name]);
    covered = (t) => t.metadata[name] !== undefined;
  }
  return { label: spec, test, covered };
}

// ---- grouping ---------------------------------------------------------------
function dimension(dim, tracesById) {
  if (dim === 'step') return (g) => g.step;
  if (dim === 'model') return (g) => g.model;
  if (dim === 'trace') return (g) => tracesById.get(g.traceId)?.name ?? '(none)';
  if (dim.startsWith('meta.')) {
    const k = dim.slice(5);
    return (g) => {
      const v = tracesById.get(g.traceId)?.metadata?.[k];
      return v === undefined ? '(none)' : String(v);
    };
  }
  throw new Error(`unknown dimension "${dim}". Use step, model, trace or meta.KEY`);
}

function groupRows(data, dim, success, total) {
  const tracesById = new Map(data.traces.map((t) => [t.id, t]));
  const key = dimension(dim, tracesById);
  const groups = new Map();
  for (const g of data.gens) {
    const k = key(g);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(g);
  }
  return [...groups].map(([k, xs]) => {
    const traceIds = new Set(xs.map((g) => g.traceId));
    const latencies = xs.map((g) => g.ms).filter((x) => x != null);
    const cost = sum(xs.map((g) => g.cost));
    const row = {
      key: k,
      calls: xs.length,
      conversations: traceIds.size,
      cost,
      share: cost / (total || 1),
      costPerCall: cost / xs.length,
      avgInput: mean(xs.map((g) => g.input + g.cached)),
      avgOutput: mean(xs.map((g) => g.output)),
      p50ms: percentile(latencies, 50),
      p95ms: percentile(latencies, 95),
      errors: xs.filter((g) => g.error).length,
    };
    if (success && dim !== 'step' && dim !== 'model') {
      const ts = [...traceIds].map((id) => tracesById.get(id)).filter(Boolean);
      const wins = ts.filter(success.test).length;
      row.costPerConversation = cost / (ts.length || 1);
      row.successRate = ts.length ? wins / ts.length : null;
      row.costPerSuccess = wins ? cost / wins : null;
    }
    return row;
  }).sort((a, b) => b.cost - a.cost);
}

// ---- analyze ----------------------------------------------------------------
function analyze(data, opts = {}) {
  const by = opts.by || ['step', 'model'];
  const success = parseSuccess(opts.success);
  const traces = data.traces.filter((t) => t.gens.length);
  const total = sum(data.gens.map((g) => g.cost));
  const perTrace = traces.map((t) => t.cost);

  const r = {
    label: opts.label || data.meta?.label || '',
    warnings: data.warnings || [],
    totals: {
      conversations: traces.length,
      calls: data.gens.length,
      cost: total,
      errors: data.gens.filter((g) => g.error).length,
      inputTokens: sum(data.gens.map((g) => g.input)),
      cachedTokens: sum(data.gens.map((g) => g.cached)),
      outputTokens: sum(data.gens.map((g) => g.output)),
    },
    perCall: { mean: total / (data.gens.length || 1) },
    perConversation: {
      mean: mean(perTrace),
      p50: percentile(perTrace, 50),
      p95: percentile(perTrace, 95),
      max: perTrace.length ? Math.max(...perTrace) : 0,
      calls: mean(traces.map((t) => t.gens.length)),
      top5Share: topShare(perTrace, 0.05),
    },
    success: null,
    groups: {},
    waste: findWaste(data, opts),
  };

  if (success) {
    const covered = traces.filter(success.covered).length;
    const wins = traces.filter(success.test).length;
    r.success = {
      definition: success.label,
      conversations: wins,
      rate: traces.length ? wins / traces.length : 0,
      costPerSuccess: wins ? total / wins : null,
      coverage: traces.length ? covered / traces.length : 0,
    };
    if (r.success.coverage < 1) {
      r.warnings = [...r.warnings, `success is defined for ${covered} of ${traces.length} conversations; the rest count as not successful.`];
    }
  }
  for (const dim of by) r.groups[dim] = groupRows({ ...data, traces }, dim, success, total);
  return r;
}

// ---- format -----------------------------------------------------------------
function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function formatReport(r) {
  const t = r.totals;
  const out = [];
  out.push(`# LLM cost report${r.label ? `: ${r.label}` : ''}`, '');
  for (const w of r.warnings) out.push(`> ⚠️ ${w}`);
  if (r.warnings.length) out.push('');
  out.push(`- ${t.conversations.toLocaleString('en-US')} conversations, ${t.calls.toLocaleString('en-US')} model calls, ${t.errors} failed`);
  out.push(`- Total ${usd(t.cost)} · per call ${usd(r.perCall.mean)} · per conversation ${usd(r.perConversation.mean)} (p50 ${usd(r.perConversation.p50)}, p95 ${usd(r.perConversation.p95)}, max ${usd(r.perConversation.max)})`);
  out.push(`- The most expensive 5% of conversations are ${pct(r.perConversation.top5Share)} of spend`);
  const inTotal = t.inputTokens + t.cachedTokens;
  out.push(`- Tokens: ${inTotal.toLocaleString('en-US')} in (${pct(t.cachedTokens / (inTotal || 1))} cached), ${t.outputTokens.toLocaleString('en-US')} out`);
  if (r.success) {
    out.push(`- **Success (${r.success.definition}): ${r.success.conversations} of ${t.conversations} (${pct(r.success.rate)}) → ${usd(r.success.costPerSuccess)} per success**`);
  }

  for (const [dim, rows] of Object.entries(r.groups)) {
    out.push('', `## By ${dim}`, '');
    const withSuccess = rows.some((x) => x.successRate !== undefined);
    const headers = [dim, 'calls', 'cost', 'share', 'per call', 'avg in / out', 'p50 / p95', 'errors'];
    if (withSuccess) headers.push('per conv', 'success', 'per success');
    out.push(table(headers, rows.map((x) => {
      const row = [x.key, x.calls.toLocaleString('en-US'), usd(x.cost), pct(x.share), usd(x.costPerCall),
        `${Math.round(x.avgInput).toLocaleString('en-US')} / ${Math.round(x.avgOutput)}`, `${ms(x.p50ms)} / ${ms(x.p95ms)}`, String(x.errors)];
      if (withSuccess) row.push(usd(x.costPerConversation), pct(x.successRate), usd(x.costPerSuccess));
      return row;
    })));
  }

  out.push('', '## Where the money leaks', '');
  if (!r.waste.length) out.push('Nothing flagged.');
  for (const w of r.waste) {
    const saving = w.saving != null ? ` · est. saving **${usd(w.saving)}** (${pct(w.saving / (t.cost || 1))})` : '';
    out.push(`**${w.id} · ${w.title}**: ${usd(w.cost)} touched (${pct(w.share)})${saving}`);
    out.push(`  ${w.detail}`);
    out.push(`  → ${w.hint}`, '');
  }
  if (r.waste.length > 1) out.push('_Findings can overlap; their numbers are not additive._');
  return out.join('\n').trimEnd() + '\n';
}

// ---- compare ----------------------------------------------------------------
function delta(a, b) {
  if (a == null || b == null || !a) return null;
  return (b - a) / a;
}

function compare(a, b) {
  const metric = (name, fa, fb, fmt, lowerIsBetter = true) => {
    const d = delta(fa, fb);
    const better = d == null || lowerIsBetter === null || Math.abs(d) < 0.02 ? null : lowerIsBetter ? d < 0 : d > 0;
    return { name, base: fa, cand: fb, delta: d, better, fmt };
  };
  const rows = [
    metric('Conversations', a.totals.conversations, b.totals.conversations, String, null),
    metric('Cost per model call', a.perCall.mean, b.perCall.mean, usd),
    metric('Model calls per conversation', a.perConversation.calls, b.perConversation.calls, (x) => x.toFixed(1)),
    metric('Cost per conversation', a.perConversation.mean, b.perConversation.mean, usd),
    metric('Cost per conversation, p95', a.perConversation.p95, b.perConversation.p95, usd),
  ];
  if (a.success && b.success) {
    rows.push(metric('Success rate', a.success.rate, b.success.rate, (x) => pct(x), false));
    rows.push(metric('Cost per success', a.success.costPerSuccess, b.success.costPerSuccess, usd));
  }
  const stepsA = new Map((a.groups.step || []).map((x) => [x.key, x]));
  for (const s of b.groups.step || []) {
    const sa = stepsA.get(s.key);
    if (sa) rows.push(metric(`p95 latency: ${s.key}`, sa.p95ms, s.p95ms, ms));
  }

  const verdict = [];
  const call = delta(a.perCall.mean, b.perCall.mean);
  const conv = delta(a.perConversation.mean, b.perConversation.mean);
  const succ = a.success && b.success ? delta(a.success.costPerSuccess, b.success.costPerSuccess) : null;
  if (call != null && conv != null && call < -0.02 && conv > 0.02) {
    verdict.push(`Cheaper per call (${signedPct(call)}) but more expensive per conversation (${signedPct(conv)}): conversations need ${a.perConversation.calls.toFixed(1)} → ${b.perConversation.calls.toFixed(1)} calls.`);
  }
  if (succ != null && conv != null && conv < 0.02 && succ > 0.02) {
    verdict.push(`Cost per success went UP (${signedPct(succ)}) because the success rate fell (${pct(a.success.rate)} → ${pct(b.success.rate)}).`);
  } else if (succ != null && succ > 0.02) {
    verdict.push(`Cost per success went UP ${signedPct(succ)} (${usd(a.success.costPerSuccess)} → ${usd(b.success.costPerSuccess)}), and the success rate moved ${pct(a.success.rate)} → ${pct(b.success.rate)}.`);
  } else if (succ != null && succ < -0.02) {
    verdict.push(`Cost per success went down ${signedPct(succ)} (${usd(a.success.costPerSuccess)} → ${usd(b.success.costPerSuccess)}).`);
  }
  for (const r of rows) {
    if (r.name.startsWith('p95 latency') && r.delta != null && r.delta > 0.2) verdict.push(`${r.name} rose ${signedPct(r.delta)}.`);
  }
  return { base: a.label || 'base', cand: b.label || 'candidate', rows, verdict, costPerSuccessDelta: succ, costPerConversationDelta: conv };
}

function formatCompare(c) {
  const out = [`# Cost compare: ${c.base} → ${c.cand}`, ''];
  for (const v of c.verdict) out.push(`- **${v}**`);
  if (c.verdict.length) out.push('');
  out.push(table(['', 'Metric', c.base, c.cand, 'Change'], c.rows.map((r) => [
    r.better === true ? '🟢' : r.better === false ? '🔴' : '⚪',
    r.name, r.fmt(r.base), r.fmt(r.cand), signedPct(r.delta),
  ])));
  return out.join('\n') + '\n';
}

module.exports = { analyze, formatReport, compare, formatCompare, parseSuccess };
