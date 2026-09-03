import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = (process.env.UAT_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/, '');
const artifactDir = process.env.UAT_ARTIFACT_DIR || join('test', 'uat-artifacts', 'platform-golden', new Date().toISOString().slice(0, 10));
const datasetId = process.env.UAT_DATASET_ID || 'uat-platform-golden-sales';

const cases = [
  ['DI-GOLD-001', '普通销售洞察真实 LLM', '分析月度销售额、利润和订单数量'],
  ['DI-GOLD-002', '高基数多维月度洞察', '分析每个月、地区、省份、城市、商品类别的销售额和利润'],
  ['DI-GOLD-003', '稀疏业务时间序列', '比较有记录月份的销售额变化，不要把缺失月份当作零'],
  ['DI-GOLD-004', '核心成功扩展失败', '保留核心销售结论，并标记无法验证的扩展分析'],
  ['DI-GOLD-005', 'LLM 超时、限流与 Provider 失败', '验证失败时不生成伪成功正文'],
  ['DI-GOLD-006', 'Evidence 超预算与可追溯分块', '验证高基数证据的来源和覆盖范围'],
  ['DI-GOLD-007', 'Skill 版本与派生指标口径', '按 Skill 口径分析销售额、利润和毛利率'],
  ['DI-GOLD-008', '权限、租户与行级过滤', '在当前授权范围内分析各地区销售额'],
  ['DI-GOLD-009', 'PC 与移动端结果体验', '生成可在桌面和移动端阅读的销售洞察'],
  ['DI-GOLD-010', '服务重启与运行恢复', '验证洞察运行状态和审计生命周期'],
];

const rows = [
  { 月份: '2025-01', 地区: '华东', 省份: '上海市', 城市: '上海市', 类别: '海鲜', 销售额: 100, 利润: 20, 订单数: 4 },
  { 月份: '2025-02', 地区: '华东', 省份: '浙江省', 城市: '杭州市', 类别: '点心', 销售额: 120, 利润: 24, 订单数: 5 },
  { 月份: '2025-03', 地区: '华北', 省份: '河北省', 城市: '石家庄市', 类别: '饮料', 销售额: 90, 利润: 12, 订单数: 3 },
  { 月份: '2025-04', 地区: '华南', 省份: '广东省', 城市: '深圳市', 类别: '肉家禽', 销售额: 140, 利润: 35, 订单数: 6 },
  { 月份: '2025-05', 地区: '西南', 省份: '四川省', 城市: '成都市', 类别: '日用品', 销售额: 130, 利润: 30, 订单数: 5 },
  { 月份: '2025-06', 地区: '东北', 省份: '辽宁省', 城市: '大连市', 类别: '海鲜', 销售额: 150, 利润: 42, 订单数: 7 },
];

async function json(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function inputFor(id, question) {
  return {
    schema: 'wynai.insight-input/v1',
    title: `${id} ${question}`,
    source: { type: 'platform-golden-uat', sourceId: `${id}-${Date.now()}-${Math.random().toString(16).slice(2)}` },
    datasets: [{ id: datasetId, name: '平台黄金销售数据' }],
    scope: { grain: 'month', coverage: 'caller-declared-complete' },
    quality: { accuracy: 'exact', isSample: false, isTruncated: false },
    context: { question },
    resultSets: [{
      id: `${id.toLowerCase()}-result`,
      schema: [
        { name: '月份', type: 'string', role: 'time', grain: 'month' },
        { name: '地区', type: 'string', role: 'dimension' },
        { name: '省份', type: 'string', role: 'dimension' },
        { name: '城市', type: 'string', role: 'dimension' },
        { name: '类别', type: 'string', role: 'dimension' },
        { name: '销售额', type: 'number', role: 'measure', aggregation: 'sum', additivity: 'additive' },
        { name: '利润', type: 'number', role: 'measure', aggregation: 'sum', additivity: 'additive' },
        { name: '订单数', type: 'number', role: 'measure', aggregation: 'sum', additivity: 'additive' },
      ],
      rows,
    }],
  };
}

const live = await json('/api/live');
assert.equal(live.response.status, 200);
const health = await json('/api/health');
assert.equal(health.response.status, 200);
assert.equal(health.payload.connected, true);
assert.equal(health.payload.platformMigrationMode, 'shadow');

const results = [];
for (const [id, name, question] of cases) {
  const startedAt = Date.now();
  const input = inputFor(id, question);
  const accepted = await json('/api/data-insights/inputs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.ok([200, 201].includes(accepted.response.status), `${id} 输入接入失败：${accepted.payload.message || ''}`);
  const insightId = accepted.payload.insightId;
  const generated = await json(`/api/data-insights/${insightId}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ insightId, prompt: question }) });
  const diagnostics = await json(`/api/data-insights/${insightId}/diagnostics`);
  assert.equal(diagnostics.response.status, 200);
  const event = (diagnostics.payload.events || []).filter(item => item.type === 'platform.migration.orchestration').at(-1);
  const comparison = event?.data?.comparison || null;
  const lifecycle = diagnostics.payload.lifecycle || null;
  const result = {
    id,
    name,
    question,
    insightId,
    durationMs: Date.now() - startedAt,
    generate: { httpStatus: generated.response.status, status: generated.payload.status || null, provider: generated.payload.provider || null, contentLength: String(generated.payload.content || '').length, documentPresent: Boolean(generated.payload.document) },
    comparison: { passed: comparison?.passed === true, differenceCount: comparison?.differences?.length || 0, differenceKinds: (comparison?.differences || []).map(item => item.kind) },
    lifecycle: { valid: lifecycle?.valid === true, openAttempts: lifecycle?.openAttempts ?? null, orphanTerminalEvents: lifecycle?.orphanTerminalEvents ?? null },
    trace: { eventCount: diagnostics.payload.events?.length || 0 },
  };
  assert.equal(result.generate.httpStatus, 200, `${id} 生成失败：${generated.payload.message || ''}`);
  assert.ok(['completed', 'completed-partial'].includes(result.generate.status), `${id} 非终态：${result.generate.status}`);
  assert.equal(result.generate.provider, 'llm-orchestrated');
  assert.ok(result.generate.contentLength > 0);
  assert.equal(result.comparison.passed, true, `${id} 存在兼容差异：${JSON.stringify(result.comparison)}`);
  assert.equal(result.comparison.differenceCount, 0);
  assert.equal(result.lifecycle.valid, true);
  assert.equal(result.lifecycle.openAttempts, 0);
  results.push(result);
  console.log(`PASS ${id} ${name}`);
}

const report = {
  schema: 'wynai.platform-golden-uat/v1',
  version: 1,
  generatedAt: new Date().toISOString(),
  baseUrl,
  datasetId,
  mode: health.payload.platformMigrationMode,
  summary: { total: results.length, passed: results.filter(item => item.comparison.passed).length, failed: results.filter(item => !item.comparison.passed).length },
  results,
  negativePathEvidence: { cases: ['DI-GOLD-005', 'DI-GOLD-006'], note: '本运行器验证真实成功 shadow 双跑；超时、限流和上下文超预算的故障注入由 Gateway/Evidence 自动化专项覆盖。' },
};
await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
assert.equal(report.summary.failed, 0);
console.log(JSON.stringify(report.summary));
