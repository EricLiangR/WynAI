import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateReleaseCase, normalizeReleaseGatePack, summarizeReleaseGate } from '../lib/evaluation/release-gate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packPath = process.env.UAT_RELEASE_PACK || join(root, 'evaluation', 'packs', 'sales-ay-release.v1.json');
const baseUrl = String(process.env.UAT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const outputDir = process.env.UAT_OUTPUT_DIR || join(root, 'UAT-AY', 'release-gate-1.0.0-2026-09-20');
const requestedIds = new Set(String(process.env.UAT_CASE_IDS || '').split(',').map(value => value.trim()).filter(Boolean));
const timeoutMs = Number(process.env.UAT_CASE_TIMEOUT_MS || 90000);
const businessDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

async function jsonFetch(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, statusCode: response.status, payload };
}

function unique(items) { return [...new Set(items.filter(Boolean))]; }
function hashRows(resultSets = []) {
  return createHash('sha256').update(JSON.stringify(resultSets.map(item => item?.rows || []))).digest('hex');
}

function normalizeLiveResponse(response = {}) {
  const resultSets = response.resultSets || [];
  const selected = [...resultSets].reverse().find(item => Array.isArray(item?.rows)) || null;
  const queryRequests = response.queryRequests || [];
  const valueAliases = {};
  for (const request of queryRequests) {
    for (const metric of request.measures || []) {
      const concept = String(metric?.concept || '').trim();
      if (concept && metric?.alias) valueAliases[concept] = unique([...(valueAliases[concept] || []), metric.alias]);
    }
  }
  for (const field of selected?.schema || []) {
    if (field?.aggregation === 'share-of-total' && field?.name) valueAliases.share = unique([...(valueAliases.share || []), field.name]);
  }
  return {
    status: response.status || null,
    traceId: response.trace?.traceId || null,
    adapter: selected?.provenance?.adapter || null,
    fallback: response.trace?.platformMigration?.fallback ?? false,
    fields: unique(resultSets.flatMap(resultSet => (resultSet.schema || []).flatMap(field => [field?.name, field?.field, field?.sourceField]))),
    metrics: unique(queryRequests.flatMap(request => (request.measures || []).map(metric => metric?.field))),
    filters: queryRequests.flatMap(request => request.filters || []),
    postAggregateFilters: queryRequests.flatMap(request => request.resultFilters || []),
    rows: selected?.rows || [],
    valueAliases,
    resultContract: { ...(selected?.resultContract || {}), ...(selected?.quality || {}) },
  };
}

function compactResultSets(resultSets = []) {
  return resultSets.map(resultSet => ({
    id: resultSet.id,
    requestId: resultSet.requestId,
    adapter: resultSet.provenance?.adapter || null,
    fields: (resultSet.schema || []).map(field => ({ name: field.name, sourceField: field.sourceField || field.field, role: field.role })),
    rowCount: resultSet.rows?.length || 0,
    statistics: resultSet.statistics || null,
    scope: resultSet.scope || null,
    resultContract: resultSet.resultContract || null,
    quality: resultSet.quality || null,
  }));
}

const pack = normalizeReleaseGatePack(JSON.parse(await readFile(packPath, 'utf8')));
const cases = requestedIds.size ? pack.cases.filter(item => requestedIds.has(item.id)) : pack.cases;
if (requestedIds.size && cases.length !== requestedIds.size) throw new Error('UAT_CASE_IDS 包含用例包中不存在的 ID');

const health = await jsonFetch('/api/health');
if (!health.ok || health.payload?.connected !== true) throw new Error(`8787 健康检查失败：HTTP ${health.statusCode}`);

const startedAt = new Date().toISOString();
const results = [];
for (const [index, testCase] of cases.entries()) {
  const started = Date.now();
  let response = null;
  let transport = null;
  try {
    const conversation = await jsonFetch('/api/smart-query/conversations', {
      method: 'POST', body: JSON.stringify({ datasetId: pack.datasetId }),
    });
    if (!conversation.ok || !conversation.payload?.id) throw new Error(`创建会话失败：HTTP ${conversation.statusCode}`);
    const message = await jsonFetch(`/api/smart-query/conversations/${conversation.payload.id}/messages`, {
      method: 'POST', body: JSON.stringify({ question: testCase.question }),
    });
    response = message.payload?.response || null;
    if (!message.ok || !response) throw new Error(message.payload?.message || `查询失败：HTTP ${message.statusCode}`);
    transport = { conversationId: conversation.payload.id, httpStatus: message.statusCode };
  } catch (error) {
    transport = { error: error?.message || String(error) };
  }

  const evaluation = response
    ? evaluateReleaseCase(testCase, normalizeLiveResponse(response), { currentDate: businessDate })
    : { id: testCase.id, passed: false, checks: [{ name: 'transport', passed: false, actual: transport?.error || null, expected: 'successful response' }], actual: {} };
  results.push({
    ...evaluation,
    question: testCase.question,
    durationMs: Date.now() - started,
    transport,
    evidence: response ? {
      traceId: response.trace?.traceId || null,
      skillRefs: response.diagnostics?.skillRefs || response.businessIntent?.skillRefs || [],
      analysisMethod: response.analysisMethod || null,
      planningDiagnostics: response.planningDiagnostics || null,
      queryRequests: response.queryRequests || [],
      resultSets: compactResultSets(response.resultSets || []),
      rowsSha256: hashRows(response.resultSets || []),
      clarification: response.clarification || null,
    } : null,
  });
  const failures = evaluation.checks.filter(item => !item.passed).map(item => item.name).join(',');
  console.log(`[${index + 1}/${cases.length}] ${evaluation.passed ? 'PASS' : 'FAIL'} ${testCase.id}${failures ? ` (${failures})` : ''}`);
}

const summary = summarizeReleaseGate({ ...pack, cases }, results);
const report = {
  ...summary,
  startedAt,
  completedAt: new Date().toISOString(),
  baseUrl,
  datasetName: pack.datasetName,
  skillRef: pack.skillRef,
  health: { connected: health.payload?.connected, server: health.payload?.server, llmModel: health.payload?.llmModel },
  runtime: { businessDate, timeZone: 'Asia/Shanghai' },
  results,
};
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'api-release-gate.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed, releaseReady: report.releaseReady }));
if (!report.releaseReady) process.exitCode = 1;
