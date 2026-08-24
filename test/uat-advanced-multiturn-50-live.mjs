import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = process.env.WYN_AI_UAT_BASE_URL || 'http://127.0.0.1:8787';
const datasetId = process.env.WYN_AI_UAT_DATASET_ID || '2b445034-38fe-4350-9cab-b7684c28b5f8';
const artifactDir = join(process.cwd(), 'test', 'uat-artifacts', 'advanced-multiturn-50', '2026-08-24');

const ok = (question, expect = {}) => ({ question, status: 'ok', expect });
const clarify = question => ({ question, status: 'needs_clarification' });

const scenarios = [
  { id: 'AMT-001', title: '三年销售额同比后限定华东', turns: [ok('2023至2025年销售额和销售额同比增长率', { derived: ['revenue_yoy'], periods: [2023, 2024, 2025] }), ok('只看华东', { derived: ['revenue_yoy'], region: '华东', periods: [2023, 2024, 2025] })] },
  { id: 'AMT-002', title: '三年利润同比后限定华东', turns: [ok('2023至2025年利润和利润同比增长率', { derived: ['profit_yoy'] }), ok('只看华东', { derived: ['profit_yoy'], region: '华东' })] },
  { id: 'AMT-003', title: '三年销量同比后限定华东', turns: [ok('2023至2025年销量和销量同比增长率', { derived: ['quantity_yoy'] }), ok('只看华东', { derived: ['quantity_yoy'], region: '华东' })] },
  { id: 'AMT-004', title: '月销售额环比后限定华东', turns: [ok('2025年每月销售额和环比增长率', { derived: ['revenue_mom'], grain: 'month' }), ok('只看华东', { derived: ['revenue_mom'], grain: 'month', region: '华东' })] },
  { id: 'AMT-005', title: '月利润环比后限定华东', turns: [ok('2025年每月利润和环比增长率', { derived: ['profit_mom'], grain: 'month' }), ok('只看华东', { derived: ['profit_mom'], region: '华东' })] },
  { id: 'AMT-006', title: '月销量环比后限定华东', turns: [ok('2025年每月销量和环比增长率', { derived: ['quantity_mom'], grain: 'month' }), ok('只看华东', { derived: ['quantity_mom'], region: '华东' })] },
  { id: 'AMT-007', title: '月销售额同比后限定华东', turns: [ok('2025年每月销售额和同比增长率', { derived: ['revenue_yoy'], grain: 'month' }), ok('只看华东', { derived: ['revenue_yoy'], region: '华东' })] },
  { id: 'AMT-008', title: '月利润同比后限定华东', turns: [ok('2025年每月利润和同比增长率', { derived: ['profit_yoy'], grain: 'month' }), ok('只看华东', { derived: ['profit_yoy'], region: '华东' })] },
  { id: 'AMT-009', title: '复合指标与销售额同比', turns: [ok('2023至2025年销售额、利润和销售额同比增长率', { metrics: ['订单金额', '订单利润'], derived: ['revenue_yoy'] }), ok('只看华东', { metrics: ['订单金额', '订单利润'], derived: ['revenue_yoy'], region: '华东' })] },
  { id: 'AMT-010', title: '复合指标与销量同比', turns: [ok('2023至2025年销售额、销量和销量同比增长率', { metrics: ['订单金额', '购买数量'], derived: ['quantity_yoy'] }), ok('只看华东', { derived: ['quantity_yoy'], region: '华东' })] },

  { id: 'AMT-011', title: '每年省份冠军后切利润', turns: [ok('2023、2024、2025年销售额排名第一的省份分别是哪个', { partition: ['period'], ranking: 1 }), ok('改成利润', { metrics: ['订单利润'], partition: ['period'], ranking: 1 })] },
  { id: 'AMT-012', title: '每年城市冠军后切利润', turns: [ok('2023至2025年每年销售额最高的城市', { partition: ['period'], ranking: 1 }), ok('改成利润', { metrics: ['订单利润'], partition: ['period'] })] },
  { id: 'AMT-013', title: '每年省份利润后两名后切销售额', turns: [ok('2023至2025年每年利润最低的两个省份', { partition: ['period'], ranking: 2, direction: 'asc' }), ok('改成销售额', { metrics: ['订单金额'], partition: ['period'] })] },
  { id: 'AMT-014', title: '每年产品销量前三后切销售额', turns: [ok('2023至2025年每年销量前三的产品', { partition: ['period'], ranking: 3 }), ok('改成销售额', { metrics: ['订单金额'], partition: ['period'] })] },
  { id: 'AMT-015', title: '每年省份销售额前二后切利润', turns: [ok('2023至2025年每年销售额前两个省份', { partition: ['period'], ranking: 2 }), ok('改成利润', { partition: ['period'] })] },
  { id: 'AMT-016', title: '每年城市利润前三后限定华东', turns: [ok('2023至2025年每年利润前三的城市', { partition: ['period'], ranking: 3 }), ok('只看华东', { partition: ['period'], region: '华东' })] },
  { id: 'AMT-017', title: '每年类别销量冠军后切销售额', turns: [ok('2023至2025年每年销量最高的商品类别', { partition: ['period'], ranking: 1 }), ok('改成销售额', { partition: ['period'] })] },
  { id: 'AMT-018', title: '每城利润最高产品后限定华东', turns: [ok('每个城市利润最高的产品', { partition: ['city'], ranking: 1 }), ok('只看华东', { partition: ['city'], region: '华东' })] },
  { id: 'AMT-019', title: '每地区销售额最高客户后切利润', turns: [ok('每个地区销售额最高的客户', { partition: ['region'], ranking: 1 }), ok('改成利润', { partition: ['region'] })] },
  { id: 'AMT-020', title: '每经理销售额最高产品后切利润', turns: [ok('每个销售经理销售额最高的产品', { partition: ['employee'], ranking: 1 }), ok('改成利润', { partition: ['employee'] })] },

  { id: 'AMT-021', title: '三年销售经理累计前三后切利润', turns: [ok('过去三年销售额累计排名前三的销售经理是谁', { dimensions: ['员工姓名'], ranking: 3, scopePolicy: 'latest-complete-years' }), ok('改成利润', { metrics: ['订单利润'], dimensions: ['员工姓名'], ranking: 3 })] },
  { id: 'AMT-022', title: '五年销售经理累计前五后限定华东', turns: [ok('过去五年销售额累计排名前五的销售经理', { dimensions: ['员工姓名'], ranking: 5 }), ok('只看华东', { region: '华东', ranking: 5 })] },
  { id: 'AMT-023', title: '三年员工利润后三后切销售额', turns: [ok('过去三年累计利润最低的三个员工', { dimensions: ['员工姓名'], ranking: 3, direction: 'asc' }), ok('改成销售额', { metrics: ['订单金额'], ranking: 3 })] },
  { id: 'AMT-024', title: '三年客户累计销售额前五后限定华东', turns: [ok('2023至2025累计销售额前五的客户', { dimensions: ['客户名称'], ranking: 5 }), ok('只看华东', { region: '华东' })] },
  { id: 'AMT-025', title: '三年产品累计利润前五后切销量', turns: [ok('2023至2025累计利润前五的产品', { dimensions: ['商品名称'], ranking: 5 }), ok('改成销量', { metrics: ['购买数量'] })] },
  { id: 'AMT-026', title: '三年供应商累计销售额前五后切利润', turns: [ok('2023至2025累计销售额前五的供应商', { dimensions: ['供应商名称'], ranking: 5 }), ok('改成利润', { metrics: ['订单利润'] })] },
  { id: 'AMT-027', title: '三年城市累计销售额前五后限定华东', turns: [ok('2023至2025累计销售额前五的城市', { dimensions: ['客户城市'], ranking: 5 }), ok('只看华东', { region: '华东' })] },
  { id: 'AMT-028', title: '三年省份累计利润前三后切销售额', turns: [ok('2023至2025累计利润前三的省份', { dimensions: ['客户省份'], ranking: 3 }), ok('改成销售额', { metrics: ['订单金额'] })] },
  { id: 'AMT-029', title: '三年类别累计销量前三后切利润', turns: [ok('2023至2025累计销量前三的商品类别', { dimensions: ['类别名称'], ranking: 3 }), ok('改成利润', { metrics: ['订单利润'] })] },
  { id: 'AMT-030', title: '三年运货商累计销售额前三后切利润', turns: [ok('2023至2025累计销售额前三的运货商', { dimensions: ['运货商'], ranking: 3 }), ok('改成利润', { metrics: ['订单利润'] })] },

  { id: 'AMT-031', title: '澄清销售经理维度', turns: [clarify('过去三年销售额累计排名前三的是谁'), ok('我是需要按照销售经理作为维度', { dimensions: ['员工姓名'], patch: true, ranking: 3 })] },
  { id: 'AMT-032', title: '澄清商品类别维度', turns: [clarify('2025年销售额最高的是哪个'), ok('按照商品类别作为维度', { dimensions: ['类别名称'], patch: true })] },
  { id: 'AMT-033', title: '澄清客户维度', turns: [clarify('去年利润最低的五个是谁'), ok('按客户维度', { dimensions: ['客户名称'], patch: true, direction: 'asc' })] },
  { id: 'AMT-034', title: '澄清城市维度', turns: [clarify('2023至2025累计销售额最高的是谁'), ok('按城市维度', { dimensions: ['客户城市'], patch: true })] },
  { id: 'AMT-035', title: '澄清省份维度', turns: [clarify('2023至2025累计利润前三的是哪些'), ok('按省份维度', { dimensions: ['客户省份'], patch: true })] },
  { id: 'AMT-036', title: '澄清产品维度', turns: [clarify('2025年销量前十的是哪些'), ok('按产品名称维度', { dimensions: ['商品名称'], patch: true })] },
  { id: 'AMT-037', title: '澄清供应商维度', turns: [clarify('过去三年累计销售额前五的是谁'), ok('按供应商维度', { dimensions: ['供应商名称'], patch: true })] },
  { id: 'AMT-038', title: '澄清运货商维度', turns: [clarify('2024年利润后三名是谁'), ok('按运货商维度', { dimensions: ['运货商'], patch: true })] },
  { id: 'AMT-039', title: '澄清支付方式维度', turns: [clarify('2025年销售额最高的是哪一种'), ok('按支付方式维度', { dimensions: ['支付方式'], patch: true })] },
  { id: 'AMT-040', title: '澄清每年城市冠军', turns: [clarify('2023至2025年每年销售额最高的是谁'), ok('按城市维度', { dimensions: ['客户城市', '订购日期'], partition: ['period'], patch: true })] },

  { id: 'AMT-041', title: '省份双指标后限定华东', turns: [ok('2023至2025年各省销售额和利润', { metrics: ['订单金额', '订单利润'], dimensions: ['客户省份'] }), ok('只看华东', { region: '华东', metrics: ['订单金额', '订单利润'] })] },
  { id: 'AMT-042', title: '年度省份销售额后切利润', turns: [ok('2023至2025年每年各省销售额', { dimensions: ['客户省份', '订购日期'], grain: 'year' }), ok('改成利润', { metrics: ['订单利润'], dimensions: ['客户省份', '订购日期'] })] },
  { id: 'AMT-043', title: '季度利润后切销售额', turns: [ok('2025年按季度看利润', { grain: 'quarter', metrics: ['订单利润'] }), ok('改成销售额', { grain: 'quarter', metrics: ['订单金额'] })] },
  { id: 'AMT-044', title: '月销售额后限定华东', turns: [ok('2025年每月销售额', { grain: 'month' }), ok('只看华东', { grain: 'month', region: '华东' })] },
  { id: 'AMT-045', title: '三年销售经理累计后切利润', turns: [ok('过去三年按销售经理累计销售额', { dimensions: ['员工姓名'], scopePolicy: 'latest-complete-years' }), ok('改成利润', { metrics: ['订单利润'], dimensions: ['员工姓名'] })] },
  { id: 'AMT-046', title: '三年趋势连续切指标和地区', turns: [ok('2023至2025年销售额趋势', { grain: 'year' }), ok('改成利润', { metrics: ['订单利润'], grain: 'year' }), ok('只看华东', { metrics: ['订单利润'], grain: 'year', region: '华东' })] },
  { id: 'AMT-047', title: '华东年度同比后切利润同比', turns: [ok('华东地区每年销售额和同比增长率', { derived: ['revenue_yoy'], region: '华东' }), ok('改成利润', { derived: ['profit_yoy'], metrics: ['订单利润'], region: '华东' })] },
  { id: 'AMT-048', title: '年度趋势追加同比', turns: [ok('2023至2025年销售额趋势', { grain: 'year' }), ok('再看同比增长率', { derived: ['revenue_yoy'], periods: [2023, 2024, 2025] })] },
  { id: 'AMT-049', title: '月销售额追加环比', turns: [ok('2025年每月销售额', { grain: 'month' }), ok('再看环比增长率', { derived: ['revenue_mom'], grain: 'month' })] },
  { id: 'AMT-050', title: '月利润追加同比', turns: [ok('2025年每月利润', { grain: 'month' }), ok('再看同比增长率', { derived: ['profit_yoy'], grain: 'month' })] },
];

