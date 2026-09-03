import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = (process.env.UAT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const artifactDir = process.env.UAT_ARTIFACT_DIR || 'uat-platform-concurrency-2026-08-31';
const datasetId = '2b445034-38fe-4350-9cab-b7684c28b5f8';

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function headers(userId, organizationId) {
  return { 'content-type': 'application/json', 'x-wyn-user-id': userId, 'x-wyn-organization-id': organizationId };
}

async function createInsight(userId, organizationId, suffix) {
  const input = {
    schema: 'wynai.insight-input/v1',
    title: `并发平台验收 ${suffix}`,
    source: { type: 'uat-concurrency', sourceId: `concurrent-${suffix}-${Date.now()}` },
    datasets: [{ id: datasetId }],
    scope: { coverage: 'caller-declared-complete', filters: [{ field: '组织', operator: 'eq', value: organizationId }] },
    quality: { accuracy: 'exact', isSample: false, isTruncated: false },
    resultSets: [{ id: `rs-${suffix}`, schema: [{ name: '销售额', type: 'number', role: 'measure', aggregation: 'sum' }], rows: [{ 销售额: suffix === 'a' ? 100 : 200 }] }],
  };
  const result = await json('/api/data-insights/inputs', { method: 'POST', headers: headers(userId, organizationId), body: JSON.stringify(input) });
  assert.ok([200, 201].includes(result.status));
  return { userId, organizationId, insightId: result.payload.insightId, runId: result.payload.runId };
}

async function createSmartQuery(userId, organizationId) {
  const authHeaders = headers(userId, organizationId);
  const created = await json('/api/smart-query/conversations', { method: 'POST', headers: authHeaders, body: JSON.stringify({ datasetId }) });
  assert.equal(created.status, 201);
  const message = await json(`/api/smart-query/conversations/${created.payload.id}/messages`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ question: '统计销售额' }) });
  assert.equal(message.status, 200);
  return { userId, organizationId, conversationId: created.payload.id, trace: message.payload.response?.trace || null };
}

const startedAt = Date.now();
const migration = await json('/api/platform/migration');
assert.equal(migration.status, 200);
const [insightA, insightB, smartA, smartB] = await Promise.all([
  createInsight('uat-user-a', 'uat-org-a', 'a'),
  createInsight('uat-user-b', 'uat-org-b', 'b'),
  createSmartQuery('uat-user-a', 'uat-org-a'),
  createSmartQuery('uat-user-b', 'uat-org-b'),
]);

assert.notEqual(insightA.insightId, insightB.insightId);
assert.notEqual(smartA.conversationId, smartB.conversationId);
for (const item of [smartA, smartB]) {
  assert.equal(item.trace.platformMigration?.mode, migration.payload.mode);
  assert.equal(item.trace.platformMigration?.routing?.configuredMode, migration.payload.mode);
  assert.ok(['configured-legacy', 'percentage', 'allow-list', 'outside-rollout'].includes(item.trace.platformMigration?.routing?.reason));
}
for (const item of [insightA, insightB]) {
  const detail = await json(`/api/data-insights/${item.insightId}`, { headers: headers(item.userId, item.organizationId) });
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.input.scope.filters[0].value, item.organizationId);
}

const result = {
  schema: 'wynai.platform-concurrency-uat/v1',
  generatedAt: new Date().toISOString(),
  baseUrl,
  durationMs: Date.now() - startedAt,
  dataInsight: [insightA, insightB],
  smartQuery: [smartA, smartB].map(item => ({ ...item, trace: { traceId: item.trace.traceId, platformMigration: item.trace.platformMigration } })),
  isolation: { distinctInsightIds: insightA.insightId !== insightB.insightId, distinctConversationIds: smartA.conversationId !== smartB.conversationId, organizationFiltersPreserved: true, migrationModeConsistent: smartA.trace.platformMigration.mode === migration.payload.mode && smartB.trace.platformMigration.mode === migration.payload.mode },
  passed: true,
};
await mkdir(artifactDir, { recursive: true });
await writeFile(`${artifactDir}/latest.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
