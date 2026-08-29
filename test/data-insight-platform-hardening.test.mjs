import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInsightInput } from '../lib/data-insights/insight-input.mjs';
import { buildEvidencePack } from '../lib/data-insights/evidence-pack.mjs';
import { runInsightLlmOrchestration } from '../lib/data-insights/llm-orchestrator.mjs';

test('InsightInput v1 保留指标语义与派生公式', () => {
  const input = normalizeInsightInput({ schema: 'wynai.insight-input/v1', title: '销售', resultSets: [{ id: 'rs-1', schema: [{ name: '毛利率', type: 'number', role: 'measure', metricId: 'grossMarginRate', aggregation: 'none', semanticType: 'ratio', additivity: 'non-additive', derivedFrom: ['利润', '销售额'], formula: { operator: 'ratio' } }], rows: [{ 毛利率: 0.2 }] }] });
  assert.equal(input.resultSets[0].schema[0].additivity, 'non-additive');
  assert.equal(input.resultSets[0].schema[0].formula.operator, 'ratio');
});

test('Evidence Pack 不对非可加比率求和，并生成空值率与期间变化证据', () => {
  const pack = buildEvidencePack({ resultSets: [{ id: 'rs-1', schema: [
    { name: '月份', type: 'string', role: 'time' }, { name: '销售额', type: 'number', role: 'measure', additivity: 'additive', aggregation: 'sum' }, { name: '同比', type: 'number', role: 'measure', semanticType: 'ratio', additivity: 'non-additive', aggregation: 'none' },
  ], rows: [{ 月份: '2025年1月', 销售额: 100, 同比: 0.1 }, { 月份: '2025年2月', 销售额: 120, 同比: 0.2 }, { 月份: '2025年3月', 销售额: 140, 同比: null }] }] });
  const stats = pack.resultSets[0].statistics.fields;
  assert.equal(stats['同比'].sum, undefined); assert.equal(stats['同比'].sumSuppressed, true);
  assert.ok(pack.resultSets[0].statistics.derived.some(item => item.title.includes('空值率')));
  assert.ok(pack.resultSets[0].statistics.derived.some(item => item.title.includes('销售额')));
});

test('Critic 全部 supported 时自动规范为 sufficient', async () => {
  const llm = { enabled: true, model: 'fake', completeJson: async (_messages, options) => {
    if (options.operation.endsWith('planner')) return { schema: 'wynai.insight-planner/v1', hypotheses: [{ id: 'h1', requiredEvidenceIds: ['ev-rs-1-row-count'] }], toolRequests: [] };
    if (options.operation.endsWith('critic')) return { schema: 'wynai.insight-critic/v1', verdict: 'insufficient', assessments: [{ hypothesisId: 'h1', status: 'supported', evidenceIds: ['ev-rs-1-row-count'] }], followUps: [] };
    return { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '结果可核验。', evidenceIds: ['ev-rs-1-row-count'] }], keyFindings: [{ text: '结果可核验。', evidenceIds: ['ev-rs-1-row-count'] }], risks: [{ text: '暂无明确风险。', evidenceIds: ['ev-rs-1-row-count'] }], actions: [{ text: '持续复核。', evidenceIds: ['ev-rs-1-row-count'] }] };
  } };
  const input = buildEvidencePack({ resultSets: [{ id: 'rs-1', schema: [{ name: '销售额', type: 'number', role: 'measure' }], rows: [{ 销售额: 1 }] }] });
  const result = await runInsightLlmOrchestration({ llm, input });
  assert.equal(result.critic.verdict, 'sufficient'); assert.equal(result.critic.normalization.reason, 'all-assessments-supported');
});

test('业务事实证据进入统一目录且不会把 fallback 重复注入 LLM', async () => {
  const resultSetId = 'rs-quarter-sales';
  const base = buildEvidencePack({
    title: '过去五年季度地区品类销售',
    resultSets: [{
      id: resultSetId,
      schema: [
        { name: '季度', type: 'string', role: 'time' },
        { name: '地区', type: 'string', role: 'dimension' },
        { name: '品类', type: 'string', role: 'dimension' },
        { name: '收入', type: 'number', role: 'measure' },
        { name: '利润', type: 'number', role: 'measure' },
      ],
      rows: [
        { 季度: '2021年第1季度', 地区: '华东', 品类: '海鲜', 收入: 100, 利润: 45 },
        { 季度: '2021年第2季度', 地区: '华北', 品类: '饮料', 收入: 80, 利润: 35 },
        { 季度: '2022年第1季度', 地区: '华东', 品类: '日用品', 收入: 120, 利润: 55 },
      ],
    }],
  });
  const businessFacts = {
    schema: 'wynai.business-fact-pack/v1',
    facts: [
      { id: 'time-trend', title: '时间趋势', value: [{ 季度: '2021年第1季度', 收入: 100 }], evidenceIds: ['time-trend'], method: 'deterministic.time-group' },
      { id: 'time-anomaly', title: '时间序列高低点', value: { highest: { 收入: 120 } }, evidenceIds: ['time-anomaly'], method: 'deterministic.extrema' },
      { id: 'dimension-contribution', title: '地区贡献', value: [{ 地区: '华东', 收入: 220 }], evidenceIds: ['dimension-contribution'], method: 'deterministic.dimension-group' },
      { id: 'concentration', title: '地区集中度', value: { share: 0.72 }, evidenceIds: ['concentration'], method: 'deterministic.concentration' },
    ],
    evidenceIds: ['time-trend', 'time-anomaly', 'dimension-contribution', 'concentration'],
    fallback: { provider: 'deterministic-fallback', facts: [{ id: 'should-not-be-sent' }] },
  };
  const messages = [];
  const llm = {
    enabled: true,
    model: 'fake',
    completeJson: async (payload, options) => {
      messages.push({ payload, operation: options.operation });
      if (options.operation.endsWith('planner')) return {
        schema: 'wynai.insight-planner/v1',
        hypotheses: [{ id: 'h1', requiredEvidenceIds: ['time-trend', 'concentration'] }],
        toolRequests: [{ id: 'tr1', kind: 'trend', resultSetId, field: '收入', reason: '验证趋势' }],
      };
      if (options.operation.endsWith('critic')) return {
        schema: 'wynai.insight-critic/v1', verdict: 'sufficient',
        assessments: [{ hypothesisId: 'h1', status: 'supported', reason: '证据足够', evidenceIds: ['time-trend', 'concentration'] }],
        followUps: [],
      };
      return {
        schema: 'wynai.insight-narrator/v1',
        managementSummary: [{ text: '季度趋势与地区集中度均可核验。', evidenceIds: ['time-trend', 'concentration'] }],
        keyFindings: [{ text: '华东贡献较高。', evidenceIds: ['dimension-contribution'] }],
        risks: [{ text: '地区集中度需要持续监控。', evidenceIds: ['concentration'] }],
        actions: [{ text: '按季度复核地区与品类结构。', evidenceIds: ['time-trend', 'dimension-contribution'] }],
      };
    },
  };
  const result = await runInsightLlmOrchestration({ llm, prompt: '分析季度地区品类关系', input: { ...base, businessFacts } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.stageAudit.map(item => item.stage), ['planner', 'critic', 'narrator']);
  assert.ok(result.evidence.some(item => item.id === 'time-trend'));
  assert.ok(result.evidence.some(item => item.id === 'concentration'));
  assert.equal(messages[0].payload[1].content.includes('should-not-be-sent'), false);
  assert.ok(messages[0].payload[1].content.length / 4 < 20000);
});
