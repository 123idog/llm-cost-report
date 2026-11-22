# llm-cost-report

[![CI](https://github.com/123idog/llm-cost-report/actions/workflows/ci.yml/badge.svg)](https://github.com/123idog/llm-cost-report/actions/workflows/ci.yml)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)
![license: MIT](https://img.shields.io/badge/license-MIT-blue)

**What your LLM app really costs, per conversation and per result, and where the money leaks. Reads your Langfuse traces.**

You moved the main step to a model that's 3× cheaper per token. The bill should drop. Did it?

```text
$ llm-cost compare v1.json v2.json --success score:qualified

# Cost compare: v1 → v2

- Cheaper per call (-38%) but more expensive per conversation (+13%): conversations need 13.8 → 25.1 calls.
- Cost per success went UP +74% ($0.349 → $0.608), and the success rate moved 30% → 19%.

|    | Metric                       | v1      | v2      | Change |
|----|------------------------------|---------|---------|--------|
| 🟢 | Cost per model call          | $0.0075 | $0.0046 | -38%   |
| 🔴 | Model calls per conversation | 13.8    | 25.1    | +81%   |
| 🔴 | Cost per conversation        | $0.103  | $0.117  | +13%   |
| 🔴 | Success rate                 | 30%     | 19%     | -35%   |
| 🔴 | Cost per success             | $0.349  | $0.608  | +74%   |
```

The cheaper model asked more clarifying questions and qualified fewer leads. Every per-token dashboard called it a win. **Cost per qualified lead went up 74%.**

Three ideas behind the tool:

1. **Price per result, not per token.** Per call → per conversation → per success. Only the last one tells you whether the bot is worth it.
2. **Find the leak before cutting the model.** Uncached prompts and oversized models usually cost more than the model choice itself.
3. **Never sum around missing data.** Calls without a cost, incomplete exports and unscored conversations are reported, not silently treated as zero.

---

## Quick start

```bash
npm install -g github:123idog/llm-cost-report

# demo with invented data (a fictional bike shop's sales bot), no Langfuse needed
node examples/generate-demo.js
llm-cost report  examples/demo-v1.json --success score:qualified --prices examples/prices.json
llm-cost compare examples/demo-v1.json examples/demo-v2.json --success score:qualified
```

## With your own Langfuse project

```bash
export LANGFUSE_HOST=https://cloud.langfuse.com
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...

llm-cost fetch --from 2026-11-01 --to 2026-11-08 --out week.json
# traces: retrieved 2400 of 2400
# observations: retrieved 31877 of 31877
# scores: retrieved 2400 of 2400

llm-cost report week.json --success score:qualified --by step,model,meta.language
```

`fetch` only sends `GET` requests and paginates to the end. If it stops early, the export records `retrieved N of M` and every report built on it starts with a warning.

---

## What the report shows

```text
# LLM cost report: v1

- 240 conversations, 3,322 model calls, 50 failed
- Total $24.80 · per call $0.0075 · per conversation $0.103 (p50 $0.091, p95 $0.154, max $0.992)
- The most expensive 5% of conversations are 17% of spend
- Tokens: 9,415,753 in (0% cached), 287,240 out
- Success (score:qualified): 71 of 240 (30%) → $0.349 per success
```

Then a table per dimension (`--by step,model,trace,meta.KEY`) with cost, share, cost per call, average tokens in and out, p50/p95 latency and errors. Conversation-level dimensions such as `meta.language` also get cost per conversation, success rate and cost per success, so you can see that one market costs more per result than another.

### Where the money leaks

| ID | Finding | Estimated saving |
|---|---|---|
| W01 | **Failed calls you still paid for**, by step | Their full cost |
| W02 | **Long prompt resent without caching**: a step with thousands of input tokens per call, mostly fixed, nothing cached | Fixed part × (input price − cached price) |
| W03 | **Big model for a tiny answer**: a step on an expensive model whose output averages a few tokens (routing, labels, yes/no) | Same tokens on the cheapest model in `--prices` |
| W04 | **Runaway conversations** with more than `--loop` model calls | Not estimated: read them first |

From the demo:

```text
W02 · "answer" resends the same long prompt without caching: $16.48 touched (66%) · est. saving $9.89 (40%)
  1,566 calls on model-large, ~3,625 input tokens each, of which ~2,807 look fixed. 0% served from cache.

W03 · "classify" uses model-large for a ~6-token answer: $8.22 touched (33%) · est. saving $7.73 (31%)
  1,516 calls with short outputs (labels, yes/no, routing). The same tokens on model-small would cost ~6% as much.
  → Candidate for model-small. Run your eval suite on it first: a cheaper classifier that misroutes costs more than it saves.
```

Findings below 1% of spend are hidden. Findings can overlap, so their savings are not added up.

---

## Options

| Option | Meaning |
|---|---|
| `--success score:qualified` | Score exists and is truthy / > 0 |
| `--success score:csat>=4` | Numeric comparison: `>=`, `>`, `<=`, `<`, `=` |
| `--success tag:won` / `meta:outcome=resolved` | Tag present / metadata value |
| `--prices prices.json` | USD per 1M tokens: `{"model": {"input": 2.5, "cachedInput": 0.25, "output": 10}}`. Used for savings estimates, and for calls Langfuse didn't price |
| `--loop 20` | Threshold for runaway conversations |
| `--json` | Machine-readable output |
| `compare ... --max-increase 10` | Exit 1 if cost per success (or per conversation, without `--success`) rises more than 10% |

### Gate a release

```bash
llm-cost compare baseline.json candidate.json --success score:qualified --max-increase 10 && ./deploy.sh
```

Pair it with a quality gate such as [llm-eval-kit](https://github.com/123idog/llm-eval-kit): a release has to hold quality **and** cost per result.

---

## Getting good data into Langfuse

The report is only as good as the traces:

- **One trace per conversation**, each model call a generation **named by step** (`classify`, `answer`, ...).
- **The exact model name** on every generation, and **cached input tokens** in the usage details.
- **The outcome as a score on the trace.** Outcomes usually arrive later (the CRM learns the lead qualified the next day), so write them back by trace ID from a nightly job.
- **Metadata** for language, channel and prompt revision, so you can split by market and by version.

## Library

```js
const { report, formatReport, compare, formatCompare } = require('llm-cost-report');

const before = report('before.json', { success: 'score:qualified', prices });
const after = report('after.json', { success: 'score:qualified', prices });
console.log(formatCompare(compare(before, after)));
```

---

## Tests

```bash
npm test
```

14 tests, using Node's built-in runner and no dependencies. The `fetch` tests run against a mocked API. All demo data, models and prices are invented.

---

## Author

**Ido Guy**, AI & Automation Engineer. I build production AI systems and measure what they cost and what they return. [LinkedIn](https://www.linkedin.com/in/ido-guy)

MIT License.
