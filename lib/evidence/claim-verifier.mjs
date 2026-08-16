function normalizedSet(values = []) {
  return new Set(values.filter(Boolean).map(value => String(value)));
}

function missingValues(required, actual) {
  const actualSet = normalizedSet(actual);
  return [...normalizedSet(required)].filter(value => !actualSet.has(value));
}

function filterKey(filter) {
  return `${filter.field}|${filter.operator}|${JSON.stringify(filter.value)}`;
}

export function verifyEvidenceScope(required = {}, evidenceScope = {}) {
  const reasons = [];
  const missingMetrics = missingValues(required.metrics, evidenceScope.metrics);
  if (missingMetrics.length) reasons.push(`缺少指标范围：${missingMetrics.join('、')}`);
  const missingDimensions = missingValues(required.dimensions, evidenceScope.dimensions);
  if (missingDimensions.length) reasons.push(`缺少维度范围：${missingDimensions.join('、')}`);
  const missingPeriods = missingValues(required.periods, evidenceScope.periods);
  if (missingPeriods.length) reasons.push(`缺少时间范围：${missingPeriods.join('、')}`);
  const actualFilters = new Set((evidenceScope.filters || []).map(filterKey));
  const missingFilters = (required.filters || []).filter(filter => !actualFilters.has(filterKey(filter)));
  if (missingFilters.length) reasons.push(`证据过滤范围与结论不一致：${missingFilters.map(filter => filter.field).join('、')}`);
  return { valid: reasons.length === 0, reasons };
}

export function assertEvidenceScope(required, evidenceScope) {
  const verification = verifyEvidenceScope(required, evidenceScope);
  if (!verification.valid) {
    const error = new Error(`证据不能支持该结论：${verification.reasons.join('；')}`);
    error.status = 422;
    throw error;
  }
  return verification;
}
