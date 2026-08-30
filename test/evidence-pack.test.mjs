import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidencePack } from '../lib/data-insights/evidence-pack.mjs';
import { buildBusinessFactPack } from '../business-fact-engine.mjs';
import { compileSkillPlan } from '../skill-plan.mjs';

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

test('高基数 Evidence Pack 默认保留完整核心聚合并记录覆盖范围', () => {
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
  assert.equal(pack.coverage.omittedGroups, 0);
  assert.equal(pack.coverage.groupingsComplete, true);
  assert.ok(pack.resultSets[0].statistics.groupings.every(grouping => grouping.rows.length === grouping.totalGroups));
  assert.equal(pack.policy.rawRowsToLlm, false);
});

test('Evidence Pack 显式平台限制会记录派生证据覆盖范围，不伪装为源数据缺失', () => {
  const rows = Array.from({ length: 80 }, (_, index) => ({ 地区: `地区${index}`, 销售额: index + 1 }));
  const pack = buildEvidencePack({ resultSets: [{ id: 'rs-limited', schema: [
    { name: '地区', type: 'string', role: 'dimension' }, { name: '销售额', type: 'number', role: 'measure' },
  ], rows }] }, { maxGroups: 40 });
  assert.ok(pack.coverage.omittedGroups > 0);
  assert.equal(pack.coverage.sourceCompleteness.isTruncated, null);
  assert.equal(pack.coverage.evidenceCoverage.complete, false);
  assert.ok(pack.resultSets[0].statistics.groupings.every(grouping => grouping.rows.length <= 40));
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

test('供应商只在部分月份有记录属于业务稀疏，不被判为源数据或证据缺失', () => {
  const rows = [
    { 供应商: 'A', 月份: '2024-01', 销售额: 100, 利润: 20 },
    { 供应商: 'A', 月份: '2024-03', 销售额: 120, 利润: 24 },
    { 供应商: 'B', 月份: '2024-02', 销售额: 80, 利润: 12 },
  ];
  const input = {
    scope: { periodCoverageMode: 'observed-records-only' },
    quality: { accuracy: 'exact', isSample: false, isTruncated: false },
    resultSets: [{ id: 'rs-sparse', schema: [
      { name: '供应商', type: 'string', role: 'dimension' },
      { name: '月份', type: 'string', role: 'time', grain: 'month' },
      { name: '销售额', type: 'number', role: 'measure' },
      { name: '利润', type: 'number', role: 'measure' },
    ], rows }],
  };
  const pack = buildEvidencePack(input);
  const facts = buildBusinessFactPack({ input, evidencePack: pack, skills: [{ id: 'test', version: '1', metrics: [
    { id: 'revenue', name: '销售额', field: '销售额', aggregation: 'sum' },
    { id: 'profit', name: '利润', field: '利润', aggregation: 'sum' },
  ] }] });
  const trend = facts.facts.find(item => item.id === 'time-trend');
  assert.deepEqual(trend.value.observedPeriods, ['2024-01', '2024-03', '2024-02']);
  assert.equal(trend.scope.periodCoverageMode, 'observed-records-only');
  assert.equal(trend.scope.resultLimited, false);
  assert.equal(pack.coverage.sourceCompleteness.isTruncated, false);
  assert.equal(pack.coverage.evidenceCoverage.complete, true);
  assert.equal(pack.coverage.businessSparsity.missingRowsAreZero, false);
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

test('SkillPlan 将核心与扩展方法编译为不可弱化的运行时契约', () => {
  const plan = compileSkillPlan({
    question: '按月分析收入',
    schema: [
      { name: '月份', type: 'string', role: 'time' },
      { name: '收入', type: 'number', role: 'measure' },
    ],
    skills: [{
      id: 'demo',
      version: '1.0.0',
      insightMethods: ['monthly-trend', 'region-contribution'],
      coreMethods: ['monthly-trend'],
      optionalMethods: ['region-contribution'],
      evidenceRequirements: { 'monthly-trend': ['月份', '收入'], 'region-contribution': ['地区', '收入'] },
    }],
  });
  assert.equal(plan.schema, 'wynai.skill-plan/v1');
  assert.equal(plan.methods.find(item => item.id === 'monthly-trend').blocking, true);
  assert.equal(plan.methods.find(item => item.id === 'monthly-trend').available, true);
  assert.deepEqual(plan.unavailableCoreMethods, []);
  assert.equal(plan.methods.find(item => item.id === 'region-contribution').priority, 'extended');
  assert.deepEqual(plan.methods.find(item => item.id === 'region-contribution').missingFields, ['地区']);
});
