import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDataset } from '../lib/analysis-core.mjs';
import { runAutonomousAnalysis } from '../lib/harness/orchestrator.mjs';

const metadata = {
  id: 'dataset-sales-v2',
  name: '销售经营数据',
  revision: 9,
  indexed: true,
  description: '订单级销售经营宽表',
  fieldCount: 7,
  assistant: { describedFieldCount: 7 },
  roles: {
    time: ['订购日期'],
    measure: ['订单金额', '订单利润'],
    dimension: ['类别名称', '客户名称'],
    geography: ['客户地区'],
    identifier: ['订单编号'],
  },
  fields: [
    { name: '订单编号', type: 'String', rawType: 'String', role: 'identifier' },
    { name: '订购日期', type: 'Date', rawType: 'DateTime', role: 'time' },
    { name: '类别名称', type: 'String', rawType: 'String', role: 'dimension' },
    { name: '客户地区', type: 'String', rawType: 'String', role: 'geography' },
    { name: '客户名称', type: 'String', rawType: 'String', role: 'dimension' },
    { name: '订单金额', type: 'Number', rawType: 'Double', role: 'measure' },
    { name: '订单利润', type: 'Number', rawType: 'Double', role: 'measure' },
  ],
};

function fakeDatasetExecutor() {
  return async (_datasetId, options) => {
    if (options.queryType === 'NONE') {
      return {
        rows: [
          { 订单编号: 'O1', 订购日期: '2026-01-05', 类别名称: '饮料', 客户地区: '华东', 客户名称: '甲', 订单金额: 120, 订单利润: 30 },
          { 订单编号: 'O2', 订购日期: '2026-01-15', 类别名称: '点心', 客户地区: '华西', 客户名称: '乙', 订单金额: 80, 订单利润: 15 },
          { 订单编号: 'O3', 订购日期: '2026-02-05', 类别名称: '饮料', 客户地区: '华东', 客户名称: '甲', 订单金额: 230, 订单利润: 45 },
          { 订单编号: 'O4', 订购日期: '2026-02-18', 类别名称: '点心', 客户地区: '华西', 客户名称: '丙', 订单金额: 70, 订单利润: 10 },
        ],
        truncated: false,
      };
    }
    const query = options.query;
    if (query.startsWith('EVALUATE ROW')) {
      return { rows: [{ source_rows: 4, total: 500, orders: 4, profit: 100, date_min: '2026-01-05', date_max: '2026-02-18' }], truncated: false };
    }
    const hasDate = query.includes('[订购日期]');
    const hasRegion = query.includes('[客户地区]');
    const hasCategory = query.includes('[类别名称]');
    if (hasDate && hasRegion) {
      return { rows: [
        { group1: '2026-01-05', group2: '华东', revenue: 120, profit: 30 },
        { group1: '2026-01-15', group2: '华西', revenue: 80, profit: 15 },
        { group1: '2026-02-05', group2: '华东', revenue: 230, profit: 45 },
        { group1: '2026-02-18', group2: '华西', revenue: 70, profit: 10 },
      ], truncated: false };
    }
    if (hasDate && hasCategory) {
      return { rows: [
        { group1: '2026-01-05', group2: '饮料', revenue: 120, profit: 30 },
        { group1: '2026-01-15', group2: '点心', revenue: 80, profit: 15 },
        { group1: '2026-02-05', group2: '饮料', revenue: 230, profit: 45 },
        { group1: '2026-02-18', group2: '点心', revenue: 70, profit: 10 },
      ], truncated: false };
    }
    if (hasDate) return { rows: [{ group1: '2026-01-05', revenue: 200, profit: 45 }, { group1: '2026-02-05', revenue: 300, profit: 55 }], truncated: false };
    if (query.includes('[客户名称]')) return { rows: [{ group1: '甲', revenue: 350, profit: 75 }, { group1: '乙', revenue: 150, profit: 25 }], truncated: false };
    if (hasRegion) return { rows: [{ group1: '华东', revenue: 350, profit: 75 }, { group1: '华西', revenue: 150, profit: 25 }], truncated: false };
    if (hasCategory) return { rows: [{ group1: '饮料', revenue: 350, profit: 75 }, { group1: '点心', revenue: 150, profit: 25 }], truncated: false };
    throw new Error('未识别的测试查询');
  };
}

