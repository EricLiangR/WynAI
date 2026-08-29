import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidencePack } from '../lib/data-insights/evidence-pack.mjs';

test('Evidence Pack 使用全量统计并禁止原始明细外发', () => {
  const pack = buildEvidencePack({ title: '销售分析', resultSets: [{ id: 'rs-1', schema: [{ name: '区域', type: 'string', role: 'dimension' }, { name: '销售额', type: 'number', role: 'measure' }], rows: [{ 区域: '华东', 销售额: 100 }, { 区域: '华南', 销售额: 80 }, { 区域: '华东', 销售额: 20 }] }] });
  assert.equal(pack.schema, 'wynai.evidence-pack/v1');
  assert.equal(pack.resultSets[0].statistics.rowCount, 3);
  assert.equal(pack.resultSets[0].statistics.fields.销售额.sum, 200);
  assert.equal(pack.resultSets[0].statistics.fields.销售额.average, 200 / 3);
  assert.equal(pack.policy.rawRowsToLlm, false);
  assert.equal(pack.resultSets[0].samples.length, 3);
});

test('Evidence Pack 为时间和业务层级生成全量聚合证据而非只依赖样本', () => {
  const rows = [
    { 日期: '2023年1月', 大区: '华东', 省份: '江苏省', 城市: '南京市', 销售额: 100, 利润: 20 },
    { 日期: '2023年1月', 大区: '华南', 省份: '广东省', 城市: '广州市', 销售额: 80, 利润: 12 },
    { 日期: '2023年2月', 大区: '华东', 省份: '江苏省', 城市: '南京市', 销售额: 120, 利润: 24 },
  ];
  const pack = buildEvidencePack({ resultSets: [{ id: 'rs-hierarchy', schema: [{ name: '日期', type: 'string', role: 'time' }, { name: '大区', type: 'string', role: 'dimension' }, { name: '省份', type: 'string', role: 'dimension' }, { name: '城市', type: 'string', role: 'dimension' }, { name: '销售额', type: 'number', role: 'measure' }, { name: '利润', type: 'number', role: 'measure' }], rows }] });
  const groupings = pack.resultSets[0].statistics.groupings;
  const monthly = groupings.find(item => item.dimensions.length === 1 && item.dimensions[0].name === '日期');
  const cube = groupings.find(item => item.dimensions.length === 4);
  assert.deepEqual(monthly.rows[0], { 日期: '2023-01', recordCount: 2, 销售额: 180, 利润: 32 });
  assert.equal(monthly.totalGroups, 2);
  assert.equal(cube.rows.length, 3);
  assert.equal(pack.policy.rawRowsToLlm, false);
  assert.equal(pack.resultSets[0].samples.length, 3);
});

test('高基数 Evidence Pack 受预算控制并记录覆盖范围', () => {
  const rows = Array.from({ length: 1581 }, (_, index) => ({
    月份: `2023年${(index % 12) + 1}月`,
    地区: `地区${index % 6}`,
    省份: `省份${index % 16}`,
    城市: `城市${index % 80}`,
    销售额: index + 100,
    利润: index + 20,
  }));
  const pack = buildEvidencePack({ resultSets: [{ id: 'rs-high', schema: [
    { name: '月份', type: 'string', role: 'time' }, { name: '地区', type: 'string', role: 'dimension' }, { name: '省份', type: 'string', role: 'dimension' }, { name: '城市', type: 'string', role: 'dimension' }, { name: '销售额', type: 'number', role: 'measure' }, { name: '利润', type: 'number', role: 'measure' },
  ], rows }] });
  assert.equal(pack.complexity.level, 'high-cardinality');
  assert.equal(pack.budget.withinBudget, true);
  assert.ok(pack.budget.estimatedTokens < pack.budget.maxTokens);
  assert.ok(pack.coverage.omittedGroups > 0);
  assert.ok(pack.resultSets[0].statistics.groupings.every(grouping => grouping.rows.length <= 40));
  assert.equal(pack.policy.rawRowsToLlm, false);
});

test('Evidence Pack 超预算时保留预算诊断', () => {
  const pack = buildEvidencePack({ evidence: [{ id: 'ev-big', value: Array.from({ length: 100 }, (_, index) => ({ value: index })) }], resultSets: [] }, { maxTokens: 10, maxEvidenceRows: 100 });
  assert.equal(pack.budget.withinBudget, false);
  assert.ok(pack.budget.estimatedTokens > pack.budget.maxTokens);
});

test('聚合结果在合理规模内完整传递，不按平台推断缺失期间', () => {
  const rows = Array.from({ length: 38 }, (_, index) => ({
    月份: `2022-${String(index + 1).padStart(2, '0')}`,
    销售额: index + 100,
    利润: index + 40,
  }));
  const pack = buildEvidencePack({
    title: '过去四年每月销售额和利润',
    scope: { timeRange: { start: '2022-01-01', end: '2026-01-01' }, grain: 'month' },
    resultSets: [{ id: 'rs-full-periods', schema: [
      { name: '月份', type: 'string', role: 'time' },
      { name: '销售额', type: 'number', role: 'measure' },
      { name: '利润', type: 'number', role: 'measure' },
    ], rows }],
  });
  assert.equal(pack.resultSets[0].rows.length, 38);
  assert.equal(pack.policy.sampleStrategy, 'none-for-aggregate-results');
  assert.equal(pack.inputCoverage.platformDoesNotInferMissingPeriods, true);
});

test('高基数聚合结果进入可追溯分块清单，不做头尾采样', async () => {
  const rows = Array.from({ length: 1581 }, (_, index) => ({ 月份: `2020-${String((index % 12) + 1).padStart(2, '0')}`, 地区: `区域${index}`, 销售额: index + 1 }));
  const pack = buildEvidencePack({ resultSets: [{ id: 'rs-large', schema: [{ name: '月份', type: 'string', role: 'time' }, { name: '地区', type: 'string', role: 'dimension' }, { name: '销售额', type: 'number', role: 'measure' }], rows }] });
  assert.equal(pack.resultSets[0].rows.length, 1581);
  const { runInsightLlmOrchestration } = await import('../lib/data-insights/llm-orchestrator.mjs');
  const seen = [];
  const llm = { enabled: true, model: 'fake', completeJson: async (messages, options) => {
    if (options.operation.endsWith('planner')) { seen.push(messages[1].content); return { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] }; }
    if (options.operation.endsWith('critic')) return { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] };
    return { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '分块结果已接收。', evidenceIds: ['ev-rs-large-row-count'] }], keyFindings: [{ text: '分块结果可核验。', evidenceIds: ['ev-rs-large-row-count'] }], risks: [{ text: '暂无明确风险。', evidenceIds: ['ev-rs-large-row-count'] }], actions: [{ text: '继续复核。', evidenceIds: ['ev-rs-large-row-count'] }] };
  } };
  const result = await runInsightLlmOrchestration({ llm, input: pack });
  assert.equal(result.status, 'completed');
  assert.match(seen[0], /chunked-summary-all-rows/);
  assert.match(seen[0], /chunkCount/);
  assert.doesNotMatch(seen[0], /bounded-summary/);
});