assert.equal(scenarios.length, 50);
assert.ok(scenarios.every(item => item.turns.length >= 2));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function jsonFetch(path, init = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(baseUrl + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    const payload = await response.json();
    if (response.status === 429) {
      await delay(Math.max(250, Number(payload.retryAfterMs) || 1000) + 50);
      continue;
    }
    if (!response.ok) throw new Error(response.status + ' ' + (payload.message || path));
    return payload;
  }
  throw new Error('连续五次触发限流');
}

function validateTurn(response, turn, previousResponse) {
  assert.equal(response.status, turn.status);
  if (turn.status === 'needs_clarification') {
    assert.ok(response.clarification?.question);
    assert.equal(response.document, null);
    assert.equal(response.pendingContext?.schema, 'wynai.pending-query-context/v1');
    assert.ok(response.pendingContext.unresolvedSlots.length > 0);
    return;
  }
  assert.equal(response.semanticValidation?.valid, true);
  const result = response.resultSets?.[0];
  assert.ok(result);
  assert.ok(result.rows.length > 0);
  assert.equal(result.quality?.isSample, false);
  assert.equal(result.quality?.isTruncated, false);
  const intent = response.businessIntent;
  const expect = turn.expect || {};
  if (expect.metrics) assert.deepEqual(intent.metrics.map(item => item.field), expect.metrics);
  if (expect.dimensions) assert.deepEqual(intent.dimensions.map(item => item.field), expect.dimensions);
  if (expect.derived) {
    assert.deepEqual(intent.derivedMetrics.map(item => item.alias), expect.derived);
    for (const alias of expect.derived) assert.ok(result.schema.some(column => column.name === alias && column.format === 'percentage'));
  }
  if (expect.partition) assert.deepEqual(intent.ranking?.partitionBy, expect.partition);
  if (expect.ranking != null) assert.equal(intent.ranking?.limit, expect.ranking);
  if (expect.direction) assert.equal(intent.ranking?.direction, expect.direction);
  if (expect.periods) assert.deepEqual(intent.time.periods, expect.periods);
  if (expect.grain) assert.equal(intent.time.grain, expect.grain);
  if (expect.scopePolicy) assert.equal(intent.time.scopePolicy, expect.scopePolicy);
  if (expect.region) assert.equal(intent.filters.find(item => item.field === '客户地区')?.value, expect.region);
  if (expect.patch) {
    assert.equal(response.intentPatch?.schema, 'wynai.intent-patch/v1');
    assert.ok(response.intentPatch.operations.length > 0);
  }
  if (previousResponse?.status === 'needs_clarification') assert.equal(response.intentPatch?.schema, 'wynai.intent-patch/v1');
}

