import { selectAnalysisFields, toDate, toNumber } from '../analysis-core.mjs';
import { verifyEvidenceScope } from '../evidence/claim-verifier.mjs';

const NUMBER_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const PERCENT_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

function monthKey(value) {
  const date = toDate(value);
  return date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : null;
}

function dimensionDelta(resultSet, dimensionAlias, currentPeriod, baselinePeriod) {
  const values = new Map();
  for (const row of resultSet?.rows || []) {
    const period = monthKey(row.period);
    if (period !== currentPeriod && period !== baselinePeriod) continue;
    const label = row[dimensionAlias] == null ? null : String(row[dimensionAlias]);
    const value = toNumber(row.value);
    if (!label || value == null) continue;
    const entry = values.get(label) || { label, current: 0, baseline: 0 };
    if (period === currentPeriod) entry.current += value;
    else entry.baseline += value;
    values.set(label, entry);
  }
  return [...values.values()].map(item => ({ ...item, delta: item.current - item.baseline }));
}

function driverArtifacts({ metadata, request, resultSet, dimensionAlias, dimensionField, context, filters }) {
  const changes = dimensionDelta(resultSet, dimensionAlias, context.current.period, context.baseline.period);
  if (!changes.length) return null;
  const direction = context.delta >= 0 ? 1 : -1;
  changes.sort((a, b) => direction * (b.delta - a.delta));
  const top = changes[0];
  const offsets = [...changes].sort((a, b) => direction * (a.delta - b.delta))[0];
  const share = context.delta ? top.delta / Math.abs(context.delta) * 100 : null;
  const evidenceId = `ev-growth-${dimensionAlias}`;
  const findingId = `finding-growth-${dimensionAlias}`;
  const requiredScope = {
    metrics: [context.measure],
    dimensions: [selectAnalysisFields(metadata).date.name, dimensionField],
    periods: [context.baseline.period, context.current.period],
    filters,
  };
  const evidenceScope = { ...requiredScope };
  const scopeVerification = verifyEvidenceScope(requiredScope, evidenceScope);
  const movement = context.delta >= 0 ? '增长' : '下降';
  const driverVerb = top.delta >= 0 ? '拉动' : '拖累';
  const statement = `${context.current.period} 较 ${context.baseline.period}${movement} ¥${NUMBER_FORMAT.format(Math.abs(context.delta))}；${top.label} 是${dimensionField}中最主要的${driverVerb}项，变化 ¥${NUMBER_FORMAT.format(Math.abs(top.delta))}${share == null ? '' : `，约相当于净变化的 ${PERCENT_FORMAT.format(Math.abs(share))}%`}。`;
  const counter = offsets && offsets.label !== top.label
    ? `${offsets.label} 呈现反向影响，变化 ${offsets.delta >= 0 ? '+' : '-'}¥${NUMBER_FORMAT.format(Math.abs(offsets.delta))}。`
    : '未识别到独立反向贡献项。';
  const evidence = {
    id: evidenceId,
    title: `${dimensionField}期间变化贡献`,
    fields: [selectAnalysisFields(metadata).date.name, dimensionField, context.measure],
    rowCount: resultSet.statistics.rowCount,
    value: { current: context.current, baseline: context.baseline, changes: changes.slice(0, 20) },
    method: 'CanonicalResultSet 期间贡献分解',
    queryPlan: { id: request.id, purpose: request.purpose, adapter: resultSet.provenance.adapter },
    scope: evidenceScope,
    verification: scopeVerification,
  };
  const insight = {
    id: `insight-growth-${dimensionAlias}`,
    category: '增长来源',
    title: `${top.label} 是主要${driverVerb}项`,
    statement: `${statement} ${counter}`,
    confidence: scopeVerification.valid ? 'high' : 'low',
    evidenceIds: [evidenceId],
    limitations: resultSet.quality.isTruncated ? ['查询结果已截断，需要缩小范围复核'] : [],
  };
  const finding = {
    id: findingId,
    type: context.delta >= 0 ? 'opportunity' : 'risk',
    title: insight.title,
    claim: insight.statement,
    evidenceIds: [evidenceId],
    counterEvidenceIds: [],
    confidence: insight.confidence,
    verificationStatus: scopeVerification.valid ? 'verified' : 'needs-review',
    businessImpact: 'high',
    reportPriority: 0.95,
  };
  const chart = {
    id: `chart-growth-${dimensionAlias}`,
    type: 'bar',
    title: `${context.current.period} 较 ${context.baseline.period} · ${dimensionField}变化贡献`,
    xField: dimensionField,
    yField: `${context.measure}变化`,
    labels: changes.slice(0, 10).map(item => item.label),
    values: changes.slice(0, 10).map(item => item.delta),
    evidenceId,
  };
  return { evidence, insight, finding, chart };
}

export function buildGrowthDriverArtifacts({ metadata, planned, outcomes }) {
  if (!planned?.context) return { evidence: [], insights: [], findings: [], charts: [] };
  const selected = selectAnalysisFields(metadata);
  const artifacts = [];
  const configurations = [
    { alias: 'region', field: selected.region?.name, requestId: 'qry-growth-region' },
    { alias: 'category', field: selected.category?.name, requestId: 'qry-growth-category' },
  ];
  for (const configuration of configurations) {
    if (!configuration.field) continue;
    const outcome = outcomes.find(item => item.request.id === configuration.requestId);
    const request = planned.requests.find(item => item.id === configuration.requestId);
    if (!outcome || !request) continue;
    const artifact = driverArtifacts({
      metadata,
      request,
      resultSet: outcome.resultSet,
      dimensionAlias: configuration.alias,
      dimensionField: configuration.field,
      context: planned.context,
      filters: request.filters,
    });
    if (artifact) artifacts.push(artifact);
  }
  return {
    evidence: artifacts.map(item => item.evidence),
    insights: artifacts.map(item => item.insight),
    findings: artifacts.map(item => item.finding),
    charts: artifacts.map(item => item.chart),
  };
}
