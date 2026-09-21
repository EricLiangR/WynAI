function uniqueStrings(items = []) {
  return [...new Set(items.map(item => String(item || '').trim()).filter(Boolean))];
}

function normalizePredicate(input = {}) {
  const predicate = { field: String(input.field || '').trim(), operator: String(input.operator || '').trim() };
  if (!predicate.field || !predicate.operator) throw new Error('发布门禁条件必须包含 field 和 operator');
  if (Object.hasOwn(input, 'value')) predicate.value = input.value;
  if (Object.hasOwn(input, 'values')) predicate.values = Array.isArray(input.values) ? input.values : [input.values];
  return predicate;
}

function addCalendarDays(isoDate, offsetDays) {
  const date = new Date(`${String(isoDate).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + Number(offsetDays || 0));
  return date.toISOString().slice(0, 10);
}

function resolveExpectedValue(value, runtime = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.$relativeDate === 'businessDate') {
    const currentDate = runtime.currentDate || null;
    return currentDate ? addCalendarDays(currentDate, value.offsetDays || 0) : value;
  }
  return value;
}

function resolveExpectedPredicate(predicate, runtime = {}) {
  const resolved = { ...predicate };
  if (Object.hasOwn(resolved, 'value')) resolved.value = resolveExpectedValue(resolved.value, runtime);
  if (Object.hasOwn(resolved, 'values')) resolved.values = resolved.values.map(value => resolveExpectedValue(value, runtime));
  return resolved;
}

function normalizeExpected(input = {}) {
  const rows = input.rows == null ? null : Number(input.rows);
  if (rows != null && (!Number.isInteger(rows) || rows < 0)) throw new Error('expected.rows 必须是非负整数');
  return {
    status: String(input.status || 'ok').trim(),
    clarification: Boolean(input.clarification),
    fields: uniqueStrings(input.fields || []),
    metrics: uniqueStrings(input.metrics || []),
    filters: (input.filters || []).map(normalizePredicate),
    forbiddenFilters: (input.forbiddenFilters || []).map(normalizePredicate),
    postAggregateFilters: (input.postAggregateFilters || []).map(normalizePredicate),
    rows,
    allowZeroRows: Boolean(input.allowZeroRows),
    adapter: input.adapter == null ? null : String(input.adapter),
    requireTrace: input.requireTrace !== false,
    complete: input.complete !== false,
    values: (input.values || []).map(item => ({
      field: String(item.field || '').trim(), value: item.value,
      tolerance: Number.isFinite(Number(item.tolerance)) ? Number(item.tolerance) : 0,
    })),
  };
}

export function normalizeReleaseGatePack(input = {}) {
  const id = String(input.id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{2,100}$/i.test(id)) throw new Error('发布门禁包 ID 无效');
  if (!String(input.datasetId || '').trim()) throw new Error('发布门禁包缺少数据集');
  const cases = (input.cases || []).map((item, index) => ({
    id: String(item.id || `${id}-${index + 1}`).trim(),
    question: String(item.question || '').trim(),
    expected: normalizeExpected(item.expected),
    tags: uniqueStrings(item.tags || []),
    screenshot: item.screenshot === 'overview-only' ? 'overview-only' : 'overview-and-detail',
    equivalentTo: item.equivalentTo == null ? null : String(item.equivalentTo),
  }));
  if (!cases.length || cases.some(item => !item.id || !item.question)) throw new Error('发布门禁包必须包含非空用例');
  if (new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('发布门禁用例 ID 必须唯一');
  return {
    schema: 'wynai.release-gate-pack/v1', id, version: String(input.version || '1.0.0'),
    datasetId: String(input.datasetId), datasetName: String(input.datasetName || ''),
    skillRef: input.skillRef == null ? null : String(input.skillRef),
    status: input.status === 'approved' ? 'approved' : 'draft', cases,
  };
}

function asArray(value) { return Array.isArray(value) ? value : []; }
function actualRows(actual = {}) { return asArray(actual.rows || actual.data || actual.result?.rows || actual.resultSet?.rows); }
function resultContract(actual = {}) { return actual.resultContract || actual.contract || actual.result?.contract || actual.resultSet?.contract || {}; }
function canonical(actual = {}) { return actual.canonical || actual.queryRequest || actual.request || actual.queryRequests?.[0] || {}; }

function predicates(actual = {}, key = 'filters') {
  const query = canonical(actual);
  if (key === 'postAggregateFilters') return asArray(actual.postAggregateFilters || query.postAggregateFilters || query.having || actual.having);
  return asArray(actual.filters || query.filters);
}

function predicateValue(input) { return Object.hasOwn(input || {}, 'values') ? input.values : input?.value; }
function sameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    const a = asArray(left).map(String).sort();
    const b = asArray(right).map(String).sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return String(left ?? '') === String(right ?? '');
}
function hasPredicate(actual, expected) {
  return actual.some(item => item?.field === expected.field && item?.operator === expected.operator
    && (!Object.hasOwn(expected, 'value') && !Object.hasOwn(expected, 'values')
      ? true : sameValue(predicateValue(item), predicateValue(expected))));
}
function actualFields(actual = {}, rows = actualRows(actual)) {
  const declared = [...asArray(actual.fields), ...asArray(actual.columns), ...asArray(actual.result?.fields), ...asArray(actual.resultSet?.fields)]
    .map(item => typeof item === 'string' ? item : item?.field || item?.name || item?.sourceField);
  return uniqueStrings([...declared, ...rows.flatMap(row => Object.keys(row || {}))]);
}
function actualMetrics(actual = {}) {
  return uniqueStrings(asArray(actual.metrics || canonical(actual).metrics).map(item => typeof item === 'string' ? item : item?.field));
}
function findValue(rows, expected, actual = {}) {
  const fields = uniqueStrings([expected.field, ...(actual.valueAliases?.[expected.field] || [])]);
  for (const row of rows) {
    for (const field of fields) if (Object.hasOwn(row || {}, field)) return row[field];
  }
  return undefined;
}
function valueMatches(actual, expected, tolerance) {
  if (typeof expected === 'number') {
    const number = Number(actual);
    return Number.isFinite(number) && Math.abs(number - expected) <= tolerance;
  }
  return sameValue(actual, expected);
}
function check(name, passed, actual, expected) { return { name, passed: Boolean(passed), actual, expected }; }

export function evaluateReleaseCase(testCase, actual = {}, runtime = {}) {
  const expected = normalizeExpected(testCase?.expected || {});
  const filtersExpected = expected.filters.map(item => resolveExpectedPredicate(item, runtime));
  const forbiddenFiltersExpected = expected.forbiddenFilters.map(item => resolveExpectedPredicate(item, runtime));
  const postAggregateFiltersExpected = expected.postAggregateFilters.map(item => resolveExpectedPredicate(item, runtime));
  const rows = actualRows(actual);
  const contract = resultContract(actual);
  const filters = predicates(actual, 'filters');
  const postAggregateFilters = predicates(actual, 'postAggregateFilters');
  const status = actual.status || actual.actualStatus || actual.response?.status || null;
  const traceId = actual.traceId || actual.trace?.id || actual.response?.traceId || null;
  const adapter = actual.adapter || actual.execution?.adapter || contract.adapter || null;
  const fallback = actual.fallback ?? actual.usedFallback ?? actual.execution?.fallback ?? false;
  const fields = actualFields(actual, rows);
  const metrics = actualMetrics(actual);
  const checks = [
    check('status', status === expected.status, status, expected.status),
    check('clarification', !expected.clarification || status === 'needs_clarification', status, 'needs_clarification'),
    check('fields', expected.fields.every(field => fields.includes(field)), fields, expected.fields),
    check('metrics', expected.metrics.every(field => metrics.includes(field)), metrics, expected.metrics),
    check('filters', filtersExpected.every(item => hasPredicate(filters, item)), filters, filtersExpected),
    check('forbiddenFilters', forbiddenFiltersExpected.every(item => !hasPredicate(filters, item)), filters, forbiddenFiltersExpected),
    check('postAggregateFilters', postAggregateFiltersExpected.every(item => hasPredicate(postAggregateFilters, item)), postAggregateFilters, postAggregateFiltersExpected),
    check('rows', expected.rows == null || rows.length === expected.rows, rows.length, expected.rows),
    check('zeroRows', rows.length > 0 || expected.allowZeroRows || expected.clarification, rows.length, expected.allowZeroRows ? '0 allowed' : '> 0'),
    check('trace', !expected.requireTrace || expected.clarification || Boolean(traceId), traceId, expected.requireTrace ? 'required' : 'optional'),
    check('fallback', fallback === false, fallback, false),
    check('adapter', !expected.adapter || adapter === expected.adapter, adapter, expected.adapter),
  ];
  if (expected.complete && !expected.clarification) {
    checks.push(
      check('isSample', contract.isSample === false, contract.isSample, false),
      check('isTruncated', contract.isTruncated === false, contract.isTruncated, false),
      check('isEstimated', contract.isEstimated === false, contract.isEstimated, false),
      check('limitReached', contract.limitReached === false, contract.limitReached, false),
      check('returnedRowCount', contract.returnedRowCount === rows.length, contract.returnedRowCount, rows.length),
      check('totalRowCount', contract.totalRowCount === rows.length, contract.totalRowCount, rows.length),
    );
  }
  for (const item of expected.values) {
    const value = findValue(rows, item, actual);
    checks.push(check(`value:${item.field}`, valueMatches(value, item.value, item.tolerance), value, item.value));
  }
  return {
    id: testCase?.id || null, passed: checks.every(item => item.passed), checks,
    actual: { status, rowCount: rows.length, fields, metrics, filters, postAggregateFilters, traceId, adapter, fallback, contract },
  };
}

export function summarizeReleaseGate(pack, results = []) {
  const normalized = normalizeReleaseGatePack(pack);
  const byId = new Map(results.map(item => [item.id, item]));
  const cases = normalized.cases.map(testCase => byId.get(testCase.id) || {
    id: testCase.id, passed: false, checks: [check('executed', false, false, true)],
  });
  return {
    schema: 'wynai.release-gate-run/v1', packRef: `${normalized.id}@${normalized.version}`,
    datasetId: normalized.datasetId, total: cases.length,
    passed: cases.filter(item => item.passed).length,
    failed: cases.filter(item => !item.passed).length,
    releaseReady: cases.length > 0 && cases.every(item => item.passed), results: cases,
  };
}
