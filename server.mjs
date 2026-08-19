import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeDataset, normalizeDatasetMetadata } from './lib/analysis-core.mjs';
import { applyLocalFilters, buildAnalysisQueryBundle, compileFilteredDetailQuery } from './lib/wax-query.mjs';
import { JsonRunStore } from './lib/run-store.mjs';
import { buildReportExport } from './lib/report-export.mjs';
import { runAutonomousAnalysis } from './lib/harness/orchestrator.mjs';
import { createExplorationLlm } from './lib/llm/exploration-agent.mjs';
import { normalizeCanonicalFilters } from './lib/planning/query-request-schema.mjs';
import { parseLlmJson, structuredReportMarkdown, validateStructuredReport } from './lib/report/structured-report.mjs';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(rootDir, 'public');

function resolveRuntimePath(value, fallback) {
  const selected = value || fallback;
  return isAbsolute(selected) ? selected : resolve(process.cwd(), selected);
}

const envFile = resolveRuntimePath(process.env.WYN_AI_ENV_FILE, join(rootDir, '.env.local'));

async function loadLocalEnv(filePath = envFile) {
  try {
    const source = await readFile(filePath, 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await loadLocalEnv();

function commandLineNumber(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
  return value ? Number(value) : null;
}

function validPort(name, value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

const config = {
  wynBaseUrl: (process.env.WYN_BASE_URL || 'http://localhost:51980').replace(/\/$/, ''),
  token: process.env.WYN_TOKEN || '',
  host: process.env.HOST || '127.0.0.1',
  port: validPort('PORT', commandLineNumber('port') || process.env.PORT || 8787),
  llmBaseUrl: (process.env.LLM_BASE_URL || '').replace(/\/$/, ''),
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || '',
};
const explorationLlm = createExplorationLlm({
  baseUrl: config.llmBaseUrl,
  apiKey: config.llmApiKey,
  model: config.llmModel,
});
config.viewProxyPort = validPort(
  'WYN_VIEW_PROXY_PORT',
  commandLineNumber('view-proxy-port') || process.env.WYN_VIEW_PROXY_PORT || config.port + 1,
);
if (config.viewProxyPort === config.port) {
  throw new Error('PORT and WYN_VIEW_PROXY_PORT must be different');
}

const analysisResults = new Map();
const viewDefinitions = new Map();
const agentRuns = new Map();
const datasetMetadataCache = new Map();
let datasetDocumentCache = { expiresAt: 0, items: [] };
const MAX_CAPTURED_RESULTS = 30;
const MAX_AGENT_RUNS = 100;
const MAX_DATASET_ROWS = 5000;
const MAX_QUERY_ROWS = 5000;
const dataDir = resolveRuntimePath(process.env.WYN_AI_DATA_DIR, join(rootDir, 'data'));
const runStore = new JsonRunStore(join(dataDir, 'analysis-runs'), { maxItems: 100 });
for (const run of (await runStore.init()).reverse()) agentRuns.set(run.id, run);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendDownload(response, exportFile) {
  response.writeHead(200, {
    'Content-Type': exportFile.contentType,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(exportFile.filename)}`,
    'Content-Length': Buffer.byteLength(exportFile.body),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(exportFile.body);
}

function trimResultCache() {
  while (analysisResults.size > MAX_CAPTURED_RESULTS) {
    analysisResults.delete(analysisResults.keys().next().value);
  }
}

function trimAgentRuns() {
  while (agentRuns.size > MAX_AGENT_RUNS) {
    agentRuns.delete(agentRuns.keys().next().value);
  }
}

function parseJsonText(value) {
  return JSON.parse(String(value || '').replace(/^\uFEFF/, '').trim());
}

function describePayloadShape(value, depth = 0) {
  if (depth > 4 || value == null) return value == null ? String(value) : typeof value;
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length, sample: value.length ? describePayloadShape(value[0], depth + 1) : null };
  }
  if (typeof value === 'object') {
    return {
      type: 'object',
      keys: Object.keys(value).slice(0, 24),
      children: Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, child]) => [key, describePayloadShape(child, depth + 1)])),
    };
  }
  return typeof value;
}
function extractViewId(value = '') {
  try {
    return new URL(value).searchParams.get('viewId') || '';
  } catch {
    return String(value).match(/[?&]viewId=([a-zA-Z0-9-]+)/)?.[1] || '';
  }
}

function findRowArray(value, depth = 0, candidates = []) {
  if (depth > 12 || value == null) return candidates;
  if (Array.isArray(value)) {
    if (value.length && value.some(item => item && typeof item === 'object' && !Array.isArray(item))) {
      candidates.push(value);
    }
    for (const item of value.slice(0, 8)) findRowArray(item, depth + 1, candidates);
  } else if (typeof value === 'object') {
    for (const child of Object.values(value)) findRowArray(child, depth + 1, candidates);
  }
  return candidates;
}

function matrixRows(value, depth = 0, candidates = []) {
  if (depth > 12 || value == null) return candidates;
  if (Array.isArray(value)) {
    if (value.length >= 2 && value.every(row => Array.isArray(row))) {
      const headers = value[0];
      if (headers.length && headers.every(header => ['string', 'number'].includes(typeof header))) {
        candidates.push({ headers: headers.map(header => String(header)), rows: value.slice(1) });
      }
    }
    for (const item of value.slice(0, 12)) matrixRows(item, depth + 1, candidates);
  } else if (typeof value === 'object') {
    const rows = value.rows || value.dataRows || value.values;
    const columns = value.columns || value.fields || value.headers;
    if (Array.isArray(rows) && rows.length && rows.every(row => Array.isArray(row)) && Array.isArray(columns)) {
      const headers = columns.map(column => typeof column === 'string' ? column : column?.name || column?.label || column?.alias || '').filter(Boolean);
      if (headers.length) candidates.push({ headers, rows });
    }
    for (const child of Object.values(value)) matrixRows(child, depth + 1, candidates);
  }
  return candidates;
}

function resultRows(record) {
  const aggregationResult = record?.aggregationResult;
  const directCandidates = [
    aggregationResult?.data,
    aggregationResult?.rows,
    aggregationResult?.result?.data,
    aggregationResult?.result?.rows,
    aggregationResult?.resultSet?.data,
    aggregationResult?.resultSet?.rows,
  ].filter(candidate => Array.isArray(candidate) && candidate.length);
  if (directCandidates.length) return directCandidates.sort((a, b) => b.length - a.length)[0];

  const candidates = [
    ...findRowArray(aggregationResult),
    ...findRowArray(record?.pivotPayload),
  ];
  const objectRows = candidates.sort((a, b) => b.length - a.length)[0];
  if (objectRows?.length) return objectRows;

  const matrices = [
    ...matrixRows(aggregationResult),
    ...matrixRows(record?.pivotPayload),
  ].sort((a, b) => b.rows.length - a.rows.length);
  const matrix = matrices[0];
  if (!matrix) return [];
  return matrix.rows.map(row => Object.fromEntries(matrix.headers.map((header, index) => [header, row[index] ?? null])));
}
function unwrapValue(value, depth = 0) {
  if (depth > 5) return value;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    if (value.length === 1) return unwrapValue(value[0], depth + 1);
    return value.map(item => unwrapValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    for (const key of ['raw', 'displayValue', 'formattedValue', 'value', 'display', 'label']) {
      if (value[key] != null) return unwrapValue(value[key], depth + 1);
    }
  }
  return value;
}

function normalizedRows(record, limit = 1000) {
  return resultRows(record).slice(0, limit).map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { 序号: index + 1, 值: unwrapValue(row) };
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, unwrapValue(value)]));
  });
}

function resultSummary(record) {
  const rows = normalizedRows(record);
  const columns = [...new Set(rows.slice(0, 100).flatMap(row => Object.keys(row)))];
  const validCells = rows.reduce((total, row) => total + columns.filter(column => {
    const value = row[column];
    return value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
  }).length, 0);
  const totalCells = Math.max(rows.length * Math.max(columns.length, 1), 1);
  return {
    rowCount: resultRows(record).length,
    columnCount: columns.length,
    columns,
    completeness: Math.round(validCells / totalCells * 100),
  };
}

function upsertAnalysisResult(viewId, patch) {
  if (!viewId) return;
  const existing = analysisResults.get(viewId) || { viewId, capturedAt: new Date().toISOString() };
  analysisResults.delete(viewId);
  analysisResults.set(viewId, { ...existing, ...patch, viewId, capturedAt: new Date().toISOString() });
  trimResultCache();
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('请求体过大'));
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('请求体不是有效 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function wynUrl(pathname) {
  const baseUrl = config.wynBaseUrl.endsWith('/') ? config.wynBaseUrl : `${config.wynBaseUrl}/`;
  const url = new URL(String(pathname).replace(/^\/+/, ''), baseUrl);
  if (config.token) url.searchParams.set('token', config.token);
  return url;
}

const defaultHeaders = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Content-Type': 'application/json',
  Origin: config.wynBaseUrl,
  Referer: `${config.wynBaseUrl}/chatanalysis`,
  'X-Requested-With': 'XMLHttpRequest',
};

async function wynFetch(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 120_000);
  try {
    return await fetch(wynUrl(pathname), {
      ...options,
      headers: { ...defaultHeaders, ...(options.headers || {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function handleHealth(response) {
  if (!config.token) {
    sendJson(response, 503, { connected: false, message: '尚未配置 WYN_TOKEN' });
    return;
  }

  try {
    const upstream = await wynFetch('/api/v2/chat/analysis/sessions', { method: 'GET', timeout: 8_000 });
    sendJson(response, upstream.ok ? 200 : 502, {
      connected: upstream.ok,
      server: config.wynBaseUrl,
      listenHost: config.host,
      viewProxyPort: config.viewProxyPort,
      llmConfigured: Boolean(config.llmBaseUrl && config.llmModel),
      llmModel: config.llmModel || 'Atlas 内置洞察引擎',
      status: upstream.status,
      message: upstream.ok ? 'Wyn 服务连接正常' : `Wyn 返回 ${upstream.status}`,
    });
  } catch (error) {
    sendJson(response, 502, {
      connected: false,
      server: config.wynBaseUrl,
      listenHost: config.host,
      viewProxyPort: config.viewProxyPort,
      message: error.name === 'AbortError' ? 'Wyn 服务连接超时' : error.message,
    });
  }
}

async function loadDatasetDocuments({ force = false } = {}) {
  if (!force && datasetDocumentCache.expiresAt > Date.now()) return datasetDocumentCache.items;

  const pageSize = 500;
  const items = [];
  let pageNumber = 1;

  while (pageNumber <= 20) {
    const requestBody = {
      types: 'dataset',
      pageSize,
      pageNumber,
      deleted: false,
      searchForAllTags: false,
      disableHideInDocumentPortalFilter: true,
      enableDataModelFilter: false,
      fromAdminPortal: false,
      includeIndirectReference: false,
      includeDocTypeExtFields: true,
    };

    const upstream = await wynFetch('/api/v2/common/documents/search', {
      method: 'POST',
      body: JSON.stringify(requestBody),
      timeout: 20_000,
    });
    const raw = await upstream.text();
    let payload = {};
    try { payload = parseJsonText(raw); } catch { /* handled below */ }

    if (!upstream.ok) {
      throw new Error(payload.message || `获取数据集失败 (${upstream.status})`);
    }

    const pageItems = Array.isArray(payload.data) ? payload.data : [];
    items.push(...pageItems);
    const total = Number(payload.pagination?.total || 0);
    if (!pageItems.length || pageItems.length < pageSize || (total > 0 && items.length >= total)) break;
    pageNumber += 1;
  }

  datasetDocumentCache = { expiresAt: Date.now() + 60_000, items };
  return items;
}
function isAnalysisDataset(item) {
  return Boolean(item?.docTypeExtFields?.supportChatAnalysis)
    || /DATASET_SUPPORT_CHAT_ANALYSIS=True/i.test(item?.meta || '');
}

async function handleDatasets(response) {
  const documents = await loadDatasetDocuments();

  const datasets = documents
    .filter(isAnalysisDataset)
    .map(item => ({
      id: item.id,
      name: item.displayName || item.title,
      description: item.description || '',
      revision: item.revisionNo ?? null,
      analysisReady: true,
    }));

  sendJson(response, 200, { datasets, total: datasets.length });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function findAnalysisDataset(datasetId) {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(datasetId)) throw httpError(400, '无效的数据集 ID');
  const documents = await loadDatasetDocuments();
  const documentInfo = documents.find(item => item.id === datasetId && isAnalysisDataset(item));
  if (!documentInfo) throw httpError(404, '数据集不存在，或尚未启用受控 AI 分析');
  return documentInfo;
}

async function loadDatasetMetadata(datasetId, { force = false } = {}) {
  const documentInfo = await findAnalysisDataset(datasetId);
  const cached = datasetMetadataCache.get(datasetId);
  if (!force && cached?.expiresAt > Date.now() && cached.revision === documentInfo.revisionNo) return cached.metadata;
  if (!documentInfo.contentUrl) throw httpError(502, 'Wyn 未返回数据集结构定义地址');

  const upstream = await wynFetch(documentInfo.contentUrl, {
    method: 'GET',
    headers: { Accept: 'application/octet-stream, application/json' },
    timeout: 30_000,
  });
  const raw = await upstream.text();
  if (!upstream.ok) throw httpError(502, `读取数据集结构失败 (${upstream.status})`);

  let definition;
  try { definition = parseJsonText(raw); }
  catch { throw httpError(502, 'Wyn 返回的数据集结构无法解析'); }
  const metadata = normalizeDatasetMetadata(documentInfo, definition);
  datasetMetadataCache.set(datasetId, {
    expiresAt: Date.now() + 5 * 60_000,
    revision: documentInfo.revisionNo,
    metadata,
  });
  return metadata;
}

async function executeDatasetQuery(datasetId, { queryType = 'NONE', query = '', rowLimit = MAX_DATASET_ROWS } = {}) {
  await findAnalysisDataset(datasetId);
  const safeLimit = Math.max(1, Math.min(MAX_QUERY_ROWS, Number(rowLimit) || MAX_DATASET_ROWS));
  const upstream = await wynFetch(`/api/v2/data/datasets/${datasetId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      QueryType: queryType,
      Query: query,
      Format: 'Json',
      Options: {
        RowLimit: String(safeLimit),
        UnknownTypeHandle: 'CastToString',
        MissParameterHandle: 'Error',
      },
    }),
    timeout: 90_000,
  });
  const raw = await upstream.text();
  if (!upstream.ok) {
    let payload = {};
    try { payload = parseJsonText(raw); } catch { /* plain error */ }
    throw httpError(502, payload.message || `Wyn 数据集查询失败 (${upstream.status})`);
  }
  let payload;
  try { payload = parseJsonText(raw); }
  catch { throw httpError(502, 'Wyn 返回的数据集结果无法解析'); }
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return { rows, rowLimit: safeLimit, truncated: rows.length >= safeLimit, queryType };
}

async function loadDatasetRows(datasetId, rowLimit) {
  return executeDatasetQuery(datasetId, { queryType: 'NONE', query: '', rowLimit });
}

async function loadQualitySample(datasetId, metadata, rowLimit, filters) {
  const detailPlan = compileFilteredDetailQuery(metadata, filters);
  if (!detailPlan) return loadDatasetRows(datasetId, rowLimit);
  const result = await executeDatasetQuery(datasetId, {
    queryType: 'WAX',
    query: detailPlan.wax,
    rowLimit,
  });
  return { ...result, plan: detailPlan };
}

async function executeWaxBundle(datasetId, bundle) {
  const entries = await Promise.all(bundle.plans.map(async queryPlan => {
    const startedAt = Date.now();
    const result = await executeDatasetQuery(datasetId, {
      queryType: 'WAX',
      query: queryPlan.wax,
      rowLimit: queryPlan.spec.limit,
    });
    return [queryPlan.id, {
      rows: result.rows,
      plan: queryPlan,
      durationMs: Date.now() - startedAt,
      truncated: result.truncated,
    }];
  }));
  return Object.fromEntries(entries);
}

async function callAgentReportLlm(analysis, metadata) {
  if (!config.llmBaseUrl || !config.llmModel) return null;
  const url = /\/chat\/completions$/i.test(config.llmBaseUrl)
    ? config.llmBaseUrl
    : `${config.llmBaseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  const allowedEvidenceIds = analysis.evidence.map(item => item.id);
  const evidenceCatalog = analysis.evidence.map(item => ({
    id: item.id,
    title: item.title,
    fields: item.fields,
    method: item.method,
    scope: item.scope || null,
  }));
  const invalidDurationEvidence = analysis.evidence
    .filter(item => item.scope?.invalidDurationFields?.length)
    .map(item => ({
      evidenceId: item.id,
      fields: item.scope.invalidDurationFields,
      requiredDisclosure: '负值异常，已从正常效率排名和图表中排除，需核验时间戳顺序与计算口径',
    }));
  const messages = [
    {
      role: 'system',
      content: '你是一名企业经营分析负责人。只能使用输入中的 KPI、洞察和证据，不得新增任何数字、客户、事实或推断。只输出合法 JSON，不要输出 Markdown。JSON 必须包含 managementSummary、keyFindings、risks、actions 四个数组；每项必须严格使用 {"text":"...","evidenceIds":["ev-id"],"verificationRequired":false}。evidenceIds 字段不可省略且至少包含一个值，只能逐字复制 allowedEvidenceIds 中的 ID，不得自行创造、改写或翻译 ID。即使 verificationRequired=true 也必须引用触发该待验证事项的已有证据。证据 scope.resultLimited=true 表示只返回排序后的局部结果，任何最高、最低、所有、全部、唯一、整体、总体或全局结论必须明确限定为“当前返回范围内”或“所列项目中”，不得外推到全量。对 invalidDurationEvidence 中的每个 evidenceId，必须单独形成一条明确包含“负值异常”“已从正常效率排名和图表中排除”“需核验”的数据质量披露。不得把该 evidenceId 引用到正常效率排名或瓶颈条目；若正常排名由其他无负时长证据支持，只引用其他证据。任何分组数值必须保留 insights 中对应的实体、期间或组合上下文，不得省略主体后改写成整体值；“前三项合计占100%”不得改写成某个单项占比100%。actions 应优先使用不含数字的定性行动；确需引用现状数字时，该数字必须逐字出现在同一证据关联的 insights 中，且严禁把任何数字写成目标、阈值或承诺。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        analysisGoal: analysis.goal,
        dataset: analysis.dataset,
        datasetDescription: metadata.description,
        businessSemantics: metadata.fields.filter(field => field.description).map(field => ({ field: field.name, description: field.description })),
        profile: analysis.profile,
        kpis: analysis.kpis,
        insights: analysis.insights,
        allowedEvidenceIds,
        evidenceCatalog,
        invalidDurationEvidence,
      }),
    },
  ];
  try {
    let lastError;
    const validationErrors = [];
    const outputPreviews = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.llmModel, temperature: 0.1, response_format: { type: 'json_object' }, messages }),
        signal: controller.signal,
      });
      const payload = await upstream.json().catch(() => ({}));
      if (!upstream.ok) throw new Error(payload.error?.message || payload.message || `大模型返回 ${upstream.status}`);
      const content = payload.choices?.[0]?.message?.content || payload.output_text || '';
      outputPreviews.push(String(content).slice(0, 4000));
      try {
        const structured = validateStructuredReport(parseLlmJson(content), analysis);
        return { structured, markdown: structuredReportMarkdown(structured), attempts: attempt + 1 };
      } catch (error) {
        lastError = error;
        validationErrors.push(error.message);
        if (attempt < 2) {
          messages.push(
            { role: 'assistant', content },
            { role: 'user', content: `上次输出未通过校验：${error.message}。请重新输出完整 JSON。每一项都必须包含 evidenceIds，且只能从以下列表逐字复制，至少选择一个：${allowedEvidenceIds.join('、')}。受限证据的最高或最低结论必须明确写“当前返回范围内”。请为 invalidDurationEvidence 中每个 evidenceId 单独输出一条数据质量项，原文包含“负值异常，已从正常效率排名和图表中排除，需核验”。正常效率排名条目不得引用这些 evidenceId；若排名由其他证据支持，只引用其他证据。actions 的 text 请移除所有目标、阈值和承诺；其中任何保留数字都必须逐字来自同一证据关联的洞察。` },
          );
        }
      }
    }
    const error = lastError || new Error('大模型报告校验失败');
    error.diagnostics = { reportAttempts: outputPreviews.length, validationErrors, outputPreviews };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function handleDatasetMetadata(datasetId, response) {
  try {
    const metadata = await loadDatasetMetadata(datasetId);
    sendJson(response, 200, metadata);
  } catch (error) {
    sendJson(response, error.status || 502, { message: error.message });
  }
}

function agentRunSummary(run) {
  return {
    id: run.id,
    version: run.version || run.analysis?.version || 'analysis-run/v1',
    status: run.status,
    goal: run.goal || run.focus || '',
    focus: run.focus || run.goal || '',
    dataset: run.analysis?.dataset || run.dataset,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    rowCount: run.analysis?.profile?.rowCount || 0,
    evidenceCoverage: run.analysis?.validation?.evidenceCoverage ?? 0,
    queryMode: run.analysis?.validation?.queryMode || null,
    filterCount: run.analysis?.execution?.filters?.length || 0,
  };
}

async function saveAgentRun(run) {
  agentRuns.delete(run.id);
  agentRuns.set(run.id, run);
  trimAgentRuns();
  await runStore.save(run);
}

function appendReportWarning(analysis, message) {
  if (!message) return;
  analysis.report.warning = analysis.report.warning
    ? `${analysis.report.warning}；${message}`
    : message;
}

async function handlePreviewAgentQueryPlan(request, response) {
  const body = await readJson(request);
  const datasetId = String(body.datasetId || '').trim();
  if (!datasetId) return sendJson(response, 400, { message: '数据集不能为空' });
  const metadata = await loadDatasetMetadata(datasetId);
  const bundle = buildAnalysisQueryBundle(metadata, body.filters || []);
  sendJson(response, 200, {
    ...bundle,
    capabilities: {
      dataSourceSql: false,
      arbitraryWax: false,
      completeDatasetAggregation: Boolean(metadata.indexed),
      qualitySampleLimit: MAX_DATASET_ROWS,
    },
  });
}

async function handleCreateAgentRun(request, response) {
  const body = await readJson(request);
  const datasetId = String(body.datasetId || '').trim();
  const goal = String(body.goal || '').trim().slice(0, 2000);
  if (!datasetId || !goal) return sendJson(response, 400, { message: '数据集和分析目标不能为空' });

  const run = {
    id: randomUUID(),
    status: 'running',
    goal,
    dataset: { id: datasetId },
    createdAt: new Date().toISOString(),
  };
  await saveAgentRun(run);

  try {
    const metadata = await loadDatasetMetadata(datasetId);
    const queryBundle = buildAnalysisQueryBundle(metadata, body.filters || []);
    const queryWarnings = [];
    let queryResult;
    try {
      queryResult = await loadQualitySample(datasetId, metadata, body.rowLimit, queryBundle.filters);
    } catch (error) {
      if (!queryBundle.filters.length) throw error;
      const unfiltered = await loadDatasetRows(datasetId, body.rowLimit);
      queryResult = {
        ...unfiltered,
        rows: applyLocalFilters(unfiltered.rows, metadata, queryBundle.filters),
        queryType: 'NONE_LOCAL_FILTER_FALLBACK',
      };
      queryWarnings.push(`筛选范围的质量样本改为本地受控回退：${error.message}`);
    }

    let aggregateResults = null;
    if (metadata.indexed) {
      try {
        aggregateResults = await executeWaxBundle(datasetId, queryBundle);
        const truncatedPlans = Object.values(aggregateResults).filter(item => item.truncated).map(item => item.plan.purpose);
        if (truncatedPlans.length) queryWarnings.push(`以下聚合达到结果上限，请缩小筛选范围后复核：${truncatedPlans.join('、')}`);
      } catch (error) {
        queryWarnings.push(`WAX 完整数据集聚合未完成，指标改用质量样本计算：${error.message}`);
      }
    } else {
      queryWarnings.push('当前数据集未启用缓存索引，指标使用受控质量样本计算');
    }

    const analysis = analyzeDataset({
      metadata,
      rows: queryResult.rows,
      aggregates: aggregateResults,
      filters: queryBundle.filters,
      goal,
      rowLimit: queryResult.rowLimit,
    });
    analysis.profile.sourceTruncated = queryResult.truncated;
    analysis.execution = {
      dataSource: 'wyn-dataset-api',
      queryType: aggregateResults ? 'WAX+SAMPLE' : queryResult.queryType,
      sampleQueryType: queryResult.queryType,
      sampleRowLimit: queryResult.rowLimit,
      filters: queryBundle.filters,
      waxStatus: aggregateResults ? 'completed' : 'fallback',
      waxQueryCount: aggregateResults ? Object.keys(aggregateResults).length : 0,
      queryPlans: queryBundle.plans.map(item => ({
        id: item.id,
        purpose: item.purpose,
        queryType: item.queryType,
        sqlAllowed: item.sqlAllowed,
        spec: item.spec,
        durationMs: aggregateResults?.[item.id]?.durationMs ?? null,
      })),
      sqlAllowed: false,
      llmModel: config.llmModel || null,
    };
    queryWarnings.forEach(message => appendReportWarning(analysis, message));
    try {
      const aiReport = await callAgentReportLlm(analysis, metadata);
      if (!aiReport?.markdown) throw new Error('严格分析未生成 AI 报告');
      analysis.report.aiNarrative = aiReport?.markdown || null;
      analysis.report.aiStructured = aiReport?.structured || null;
      analysis.report.model = analysis.report.aiNarrative ? config.llmModel : 'Atlas 确定性分析引擎';
    } catch (error) {
      analysis.report.aiNarrative = null;
      analysis.report.model = 'Atlas 确定性分析引擎';
      appendReportWarning(analysis, `外部大模型报告未生成：${error.name === 'AbortError' ? '响应超时' : error.message}`);
    }
    Object.assign(run, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      analysis,
    });
    await saveAgentRun(run);
    sendJson(response, 201, run);
  } catch (error) {
    Object.assign(run, { status: 'failed', completedAt: new Date().toISOString(), error: error.message, diagnostics: error.diagnostics || null });
    await saveAgentRun(run).catch(persistError => console.error('保存失败运行记录时出错', persistError));
    sendJson(response, error.status || 502, { id: run.id, status: run.status, message: error.message });
  }
}

async function handleCreateV2AgentRun(request, response) {
  const body = await readJson(request);
  if (['wax', 'sql', 'query', 'payload', 'pivotPayload'].some(key => body[key] != null)) {
    return sendJson(response, 400, { message: 'V2 分析接口只接受业务关注方向和结构化约束，不接受 WAX、SQL 或原始查询 Payload' });
  }
  const datasetId = String(body.datasetId || '').trim();
  const focus = String(body.focus || '').trim().slice(0, 2000);
  const strictMode = body.strictMode === true;
  if (!datasetId) return sendJson(response, 400, { message: '数据集不能为空；关注方向可以留空' });
  const constraints = body.constraints && typeof body.constraints === 'object'
    ? body.constraints
    : { filters: body.filters || [] };

  let metadata;
  let normalizedFilters;
  try {
    metadata = await loadDatasetMetadata(datasetId);
    normalizedFilters = normalizeCanonicalFilters(metadata, Array.isArray(constraints.filters) ? constraints.filters : []);
  } catch (error) {
    return sendJson(response, error.status || 502, { message: error.message });
  }

  const run = {
    id: randomUUID(),
    version: 'analysis-run/v2.1',
    status: 'running',
    focus,
    goal: focus,
    constraints: { filters: normalizedFilters, strictMode },
    dataset: { id: datasetId },
    createdAt: new Date().toISOString(),
  };
  await saveAgentRun(run);

  try {
    const result = await runAutonomousAnalysis({
      metadata,
      focus,
      constraints: run.constraints,
      executeDatasetQuery,
      analyzeDataset,
      explorationAgent: explorationLlm,
      strictMode,
    });
    const { analysis } = result;
    result.audit.warnings.forEach(message => appendReportWarning(analysis, `查询降级：${message}`));
    try {
      const aiReport = await callAgentReportLlm(analysis, metadata);
      analysis.report.aiNarrative = aiReport?.markdown || null;
      analysis.report.aiStructured = aiReport?.structured || null;
      analysis.report.model = analysis.report.aiNarrative ? config.llmModel : 'Atlas V2.1 确定性降级引擎';
    } catch (error) {
      if (strictMode) {
        error.status = 422;
        error.diagnostics = { ...(error.diagnostics || {}), phase: 'report', message: error.message, fallbackExecuted: false };
        throw error;
      }
      analysis.report.aiNarrative = null;
      analysis.report.model = 'Atlas V2.1 确定性降级引擎';
      appendReportWarning(analysis, `外部大模型报告未生成：${error.name === 'AbortError' ? '响应超时' : error.message}`);
    }
    Object.assign(run, result, {
      status: result.audit.warnings.length ? 'partial' : 'completed',
      completedAt: new Date().toISOString(),
    });
    await saveAgentRun(run);
    sendJson(response, 201, run);
  } catch (error) {
    Object.assign(run, { status: 'failed', completedAt: new Date().toISOString(), error: error.message, diagnostics: error.diagnostics || null });
    await saveAgentRun(run).catch(persistError => console.error('保存 V2 失败运行记录时出错', persistError));
    sendJson(response, error.status || 502, { id: run.id, version: run.version, status: run.status, message: error.message, diagnostics: run.diagnostics });
  }
}

function handleAgentRuns(pathname, response) {
  const runId = pathname.slice('/api/analysis-agent/runs/'.length);
  if (!runId) {
    const items = [...agentRuns.values()].reverse().map(agentRunSummary);
    return sendJson(response, 200, { items, total: items.length });
  }
  const run = agentRuns.get(runId);
  if (!run) return sendJson(response, 404, { message: '分析运行不存在或已过期' });
  sendJson(response, 200, run);
}

function handleV2AgentRuns(pathname, response) {
  const prefix = '/api/analysis-agent/v2/runs';
  const runId = pathname.length > prefix.length ? pathname.slice(prefix.length + 1) : '';
  if (!runId) {
    const items = [...agentRuns.values()].reverse().filter(run => ['analysis-run/v2', 'analysis-run/v2.1'].includes(run.version)).map(agentRunSummary);
    return sendJson(response, 200, { items, total: items.length, version: 'analysis-run/v2.1' });
  }
  const run = agentRuns.get(runId);
  if (!run || !['analysis-run/v2', 'analysis-run/v2.1'].includes(run.version)) return sendJson(response, 404, { message: 'V2 分析运行不存在或已过期' });
  sendJson(response, 200, run);
}

function handleAgentReportExport(runId, format, response) {
  const run = agentRuns.get(runId);
  if (!run) return sendJson(response, 404, { message: '分析运行不存在' });
  if (!['completed', 'partial'].includes(run.status) || !run.analysis) return sendJson(response, 409, { message: '分析运行尚未完成' });
  sendDownload(response, buildReportExport(run, format));
}

async function handleChat(request, response) {
  const body = await readJson(request);
  const question = String(body.question || '').trim();
  const datasetId = String(body.datasetId || '').trim();

  if (!question || !datasetId) {
    sendJson(response, 400, { message: '问题和数据集不能为空' });
    return;
  }

  const payload = {
    userInput: question,
    datasetId,
    clientReferenceTime: new Date().toISOString(),
    includeInsight: true,
    stream: body.stream !== false,
  };

  const upstream = await wynFetch('/api/v2/chat/analysis/queries?outputLocale=zh-CN', {
    method: 'POST',
    headers: {
      Accept: payload.stream ? 'text/event-stream, application/x-ndjson, application/json, text/plain' : 'application/json, text/plain',
    },
    body: JSON.stringify(payload),
  });

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  response.writeHead(upstream.status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  if (!upstream.body) {
    response.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(value);
    }
  } finally {
    response.end();
  }
}

async function handleView(viewId, response) {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(viewId)) {
    sendJson(response, 400, { message: '无效的分析视图 ID' });
    return;
  }

  const upstream = await wynFetch(`/api/v2/chat/analysis/views/${viewId}`, {
    method: 'GET',
    timeout: 30_000,
  });
  const raw = await upstream.text();
  let payload;
  try { payload = JSON.parse(raw); }
  catch { payload = { message: raw || `Wyn 返回 ${upstream.status}` }; }
  if (upstream.ok) viewDefinitions.set(viewId, payload);
  sendJson(response, upstream.status, payload);
}

function analysisListItem(record) {
  const view = viewDefinitions.get(record.viewId) || {};
  const summary = resultSummary(record);
  return {
    viewId: record.viewId,
    datasetId: record.datasetId || record.aggregationResult?.datasetId || view.chart?.datasetId || '',
    topic: record.topic || view.insight?.topic || view.chart?.query?.name || 'Wyn 分析结果',
    queryName: view.chart?.query?.name || '',
    chartType: view.chart?.visualization?.chartType || '',
    capturedAt: record.capturedAt,
    source: record.aggregationResult ? 'aggregation-result' : 'pivot',
    ...summary,
  };
}

function handleAnalysisResults(pathname, response) {
  const viewId = pathname.slice('/api/analysis-results/'.length);
  if (!viewId) {
    const items = [...analysisResults.values()].reverse().map(analysisListItem);
    sendJson(response, 200, { items, total: items.length, llmConfigured: Boolean(config.llmBaseUrl && config.llmModel) });
    return;
  }

  const record = analysisResults.get(viewId);
  if (!record) {
    sendJson(response, 404, { message: '尚未捕获该分析的结果集，请先在智能问数中生成并加载图表。' });
    return;
  }
  const rows = normalizedRows(record);
  const totalRows = resultRows(record).length;
  sendJson(response, 200, {
    ...analysisListItem(record),
    rows,
    truncated: totalRows > rows.length,
    query: record.query || viewDefinitions.get(viewId)?.chart?.query || null,
    aggregationResultId: record.aggregationResult?.id || '',
  });
}

function numericInsights(rows, columns) {
  return columns.map(column => {
    const values = rows.map(row => Number(row[column])).filter(Number.isFinite);
    if (!values.length) return null;
    const sum = values.reduce((total, value) => total + value, 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { column, count: values.length, sum, average: sum / values.length, min, max };
  }).filter(Boolean).slice(0, 6);
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function buildLocalInsight(record, prompt) {
  const rows = normalizedRows(record);
  const summary = resultSummary(record);
  const numeric = numericInsights(rows, summary.columns);
  const emptyRate = 100 - summary.completeness;
  const findings = [];

  if (!rows.length) {
    findings.push({ tone: 'warning', label: '数据质量', value: '无有效记录', detail: '结果集为空，建议检查筛选条件、字段映射和数据源刷新状态。' });
  } else {
    findings.push({ tone: 'violet', label: '分析规模', value: `${summary.rowCount} 行 × ${summary.columnCount} 列`, detail: `已读取 ${summary.columns.slice(0, 4).join('、') || '结果字段'}。` });
    findings.push({ tone: summary.completeness >= 80 ? 'green' : 'warning', label: '数据完整度', value: `${summary.completeness}%`, detail: emptyRate ? `约 ${emptyRate}% 的单元格为空或结构无效。` : '当前结果未发现明显缺失值。' });
  }

  for (const item of numeric.slice(0, 2)) {
    findings.push({
      tone: 'cyan',
      label: item.column,
      value: `均值 ${formatNumber(item.average)}`,
      detail: `范围 ${formatNumber(item.min)} ～ ${formatNumber(item.max)}，合计 ${formatNumber(item.sum)}。`,
    });
  }

  const numericText = numeric.length
    ? numeric.map(item => `- **${item.column}**：共 ${item.count} 个数值，均值 ${formatNumber(item.average)}，最小 ${formatNumber(item.min)}，最大 ${formatNumber(item.max)}，合计 ${formatNumber(item.sum)}。`).join('\n')
    : '- 当前结果没有识别到可直接计算的有效数值列。';
  const qualityText = summary.completeness < 80
    ? `结果完整度为 **${summary.completeness}%**，应优先排查空数组、嵌套空值、字段类型或聚合配置。`
    : `结果完整度为 **${summary.completeness}%**，可继续进行业务解释与趋势验证。`;

  return {
    provider: 'local-demo',
    model: 'Atlas 内置洞察引擎',
    findings,
    content: `## 核心结论\n\n本次二次洞察基于 Wyn 返回的 **${summary.rowCount} 行、${summary.columnCount} 列**结构化结果集。${qualityText}\n\n## 指标扫描\n\n${numericText}\n\n## 针对分析目标\n\n${prompt || '请从业务趋势、异常和风险角度解读当前结果。'}\n\n- 将关键结论与原始字段逐项核验，避免把空值或格式化文本当作真实数值。\n- 对时间、地区、产品等维度继续下钻，比较环比、同比和贡献度。\n- 对异常点回查明细记录与筛选条件，再形成可执行的业务动作。\n\n## 建议动作\n\n1. 优先处理完整度低于 80% 的字段。\n2. 将有效指标按核心维度分组，并保留 Top/Bottom 贡献项。\n3. 由业务负责人确认指标口径后，再生成面向管理层的智能报告。`,
  };
}

async function callConfiguredLlm(record, prompt) {
  const rows = normalizedRows(record, 120);
  const summary = resultSummary(record);
  const view = viewDefinitions.get(record.viewId) || {};
  const url = /\/chat\/completions$/i.test(config.llmBaseUrl)
    ? config.llmBaseUrl
    : `${config.llmBaseUrl}/chat/completions`;
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.llmModel,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: '你是一名严谨的企业数据分析师。只基于给定结果集回答，明确指出数据质量问题，并用中文输出核心结论、证据、风险和行动建议。',
        },
        {
          role: 'user',
          content: JSON.stringify({
            analysisGoal: prompt,
            topic: record.topic || view.insight?.topic,
            query: record.query || view.chart?.query,
            summary,
            rows,
            note: resultRows(record).length > rows.length ? `仅提供前 ${rows.length} 行样本` : '已提供完整结果',
          }),
        },
      ],
    }),
  });
  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error(payload.error?.message || payload.message || `大模型返回 ${upstream.status}`);
  return {
    provider: 'llm',
    model: config.llmModel,
    findings: buildLocalInsight(record, prompt).findings,
    content: payload.choices?.[0]?.message?.content || payload.output_text || '大模型未返回可展示文本。',
  };
}

