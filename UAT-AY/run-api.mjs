import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = process.env.UAT_BASE_URL || 'http://127.0.0.1:8811';
const datasetId = '18b86197-65e3-4682-8501-6e7125afad02';
const runDir = join(process.cwd(), 'UAT-AY');
const cases = JSON.parse(await readFile(join(runDir, 'cases.json'), 'utf8'));

async function jsonFetch(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, statusCode: response.status, payload };
}

const startedAt = new Date().toISOString();
const health = await jsonFetch('/api/health');
const metadata = await jsonFetch(`/api/datasets/${datasetId}/metadata`);
const skillCatalog = await jsonFetch('/api/smart-query/skills');
const results = [];

for (const item of cases) {
  const started = Date.now();
  const conversation = await jsonFetch('/api/smart-query/conversations', { method: 'POST', body: JSON.stringify({ datasetId }) });
  const conversationId = conversation.payload?.id || null;
  let message = null;
  if (conversationId) {
    message = await jsonFetch(`/api/smart-query/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ question: item.question }) });
  }
  const response = message?.payload?.response || null;
  results.push({
    ...item,
    startedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    conversationId,
    httpStatus: message?.statusCode || conversation.statusCode,
    actualStatus: response?.status || 'transport_error',
    loadedSkillRefs: message?.payload?.conversation?.loadedSkillRefs || null,
    skillRefs: response?.businessIntent?.skillRefs || [],
    semanticValidation: response?.semanticValidation || null,
    businessIntent: response?.businessIntent || null,
    queryRequests: response?.queryRequests || [],
    resultSets: response?.resultSets || [],
    clarification: response?.clarification || null,
    document: response?.document || null,
    error: message?.ok ? null : message?.payload || conversation.payload,
  });
  console.log(`${response?.status === 'ok' ? 'DONE' : 'FAIL'} ${item.id} ${item.question}`);
}

const report = {
  schema: 'wynai.uat-ay-api-run/v1',
  startedAt,
  completedAt: new Date().toISOString(),
  baseUrl,
  dataset: { id: datasetId, name: metadata.payload?.name || null, revision: metadata.payload?.revision ?? null },
  health: health.payload,
  skillCatalog: skillCatalog.payload,
  summary: {
    total: results.length,
    ok: results.filter(item => item.actualStatus === 'ok').length,
    clarification: results.filter(item => item.actualStatus === 'needs_clarification').length,
    failed: results.filter(item => !['ok', 'needs_clarification'].includes(item.actualStatus)).length,
    skillBound: results.filter(item => item.skillRefs.includes('sales-opportunity-a53@1.0.0')).length,
  },
  results,
};
await mkdir(runDir, { recursive: true });
await writeFile(join(runDir, 'api-results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report.summary));
