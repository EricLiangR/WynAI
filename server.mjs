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
import { parseLlmJson, prepareStructuredReport, structuredReportMarkdown, validateStructuredReport } from './lib/report/structured-report.mjs';
import { SmartQueryConversationStore } from './lib/conversation/session.mjs';
import { MultiDatasetQueryService } from './lib/query/multi-dataset.mjs';
import { parseDocxTemplate } from './lib/template/docx-parser.mjs';
import { composeDocxTemplate } from './lib/template/docx-composer.mjs';
import { loadSkillsFromDirectory } from './lib/skills/skill-registry.mjs';
import { SkillGovernanceService } from './lib/skills/skill-governance.mjs';
import { OperationalEventLog, createTraceId } from './lib/observability/operational-event-log.mjs';
import { FeedbackLearningService } from './lib/learning/feedback-learning.mjs';
import { RequestAuditLog, SlidingWindowRateLimiter, requestIdentity } from './lib/security/request-governance.mjs';
import { TemplatePackageRepository } from './lib/template/template-model.mjs';
import { proposeCanonicalQueries, proposeFormula } from './lib/reporting/binding-resolver.mjs';
import { ReportRunRepository } from './lib/reporting/report-runner.mjs';
import { DataInsightStore } from './lib/data-insights/insight-store.mjs';
import { WynQueryInsightAdapter } from './lib/data-insights/wyn-query-adapter.mjs';

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

function configuredBoolean(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (/^(true|1|yes)$/i.test(String(value))) return true;
  if (/^(false|0|no)$/i.test(String(value))) return false;
  return fallback;
}

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
  llmTimeoutMs: Math.max(10_000, Number(process.env.LLM_TIMEOUT_MS) || 180_000),
  intentLlmTimeoutMs: Math.max(1_000, Number(process.env.INTENT_LLM_TIMEOUT_MS) || 10_000),
  llmEnableThinking: configuredBoolean(process.env.LLM_ENABLE_THINKING, /dashscope\.aliyuncs\.com/i.test(process.env.LLM_BASE_URL || '') ? false : null),
  skillAdminToken: process.env.WYN_AI_SKILL_ADMIN_TOKEN || '',
};
const llmEndpointHost = (() => {
  try { return new URL(config.llmBaseUrl).host; } catch { return null; }
})();
const explorationLlm = createExplorationLlm({
  baseUrl: config.llmBaseUrl,
  apiKey: config.llmApiKey,
  model: config.llmModel,
  timeoutMs: config.llmTimeoutMs,
  enableThinking: config.llmEnableThinking,
});
const intentLlm = createExplorationLlm({
  baseUrl: config.llmBaseUrl,
  apiKey: config.llmApiKey,
  model: config.llmModel,
  timeoutMs: config.intentLlmTimeoutMs,
  enableThinking: config.llmEnableThinking,
});
config.viewProxyPort = validPort(
  'WYN_VIEW_PROXY_PORT',
  commandLineNumber('view-proxy-port') || process.env.WYN_VIEW_PROXY_PORT || config.port + 1,
);
if (config.viewProxyPort === config.port) {
  throw new Error('PORT and WYN_VIEW_PROXY_PORT must be different');
}

const dataInsightStore = new DataInsightStore({ maxItems: 30 });
const viewDefinitions = new Map();
const wynQueryInsightAdapter = new WynQueryInsightAdapter({
  register: input => dataInsightStore.register(input).record,
  maxItems: 30,
});
const agentRuns = new Map();
const datasetMetadataCache = new Map();
let datasetDocumentCache = { expiresAt: 0, items: [] };
const MAX_AGENT_RUNS = 100;
const MAX_DATASET_ROWS = 5000;
const MAX_QUERY_ROWS = 5000;
const dataDir = resolveRuntimePath(process.env.WYN_AI_DATA_DIR, join(rootDir, 'data'));
const runStore = new JsonRunStore(join(dataDir, 'analysis-runs'), { maxItems: 100 });
for (const run of (await runStore.init()).reverse()) agentRuns.set(run.id, run);
const conversationStore = new JsonRunStore(join(dataDir, 'smart-query-conversations'), { maxItems: 100 });
const operationalEventLog = new OperationalEventLog({ persistence: new JsonRunStore(join(dataDir, 'operation-events'), { maxItems: 10_000 }), maxItems: 10_000 });
await operationalEventLog.init();
const feedbackLearning = new FeedbackLearningService({
  feedbackPersistence: new JsonRunStore(join(dataDir, 'user-feedback'), { maxItems: 5000 }),
  candidatePersistence: new JsonRunStore(join(dataDir, 'learning-candidates'), { maxItems: 5000 }),
  maxItems: 5000,
});
await feedbackLearning.init();