async function handleSecondaryInsight(request, response) {
  const body = await readJson(request);
  const viewId = String(body.viewId || '').trim();
  const prompt = String(body.prompt || '').trim().slice(0, 4000);
  const record = analysisResults.get(viewId);
  if (!record) return sendJson(response, 404, { message: '结果集不存在或已过期，请重新执行一次智能问数。' });

  try {
    const result = config.llmBaseUrl && config.llmModel
      ? await callConfiguredLlm(record, prompt)
      : buildLocalInsight(record, prompt);
    sendJson(response, 200, { ...result, viewId, generatedAt: new Date().toISOString() });
  } catch (error) {
    sendJson(response, 502, { message: `二次洞察失败：${error.message}` });
  }
}

async function serveStatic(requestUrl, response) {
  let pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  if (pathname === '/vendor/echarts.min.js') {
    const content = await readFile(join(rootDir, 'node_modules', 'echarts', 'dist', 'echarts.min.js'));
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    response.end(content);
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    sendJson(response, 403, { message: 'Forbidden' });
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') sendJson(response, 404, { message: 'Not found' });
    else throw error;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, 'http://localhost');
    const { pathname } = requestUrl;
    if (request.method === 'GET' && pathname === '/api/live') {
      return sendJson(response, 200, {
        alive: true,
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
      });
    }
    if (request.method === 'GET' && pathname === '/api/health') return await handleHealth(response);
    if (request.method === 'GET' && pathname === '/api/datasets') return await handleDatasets(response);
    if (request.method === 'GET' && /^\/api\/datasets\/[a-zA-Z0-9-]+\/metadata$/.test(pathname)) {
      const datasetId = pathname.split('/')[3];
      return await handleDatasetMetadata(datasetId, response);
    }
    if (request.method === 'POST' && pathname === '/api/analysis-agent/v2/runs') {
      return await handleCreateV2AgentRun(request, response);
    }
    const v2ReportRoute = pathname.match(/^\/api\/analysis-agent\/v2\/runs\/([a-zA-Z0-9-]{8,80})\/report$/);
    if (request.method === 'GET' && v2ReportRoute) {
      return handleAgentReportExport(v2ReportRoute[1], requestUrl.searchParams.get('format') || 'html', response);
    }
    if (request.method === 'GET' && (pathname === '/api/analysis-agent/v2/runs' || pathname.startsWith('/api/analysis-agent/v2/runs/'))) {
      return handleV2AgentRuns(pathname, response);
    }
    if (request.method === 'POST' && pathname === '/api/analysis-agent/runs') {
      return await handleCreateAgentRun(request, response);
    }
    if (request.method === 'POST' && pathname === '/api/analysis-agent/query-plans/preview') {
      return await handlePreviewAgentQueryPlan(request, response);
    }
    const reportRoute = pathname.match(/^\/api\/analysis-agent\/runs\/([a-zA-Z0-9-]{8,80})\/report$/);
    if (request.method === 'GET' && reportRoute) {
      return handleAgentReportExport(reportRoute[1], requestUrl.searchParams.get('format') || 'html', response);
    }
    if (request.method === 'GET' && (pathname === '/api/analysis-agent/runs' || pathname.startsWith('/api/analysis-agent/runs/'))) {
      return handleAgentRuns(pathname, response);
    }
    if (request.method === 'GET' && (pathname === '/api/analysis-results' || pathname.startsWith('/api/analysis-results/'))) {
      return handleAnalysisResults(pathname, response);
    }
    if (request.method === 'POST' && pathname === '/api/secondary-insights') {
      return await handleSecondaryInsight(request, response);
    }
    if (request.method === 'GET' && pathname.startsWith('/api/views/')) {
      return await handleView(pathname.slice('/api/views/'.length), response);
    }
    if (request.method === 'POST' && pathname === '/api/chat') return await handleChat(request, response);
    if (pathname.startsWith('/api/')) return sendJson(response, 404, { message: 'API not found' });
    return await serveStatic(request.url, response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      sendJson(response, error.status || 500, {
        message: error.name === 'AbortError' ? 'Wyn 响应超时，请稍后重试' : error.message,
      });
    } else {
      response.end();
    }
  }
});

