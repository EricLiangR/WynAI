import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = process.env.WYN_AI_UAT_BASE_URL || 'http://127.0.0.1:8787';
const datasetId = process.env.WYN_AI_UAT_DATASET_ID || '2b445034-38fe-4350-9cab-b7684c28b5f8';
const artifactDir = join(process.cwd(), 'test', 'uat-artifacts', 'semantic-50', '2026-08-23');

const cases = [
  ['UAT-001', '去年每类产品销售额是多少', ['类别名称'], ['订单金额']],
  ['UAT-002', '去年各类商品利润', ['类别名称'], ['订单利润']],
  ['UAT-003', '去年按品类看销量', ['类别名称'], ['购买数量']],
  ['UAT-004', '商品类别销售额前五', ['类别名称'], ['订单金额'], 5, 'desc'],
  ['UAT-005', '利润最低的产品类别是哪个', ['类别名称'], ['订单利润'], 1, 'asc'],
  ['UAT-006', '每个产品销售额', ['商品名称'], ['订单金额']],
  ['UAT-007', '商品利润最高', ['商品名称'], ['订单利润'], 1, 'desc'],
  ['UAT-008', '销量前十的产品', ['商品名称'], ['购买数量'], 10, 'desc'],
  ['UAT-009', '客户城市销售额', ['客户城市'], ['订单金额']],
  ['UAT-010', '每个城市利润', ['客户城市'], ['订单利润']],
  ['UAT-011', '销售额最高的城市', ['客户城市'], ['订单金额'], 1, 'desc'],
  ['UAT-012', '销售最低的三个城市', ['客户城市'], ['订单金额'], 3, 'asc'],
  ['UAT-013', '过去五年累计销售排名前五的城市，城市名称和销售额', ['客户城市'], ['订单金额'], 5, 'desc'],
  ['UAT-014', '去年城市销量前五', ['客户城市'], ['购买数量'], 5, 'desc'],
  ['UAT-015', '各省销售额', ['客户省份'], ['订单金额']],
  ['UAT-016', '省份利润最高', ['客户省份'], ['订单利润'], 1, 'desc'],
  ['UAT-017', '销售额倒数两个省', ['客户省份'], ['订单金额'], 2, 'asc'],
  ['UAT-018', '客户省份利润', ['客户省份'], ['订单利润']],
  ['UAT-019', '总部省份销售额', ['总部省份'], ['订单金额']],
  ['UAT-020', '各地区销售额', ['客户地区'], ['订单金额']],
  ['UAT-021', '客户地区利润前五', ['客户地区'], ['订单利润'], 5, 'desc'],
  ['UAT-022', '每个客户销售额', ['客户名称'], ['订单金额']],
  ['UAT-023', '客户利润最高', ['客户名称'], ['订单利润'], 1, 'desc'],
  ['UAT-024', '各供应商销售额', ['供应商名称'], ['订单金额']],
  ['UAT-025', '供应商利润后五', ['供应商名称'], ['订单利润'], 5, 'asc'],
  ['UAT-026', '每个员工销售额', ['员工姓名'], ['订单金额']],
  ['UAT-027', '销售员利润最高', ['员工姓名'], ['订单利润'], 1, 'desc'],
  ['UAT-028', '各支付方式销售额', ['支付方式'], ['订单金额']],
  ['UAT-029', '付款方式利润', ['支付方式'], ['订单利润']],
  ['UAT-030', '各运货商销售额', ['运货商'], ['订单金额']],
  ['UAT-031', '承运商利润前五', ['运货商'], ['订单利润'], 5, 'desc'],
  ['UAT-032', '2025年销售总额', [], ['订单金额']],
  ['UAT-033', '去年利润总额', [], ['订单利润']],
  ['UAT-034', '前年销量', [], ['购买数量']],
  ['UAT-035', '2023、2024、2025年销售额', ['订购日期'], ['订单金额']],
  ['UAT-036', '23、24、25年利润分别是多少', ['订购日期'], ['订单利润']],
  ['UAT-037', '2023至2025每年销售额', ['订购日期'], ['订单金额']],
  ['UAT-038', '2023至2025年销售额趋势', ['订购日期'], ['订单金额']],
  ['UAT-039', '过去五年累计销售额', [], ['订单金额']],
  ['UAT-040', '2023至2025累计利润', [], ['订单利润']],
  ['UAT-041', '2023至2025各省销售额', ['客户省份'], ['订单金额']],
  ['UAT-042', '2023至2025每年各省销售额', ['客户省份', '订购日期'], ['订单金额']],
  ['UAT-043', '2023至2025累计各省销售额', ['客户省份'], ['订单金额']],
  ['UAT-044', '去年各省销售额和利润', ['客户省份'], ['订单金额', '订单利润']],
  ['UAT-045', '销售额最高的客户', ['客户名称'], ['订单金额'], 1, 'desc'],
  ['UAT-046', '销量最少的产品', ['商品名称'], ['购买数量'], 1, 'asc'],
  ['UAT-047', 'Top 5城市销售额', ['客户城市'], ['订单金额'], 5, 'desc'],
  ['UAT-048', '倒数五个商品类别利润', ['类别名称'], ['订单利润'], 5, 'asc'],
  ['UAT-049', '今年每月销售额', ['订购日期'], ['订单金额'], null, null, 'needs_clarification'],
  ['UAT-050', '2025年按季度看利润', ['订购日期'], ['订单利润']],
];

