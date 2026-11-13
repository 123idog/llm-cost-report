#!/usr/bin/env node
'use strict';
// Generates two fake Langfuse exports for a fictional bike shop's sales chatbot ("Pedal & Co").
// Everything here is invented: models, prices, conversations, outcomes.
//
//   v1: classify + answer both on model-large, no prompt caching.
//   v2: the answer step moved to model-medium to save money. The cheaper model asks more
//       clarifying questions and qualifies fewer leads.
//
//   node examples/generate-demo.js            → examples/demo-v1.json, examples/demo-v2.json

const fs = require('fs');
const path = require('path');
const prices = require('./prices.json');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANGS = [['hebrew', 0.5, 1.15], ['arabic', 0.3, 1.4], ['english', 0.2, 1]];
const SPEED = { 'model-large': [900, 12], 'model-medium': [600, 8], 'model-small': [250, 4] };

function cost(model, input, cached, output) {
  const p = prices[model];
  return (input * p.input + cached * p.cachedInput + output * p.output) / 1e6;
}

function generate(version, { conversations = 240, seed = 7 } = {}) {
  const r = rng(seed + (version === 'v2' ? 1000 : 0));
  const between = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const answerModel = version === 'v2' ? 'model-medium' : 'model-large';
  const traces = [];
  const observations = [];
  const scores = [];
  const t0 = Date.parse('2026-11-02T06:00:00Z');
  let obsN = 0;

  for (let i = 0; i < conversations; i++) {
    const id = `${version}-conv-${String(i + 1).padStart(4, '0')}`;
    let x = r();
    const [lang, , mult] = LANGS.find(([, w]) => (x -= w) < 0) || LANGS[0];
    let clock = t0 + Math.floor(r() * 7 * 24 * 3600 * 1000);
    traces.push({ id, name: 'sales-chat', timestamp: new Date(clock).toISOString(), tags: [version], metadata: { language: lang, channel: 'whatsapp' } });

    const runaway = r() < 0.02;
    let turns = runaway ? between(22, 35) : between(3, 9);
    if (version === 'v2' && !runaway) turns = Math.round(turns * 1.8);

    const call = (step, model, input, output, { error = false } = {}) => {
      const [base, perTok] = SPEED[model];
      let latency = base + output * perTok + r() * 400;
      if (r() < 0.03) latency *= 2.5;
      if (error) latency = 30000;
      const start = clock;
      clock += Math.round(latency);
      observations.push({
        id: `obs-${version}-${++obsN}`,
        traceId: id,
        type: 'GENERATION',
        name: step,
        model,
        startTime: new Date(start).toISOString(),
        endTime: new Date(clock).toISOString(),
        level: error ? 'ERROR' : 'DEFAULT',
        usageDetails: { input, output, total: input + output },
        costDetails: { total: cost(model, input, 0, output) },
      });
    };

    for (let turn = 1; turn <= turns; turn++) {
      clock += between(20, 180) * 1000; // customer typing
      call('classify', 'model-large', 1800 + Math.round(60 * turn * mult), between(4, 9));
      const ansIn = 2600 + Math.round(180 * turn * mult);
      if (r() < 0.03) call('answer', answerModel, ansIn, 0, { error: true });
      call('answer', answerModel, ansIn, Math.round(between(90, 160) * mult));
    }
    call('crm-summary', 'model-small', 900 + Math.round(150 * turns * mult), between(150, 260));

    const pQualified = (version === 'v2' ? 0.22 : 0.31) * (lang === 'arabic' ? 0.8 : 1);
    scores.push({ traceId: id, name: 'qualified', value: !runaway && r() < pQualified ? 1 : 0 });
  }

  const n = { traces: traces.length, observations: observations.length, scores: scores.length };
  return { meta: { source: 'demo (invented data)', label: version, retrieved: n, available: n }, traces, observations, scores };
}

if (require.main === module) {
  for (const v of ['v1', 'v2']) {
    const file = path.join(__dirname, `demo-${v}.json`);
    fs.writeFileSync(file, JSON.stringify(generate(v)));
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
}

module.exports = { generate };
