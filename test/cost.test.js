'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const lib = require('../src/index.js');
const { percentile, topShare, usd } = require('../src/stats.js');
const { generate } = require('../examples/generate-demo.js');
const prices = require('../examples/prices.json');

const ROOT = path.join(__dirname, '..');
const v1 = generate('v1');
const v2 = generate('v2');
const OPTS = { success: 'score:qualified', prices, by: ['step', 'model', 'meta.language'] };

const gen = (over = {}) => ({
  id: over.id || `o${Math.random()}`,
  traceId: 't1',
  type: 'GENERATION',
  name: 'answer',
  model: 'model-large',
  startTime: '2026-11-02T10:00:00.000Z',
  endTime: '2026-11-02T10:00:01.500Z',
  usageDetails: { input: 1000, output: 100 },
  costDetails: { total: 0.01 },
  ...over,
});
const exp = (observations, extra = {}) => ({ traces: [{ id: 't1', name: 'chat', metadata: {} }], observations, scores: [], ...extra });

test('stats: percentile, top share, money formatting', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(topShare([10, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 0.05), 10 / 29);
  assert.equal(usd(0.00123), '$0.0012');
  assert.equal(usd(0.349), '$0.349');
  assert.equal(usd(24.8), '$24.80');
  assert.equal(usd(12345), '$12,345');
});

test('readExport accepts raw API pages and rejects empty exports', () => {
  const e = lib.readExport({ traces: { data: [{ id: 't1' }] }, observations: { data: [gen()] } });
  assert.equal(e.traces.length, 1);
  assert.equal(e.observations.length, 1);
  assert.throws(() => lib.readExport({ traces: [], observations: [] }), /no traces/);
});

test('normalize: cost comes from Langfuse first, then --prices, and missing cost is never silent', () => {
  const d = lib.normalize(lib.readExport(exp([
    gen({ id: 'a' }),
    gen({ id: 'b', costDetails: undefined, calculatedTotalCost: 0.02 }),
    gen({ id: 'c', costDetails: undefined, usageDetails: { input: 1000, cache_read_input_tokens: 1000, output: 100 } }),
    gen({ id: 'd', costDetails: undefined, model: 'mystery-model' }),
    { id: 'span', traceId: 't1', type: 'SPAN', name: 'tool' },
  ])), { prices });
  assert.equal(d.gens.length, 4, 'non-generation observations are skipped');
  const by = Object.fromEntries(d.gens.map((g) => [g.id, g]));
  assert.equal(by.a.cost, 0.01);
  assert.equal(by.b.cost, 0.02);
  assert.equal(by.c.costSource, 'prices');
  assert.equal(by.c.cost, (1000 * 2.5 + 1000 * 0.25 + 100 * 10) / 1e6);
  assert.equal(by.c.cached, 1000);
  assert.equal(by.d.costSource, 'missing');
  assert.equal(by.a.ms, 1500);
  assert.ok(d.warnings.some((w) => /1 of 4 generations have no cost/.test(w)));
});

test('normalize: an export that says it is incomplete gets a loud warning', () => {
  const d = lib.normalize(lib.readExport(exp([gen()], { meta: { retrieved: { traces: 100 }, available: { traces: 2400 } } })));
  assert.ok(d.warnings.some((w) => /INCOMPLETE EXPORT: retrieved 100 of 2400 traces/.test(w)));
});

test('parseSuccess: score, comparison, tag and metadata forms', () => {
  const t = { scores: { qualified: 1, csat: 3 }, tags: ['won'], metadata: { outcome: 'resolved' } };
  assert.equal(lib.parseSuccess('score:qualified').test(t), true);
  assert.equal(lib.parseSuccess('score:csat>=4').test(t), false);
  assert.equal(lib.parseSuccess('score:csat<4').test(t), true);
  assert.equal(lib.parseSuccess('tag:won').test(t), true);
  assert.equal(lib.parseSuccess('meta:outcome=resolved').test(t), true);
  assert.equal(lib.parseSuccess('score:missing').test(t), false);
  assert.throws(() => lib.parseSuccess('qualified'), /cannot parse/);
});

test('analyze: group tables add up to the total', () => {
  const r = lib.report(v1, OPTS);
  assert.equal(r.totals.calls, v1.observations.length);
  assert.equal(r.totals.conversations, 240);
  for (const dim of ['step', 'model', 'meta.language']) {
    const s = r.groups[dim].reduce((a, x) => a + x.cost, 0);
    assert.ok(Math.abs(s - r.totals.cost) < 1e-9, `${dim} adds up`);
  }
  assert.equal(r.success.coverage, 1);
  assert.ok(Math.abs(r.success.costPerSuccess - r.totals.cost / r.success.conversations) < 1e-12);
  const lang = r.groups['meta.language'];
  assert.ok(lang.every((x) => x.successRate !== undefined), 'conversation-level groups get success columns');
  assert.ok(r.groups.step.every((x) => x.successRate === undefined), 'call-level groups do not');
});

test('waste W01: failed calls are counted at their real cost', () => {
  const r = lib.report(v1, OPTS);
  const w = r.waste.find((x) => x.id === 'W01');
  const failed = v1.observations.filter((o) => o.level === 'ERROR');
  assert.ok(failed.length > 0);
  assert.ok(Math.abs(w.cost - failed.reduce((a, o) => a + o.costDetails.total, 0)) < 1e-12);
});