async function jsonFetch(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${payload.message || path}`);
  return payload;
}

function assertSorted(rows, alias, direction) {
  const values = rows.map(row => Number(row[alias])).filter(Number.isFinite);
  for (let index = 1; index < values.length; index += 1) {
    if (direction === 'asc') assert.ok(values[index - 1] <= values[index], `${values[index - 1]} <= ${values[index]}`);
    else assert.ok(values[index - 1] >= values[index], `${values[index - 1]} >= ${values[index]}`);
  }
}

const health = await jsonFetch('/api/health');
assert.equal(health.connected, true);
const metadata = await jsonFetch(`/api/datasets/${datasetId}/metadata`);
assert.equal(metadata.id, datasetId);
assert.equal(metadata.revision, 7);
const conversation = await jsonFetch('/api/smart-query/conversations', {
  method: 'POST', body: JSON.stringify({ datasetId }),
});

const results = [];
for (const [id, question, expectedDimensions, expectedMeasures, limit = null, direction = null, expectedStatus = 'ok'] of cases) {
  const startedAt = Date.now();
  const payload = await jsonFetch(`/api/smart-query/conversations/${conversation.id}/messages`, {
    method: 'POST', body: JSON.stringify({ question }),
  });
  const response = payload.response;
  const record = {
    id, question, expectedStatus, actualStatus: response.status, durationMs: Date.now() - startedAt,
    passed: false, issue: null, planner: response.analysisMethod?.id || null,
    intent: response.businessIntent || null,
    request: response.queryRequests?.[0] || null,
    semanticValidation: response.semanticValidation || null,
    resultSummary: null,
    answer: response.document?.blocks?.find(block => block.id === 'answer-summary')?.content || response.clarification?.question || null,
  };
  try {
    assert.equal(response.status, expectedStatus);
    if (expectedStatus === 'ok') {
      const request = response.queryRequests[0];
      const resultSet = response.resultSets[0];
      assert.deepEqual(request.select.map(item => item.field), expectedDimensions);
      assert.deepEqual(request.measures.map(item => item.field), expectedMeasures);
      assert.equal(response.semanticValidation?.valid, true);
      assert.ok(resultSet.rows.length > 0);
      assert.equal(resultSet.quality?.isSample, false);
      assert.equal(resultSet.quality?.isTruncated, false);
      if (limit != null) {
        assert.equal(request.limit, limit);
        assert.ok(resultSet.rows.length <= limit);
        assertSorted(resultSet.rows, request.measures[0].alias, direction);
      }
      for (const item of request.select) assert.ok(resultSet.schema.some(column => column.name === item.alias));
      for (const item of request.measures) {
        assert.ok(resultSet.schema.some(column => column.name === item.alias));
        assert.ok(resultSet.rows.every(row => Number.isFinite(Number(row[item.alias]))));
      }
      record.resultSummary = {
        rowCount: resultSet.rows.length,
        columns: resultSet.schema.map(column => column.name),
        firstRows: resultSet.rows.slice(0, 5),
        quality: resultSet.quality,
      };
    } else {
      assert.match(response.clarification?.question || '', /结果行数 0|调整问题范围/);
    }
    record.passed = true;
  } catch (error) {
    record.issue = error.message;
  }
  results.push(record);
  console.log(`${record.passed ? 'PASS' : 'FAIL'} ${id} ${question}`);
}

await mkdir(artifactDir, { recursive: true });
const report = {
  schema: 'wynai.semantic-uat-run/v1',
  executedAt: new Date().toISOString(),
  baseUrl,
  dataset: { id: metadata.id, name: metadata.name, revision: metadata.revision },
  health: { connected: health.connected, llmConfigured: health.llmConfigured, llmModel: health.llmModel },
  summary: {
    total: results.length,
    passed: results.filter(item => item.passed).length,
    failed: results.filter(item => !item.passed).length,
  },
  results,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(join(artifactDir, 'api-results.json'), serialized, 'utf8');
await writeFile(join(process.cwd(), 'test', 'uat-artifacts', 'semantic-50', 'latest.json'), serialized, 'utf8');
assert.equal(report.summary.failed, 0, `${report.summary.failed} 个真实 UAT 未通过`);
console.log(JSON.stringify(report.summary));
