import { normalizeInsightDocument } from '../protocol/interaction-contract.mjs';

function accuracyOf(resultSets = []) {
  if (resultSets.some(item => item.quality?.isSample)) return 'sample';
  if (resultSets.some(item => item.quality?.isEstimated)) return 'estimated';
  if (resultSets.some(item => item.quality?.isTruncated)) return 'unknown';
  return 'exact';
}

function collectEvidenceIds(analysis) {
  return (analysis?.evidence || []).map(item => ({
    id: item.id,
    title: item.title || item.id,
    value: item.value ?? null,
    scope: item.scope || null,
    verification: item.verification || null,
  }));
}

function isUserFacingQualityWarning(message) {
  const text = String(message || '');
  if (/AI Planner|AI Critic|NONE JSON|WAX 原始日期分组|服务端列裁剪|时间粒度.*归并/.test(text)) return false;
  return /样本|截断|达到(?:结果)?上限|估算|不完整|范围不足|无法保证.*完整|结果受限/.test(text);
}

export function composeInsightDocument({ result, conversationId = null, question = '' }) {
  const analysis = result?.analysis || {};
  const resultSets = result?.resultSets || [];
  const blocks = [];
  for (const kpi of (analysis.kpis || []).slice(0, 8)) {
    blocks.push({ id: `kpi-${kpi.id || blocks.length + 1}`, type: 'kpi', title: kpi.label || kpi.id, value: kpi.value ?? kpi.rawValue ?? null, evidenceIds: kpi.evidenceIds || [] });
  }
  const summary = analysis.report?.summary?.[0] || analysis.report?.markdown?.split('\n').find(line => line.trim()) || question || '本次分析已完成。';
  blocks.push({ id: 'summary', type: 'text', title: '分析摘要', content: summary, evidenceIds: (analysis.insights || []).flatMap(item => item.evidenceIds || []).slice(0, 8) });
  for (const chart of (analysis.charts || []).slice(0, 12)) {
    blocks.push({ id: chart.id || `chart-${blocks.length + 1}`, type: 'chart', title: chart.title || chart.id, chartType: chart.chartType || 'line', dataRef: chart.resultSetId || chart.dataRef || resultSets.find(item => item.requestId === chart.queryId)?.id || null, encoding: chart.encoding || { x: chart.xField || null, y: chart.yField || null }, evidenceIds: chart.evidenceId ? [chart.evidenceId] : (chart.evidenceIds || []) });
  }
  for (const resultSet of resultSets.filter(item => item.rows?.length).slice(0, 6)) {
    if (blocks.some(block => block.type === 'chart' && block.dataRef === resultSet.id)) continue;
    blocks.push({ id: `table-${resultSet.requestId}`, type: 'table', title: resultSet.requestId, dataRef: resultSet.id, columns: resultSet.schema?.map(column => column.name) || [], evidenceIds: [] });
  }
  const diagnostics = [...new Set([
    ...(result?.audit?.warnings || []),
    ...resultSets.flatMap(item => item.quality?.warnings || []),
  ])];
  const warnings = diagnostics.filter(isUserFacingQualityWarning);
  warnings.slice(0, 8).forEach((message, index) => blocks.push({ id: `warning-${index + 1}`, type: 'warning', title: '数据范围提示', message, evidenceIds: [] }));
  const scope = {
    datasetId: analysis.dataset?.id || result?.dataset?.id,
    datasets: [analysis.dataset?.id || result?.dataset?.id].filter(Boolean),
    datasetRevision: analysis.dataset?.revision ?? null,
    filters: analysis.execution?.filters || [],
    timeRange: null,
    accuracy: accuracyOf(resultSets),
    isSample: resultSets.some(item => item.quality?.isSample),
    isTruncated: resultSets.some(item => item.quality?.isTruncated),
  };
  return normalizeInsightDocument({
    documentType: 'analysis-page',
    title: analysis.goal || question || '智能问数分析',
    scope,
    blocks,
    evidence: collectEvidenceIds(analysis),
    followUpActions: [],
    nextQuestions: [],
    conversationId,
  });
}