const skillRegistry = await loadSkillsFromDirectory(join(rootDir, 'skills'));
const skillGovernance = new SkillGovernanceService({
  registry: skillRegistry,
  overridePersistence: new JsonRunStore(join(dataDir, 'skill-overrides'), { maxItems: 500 }),
  auditPersistence: new JsonRunStore(join(dataDir, 'skill-audit'), { maxItems: 1000 }),
});
await skillGovernance.init();
const requestAudit = new RequestAuditLog({ maxItems: 2000, persistence: new JsonRunStore(join(dataDir, 'request-audit'), { maxItems: 2000 }) });
await requestAudit.init();
const smartQueryRateLimiter = new SlidingWindowRateLimiter({
  limit: Number(process.env.WYN_AI_SMART_QUERY_RATE_LIMIT || 60),
  windowMs: Number(process.env.WYN_AI_SMART_QUERY_RATE_WINDOW_MS || 60_000),
});
const multiDatasetQueries = new MultiDatasetQueryService({
  loadMetadata: datasetId => loadDatasetMetadata(datasetId),
  executeDatasetQuery,
});
const conversations = new SmartQueryConversationStore({
  loadMetadata: datasetId => loadDatasetMetadata(datasetId),
  eventLog: operationalEventLog,
  executeQuery: input => multiDatasetQueries.execute(input),
  intentLlm,
  skillRegistry,
  skillGovernance,
  persistence: conversationStore,
  runAnalysis: async ({ datasetId, focus, constraints, skills, strictMode }) => {
    const metadata = await loadDatasetMetadata(datasetId);
    return runAutonomousAnalysis({
      metadata,
      focus,
      constraints,
      executeDatasetQuery,
      analyzeDataset,
      explorationAgent: explorationLlm,
      skills,
      strictMode,
    });
  },
});
await conversations.init();
const templatePersistence = new JsonRunStore(join(dataDir, 'report-templates'), { maxItems: 100 });
const templatePackages = new TemplatePackageRepository({ persistence: templatePersistence, maxItems: 100 });
await templatePackages.init();
const reportRunPersistence = new JsonRunStore(join(dataDir, 'report-runs'), { maxItems: 100 });
const reportRuns = new ReportRunRepository({ templates: templatePackages, queryService: multiDatasetQueries, persistence: reportRunPersistence });
await reportRuns.init();

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

function trimAgentRuns() {
  while (agentRuns.size > MAX_AGENT_RUNS) {
    agentRuns.delete(agentRuns.keys().next().value);
  }
}