test('V2.1 Harness 按问题规划查询并由结果触发第二轮下钻', async () => {
  const result = await runAutonomousAnalysis({
    metadata,
    focus: '最近有哪些异常波动？',
    constraints: { filters: [] },
    executeDatasetQuery: fakeDatasetExecutor(),
    analyzeDataset,
  });

  assert.equal(result.analysis.version, 'analysis-run/v2.1');
  assert.equal(result.analysis.validation.queryMode, 'routed-canonical-v2.1-exploration');
  assert.equal(result.analysis.validation.evidenceCoverage, 100);
  assert.equal(result.analysis.planning.intent, 'anomaly');
  assert.equal(result.analysis.planning.plannerMode, 'deterministic-fallback');
  assert.equal(result.queries.length, 4);
  assert.equal(result.budget.usedRounds, 2);
  assert.ok(result.queries.some(item => item.request.id === 'qry-anomaly-trend'));
  assert.ok(result.queries.some(item => item.request.id === 'qry-result-driven-driver'));
  assert.ok(result.queries.some(item => item.executionPlan?.adapter === 'wyn-dataset-none-json'));
  assert.ok(result.queries.some(item => item.executionPlan?.adapter === 'wyn-wax-controlled'));
  assert.ok(result.hypotheses.some(item => item.id === 'hyp-result-driven-driver' && item.status === 'supported'));
  assert.ok(result.analysis.charts.some(item => item.id === 'chart-anomaly-trend'));
  assert.ok(result.analysis.charts.some(item => item.id === 'chart-result-driven-driver'));
  assert.ok(result.analysis.insights.some(item => item.id === 'insight-result-driven-driver' && /华东/.test(item.statement)));
  assert.ok(result.analysis.evidence.filter(item => item.id.includes('result-driven')).every(item => item.verification.valid));
  assert.equal(result.resultSets.find(item => item.requestId === 'qry-system-quality').rows.length, 0);
  assert.equal(result.resultSets.find(item => item.requestId === 'qry-system-quality').rowStorage, 'not-persisted-sensitive-detail');
  assert.ok(result.resultSets.find(item => item.requestId === 'qry-result-driven-driver').rows.length > 0);
  assert.equal(result.resultSets.find(item => item.requestId === 'qry-result-driven-driver').quality.isTruncated, false);
  assert.deepEqual(
    result.queries.find(item => item.request.id === 'qry-result-driven-driver').request.filters.slice(-2).map(item => [item.operator, item.value]),
    [['gte', '2026-01-01'], ['lt', '2026-03-01']],
  );
  assert.ok(result.queries.find(item => item.request.id === 'qry-result-driven-driver').request.lineage.triggerResultSetIds.includes('rs-qry-anomaly-trend'));
  assert.match(result.analysis.report.markdown, /异常波动/);
  assert.equal(result.audit.warnings.length, 0);
});

test('严格模式禁止确定性 fallback 被包装成成功分析', async () => {
  await assert.rejects(() => runAutonomousAnalysis({
    metadata,
    focus: '最近有哪些异常波动？',
    constraints: { filters: [] },
    executeDatasetQuery: fakeDatasetExecutor(),
    analyzeDataset,
    strictMode: true,
  }), /严格分析禁止 Planner 降级/);
});

test('严格模式在 Critic 契约失败后立即停止且不执行确定性 follow-up', async () => {
  let queryCalls = 0;
  const executeDatasetQuery = async (...args) => {
    queryCalls += 1;
    return fakeDatasetExecutor()(...args);
  };
  let captured;
  try {
    await runAutonomousAnalysis({
      metadata,
      focus: '最近有哪些异常波动？',
      constraints: { filters: [] },
      executeDatasetQuery,
      analyzeDataset,
      strictMode: true,
      explorationAgent: {
        enabled: true,
        plan: async () => ({ plan: { intent: 'anomaly', methods: ['anomaly_trend'], hypotheses: [] }, model: 'fake-model' }),
        critique: async () => ({
          summary: '无效追问', assessments: [], hypotheses: [],
          requests: [{ id: 'qry-invalid-followup', hypothesisId: 'hyp-unknown', purpose: '无来源追问', mode: 'verify', select: [{ field: '类别名称', alias: 'category' }], measures: [{ field: null, aggregation: 'countRows', alias: 'records' }] }],
        }),
      },
    });
  } catch (error) {
    captured = error;
  }
  assert.match(captured?.message || '', /严格分析禁止 Critic 降级/);
  assert.equal(captured?.diagnostics?.phase, 'critic');
  assert.equal(captured?.diagnostics?.fallbackExecuted, false);
  assert.equal(queryCalls, 3);
});

test('严格模式首轮查询失败时保留原始错误并且不调用 Critic', async () => {
  let criticCalls = 0;
  const baseExecutor = fakeDatasetExecutor();
  const executeDatasetQuery = async (datasetId, options) => {
    if (options.queryType === 'NONE' || options.query.startsWith('EVALUATE ROW')) return baseExecutor(datasetId, options);
    throw new Error('模拟首轮 WAX 失败');
  };
  let captured;
  try {
    await runAutonomousAnalysis({
      metadata,
      focus: '最近有哪些异常波动？',
      constraints: { filters: [] },
      executeDatasetQuery,
      analyzeDataset,
      strictMode: true,
      explorationAgent: {
        enabled: true,
        plan: async () => ({ plan: { intent: 'anomaly', methods: ['anomaly_trend'], hypotheses: [] }, model: 'fake-model' }),
        critique: async () => {
          criticCalls += 1;
          return { summary: '不应执行', assessments: [], hypotheses: [], requests: [] };
        },
      },
    });
  } catch (error) {
    captured = error;
  }
  assert.match(captured?.message || '', /严格分析首轮查询失败.*模拟首轮 WAX 失败/);
  assert.equal(captured?.diagnostics?.phase, 'initial-query');
  assert.equal(captured?.diagnostics?.fallbackExecuted, false);
  assert.equal(criticCalls, 0);
});