const viewProxyServer = http.createServer(async (request, response) => {
  try {
    const target = new URL(request.url, `${config.wynBaseUrl}/`);
    const isViewPage = /^\/dashboards\/chatanalysis\/view$/i.test(target.pathname);
    const isDataInsightRequest = /^\/api\/v2\/chat\/analysis\/data-insight$/i.test(target.pathname);
    const isPivotRequest = /\/api\/(?:v\d+\/)?pivot$/i.test(target.pathname);
    const isApiRequest = /^\/api\//i.test(target.pathname);
    const isStaticApiAsset = /^\/api\/(?:PluginAssets|themefiles)\//i.test(target.pathname);
    const needsToken = target.searchParams.has('token') || isViewPage || (isApiRequest && !isStaticApiAsset);
    if (config.token && needsToken) target.searchParams.set('token', config.token);

    const incomingReferer = request.headers.referer || '';
    const requestViewId = extractViewId(incomingReferer) || target.searchParams.get('viewId') || '';
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await readRawBody(request);
    if (isDataInsightRequest && requestViewId && body?.length) {
      try {
        const insightRequest = JSON.parse(body.toString('utf8'));
        upsertAnalysisResult(requestViewId, {
          topic: insightRequest.topic || '',
          query: insightRequest.query || null,
          datasetId: insightRequest.aggregationResult?.datasetId || '',
          aggregationResult: insightRequest.aggregationResult || null,
        });
      } catch {
        // Wyn 请求仍然继续透传；无法解析时仅跳过结果缓存。
      }
    }
    const headers = { ...request.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    headers['accept-encoding'] = 'identity';
    headers.origin = config.wynBaseUrl;
    headers.referer = `${config.wynBaseUrl}/chatanalysis`;

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    });

    const responseHeaders = Object.fromEntries(upstream.headers.entries());
    delete responseHeaders['content-length'];
    delete responseHeaders['content-encoding'];
    delete responseHeaders['transfer-encoding'];
    delete responseHeaders.connection;
    delete responseHeaders['x-frame-options'];
    delete responseHeaders['content-security-policy'];

    if (responseHeaders.location) {
      const redirect = new URL(responseHeaders.location, config.wynBaseUrl);
      redirect.searchParams.delete('token');
      responseHeaders.location = `${redirect.pathname}${redirect.search}${redirect.hash}`;
    }

    if (isPivotRequest && requestViewId && upstream.body) {
      const rawPivot = Buffer.from(await upstream.arrayBuffer());
      if (rawPivot.length <= 12_000_000) {
        try {
          const pivotPayload = JSON.parse(rawPivot.toString('utf8'));
          console.log(`[pivot-shape] ${JSON.stringify(describePayloadShape(pivotPayload))}`);
          upsertAnalysisResult(requestViewId, { pivotPayload });
        } catch {
          // 非 JSON 结果仍按原样返回给 Wyn 视图。
        }
      }
      response.writeHead(upstream.status, responseHeaders);
      response.end(rawPivot);
      return;
    }

    const contentType = responseHeaders['content-type'] || '';
    if (isViewPage && /text\/html/i.test(contentType) && upstream.body) {
      const html = await upstream.text();
      const embedFixes = `
        <style id="wyn-ai-demo-embed-fixes">
          .sa-app { background: #fff !important; }
          .sa-receive-msg.wyn-ai-hidden-insight,
          .sa-receive-msg:has(.sa-insight-item),
          .sa-insight-item,
          .sa-insight-content {
            display: none !important;
            width: 0 !important;
            height: 0 !important;
            min-height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            border: 0 !important;
            overflow: hidden !important;
          }
        </style>
        <script>
          (() => {
            const collapseInsightMessages = root => {
              const scope = root?.nodeType === Node.ELEMENT_NODE ? root : document;
              const insights = [
                ...(scope.matches?.('.sa-insight-item') ? [scope] : []),
                ...(scope.querySelectorAll?.('.sa-insight-item') || []),
              ];
              insights.forEach(insight => {
                insight.closest('.sa-receive-msg')?.classList.add('wyn-ai-hidden-insight');
              });
            };

            const observeInsights = () => {
              collapseInsightMessages(document);
              new MutationObserver(mutations => mutations.forEach(mutation => {
                mutation.addedNodes.forEach(collapseInsightMessages);
              })).observe(document.body, { childList: true, subtree: true });
            };
            const postFrameHeight = () => {
              const panel = document.querySelector('.sa-layout__chat-panel');
              if (!panel) return;
              const height = Math.ceil(panel.getBoundingClientRect().height + 16);
              if (height > 0) parent.postMessage({
                source: 'wyn-ai-demo',
                type: 'wyn-frame-resize',
                height,
              }, '*');
            };

            const observeFrameHeight = () => {
              let observedTarget = null;
              const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(postFrameHeight) : null;
              const refreshTarget = () => {
                const target = document.querySelector('.sa-layout__chat-panel') || document.querySelector('.sa-app');
                if (target === observedTarget) {
                  postFrameHeight();
                  return;
                }
                resizeObserver?.disconnect();
                observedTarget = target;
                if (target) resizeObserver?.observe(target);
                postFrameHeight();
              };
              refreshTarget();
              new MutationObserver(refreshTarget).observe(document.body, { childList: true, subtree: true });
            };
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', observeFrameHeight, { once: true });
            } else {
              observeFrameHeight();
            }
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', observeInsights, { once: true });
            } else {
              observeInsights();
            }

            const outerScroll = deltaY => parent.postMessage({
              source: 'wyn-ai-demo',
              type: 'wyn-frame-scroll',
              deltaY,
            }, '*');

            const canScrollInsight = (target, deltaY) => {
              const insight = target?.closest?.('.sa-insight-content');
              if (!insight || insight.scrollHeight <= insight.clientHeight + 1) return false;
              if (deltaY < 0) return insight.scrollTop > 0;
              return insight.scrollTop + insight.clientHeight < insight.scrollHeight - 1;
            };

            window.addEventListener('wheel', event => {
              if (canScrollInsight(event.target, event.deltaY)) return;
              event.preventDefault();
              outerScroll(event.deltaY);
            }, { passive: false });

            let lastTouchY = null;
            window.addEventListener('touchstart', event => {
              lastTouchY = event.touches[0]?.clientY ?? null;
            }, { passive: true });
            window.addEventListener('touchmove', event => {
              const touchY = event.touches[0]?.clientY;
              if (lastTouchY == null || touchY == null) return;
              const deltaY = lastTouchY - touchY;
              lastTouchY = touchY;
              if (canScrollInsight(event.target, deltaY)) return;
              event.preventDefault();
              outerScroll(deltaY);
            }, { passive: false });
            window.addEventListener('touchend', () => { lastTouchY = null; }, { passive: true });
          })();
        </script>`;
      const patchedHtml = /<\/head>/i.test(html)
        ? html.replace(/<\/head>/i, `${embedFixes}</head>`)
        : `${embedFixes}${html}`;
      response.writeHead(upstream.status, responseHeaders);
      response.end(patchedHtml);
      return;
    }

    response.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) {
      response.end();
      return;
    }

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(value);
      }
    } finally {
      response.end();
    }
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, 502, { message: `Wyn 视图代理失败：${error.message}` });
    } else {
      response.end();
    }
  }
});

function listen(httpServer, port, host) {
  return new Promise((resolveListen, reject) => {
    const onError = error => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      resolveListen();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(port, host);
  });
}

function close(httpServer) {
  return new Promise(resolveClose => {
    if (!httpServer.listening) {
      resolveClose();
      return;
    }
    httpServer.close(() => resolveClose());
    httpServer.closeIdleConnections?.();
  });
}

await listen(server, config.port, config.host);
try {
  await listen(viewProxyServer, config.viewProxyPort, config.host);
} catch (error) {
  await close(server);
  throw error;
}

console.log(`Wyn AI started: http://${config.host}:${config.port}`);
console.log(`Wyn view proxy started: http://${config.host}:${config.viewProxyPort}`);
console.log(`Runtime config: ${envFile}`);
console.log(`Runtime data: ${dataDir}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping Wyn AI...`);
  const forcedExit = setTimeout(() => process.exit(1), 10_000);
  forcedExit.unref();
  await Promise.all([close(server), close(viewProxyServer)]);
  clearTimeout(forcedExit);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
