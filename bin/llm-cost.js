#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('../src/index.js');

const HELP = `llm-cost: what your LLM app costs, per conversation and per result

Usage:
  llm-cost fetch   --out export.json [--from 2026-11-01] [--to 2026-11-08] [--name TRACE_NAME]
  llm-cost report  export.json [options]
  llm-cost compare base.json candidate.json [options] [--max-increase PCT]

Options:
  --by step,model,meta.language   group tables (step | model | trace | meta.KEY)
  --success score:qualified        what counts as a good outcome
                                   (score:NAME[>=N] | tag:NAME | meta:KEY=VALUE)
  --prices prices.json             USD per 1M tokens, for savings estimates and missing costs
  --loop 20                        flag conversations with more model calls than this
  --label NAME                     name shown in the report
  --json                           machine-readable output

fetch reads LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY. It only sends GET requests.
compare --max-increase 10 exits 1 when cost per success (or per conversation, without --success)
rises more than 10%.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--help' || a === '-h') args[a.replace(/^-+/, '')] = true;
    else if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      args[a.slice(2)] = v;
      i++;
    } else args._.push(a);
  }
  return args;
}

function options(args, file) {
  return {
    by: args.by ? args.by.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    success: args.success,
    prices: args.prices ? JSON.parse(fs.readFileSync(args.prices, 'utf8')) : undefined,
    loopThreshold: args.loop ? Number(args.loop) : undefined,
    label: args.label || (file ? path.basename(file, path.extname(file)) : undefined),
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const [cmd, ...files] = args._;
  if (!cmd || args.help || args.h) {
    console.log(HELP);
    return 0;
  }

  if (cmd === 'fetch') {
    if (!args.out) throw new Error('fetch needs --out FILE');
    const exp = await lib.fetchExport({ from: args.from, to: args.to, name: args.name });
    fs.writeFileSync(args.out, JSON.stringify(exp));
    const { retrieved: r, available: a } = exp.meta;
    for (const k of Object.keys(r)) {
      console.error(`${k}: retrieved ${r[k]} of ${a[k]}${r[k] < a[k] ? '  ⚠️ INCOMPLETE' : ''}`);
    }
    console.error(`wrote ${args.out}`);
    return 0;
  }

  if (cmd === 'report') {
    if (files.length !== 1) throw new Error('report needs one export file');
    const r = lib.report(files[0], options(args, files[0]));
    process.stdout.write(args.json ? JSON.stringify(r, null, 2) + '\n' : lib.formatReport(r));
    return 0;
  }

  if (cmd === 'compare') {
    if (files.length !== 2) throw new Error('compare needs two export files');
    const a = lib.report(files[0], options(args, files[0]));
    const b = lib.report(files[1], options(args, files[1]));
    const c = lib.compare(a, b);
    process.stdout.write(args.json ? JSON.stringify(c, null, 2) + '\n' : lib.formatCompare(c));
    if (args['max-increase'] !== undefined) {
      const limit = Number(args['max-increase']) / 100;
      const d = c.costPerSuccessDelta ?? c.costPerConversationDelta;
      if (d != null && d > limit) {
        console.error(`FAIL: cost per ${c.costPerSuccessDelta != null ? 'success' : 'conversation'} rose ${Math.round(d * 100)}% (limit ${args['max-increase']}%)`);
        return 1;
      }
    }
    return 0;
  }

  throw new Error(`unknown command "${cmd}". Run llm-cost --help`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`llm-cost: ${err.message}`);
    process.exit(2);
  },
);
