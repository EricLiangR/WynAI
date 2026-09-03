import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = (process.env.UAT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const artifactDir = process.env.UAT_ARTIFACT_DIR || 'uat-platform-compatibility-2026-08-31';

async function json(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

const live = await json('/api/live');
assert.equal(live.response.status, 200);
assert.equal(live.payload.alive, true);

const health = await json('/api/health');
assert.ok([200, 502, 503].includes(health.response.status));

const migration = await json('/api/platform/migration');
assert.equal(migration.response.status, 200);
assert.equal(migration.payload.schema, 'wynai.platform-migration-status/v1');
assert.ok(['legacy', 'shadow', 'canary', 'platform'].includes(migration.payload.mode));
assert.equal(migration.payload.rollbackMode, 'legacy');
assert.equal(migration.payload.policy.rollbackSupported, true);
assert.equal(migration.payload.policy.runtimeModeChange, false);
assert.equal(migration.payload.policy.requestRouting, true);
assert.equal(migration.payload.routing?.schema, 'wynai.platform-migration-routing/v1');
assert.equal(migration.payload.adapters.dataInsight.schema, 'wynai.data-insight-adapter/v1');
assert.equal(migration.payload.adapters.smartQuery.schema, 'wynai.smart-query-adapter/v1');

const input = {
  schema: 'wynai.insight-input/v1',
  title: '平台兼容 UAT 输入契约',
  source: { type: 'uat', sourceId: `platform-compatibility-${Date.now()}` },
  datasets: [{ id: 'uat-synthetic-sales', name: '合成验收数据' }],
  scope: { grain: 'month', coverage: 'caller-declared-complete', filters: [{ field: '地区', operator: 'eq', value: '华东' }] },
  quality: { accuracy: 'exact', isSample: false, isTruncated: false },
  context: { question: '按月比较销售额和利润', skills: ['retail-baseline'] },
  resultSets: [{
    id: 'monthly-sales-profit',
    schema: [
      { name: '月份', type: 'string', role: 'time', grain: 'month' },
      { name: '销售额', type: 'number', role: 'measure', aggregation: 'sum', additivity: 'additive' },
      { name: '利润', type: 'number', role: 'measure', aggregation: 'sum', additivity: 'additive' },
    ],
    rows: [{ 月份: '2025-01', 销售额: 100, 利润: 20 }, { 月份: '2025-02', 销售额: 120, 利润: 24 }],
  }],
};
const accepted = await json('/api/data-insights/inputs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
assert.ok([200, 201].includes(accepted.response.status));
assert.match(accepted.payload.insightId, /^ins-/);
const detail = await json(`/api/data-insights/${accepted.payload.insightId}`);
assert.equal(detail.response.status, 200);
assert.equal(detail.payload.input.schema, 'wynai.insight-input/v1');
assert.equal(detail.payload.input.context.question, input.context.question);
const diagnostics = await json(`/api/data-insights/${accepted.payload.insightId}/diagnostics`);
assert.equal(diagnostics.response.status, 200);
assert.equal(diagnostics.payload.lifecycle?.valid, true);
assert.equal(diagnostics.payload.lifecycle?.openAttempts, 0);
const migrationEvents = (diagnostics.payload.events || []).filter(item => item.type === 'platform.migration.run');
assert.ok(migrationEvents.length >= 1, '数据洞察诊断必须记录 platform.migration.run');
assert.equal(migrationEvents.at(-1)?.data?.schema, 'wynai.platform-migration-run/v1');

const conversation = await json('/api/smart-query/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ datasetId: '2b445034-38fe-4350-9cab-b7684c28b5f8' }) });
assert.equal(conversation.response.status, 201);
const conversationId = conversation.payload.id;
assert.match(conversationId, /^conv-/);
const rejected = await json(`/api/smart-query/conversations/${conversationId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '统计销售额', sql: 'select 1' }) });
assert.equal(rejected.response.status, 400);
assert.equal(rejected.payload.code, 'CONTRACT_INVALID');
const validMessage = await json(`/api/smart-query/conversations/${conversationId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '总销售额是多少' }) });
assert.equal(validMessage.response.status, 200);
assert.equal(validMessage.payload.response?.trace?.platformMigration?.schema, 'wynai.platform-migration-run/v1');
assert.equal(validMessage.payload.response?.trace?.platformMigration?.mode, migration.payload.mode);
const candidateMetadata = validMessage.payload.response?.trace?.platformMigration?.candidateMetadata || null;
if (migration.payload.mode === 'shadow') {
  assert.equal(candidateMetadata?.profile, 'smart-query-platform-candidate-v1');
  assert.equal(candidateMetadata?.contextAudit?.datasetId, '2b445034-38fe-4350-9cab-b7684c28b5f8');
  assert.equal(validMessage.payload.response?.trace?.platformMigration?.comparison?.passed, true);
  const blockingDifferences = (validMessage.payload.response?.trace?.platformMigration?.comparison?.differences || []).filter(item => item.blocking);
  assert.equal(blockingDifferences.length, 0, `智能问数 shadow 存在阻断差异：${JSON.stringify(blockingDifferences)}`);
}

const result = {
  schema: 'wynai.platform-compatibility-uat/v1',
  generatedAt: new Date().toISOString(),
  baseUrl,
  pid: live.payload.pid,
  migration: { mode: migration.payload.mode, rollbackMode: migration.payload.rollbackMode, routing: migration.payload.routing, adapters: migration.payload.adapters, gatewayStatus: migration.payload.gateway.status },
  health: { httpStatus: health.response.status, connected: health.payload.connected ?? false, llmHealthStatus: health.payload.llmHealthStatus || null },
  dataInsight: { httpStatus: accepted.response.status, insightId: accepted.payload.insightId, detailStatus: detail.response.status, inputSchema: detail.payload.input.schema, diagnosticsValid: diagnostics.payload.lifecycle.valid, migrationEvents: migrationEvents.length },
  smartQuery: { httpStatus: conversation.response.status, conversationId, messageHttpStatus: validMessage.response.status, runtimeMode: validMessage.payload.response?.trace?.platformMigration?.mode || null, comparisonPassed: validMessage.payload.response?.trace?.platformMigration?.comparison?.passed ?? null, candidateProfile: candidateMetadata?.profile || null, rawQueryRejected: rejected.response.status === 400 && rejected.payload.code === 'CONTRACT_INVALID' },
  uat: { platformGatewayVisible: migration.payload.gateway.status === 'available', rollbackReady: migration.payload.rollbackMode === 'legacy', noRawQueryAccepted: rejected.response.status === 400 },
};
assert.equal(result.uat.platformGatewayVisible, true);
assert.equal(result.uat.rollbackReady, true);
assert.equal(result.uat.noRawQueryAccepted, true);
await mkdir(artifactDir, { recursive: true });
await writeFile(`${artifactDir}/latest.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