const health = await jsonFetch('/api/health');
assert.equal(health.connected, true);
const metadata = await jsonFetch('/api/datasets/' + datasetId + '/metadata');
assert.equal(metadata.revision, 7);

const results = [];
for (const scenario of scenarios) {
  const conversation = await jsonFetch('/api/smart-query/conversations', {
    method: 'POST',
    body: JSON.stringify({ datasetId }),
  });
  const record = { id: scenario.id, title: scenario.title, passed: true, issue: null, conversationId: conversation.id, turns: [] };
  let previousResponse = null;
  for (let index = 0; index < scenario.turns.length; index += 1) {
    const turn = scenario.turns[index];
    const startedAt = Date.now();
    try {
      const payload = await jsonFetch('/api/smart-query/conversations/' + conversation.id + '/messages', {
        method: 'POST',
        body: JSON.stringify({ question: turn.question }),
      });
      const response = payload.response;
      validateTurn(response, turn, previousResponse);
      record.turns.push({
        turn: index + 1,
        question: turn.question,
        expectedStatus: turn.status,
        actualStatus: response.status,
        durationMs: Date.now() - startedAt,
        intent: response.businessIntent || response.pendingContext?.intent || null,
        intentPatch: response.intentPatch || null,
        queryProgram: response.queryProgram || null,
        queryRequest: response.queryRequests?.[0] || null,
        semanticValidation: response.semanticValidation || null,
        result: response.resultSets?.[0] ? {
          rowCount: response.resultSets[0].rows.length,
          schema: response.resultSets[0].schema,
          firstRows: response.resultSets[0].rows.slice(0, 8),
          quality: response.resultSets[0].quality,
        } : null,
        clarification: response.clarification || null,
      });
      previousResponse = response;
    } catch (error) {
      record.passed = false;
      record.issue = '第' + (index + 1) + '轮：' + error.message;
      break;
    }
  }
  results.push(record);
  console.log((record.passed ? 'PASS ' : 'FAIL ') + scenario.id + ' ' + scenario.title + (record.issue ? ' :: ' + record.issue : ''));
}

const report = {
  schema: 'wynai.advanced-multiturn-uat/v1',
  executedAt: new Date().toISOString(),
  baseUrl,
  dataset: { id: metadata.id, name: metadata.name, revision: metadata.revision },
  health: { connected: health.connected, llmConfigured: health.llmConfigured, llmModel: health.llmModel },
  summary: {
    scenarios: results.length,
    turns: results.reduce((total, item) => total + item.turns.length, 0),
    passed: results.filter(item => item.passed).length,
    failed: results.filter(item => !item.passed).length,
  },
  results,
};
await mkdir(artifactDir, { recursive: true });
const serialized = JSON.stringify(report, null, 2) + '\n';
await writeFile(join(artifactDir, 'api-results.json'), serialized, 'utf8');
await writeFile(join(process.cwd(), 'test', 'uat-artifacts', 'advanced-multiturn-50', 'latest.json'), serialized, 'utf8');
assert.equal(report.summary.failed, 0, report.summary.failed + ' 个复杂多轮场景失败');
console.log(JSON.stringify(report.summary));