test('waste W02: long uncached prompts are flagged, cached ones are not', () => {
  const many = (cached) => Array.from({ length: 30 }, (_, i) => gen({
    id: `g${i}`,
    usageDetails: { input: cached ? 300 : 3000 + i * 10, cache_read_input_tokens: cached ? 2700 : 0, output: 100 },
  }));
  const flagged = lib.findWaste(lib.normalize(lib.readExport(exp(many(false)))), { prices });
  assert.equal(flagged.filter((x) => x.id === 'W02').length, 1);
  assert.ok(flagged[0].saving > 0);
  const clean = lib.findWaste(lib.normalize(lib.readExport(exp(many(true)))), { prices });
  assert.equal(clean.filter((x) => x.id === 'W02').length, 0);
});

test('waste W03: a big model producing tiny outputs is flagged only when prices are known', () => {
  const r = lib.report(v1, OPTS);
  const w = r.waste.find((x) => x.id === 'W03');
  assert.match(w.title, /"classify" uses model-large/);
  assert.ok(w.saving > 0 && w.saving < w.cost);
  const noPrices = lib.report(v1, { success: 'score:qualified' });
  assert.equal(noPrices.waste.filter((x) => x.id === 'W03').length, 0);
});

test('waste W04: runaway conversations', () => {
  const r = lib.report(v1, { ...OPTS, loopThreshold: 20 });
  const w = r.waste.find((x) => x.id === 'W04');
  const long = v1.traces.filter((t) => v1.observations.filter((o) => o.traceId === t.id).length > 20);
  assert.match(w.detail, new RegExp(`^${long.length} of 240 conversations`));
});

test('compare: cheaper per call can still be more expensive per result', () => {
  const c = lib.compare(lib.report(v1, OPTS), lib.report(v2, OPTS));
  const row = (n) => c.rows.find((r) => r.name === n);
  assert.ok(row('Cost per model call').delta < 0, 'calls got cheaper');
  assert.ok(row('Cost per conversation').delta > 0, 'conversations got more expensive');
  assert.ok(c.costPerSuccessDelta > 0.3, 'cost per success rose a lot');
  assert.equal(row('Cost per success').better, false);
  assert.ok(c.verdict.some((v) => /Cheaper per call .* but more expensive per conversation/.test(v)));
  assert.ok(c.verdict.some((v) => /Cost per success went UP/.test(v)));
  assert.match(lib.formatCompare(c), /🔴 \| Cost per success/);
});

test('compare: the reverse direction reads as an improvement', () => {
  const c = lib.compare(lib.report(v2, OPTS), lib.report(v1, OPTS));
  assert.ok(c.costPerSuccessDelta < 0);
  assert.ok(c.verdict.some((v) => /Cost per success went down/.test(v)));
});

test('fetch: GET only, paginates to the end, records retrieved vs available', async () => {
  const calls = [];
  const pages = { '/api/public/traces': [[{ id: 't1' }, { id: 't2' }], [{ id: 't3' }]], '/api/public/observations': [[gen()]], '/api/public/scores': [[]] };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, page: u.searchParams.get('page'), method: init.method, auth: init.headers.authorization });
    const list = pages[u.pathname];
    const page = Number(u.searchParams.get('page'));
    const total = list.reduce((a, p) => a + p.length, 0);
    return { ok: true, json: async () => ({ data: list[page - 1] || [], meta: { totalItems: total, totalPages: list.length } }) };
  };
  const e = await lib.fetchExport({ host: 'https://lf.example.com/', publicKey: 'pk', secretKey: 'sk', fetchImpl, limit: 2 });
  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.equal(calls[0].auth, `Basic ${Buffer.from('pk:sk').toString('base64')}`);
  assert.equal(e.traces.length, 3);
  assert.deepEqual(e.meta.retrieved, e.meta.available);

  const capped = await lib.fetchExport({ host: 'https://lf.example.com', publicKey: 'pk', secretKey: 'sk', fetchImpl, limit: 2, maxPages: 1 });
  assert.equal(capped.meta.retrieved.traces, 2);
  assert.equal(capped.meta.available.traces, 3);
  await assert.rejects(lib.fetchExport({ fetchImpl, publicKey: '', secretKey: '' }), /LANGFUSE_PUBLIC_KEY/);
});

test('CLI: report, compare gate, and errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cost-'));
  const bin = path.join(ROOT, 'bin', 'llm-cost.js');
  const a = path.join(dir, 'v1.json');
  const b = path.join(dir, 'v2.json');
  fs.writeFileSync(a, JSON.stringify(v1));
  fs.writeFileSync(b, JSON.stringify(v2));
  const p = path.join(ROOT, 'examples', 'prices.json');

  const out = execFileSync(process.execPath, [bin, 'report', a, '--success', 'score:qualified', '--prices', p]).toString();
  assert.match(out, /# LLM cost report: v1/);
  assert.match(out, /Where the money leaks/);

  const gate = spawnSync(process.execPath, [bin, 'compare', a, b, '--success', 'score:qualified', '--max-increase', '10']);
  assert.equal(gate.status, 1);
  assert.match(gate.stderr.toString(), /cost per success rose/);
  const ok = spawnSync(process.execPath, [bin, 'compare', b, a, '--success', 'score:qualified', '--max-increase', '10']);
  assert.equal(ok.status, 0);

  const bad = spawnSync(process.execPath, [bin, 'nope']);
  assert.equal(bad.status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
