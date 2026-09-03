import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = (process.env.UAT_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/, '');
const artifactDir = process.env.UAT_ARTIFACT_DIR || 'uat-platform-migration-routing-2026-08-31';

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

const status = await json('/api/platform/migration');
assert.equal(status.response.status, 200);
assert.equal(status.payload.routing?.schema, 'wynai.platform-migration-routing/v1');
assert.equal(status.payload.routing.moduleModes['smart-query-request'], 'canary');
assert.equal(status.payload.routing.percentage, 0);

const datasetId = '2b445034-38fe-4350-9cab-b7684c28b5f8';
async function runConversation(userId) {
  const headers = { 'content-type': 'application/json', 'x-wyn-user-id': userId, 'x-wyn-organization-id': 'uat-org' };
  const created = await json('/api/smart-query/conversations', { method: 'POST', headers, body: JSON.stringify({ datasetId }) });
  assert.equal(created.response.status, 201);
  const message = await json(`/api/smart-query/conversations/${created.payload.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ question: '总销售额是多少' }) });
  assert.equal(message.response.status, 200);
  return { conversationId: created.payload.id, trace: message.payload.response?.trace?.platformMigration || null };
}

const allowListed = await runConversation('user-allow');
const outsideRollout = await runConversation('user-outside');
assert.equal(allowListed.trace?.mode, 'canary');
assert.equal(allowListed.trace?.candidateMetadata?.profile, 'smart-query-platform-candidate-v1');
assert.equal(outsideRollout.trace?.mode, 'legacy');
assert.equal(outsideRollout.trace?.candidateMetadata, null);

const result = {
  schema: 'wynai.platform-migration-routing-uat/v1',
  generatedAt: new Date().toISOString(),
  baseUrl,
  routing: status.payload.routing,
  allowListed,
  outsideRollout,
  passed: true,
};
await mkdir(artifactDir, { recursive: true });
await writeFile(`${artifactDir}/latest.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
