'use strict';

function sum(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function mean(xs) {
  return xs.length ? sum(xs) / xs.length : 0;
}

// Nearest-rank percentile. p in [0, 100].
function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length, Math.max(1, rank)) - 1];
}

// Share of the total held by the most expensive `fraction` of items.
function topShare(xs, fraction) {
  if (!xs.length) return 0;
  const total = sum(xs);
  if (!total) return 0;
  const s = [...xs].sort((a, b) => b - a);
  const n = Math.max(1, Math.round(s.length * fraction));
  return sum(s.slice(0, n)) / total;
}

function usd(n) {
  if (n == null || Number.isNaN(n)) return 'n/a';
  if (n === 0) return '$0';
  const a = Math.abs(n);
  if (a < 0.01) return `$${n.toFixed(4)}`;
  if (a < 1) return `$${n.toFixed(3)}`;
  if (a < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function pct(n, digits = 0) {
  if (n == null || Number.isNaN(n) || !Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(digits)}%`;
}

function signedPct(n) {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  const v = Math.round(n * 100);
  return `${v > 0 ? '+' : ''}${v}%`;
}

function ms(n) {
  if (!n) return '0 ms';
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
}

module.exports = { sum, mean, percentile, topShare, usd, pct, signedPct, ms };