function parseJsonText(value) {
  let parsed = JSON.parse(String(value || '').replace(/^\uFEFF/, '').trim());
  // Wyn may return JSON as a JSON-encoded string; unwrap that response form.
  for (let depth = 0; depth < 2 && typeof parsed === 'string'; depth += 1) {
    const nested = parsed.replace(/^\uFEFF/, '').trim();
    if (!/^[\[{]/.test(nested)) break;
    try {
      parsed = JSON.parse(nested);
    } catch {
      break;
    }
  }
  return parsed;
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

function resultRows(record) {
  return record?.input?.resultSets?.[0]?.rows || [];
}

function normalizedRows(record, limit = 1000) {
  return resultRows(record).slice(0, limit);
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

function insightRecord(detail) {
  return { insightId: detail.insightId, input: detail.input, createdAt: detail.createdAt, updatedAt: detail.updatedAt };
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
      llmProvider: config.llmBaseUrl && config.llmModel ? 'project-env' : 'local-fallback',
      llmEndpointHost,
      intentLlmTimeoutMs: config.intentLlmTimeoutMs,
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
  const limitReached = rows.length >= safeLimit;
  return {
    rows,
    rowLimit: safeLimit,
    // Wyn does not expose a definitive truncation flag in this response shape.
    // Reaching RowLimit is therefore only a possible boundary, not proof of loss.
    truncated: false,
    limitReached,
    truncationConfidence: limitReached ? 'possible' : 'none',
    queryType,
  };
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
      limitReached: result.limitReached,
      truncationConfidence: result.truncationConfidence,
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
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
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
      content: '你是一名企业经营分析负责人。只能使用输入中的 KPI、洞察和证据，不得新增任何数字、客户、事实或推断。只输出合法 JSON，不要输出 Markdown。JSON 必须包含 managementSummary、keyFindings、risks、actions 四个数组；每项必须严格使用 {"text":"...","evidenceIds":["ev-id"],"verificationRequired":false}。evidenceIds 字段不可省略且至少包含一个值，只能逐字复制 allowedEvidenceIds 中的 ID，不得自行创造、改写或翻译 ID。即使 verificationRequired=true 也必须引用触发该待验证事项的已有证据。managementSummary 只允许引用标量 KPI 数字；对于分组或交叉结果只做不带数字的定性概括，禁止合并多个实体的数值或生成数值区间。分组数值只能写在 keyFindings 或 risks 中，并且一条只引用一个分组证据、逐字保留该数值对应的全部实体、期间和布尔分组值。证据 scope.resultLimited=true 表示只返回排序后的局部结果，任何最高、最低、所有、全部、唯一、整体、总体或全局结论必须明确限定为“当前返回范围内”或“所列项目中”，不得外推到全量。对 invalidDurationEvidence 中的每个 evidenceId，必须单独形成一条明确包含“负值异常”“已从正常效率排名和图表中排除”“需核验”的数据质量披露。不得把该 evidenceId 引用到正常效率排名或瓶颈条目；若正常排名由其他无负时长证据支持，只引用其他证据。任何分组数值必须保留 insights 中对应的实体、期间或组合上下文，不得省略主体后改写成整体值；“前三项合计占100%”不得改写成某个单项占比100%。actions 应优先使用不含数字的定性行动；确需引用现状数字时，该数字必须逐字出现在同一证据关联的 insights 中，且严禁把任何数字写成目标、阈值或承诺。',
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
        body: JSON.stringify({
          model: config.llmModel,
          temperature: 0.1,
          max_tokens: 4096,
          ...(typeof config.llmEnableThinking === 'boolean' ? { enable_thinking: config.llmEnableThinking } : {}),
          response_format: { type: 'json_object' },
          messages,
        }),
        signal: controller.signal,
      });
      const payload = await upstream.json().catch(() => ({}));
      if (!upstream.ok) throw new Error(payload.error?.message || payload.message || `大模型返回 ${upstream.status}`);
      const content = payload.choices?.[0]?.message?.content || payload.output_text || '';
      outputPreviews.push(String(content).slice(0, 4000));
      try {
        const structured = validateStructuredReport(prepareStructuredReport(parseLlmJson(content), analysis), analysis);
        return { structured, markdown: structuredReportMarkdown(structured), attempts: attempt + 1 };
      } catch (error) {
        lastError = error;
        validationErrors.push(error.message);
        if (attempt < 2) {
          messages.push(
            { role: 'assistant', content },
            { role: 'user', content: `上次输出未通过校验：${error.message}。请重新输出完整 JSON。若错误包含“应关联”，删除 managementSummary 中该数字及相关数值区间；在 keyFindings 或 risks 中引用该数字时，一条只引用一个分组证据，并逐字保留错误中列出的全部实体、期间和布尔分组值；无法完整保留时删除该数字。每一项都必须包含 evidenceIds，且只能从以下列表逐字复制，至少选择一个：${allowedEvidenceIds.join('、')}。受限证据的最高或最低结论必须明确写“当前返回范围内”。请为 invalidDurationEvidence 中每个 evidenceId 单独输出一条数据质量项，原文包含“负值异常，已从正常效率排名和图表中排除，需核验”。正常效率排名条目不得引用这些 evidenceId；若排名由其他证据支持，只引用其他证据。actions 的 text 请移除所有目标、阈值和承诺；其中任何保留数字都必须逐字来自同一证据关联的洞察。` },
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
        const limitedPlans = Object.values(aggregateResults).filter(item => item.truncated || item.limitReached).map(item => item.plan.purpose);
        if (limitedPlans.length) queryWarnings.push(`以下聚合达到结果上限，可能仅代表当前返回范围，请缩小筛选范围后复核：${limitedPlans.join('、')}`);
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
    analysis.profile.sourceLimitReached = queryResult.limitReached;
    analysis.profile.sourceTruncationConfidence = queryResult.truncationConfidence;
    analysis.execution = {
      dataSource: 'wyn-dataset-api',
      queryType: aggregateResults ? 'WAX+SAMPLE' : queryResult.queryType,
      sampleQueryType: queryResult.queryType,
      sampleRowLimit: queryResult.rowLimit,
      sampleLimitReached: queryResult.limitReached,
      sampleTruncationConfidence: queryResult.truncationConfidence,
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

function publicConversation(item) {
  if (!item) return null;
  const { lastResult, lastDocument, ...safe } = item;
  return safe;
}

async function handleCreateConversation(request, response) {
  const startedAt = Date.now();
  const body = await readJson(request);
  const identity = guardSmartQuery(request, response);
  if (!identity) return;
  const item = await conversations.create({ ...body, userId: identity.userId, organizationId: identity.organizationId });
  requestAudit.record({ method: request.method, path: request.url, status: 201, durationMs: Date.now() - startedAt, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId });
  sendJson(response, 201, publicConversation(item));
}

async function handleConversationMessage(request, response, conversationId) {
  const startedAt = Date.now();
  const body = await readJson(request);
  const identity = guardSmartQuery(request, response);
  if (!identity) return;
  if (!conversations.canAccess(conversationId, identity)) {
    requestAudit.record({ method: request.method, path: request.url, status: 403, durationMs: Date.now() - startedAt, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId });
    return sendJson(response, 403, { message: '无权访问该智能问数会话' });
  }
  const controller = new AbortController();
  const traceId = createTraceId();
  operationalEventLog.record({ traceId, conversationId, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, event: 'request.accepted', phase: 'transport', details: { method: request.method, path: request.url } });

  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error('客户端已取消智能问数请求'));
  };
  request.once('aborted', abort);
  response.once('close', abort);
  let result;
  try {
    result = await conversations.ask(conversationId, { ...body, signal: controller.signal, traceId });
  } catch (error) {
    if (controller.signal.aborted || error?.code === 'REQUEST_ABORTED') {
      operationalEventLog.record({ traceId, conversationId, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, event: 'request.cancelled', phase: 'transport', outcome: 'cancelled', durationMs: Date.now() - startedAt });
      requestAudit.record({ method: request.method, path: request.url, status: 499, durationMs: Date.now() - startedAt, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, requestId: traceId, plannerMode: 'cancelled', planningDurationMs: Date.now() - startedAt });
      if (!response.destroyed && !response.writableEnded) sendJson(response, 499, { message: '本轮智能问数已取消' });
      return;
    }
    throw error;
  } finally {
    request.removeListener('aborted', abort);
    response.removeListener('close', abort);
  }
  const planning = result.response?.planningDiagnostics || {};
  result.response = { ...(result.response || {}), trace: { traceId, ...(result.response?.trace || {}) } };
  operationalEventLog.record({ traceId, conversationId, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, event: 'request.completed', phase: 'transport', outcome: result.response.status || 'ok', durationMs: Date.now() - startedAt, details: { plannerMode: planning.route, risk: planning.riskAssessment } });
  requestAudit.record({ method: request.method, path: request.url, status: 200, durationMs: Date.now() - startedAt, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, requestId: traceId, plannerMode: planning.route, planningDurationMs: planning.planningDurationMs, llmAttempted: planning.llmAttempted, llmDurationMs: planning.llmDurationMs });
  sendJson(response, 200, { ...result, conversation: publicConversation(result.conversation) });
}

async function handleMultiDatasetQuery(request, response) {
  const startedAt = Date.now();
  const body = await readJson(request);
  const identity = guardSmartQuery(request, response);
  if (!identity) return;
  const result = await multiDatasetQueries.execute(body);
  requestAudit.record({ method: request.method, path: request.url, status: 200, durationMs: Date.now() - startedAt, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId });
  sendJson(response, 200, result);
}

async function handleTemplateParse(request, response) {
  const body = await readJson(request);
  const encoded = String(body.contentBase64 || '');
  if (!encoded || encoded.length > 8_000_000) return sendJson(response, 400, { message: 'DOCX 内容不能为空或超过限制' });
  const buffer = Buffer.from(encoded, 'base64');
  sendJson(response, 200, parseDocxTemplate(buffer, { filename: body.filename || 'template.docx' }));
}

async function handleTemplateCompose(request, response) {
  const body = await readJson(request);
  const encoded = String(body.contentBase64 || '');
  if (!encoded || encoded.length > 8_000_000) return sendJson(response, 400, { message: 'DOCX 内容不能为空或超过限制' });
  const buffer = composeDocxTemplate(Buffer.from(encoded, 'base64'), body.values && typeof body.values === 'object' ? body.values : {}, { blockReplacements: Array.isArray(body.blockReplacements) ? body.blockReplacements : [] });
  sendDownload(response, { body: buffer, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: String(body.filename || 'generated-report.docx').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) });
}

async function handleTemplateCreate(request, response) {
  const body = await readJson(request);
  const encoded = String(body.contentBase64 || '');
  if (!encoded || encoded.length > 8_000_000) return sendJson(response, 400, { message: 'DOCX 内容不能为空或超过限制' });
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length) return sendJson(response, 400, { message: 'DOCX 内容无效' });
  const item = await templatePackages.create(buffer, { filename: body.filename || 'template.docx', name: body.name });
  sendJson(response, 201, templatePackages.get(item.id));
}

function handleTemplateList(response) {
  sendJson(response, 200, { schema: 'wynai.template-catalog/v1', items: templatePackages.list(), total: templatePackages.list().length });
}

function handleTemplateGet(templateId, response) {
  const item = templatePackages.get(templateId);
  if (!item) return sendJson(response, 404, { message: '报告模板不存在' });
  sendJson(response, 200, item);
}

async function handleTemplateAnnotate(request, response, templateId) {
  const result = await templatePackages.annotate(templateId, await readJson(request));
  sendJson(response, 200, { schema: 'wynai.template-annotation/v1', annotation: result, template: templatePackages.get(templateId) });
}

async function handleTemplateBinding(request, response, templateId) {
  const input = await readJson(request);
  const template = templatePackages.get(templateId, { includeSource: true });
  if (!template) return sendJson(response, 404, { message: '报告模板不存在' });
  const block = template.blocks.find(item => item.id === input.blockId);
  if (!block) return sendJson(response, 404, { message: '模板 Block 不存在' });
  let proposal = null;
  if ((!Array.isArray(input.queryRequests) || !input.queryRequests.length) && (input.businessQuestion || input.businessIntent)) {
    const datasetIds = input.datasetIds || input.businessIntent?.datasetIds || input.businessIntent?.datasets?.map(item => item.id) || [];
    const metadataItems = await Promise.all(datasetIds.map(datasetId => loadDatasetMetadata(datasetId)));
    const proposalIntent = input.businessIntent || { businessQuestion: input.businessQuestion, datasetIds, expectedResult: input.expectedResult, presentation: { targetBlockType: input.type || block.suggestion?.type || 'inline-text' } };
    const skillItems = metadataItems.length ? skillRegistry.resolveForQuestion({ datasetId: metadataItems[0].id, question: proposalIntent.businessQuestion }).skills : [];
    proposal = proposeCanonicalQueries({ metadataItems, intent: proposalIntent, skills: skillItems });
    proposal.formula = input.formula || proposeFormula(proposalIntent.businessQuestion);
  }
  const binding = await templatePackages.putBinding(templateId, { ...input, queryRequests: input.queryRequests || proposal?.requests || [], formula: input.formula || (proposal?.formula ? { ...proposal.formula, inputBindings: input.inputBindings || {} } : null), status: input.status || 'proposed' });
  sendJson(response, 200, { schema: 'wynai.binding-proposal/v1', proposal, binding, template: templatePackages.get(templateId) });
}

async function handleReportRunCreate(request, response) {
  const run = await reportRuns.create(await readJson(request));
  sendJson(response, 201, reportRuns.get(run.id));
}

function handleReportRunGet(reportId, response) {
  const run = reportRuns.get(reportId);
  if (!run) return sendJson(response, 404, { message: '报告运行不存在' });
  sendJson(response, 200, run);
}

function handleReportRunList(response) {
  const items = reportRuns.list();
  sendJson(response, 200, { schema: 'wynai.report-run-catalog/v1', items, total: items.length });
}

async function handleReportContent(request, response, reportId, blockId) {
  const session = await reportRuns.updateContent(reportId, blockId, await readJson(request));
  sendJson(response, 200, session);
}

function handleReportExport(reportId, format, response) {
  const exportFile = reportRuns.export(reportId, format);
  sendDownload(response, exportFile);
}

function handleConversation(pathname, response) {
  const prefix = '/api/smart-query/conversations/';
  const remainder = pathname.slice(prefix.length);
  const [conversationId, action] = remainder.split('/');
  const item = conversations.get(conversationId);
  if (!item) return sendJson(response, 404, { message: '会话不存在或已过期' });
  if (action === 'messages') return item;
  sendJson(response, 200, publicConversation(item));
}

function handleSkillCatalog(response) {
  const approvedSkills = skillRegistry.list().filter(skill => skill.status === 'approved');
  sendJson(response, 200, {
    schema: 'wynai.skill-catalog/v1',
    items: approvedSkills.map(skill => ({ id: skill.id, version: skill.version, name: skill.name, scope: skill.scope, status: skill.status, datasetIds: skill.datasetIds, triggers: skill.triggers })),
    total: approvedSkills.length,
  });
}

function skillActor(request) {
  return requestIdentity(request).actor;
}

function requireSkillAdmin(request, response) {
  if (!config.skillAdminToken) {
    sendJson(response, 503, { message: 'Skill 管理写操作尚未配置 WYN_AI_SKILL_ADMIN_TOKEN' });
    return false;
  }
  const provided = String(request.headers['x-wyn-skill-admin-token'] || '');
  if (provided.length !== config.skillAdminToken.length || provided !== config.skillAdminToken) {
    sendJson(response, 403, { message: '需要 Skill 管理员权限' });
    return false;
  }
  return true;
}

function guardSmartQuery(request, response) {
  const identity = requestIdentity(request);
  const key = `${identity.organizationId || 'global'}:${identity.userId || request.socket.remoteAddress || 'anonymous'}`;
  const decision = smartQueryRateLimiter.check(key);
  response.setHeader('X-RateLimit-Limit', String(decision.limit));
  response.setHeader('X-RateLimit-Remaining', String(decision.remaining));
  if (!decision.allowed) {
    response.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
    requestAudit.record({ method: request.method, path: request.url, status: 429, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, rateLimited: true });
    sendJson(response, 429, { message: '智能问数请求过于频繁，请稍后重试', retryAfterMs: decision.retryAfterMs });
    return null;
  }
  return identity;
}

async function handleSkillCreate(request, response) {
  if (!requireSkillAdmin(request, response)) return;
  const body = await readJson(request);
  const identity = requestIdentity(request);
  const skill = { ...body, status: 'draft' };
  delete skill.userId;
  delete skill.organizationId;
  const result = await skillGovernance.saveOverride(skill, { actor: identity.actor, reason: '通过管理 API 创建草稿' });
  sendJson(response, 201, { schema: 'wynai.skill-governance/v1', ...result });
}

function handleSkillVersions(request, response, id) {
  if (!requireSkillAdmin(request, response)) return;
  sendJson(response, 200, { schema: 'wynai.skill-versions/v1', id, items: skillGovernance.versions(id).map(skill => ({ id: skill.id, version: skill.version, name: skill.name, scope: skill.scope, status: skill.status, updatedAt: skill.updatedAt || null })) });
}

async function handleSkillLifecycle(request, response, id, version, action) {
  if (!requireSkillAdmin(request, response)) return;
  const body = await readJson(request);
  const options = { actor: skillActor(request), reason: body.reason || '' };
  const result = action === 'rollback'
    ? await skillGovernance.rollback(id, version, options)
    : await skillGovernance.setStatus(id, version, action === 'approve' ? 'approved' : 'retired', options);
  sendJson(response, 200, { schema: 'wynai.skill-governance/v1', ...result });
}

function handleSkillAudit(request, response) {
  if (!requireSkillAdmin(request, response)) return;
  const limit = new URL(request.url, 'http://localhost').searchParams.get('limit') || 100;
  sendJson(response, 200, { schema: 'wynai.skill-audit/v1', items: skillGovernance.auditLog({ limit }), total: skillGovernance.audit.length });
}

function handleRequestAudit(request, response) {
  if (!requireSkillAdmin(request, response)) return;
  const limit = new URL(request.url, 'http://localhost').searchParams.get('limit') || 100;
  sendJson(response, 200, { schema: 'wynai.request-audit/v1', items: requestAudit.list(limit), total: requestAudit.items.length });
}

async function handleConversationFeedback(request, response, conversationId) {
  const identity = guardSmartQuery(request, response);
  if (!identity) return;
  if (!conversations.canAccess(conversationId, identity)) return sendJson(response, 403, { message: '无权反馈该智能问数会话' });
  const body = await readJson(request);
  const conversation = conversations.get(conversationId);
  const turnId = String(body.turnId || '').slice(0, 120) || null;
  const messages = conversation.messages || [];
  const assistant = [...messages].reverse().find(message => message.role === 'assistant' && (!turnId || message.turnId === turnId)) || null;
  const user = [...messages].reverse().find(message => message.role === 'user' && (!turnId || message.turnId === turnId)) || null;
  const result = await feedbackLearning.submit(body, {
    conversationId, turnId: turnId || assistant?.turnId, traceId: body.traceId || assistant?.traceId, datasetId: conversation.dataset.id,
    organizationId: identity.organizationId, userId: identity.userId, question: user?.content || '', answer: assistant?.content || '',
    semanticSnapshot: { intent: conversation.activeBusinessIntent, queryRequest: conversation.activeQueryRequest, skillRefs: conversation.loadedSkillRefs || [] },
  });
  operationalEventLog.record({ traceId: result.feedback.traceId || createTraceId(), conversationId, turnId: result.feedback.turnId, datasetId: conversation.dataset.id, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, event: 'feedback.received', phase: 'learning', outcome: result.feedback.category, details: { feedbackId: result.feedback.id, candidateId: result.candidate.id, comment: result.feedback.comment, correction: result.feedback.correction } });
  sendJson(response, 201, { schema: 'wynai.feedback-submission/v1', feedback: { id: result.feedback.id, category: result.feedback.category }, candidate: { id: result.candidate.id, kind: result.candidate.kind, status: result.candidate.status } });
}

function handleFeedbackList(request, response) {
  if (!requireSkillAdmin(request, response)) return;
  const limit = new URL(request.url, 'http://localhost').searchParams.get('limit') || 100;
  sendJson(response, 200, { schema: 'wynai.user-feedback-list/v1', items: feedbackLearning.listFeedback({ limit }), total: feedbackLearning.feedback.length });
}

function handleLearningCandidateList(request, response) {
  if (!requireSkillAdmin(request, response)) return;
  const params = new URL(request.url, 'http://localhost').searchParams;
  sendJson(response, 200, { schema: 'wynai.learning-candidate-list/v1', items: feedbackLearning.listCandidates({ limit: params.get('limit') || 100, status: params.get('status') || null }), total: feedbackLearning.candidates.length });
}

async function handleLearningCandidateReview(request, response, id, action) {
  if (!requireSkillAdmin(request, response)) return;
  const body = await readJson(request);
  const reviewed = await feedbackLearning.review(id, action === 'approve' ? 'approved_for_authoring' : 'rejected', { actor: skillActor(request), reason: body.reason || '' });
  sendJson(response, 200, reviewed);
}

function handleOperationEvents(request, response, traceId = null) {
  if (!requireSkillAdmin(request, response)) return;
  const params = new URL(request.url, 'http://localhost').searchParams;
  const items = traceId ? operationalEventLog.trace(traceId) : operationalEventLog.list({ limit: params.get('limit') || 100, conversationId: params.get('conversationId') || null, event: params.get('event') || null });
  sendJson(response, 200, { schema: 'wynai.operation-event-list/v1', traceId, items, total: items.length });
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
  if (upstream.ok) {
    viewDefinitions.set(viewId, payload);
    wynQueryInsightAdapter.updateView(viewId, payload);
  }
  sendJson(response, upstream.status, payload);
}

function dataInsightListItem(detail) {
  const record = insightRecord(detail);
  const summary = resultSummary(record);
  return {
    insightId: detail.insightId,
    title: detail.input.title,
    source: detail.input.source || null,
    datasets: detail.input.datasets || [],
    resultSetCount: detail.input.resultSets.length,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    ...summary,
  };
}

function handleDataInsights(pathname, requestUrl, response) {
  const insightId = pathname.slice('/api/data-insights/'.length);
  if (!insightId) {
    const items = dataInsightStore.list({ sourceType: requestUrl.searchParams.get('sourceType'), sourceId: requestUrl.searchParams.get('sourceId') });
    sendJson(response, 200, { items, total: items.length, llmConfigured: Boolean(config.llmBaseUrl && config.llmModel), llmProvider: config.llmBaseUrl && config.llmModel ? 'project-env' : 'local-fallback', llmModel: config.llmModel || null, llmEndpointHost });
    return;
  }
  const detail = dataInsightStore.get(insightId);
  if (!detail) return sendJson(response, 404, { message: '数据洞察结果不存在或已过期' });
  const record = insightRecord(detail);
  const rows = normalizedRows(record);
  sendJson(response, 200, {
    ...dataInsightListItem(detail),
    insightId,
    rows,
    truncated: resultRows(record).length > rows.length || Boolean(detail.input.quality?.isTruncated),
    input: detail.input,
    primaryResultSet: detail.primaryResultSet,
  });
}

async function handleDataInsightInput(request, response) {
  const body = await readJson(request);
  try {
    const idempotencyKey = request.headers['idempotency-key'] || null;
    const result = dataInsightStore.register(body, { idempotencyKey });
    sendJson(response, result.created ? 201 : 200, { schema: 'wynai.insight-input-ack/v1', insightId: result.record.insightId, status: result.created ? 'accepted' : 'updated' });
  } catch (error) {
    if (error?.name === 'InsightInputError') return sendJson(response, error.status || 422, { code: error.code, path: error.path, message: error.message });
    throw error;
  }
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
      ...(typeof config.llmEnableThinking === 'boolean' ? { enable_thinking: config.llmEnableThinking } : {}),
      messages: [
        {
          role: 'system',
          content: '你是一名严谨的企业数据分析师。只基于给定结果集回答，明确指出数据质量问题，并用中文输出核心结论、证据、风险和行动建议。',
        },
        {
          role: 'user',
          content: JSON.stringify({
            analysisGoal: prompt,
            topic: record.input?.title,
            query: record.input?.context?.query || null,
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

async function handleSecondaryInsight(request, response, providedBody = null) {
  const body = providedBody || await readJson(request);
  const insightId = String(body.insightId || '').trim();
  const prompt = String(body.prompt || '').trim().slice(0, 4000);
  const detail = dataInsightStore.get(insightId);
  if (!detail) return sendJson(response, 404, { message: '数据洞察结果不存在或已过期，请重新提交标准结果。' });
  const record = insightRecord(detail);

  try {
    const result = config.llmBaseUrl && config.llmModel
      ? await callConfiguredLlm(record, prompt)
      : buildLocalInsight(record, prompt);
    sendJson(response, 200, { ...result, insightId, generatedAt: new Date().toISOString() });
  } catch (error) {
    sendJson(response, 502, { message: `项目 LLM 二次洞察失败（${llmEndpointHost || '未配置端点'}）：${error.message}` });
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
    if (request.method === 'POST' && pathname === '/api/smart-query/conversations') {
      return await handleCreateConversation(request, response);
    }
    if (request.method === 'GET' && pathname === '/api/smart-query/skills') {
      return handleSkillCatalog(response);
    }
    if (request.method === 'POST' && pathname === '/api/smart-query/skills') {
      return await handleSkillCreate(request, response);
    }
    if (request.method === 'GET' && pathname === '/api/smart-query/skills/audit') {
      return handleSkillAudit(request, response);
    }
    if (request.method === 'GET' && pathname === '/api/smart-query/audit') {
      return handleRequestAudit(request, response);
    }
    if (request.method === 'GET' && pathname === '/api/smart-query/feedback') return handleFeedbackList(request, response);
    if (request.method === 'GET' && pathname === '/api/smart-query/learning-candidates') return handleLearningCandidateList(request, response);
    if (request.method === 'GET' && pathname === '/api/smart-query/operation-events') return handleOperationEvents(request, response);
    const operationTraceRoute = pathname.match(/^\/api\/smart-query\/operation-events\/(trace-[a-zA-Z0-9-]{8,100})$/);
    if (request.method === 'GET' && operationTraceRoute) return handleOperationEvents(request, response, operationTraceRoute[1]);
    const learningReviewRoute = pathname.match(/^\/api\/smart-query\/learning-candidates\/(learning-candidate-[a-zA-Z0-9-]{8,100})\/(approve|reject)$/);
    if (request.method === 'POST' && learningReviewRoute) return await handleLearningCandidateReview(request, response, learningReviewRoute[1], learningReviewRoute[2]);
    const skillVersionsRoute = pathname.match(/^\/api\/smart-query\/skills\/([a-zA-Z0-9-]{2,80})\/versions$/);
    if (request.method === 'GET' && skillVersionsRoute) return handleSkillVersions(request, response, skillVersionsRoute[1]);
    const skillLifecycleRoute = pathname.match(/^\/api\/smart-query\/skills\/([a-zA-Z0-9-]{2,80})\/versions\/([^/]+)\/(approve|retire|rollback)$/);
    if (request.method === 'POST' && skillLifecycleRoute) return await handleSkillLifecycle(request, response, skillLifecycleRoute[1], decodeURIComponent(skillLifecycleRoute[2]), skillLifecycleRoute[3]);
    if (request.method === 'POST' && pathname === '/api/smart-query/query') {
      return await handleMultiDatasetQuery(request, response);
    }
    if (request.method === 'POST' && pathname === '/api/report-templates/parse') {
      return await handleTemplateParse(request, response);
    }
    if (request.method === 'POST' && pathname === '/api/report-templates') {
      return await handleTemplateCreate(request, response);
    }
    if (request.method === 'GET' && pathname === '/api/report-templates') {
      return handleTemplateList(response);
    }
    const templateRoute = pathname.match(/^\/api\/report-templates\/([a-zA-Z0-9-]{8,100})$/);
    if (request.method === 'GET' && templateRoute) return handleTemplateGet(templateRoute[1], response);
    const templateAnnotateRoute = pathname.match(/^\/api\/report-templates\/([a-zA-Z0-9-]{8,100})\/annotate$/);
    if (request.method === 'POST' && templateAnnotateRoute) return await handleTemplateAnnotate(request, response, templateAnnotateRoute[1]);
    const templateBindingRoute = pathname.match(/^\/api\/report-templates\/([a-zA-Z0-9-]{8,100})\/bindings\/propose$/);
    if (request.method === 'POST' && templateBindingRoute) return await handleTemplateBinding(request, response, templateBindingRoute[1]);
    if (request.method === 'POST' && pathname === '/api/report-templates/compose') {
      return await handleTemplateCompose(request, response);
    }
    if (request.method === 'POST' && pathname === '/api/report-runs') return await handleReportRunCreate(request, response);
    if (request.method === 'GET' && pathname === '/api/report-runs') return handleReportRunList(response);
    const reportContentRoute = pathname.match(/^\/api\/report-runs\/([a-zA-Z0-9-]{8,100})\/content\/([^/]+)$/);
    if (request.method === 'POST' && reportContentRoute) return await handleReportContent(request, response, reportContentRoute[1], decodeURIComponent(reportContentRoute[2]));
    const reportExportRoute = pathname.match(/^\/api\/report-runs\/([a-zA-Z0-9-]{8,100})\/export$/);
    if (request.method === 'GET' && reportExportRoute) return handleReportExport(reportExportRoute[1], requestUrl.searchParams.get('format') || 'docx', response);
    const templateReportRoute = pathname.match(/^\/api\/report-runs\/([a-zA-Z0-9-]{8,100})$/);
    if (request.method === 'GET' && templateReportRoute) return handleReportRunGet(templateReportRoute[1], response);
    const conversationMessageRoute = pathname.match(/^\/api\/smart-query\/conversations\/([a-zA-Z0-9-]{8,100})\/messages$/);
    const conversationFeedbackRoute = pathname.match(/^\/api\/smart-query\/conversations\/([a-zA-Z0-9-]{8,100})\/feedback$/);
    if (request.method === 'POST' && conversationFeedbackRoute) return await handleConversationFeedback(request, response, conversationFeedbackRoute[1]);
    if (request.method === 'POST' && conversationMessageRoute) {
      return await handleConversationMessage(request, response, conversationMessageRoute[1]);
    }
    const conversationRoute = pathname.match(/^\/api\/smart-query\/conversations\/([a-zA-Z0-9-]{8,100})$/);
    if (request.method === 'GET' && conversationRoute) {
      const item = conversations.get(conversationRoute[1]);
      const identity = requestIdentity(request);
      if (!item) return sendJson(response, 404, { message: '会话不存在或已过期' });
      if (!conversations.canAccess(conversationRoute[1], identity)) return sendJson(response, 403, { message: '无权访问该智能问数会话' });
      return sendJson(response, 200, publicConversation(item));
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
    if (request.method === 'POST' && pathname === '/api/data-insights/inputs') {
      return await handleDataInsightInput(request, response);
    }
    const dataInsightGenerateRoute = pathname.match(/^\/api\/data-insights\/([A-Za-z0-9-]{8,100})\/generate$/);
    if (request.method === 'POST' && dataInsightGenerateRoute) {
      const body = await readJson(request);
      return await handleSecondaryInsight(request, response, { ...body, insightId: dataInsightGenerateRoute[1] });
    }
    if (request.method === 'GET' && (pathname === '/api/data-insights' || pathname.startsWith('/api/data-insights/'))) {
      return handleDataInsights(pathname, requestUrl, response);
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
        wynQueryInsightAdapter.capture(requestViewId, {
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
          wynQueryInsightAdapter.capture(requestViewId, { pivotPayload });
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
          .wyn-smart-analyzer.theme-default.wyn-smart-analyzer.wyn-smart-analyzer .chat-layout-conversation-area {
            padding: 10px !important;
          }
          .wyn-smart-analyzer.theme-default .sa-app .sa-layout__chat-panel .sa-app__content {
            padding: 10px !important;
          }
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
