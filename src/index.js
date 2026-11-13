'use strict';

const { readExport, normalize, priceCall } = require('./load');
const { analyze, formatReport, compare, formatCompare, parseSuccess } = require('./report');
const { findWaste } = require('./waste');
const { fetchExport } = require('./fetch');

// One call from an export (file path or object) to a report.
function report(input, opts = {}) {
  const data = normalize(readExport(input), opts);
  return analyze(data, opts);
}

module.exports = { readExport, normalize, priceCall, analyze, report, formatReport, compare, formatCompare, parseSuccess, findWaste, fetchExport };
