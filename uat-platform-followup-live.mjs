import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = (process.env.UAT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const artifactDir = process.env.UAT_ARTIFACT_DIR || 'uat-followup-platform-2026-08-30';

async function json(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

const live = await json('/api/live');
assert.equal(live.response.status, 200);
assert.equal(live.payload.alive, true);

const health = await json('/api/health');
assert.equal(health.response.status, 200, `Wyn 健康检查失败：${health.payload.message || ''}`);
assert.equal(health.payload.connected, true);
assert.ok(['not_configured', 'not_checked', 'healthy', 'unhealthy', 'circuit_open'].includes(health.payload.llmHealthStatus));
assert.equal(health.payload.llmGateway.policy.responseBodyTimeoutMs, 180000);

const llmHealth = await json('/api/llm/health');
assert.ok(['healthy', 'unhealthy', 'circuit_open', 'not_configured'].includes(llmHealth.payload.status));
if (llmHealth.payload.status === 'healthy') assert.equal(llmHealth.payload.ok, true);
if (llmHealth.payload.status !== 'healthy') assert.equal(llmHealth.payload.ok, false);

const sourceId = `uat-followup-${Date.now()}`;
const input = {
  schema: 'wynai.insight-input/v1',
  title: '阶段跟进 UAT 月度销售利润',
  source: { type: 'uat', sourceId },
  datasets: [{ id: 'uat-synthetic-sales', name: '合成验收数据' }],
  scope: { grain: 'month', coverage: 'caller-declared-complete' },
  quality: { accuracy: 'exact', isSample: false, isTruncated: false },
  context: { question: '比较每月销售额和利润变化' },
  resultSets: [{
    id: 'monthly-sales-profit',
    schema: [
      { name: '月份', type: 'string', role: 'time', grain: 'month' },
      { name: '销售额', type: 'number', role: 'measure', aggregation: 'sum', additivity: 'additive' },
      { name: '利润', type: 'number', role: 'measure', aggregation: 'sum', additivity: 'additive' },
    ],
    rows: [
      { 月份: '2025-01', 销售额: 100, 利润: 20 },
      { 月份: '2025-02', 销售额: 120, 利润: 24 },
      { 月份: '2025-03', 销售额: 90, 利润: 12 },
      { 月份: '2025-04', 销售额: 140, 利润: 35 },
      { 月份: '2025-05', 销售额: 130, 利润: 30 },
      { 月份: '2025-06', 销售额: 150, 利润: 42 },
    ],
  }],
};

const accepted = await json('/api/data-insights/inputs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
assert.ok([200, 201].includes(accepted.response.status), `标准输入接入失败：${accepted.payload.message || ''}`);
const insightId = accepted.payload.insightId;
assert.match(insightId, /^ins-/);

const generated = await json(`/api/data-insights/${insightId}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ insightId, prompt: input.context.question }) });
const diagnostics = await json(`/api/data-insights/${insightId}/diagnostics`);
assert.equal(diagnostics.response.status, 200);
assert.equal(diagnostics.payload.lifecycle?.schema, 'wynai.insight-diagnostic-lifecycle/v1');
assert.equal(diagnostics.payload.lifecycle?.valid, true);
assert.equal(diagnostics.payload.lifecycle?.openAttempts, 0);

const result = {
  schema: 'wynai.platform-followup-uat/v1',
  generatedAt: new Date().toISOString(),
  baseUrl,
  pid: live.payload.pid,
  health: { status: health.payload.llmHealthStatus, responseBodyTimeoutMs: health.payload.llmGateway.policy.responseBodyTimeoutMs },
  llmHealth: { status: llmHealth.payload.status, code: llmHealth.payload.code || null, ok: llmHealth.payload.ok === true },
  insightId,
  generate: { httpStatus: generated.response.status, status: generated.payload.status || null, provider: generated.payload.provider || null, errorCode: generated.payload.error?.code || generated.payload.code || null, contentLength: String(generated.payload.content || '').length, documentPresent: Boolean(generated.payload.document) },
  lifecycle: diagnostics.payload.lifecycle,
};

if (llmHealth.payload.status === 'healthy') {
  assert.equal(generated.response.status, 200, JSON.stringify(generated.payload));
  assert.ok(['completed', 'completed-partial'].includes(generated.payload.status));
  assert.equal(generated.payload.provider, 'llm-orchestrated');
  assert.ok(String(generated.payload.content || '').trim());
} else {
  assert.notEqual(generated.response.status, 200, 'LLM 不可用时不得返回伪成功');
  assert.equal(generated.payload.status, 'failed');
  assert.equal(result.generate.contentLength, 0, 'LLM 失败时不得返回降级洞察正文');
  assert.equal(result.generate.documentPresent, false, 'LLM 失败时不得保存洞察文档');
  assert.ok(['INSIGHT_LLM_REQUIRED', 'LLM_REQUEST_FAILED', 'LLM_UPSTREAM_ERROR', 'LLM_CONNECT_TIMEOUT', 'LLM_RESPONSE_HEADER_TIMEOUT', 'LLM_RESPONSE_BODY_TIMEOUT', 'LLM_TIMEOUT', 'LLM_CIRCUIT_OPEN'].includes(result.generate.errorCode));
}

await mkdir(artifactDir, { recursive: true });
await writeFile(`${artifactDir}/latest.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
