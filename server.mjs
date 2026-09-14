import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { analyzeDataset, normalizeDatasetMetadata } from './lib/analysis-core.mjs';
import { applyLocalFilters, buildAnalysisQueryBundle, compileFilteredDetailQuery } from './lib/wax-query.mjs';
import { JsonRunStore } from './lib/run-store.mjs';
import { buildReportExport } from './lib/report-export.mjs';
import { buildInsightDocumentExport } from './insight-document-export.mjs';
import { runAutonomousAnalysis } from './lib/harness/orchestrator.mjs';
import { createExplorationLlm } from './lib/llm/exploration-agent.mjs';
import { createLlmGateway, serializeError } from './llm-gateway.mjs';
import { createPlatformGatewayManager } from './platform-gateway-manager.mjs';
import { compilePlatformContextManifest, validatePlatformEvidenceTransport } from './platform-context-governance.mjs';
import { createDataInsightCompatibilityAdapter } from './data-insight-compatibility-adapter.mjs';
import { createSmartQueryCompatibilityAdapter } from './smart-query-compatibility-adapter.mjs';
import { normalizeIndependentQueryInsightContract } from './independent-query-insight-contract.mjs';
import { createMigrationRoutingPolicy, normalizeMigrationMode } from './platform-migration-policy.mjs';
import { createPlatformMigrationRuntime } from './platform-migration-runtime.mjs';
import { createCandidateInsightOrchestrator, createCandidateSmartQueryOrchestrator } from './platform-business-orchestrators.mjs';
import { normalizeInsightInput } from './lib/data-insights/insight-input.mjs';
import { normalizeAIInteractionRequest } from './lib/protocol/interaction-contract.mjs';
import { normalizeCanonicalFilters } from './lib/planning/query-request-schema.mjs';
import { prepareStructuredReport, structuredReportMarkdown, validateStructuredReport } from './lib/report/structured-report.mjs';
import { normalizeInsightDocument } from './lib/protocol/interaction-contract.mjs';
import { composeInsightDocument } from './lib/report/insight-document.mjs';
import { SmartQueryConversationStore } from './lib/conversation/session.mjs';
import { MultiDatasetQueryService } from './lib/query/multi-dataset.mjs';
import { parseDocxTemplate } from './lib/template/docx-parser.mjs';
import { composeDocxTemplate } from './lib/template/docx-composer.mjs';
import { loadSkillsFromDirectory } from './lib/skills/skill-registry.mjs';
import { SkillGovernanceService } from './lib/skills/skill-governance.mjs';
import { OperationalEventLog, createTraceId } from './lib/observability/operational-event-log.mjs';
import { buildQualityDetails, summarizeQueryQuality } from './query-quality.mjs';
import { FeedbackLearningService } from './lib/learning/feedback-learning.mjs';
import { RequestAuditLog, SlidingWindowRateLimiter, requestIdentity } from './lib/security/request-governance.mjs';
import { TemplatePackageRepository } from './lib/template/template-model.mjs';
import { proposeCanonicalQueries, proposeFormula } from './lib/reporting/binding-resolver.mjs';
import { ReportRunRepository } from './lib/reporting/report-runner.mjs';
import { DataInsightStore } from './lib/data-insights/insight-store.mjs';
import { WynQueryInsightAdapter } from './lib/data-insights/wyn-query-adapter.mjs';
import { IndependentQueryInsightAdapter } from './lib/data-insights/independent-query-adapter.mjs';
import { InsightRunStore } from './lib/data-insights/insight-run-store.mjs';
import { buildEvidencePack } from './lib/data-insights/evidence-pack.mjs';
import { runInsightLlmOrchestration } from './lib/data-insights/llm-orchestrator.mjs';
import { compileSkillPlan } from './skill-plan.mjs';
import { assessCapabilityCoverage } from './capability-coverage.mjs';
import { normalizeModelCapability, resolveModelBudget } from './model-capability-profile.mjs';
import { InsightGovernanceService, redactInsightInput } from './lib/data-insights/insight-governance.mjs';
import { buildBusinessFactPack } from './business-fact-engine.mjs';
import { InsightDiagnosticLookupError, InsightDiagnosticStore, summarizeDiagnosticLifecycle } from './insight-diagnostic-store.mjs';

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

function validInsightTransportMode(value) {
  const mode = String(value || 'auto');
  return ['auto', 'aggregate-catalog', 'lossless-row-chunk', 'adaptive-hybrid'].includes(mode) ? mode : 'auto';
}

const config = {
  wynBaseUrl: (process.env.WYN_BASE_URL || 'http://localhost:51980').replace(/\/$/, ''),
  token: process.env.WYN_TOKEN || '',
  host: process.env.HOST || '127.0.0.1',
  port: validPort('PORT', commandLineNumber('port') || process.env.PORT || 8787),
  llmBaseUrl: (process.env.LLM_BASE_URL || '').replace(/\/$/, ''),
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || '',
  llmContextWindowTokens: Math.max(4_096, Number(process.env.LLM_CONTEXT_WINDOW_TOKENS) || 32_768),
  llmMaxInputTokens: Math.max(1_024, Number(process.env.LLM_MAX_INPUT_TOKENS) || 20_000),
  llmMaxOutputTokens: Math.max(256, Number(process.env.LLM_MAX_OUTPUT_TOKENS) || 4_096),
  llmSafetyReserveTokens: Math.max(0, Number(process.env.LLM_SAFETY_RESERVE_TOKENS) || 2_048),
  llmProtocolOverheadTokens: Math.max(0, Number(process.env.LLM_PROTOCOL_OVERHEAD_TOKENS) || 1_024),
  insightTransportMode: validInsightTransportMode(process.env.INSIGHT_TRANSPORT_MODE),
  llmBackupBaseUrl: (process.env.LLM_BACKUP_BASE_URL || '').replace(/\/$/, ''),
  llmBackupApiKey: process.env.LLM_BACKUP_API_KEY || '',
  llmBackupModel: process.env.LLM_BACKUP_MODEL || '',
  // Preserve the previously validated direct-client budget unless explicitly overridden.
  llmTimeoutMs: Math.max(10_000, Number(process.env.LLM_TIMEOUT_MS) || 180_000),
  // Complex governed intents routinely need 15-20 seconds on the configured
  // model. A 10-second default made healthy calls fail at the absolute retry
  // budget, while the separate connect timeout still fails fast on outages.
  intentLlmTimeoutMs: Math.max(1_000, Number(process.env.INTENT_LLM_TIMEOUT_MS) || 30_000),
  llmConnectTimeoutMs: Math.max(1_000, Number(process.env.LLM_CONNECT_TIMEOUT_MS) || 3_000),
  // Header wait is split into a non-destructive warning and a hard cap. Keep
  // the legacy timeout variable as an explicit hard-cap override; by default
  // each operation uses its own total request deadline as the hard cap.
  llmResponseHeaderWarningMs: Math.max(0, Number(process.env.LLM_RESPONSE_HEADER_WARNING_MS || process.env.LLM_FIRST_BYTE_TIMEOUT_MS) || 15_000),
  llmResponseHeaderTimeoutMs: Math.max(0, Number(process.env.LLM_RESPONSE_HEADER_TIMEOUT_MS) || 0),
  llmResponseBodyTimeoutMs: Math.max(0, Number(process.env.LLM_RESPONSE_BODY_TIMEOUT_MS) || 0),
  llmPlannerTimeoutMs: Math.max(10_000, Number(process.env.LLM_INSIGHT_PLANNER_TIMEOUT_MS) || 45_000),
  llmCriticTimeoutMs: Math.max(10_000, Number(process.env.LLM_INSIGHT_CRITIC_TIMEOUT_MS) || 35_000),
  llmNarratorTimeoutMs: Math.max(10_000, Number(process.env.LLM_INSIGHT_NARRATOR_TIMEOUT_MS) || 45_000),
  llmNarratorRepairTimeoutMs: Math.max(10_000, Number(process.env.LLM_INSIGHT_NARRATOR_REPAIR_TIMEOUT_MS) || 90_000),
  llmAgentReportTimeoutMs: Math.max(10_000, Number(process.env.LLM_AGENT_REPORT_TIMEOUT_MS) || 45_000),
  llmRetryBaseDelayMs: Math.max(0, Number(process.env.LLM_RETRY_BASE_DELAY_MS) || 250),
  llmRetryMaxDelayMs: Math.max(0, Number(process.env.LLM_RETRY_MAX_DELAY_MS) || 4_000),
  llmRetryJitterMs: Math.max(0, Number(process.env.LLM_RETRY_JITTER_MS) || 150),
  llmMaxAttempts: Math.max(1, Number(process.env.LLM_MAX_ATTEMPTS) || 2),
  llmCircuitFailureThreshold: Math.max(1, Number(process.env.LLM_CIRCUIT_FAILURE_THRESHOLD) || 3),
  llmCircuitCooldownMs: Math.max(1_000, Number(process.env.LLM_CIRCUIT_COOLDOWN_MS) || 30_000),
  llmCacheTtlMs: Math.max(0, Number(process.env.LLM_CACHE_TTL_MS) || 30_000),
  llmEnableThinking: configuredBoolean(process.env.LLM_ENABLE_THINKING, /dashscope\.aliyuncs\.com/i.test(process.env.LLM_BASE_URL || '') ? false : null),
  skillAdminToken: process.env.WYN_AI_SKILL_ADMIN_TOKEN || '',
};
async function probeWritableDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const probe = join(directory, `.wynai-write-probe-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(probe, 'ok', { encoding: 'utf8', flag: 'wx' });
  } finally {
    await rm(probe, { force: true }).catch(() => null);
  }
}

async function resolveWritableDataDirectory(preferred, fallback) {
  try {
    await probeWritableDirectory(preferred);
    return { path: preferred, fallback: false, preferredError: null };
  } catch (preferredError) {
    try {
      await probeWritableDirectory(fallback);
    } catch (fallbackError) {
      throw new Error(`运行数据目录不可写：首选目录 ${preferred}（${preferredError.code || preferredError.message}），备用目录 ${fallback}（${fallbackError.code || fallbackError.message}）`);
    }
    console.warn(`Runtime data directory is not writable; using fallback: ${fallback} (preferred: ${preferredError.code || preferredError.message})`);
    return { path: fallback, fallback: true, preferredError };
  }
}
const llmEndpointHost = (() => {
  try { return new URL(config.llmBaseUrl || config.llmBackupBaseUrl).host; } catch { return null; }
})();
const llmProviders = [
  { id: 'primary', baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel },
  { id: 'backup', baseUrl: config.llmBackupBaseUrl, apiKey: config.llmBackupApiKey, model: config.llmBackupModel },
];
const explorationGateway = createLlmGateway({
  providers: llmProviders,
  timeoutMs: config.llmTimeoutMs,
  connectTimeoutMs: config.llmConnectTimeoutMs,
  responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || config.llmTimeoutMs,
  responseHeaderWarningMs: Math.min(config.llmResponseHeaderWarningMs, config.llmTimeoutMs),
  responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || config.llmTimeoutMs,
  operationPolicies: {
    exploration: { requestTimeoutMs: config.llmTimeoutMs, responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || config.llmTimeoutMs, responseHeaderWarningMs: Math.min(config.llmResponseHeaderWarningMs, config.llmTimeoutMs), responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || config.llmTimeoutMs },
    'agent-report': { requestTimeoutMs: config.llmAgentReportTimeoutMs, responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || config.llmAgentReportTimeoutMs, responseHeaderWarningMs: Math.min(config.llmResponseHeaderWarningMs, config.llmAgentReportTimeoutMs), responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || config.llmAgentReportTimeoutMs },
    'insight-planner': { requestTimeoutMs: config.llmPlannerTimeoutMs, responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || config.llmPlannerTimeoutMs, responseHeaderWarningMs: Math.min(config.llmResponseHeaderWarningMs, config.llmPlannerTimeoutMs), responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || config.llmPlannerTimeoutMs },
    'insight-critic': { requestTimeoutMs: config.llmCriticTimeoutMs, responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || config.llmCriticTimeoutMs, responseHeaderWarningMs: Math.min(config.llmResponseHeaderWarningMs, config.llmCriticTimeoutMs), responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || config.llmCriticTimeoutMs },
    'insight-narrator': { requestTimeoutMs: config.llmNarratorTimeoutMs, responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || config.llmNarratorTimeoutMs, responseHeaderWarningMs: Math.min(config.llmResponseHeaderWarningMs, config.llmNarratorTimeoutMs), responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || config.llmNarratorTimeoutMs },
    'insight-narrator-repair': { requestTimeoutMs: config.llmNarratorRepairTimeoutMs, responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || config.llmNarratorRepairTimeoutMs, responseHeaderWarningMs: Math.min(config.llmResponseHeaderWarningMs, config.llmNarratorRepairTimeoutMs), responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || config.llmNarratorRepairTimeoutMs },
    probe: { requestTimeoutMs: Math.min(config.llmTimeoutMs, 10_000), responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || Math.min(config.llmTimeoutMs, 10_000), responseHeaderWarningMs: Math.min(config.llmResponseHeaderWarningMs, 5_000), responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || Math.min(config.llmTimeoutMs, 10_000) },
  },
  retryBaseDelayMs: config.llmRetryBaseDelayMs,
  retryMaxDelayMs: config.llmRetryMaxDelayMs,
  retryJitterMs: config.llmRetryJitterMs,
  maxAttempts: config.llmMaxAttempts,
  circuitFailureThreshold: config.llmCircuitFailureThreshold,
  circuitCooldownMs: config.llmCircuitCooldownMs,
  cacheTtlMs: config.llmCacheTtlMs,
  enableThinking: config.llmEnableThinking,
});
const intentGateway = createLlmGateway({
  providers: llmProviders,
  timeoutMs: config.intentLlmTimeoutMs,
  connectTimeoutMs: config.llmConnectTimeoutMs,
  responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || config.intentLlmTimeoutMs,
  responseHeaderWarningMs: Math.min(config.llmResponseHeaderWarningMs, config.intentLlmTimeoutMs),
  responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || config.intentLlmTimeoutMs,
  operationPolicies: {
    intent: { requestTimeoutMs: config.intentLlmTimeoutMs, responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || config.intentLlmTimeoutMs, responseHeaderWarningMs: Math.min(config.llmResponseHeaderWarningMs, config.intentLlmTimeoutMs), responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || config.intentLlmTimeoutMs },
    probe: { requestTimeoutMs: Math.min(config.intentLlmTimeoutMs, 10_000), responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || Math.min(config.intentLlmTimeoutMs, 10_000), responseHeaderWarningMs: Math.min(config.llmResponseHeaderWarningMs, 5_000), responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || Math.min(config.intentLlmTimeoutMs, 10_000) },
  },
  retryBaseDelayMs: config.llmRetryBaseDelayMs,
  retryMaxDelayMs: config.llmRetryMaxDelayMs,
  retryJitterMs: config.llmRetryJitterMs,
  maxAttempts: config.llmMaxAttempts,
  circuitFailureThreshold: config.llmCircuitFailureThreshold,
  circuitCooldownMs: config.llmCircuitCooldownMs,
  cacheTtlMs: config.llmCacheTtlMs,
  enableThinking: config.llmEnableThinking,
});
const platformGatewayManager = createPlatformGatewayManager({
  gateways: { exploration: explorationGateway, intent: intentGateway },
  operationBudgets: { exploration: config.llmTimeoutMs * Math.max(1, config.llmMaxAttempts), intent: config.intentLlmTimeoutMs * Math.max(1, config.llmMaxAttempts) },
});
const effectiveLlmBaseUrl = config.llmBaseUrl || config.llmBackupBaseUrl;
const effectiveLlmModel = config.llmModel || config.llmBackupModel;
const explorationLlm = createExplorationLlm({
  baseUrl: effectiveLlmBaseUrl,
  apiKey: config.llmApiKey || config.llmBackupApiKey,
  model: effectiveLlmModel,
  timeoutMs: config.llmTimeoutMs,
  enableThinking: config.llmEnableThinking,
  transport: platformGatewayManager.transport('exploration'),
});
const intentLlm = createExplorationLlm({
  baseUrl: effectiveLlmBaseUrl,
  apiKey: config.llmApiKey || config.llmBackupApiKey,
  model: effectiveLlmModel,
  timeoutMs: config.intentLlmTimeoutMs,
  enableThinking: config.llmEnableThinking,
  transport: platformGatewayManager.transport('intent'),
});
config.viewProxyPort = validPort(
  'WYN_VIEW_PROXY_PORT',
  commandLineNumber('view-proxy-port') || process.env.WYN_VIEW_PROXY_PORT || config.port + 1,
);
if (config.viewProxyPort === config.port) {
  throw new Error('PORT and WYN_VIEW_PROXY_PORT must be different');
}

const configuredDataDir = resolveRuntimePath(process.env.WYN_AI_DATA_DIR, join(rootDir, 'data'));
const runtimeData = await resolveWritableDataDirectory(configuredDataDir, join(tmpdir(), `WynAI-runtime-data-${config.port}`));
const dataDir = runtimeData.path;
const dataInsightStore = new DataInsightStore({ maxItems: 30, persistence: new JsonRunStore(join(dataDir, 'data-insights'), { maxItems: 30 }) });
const platformMigrationMode = normalizeMigrationMode(process.env.PLATFORM_MIGRATION_MODE || 'platform');
function parseMigrationModuleModes(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* accept simple module=mode pairs below */ }
  return Object.fromEntries(String(value).split(',').map(item => item.split('=').map(part => part.trim())).filter(([module, mode]) => module && mode));
}
const platformMigrationRoutingPolicy = createMigrationRoutingPolicy({
  defaultMode: platformMigrationMode,
  moduleModes: parseMigrationModuleModes(process.env.PLATFORM_MIGRATION_MODULE_MODES),
  percentage: process.env.PLATFORM_MIGRATION_PERCENTAGE == null ? 100 : process.env.PLATFORM_MIGRATION_PERCENTAGE,
  users: process.env.PLATFORM_MIGRATION_USERS,
  organizations: process.env.PLATFORM_MIGRATION_ORGANIZATIONS,
  salt: process.env.PLATFORM_MIGRATION_SALT || 'wynai-platform-v1',
});
const dataInsightCompatibilityAdapter = createDataInsightCompatibilityAdapter({ mode: platformMigrationMode });
const platformMigrationRuntime = createPlatformMigrationRuntime({
  mode: platformMigrationMode,
  resolveMode: ({ module, context, input }) => platformMigrationRoutingPolicy.resolve({ module, identity: context || {}, context: input?.identity || {} }),
});
await dataInsightStore.init();
const insightGovernance = new InsightGovernanceService({
  auditPersistence: new JsonRunStore(join(dataDir, 'insight-audit'), { maxItems: 5000 }),
  maxGenerations: Number(process.env.WYN_AI_INSIGHT_GENERATION_LIMIT || 20),
  maxConcurrent: Number(process.env.WYN_AI_INSIGHT_MAX_CONCURRENT || 2),
  timeoutMs: config.llmTimeoutMs,
});
await insightGovernance.init();
const viewDefinitions = new Map();
const wynQueryInsightAdapter = new WynQueryInsightAdapter({
  register: input => {
    const result = dataInsightStore.register(input);
    void recordInsightDiagnostic(result.record.insightId, 'input.accepted', { input: result.record.input, created: result.created, adapter: 'wyn-query' }, { actor: result.record.actor, organizationId: result.record.organizationId, source: result.record.input.source || null });
    return result.record;
  },
  maxItems: 30,
});
const independentQueryInsightAdapter = new IndependentQueryInsightAdapter({
  register: input => {
    const result = dataInsightStore.register(normalizeIndependentQueryInsightContract(input));
    void recordInsightDiagnostic(result.record.insightId, 'input.accepted', { input: result.record.input, created: result.created, adapter: 'independent-query' }, { actor: result.record.actor, organizationId: result.record.organizationId, source: result.record.input.source || null });
    return result.record;
  },
});
const agentRuns = new Map();
const datasetMetadataCache = new Map();
let datasetDocumentCache = { expiresAt: 0, items: [] };
const MAX_AGENT_RUNS = 100;
const MAX_DATASET_ROWS = 20000;
const MAX_QUERY_ROWS = 20000;
const insightRunPersistence = new JsonRunStore(resolveRuntimePath(process.env.WYN_AI_INSIGHT_RUN_DIR, join(dataDir, 'insight-runs')), { maxItems: 200 });
const insightRunStore = new InsightRunStore({ persistence: insightRunPersistence, maxItems: 200 });
await insightRunStore.init();
const insightDiagnosticStore = new InsightDiagnosticStore({ persistence: new JsonRunStore(resolveRuntimePath(process.env.WYN_AI_INSIGHT_DIAGNOSTIC_DIR, join(dataDir, 'insight-diagnostics')), { maxItems: 5000 }), maxItems: 5000 });
await insightDiagnosticStore.init();
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

async function recordInsightDiagnostic(insightId, type, data = {}, context = {}) {
  if (!insightId) return null;
  try {
    return await insightDiagnosticStore.append(insightId, type, data, context);
  } catch (error) {
    console.error('Insight diagnostic event failed', error.message);
    return null;
  }
}

// A process restart must close every persisted non-terminal run before new
// traffic is accepted, so diagnostics never leave a started attempt hanging.
const recoveredInsightRuns = await insightRunStore.recoverUnfinished('process-restart');
for (const recovered of recoveredInsightRuns) {
  const diagnosticInsightId = recovered.insightId || recovered.metadata?.sourceInsightId || null;
  const context = { actor: recovered.actor, organizationId: recovered.organizationId, runId: recovered.id, source: recovered.metadata?.source || null };
  await recordInsightDiagnostic(diagnosticInsightId, 'run.interrupted', { run: recovered, reason: recovered.interruption?.reason || 'process-restart', attempt: recovered.attempt, attemptId: recovered.attemptId }, context);
  let existingDiagnostic = null;
  if (diagnosticInsightId) {
    try { existingDiagnostic = insightDiagnosticStore.get(diagnosticInsightId); } catch { existingDiagnostic = null; }
  }
  const startedAttempt = existingDiagnostic?.events?.some(event => event.type === 'generation.started' && (event.data?.attemptId === recovered.attemptId || event.data?.runId === recovered.id));
  if (recovered.mode === 'interpret' && startedAttempt) {
    await recordInsightDiagnostic(diagnosticInsightId, 'generation.interrupted', { status: 'interrupted', reason: 'process-restart', attempt: recovered.attempt, attemptId: recovered.attemptId }, context);
  }
}

function llmHealthStatusFor(gateway, snapshot = gateway?.snapshot?.() || {}) {
  if (!gateway?.enabled) return 'not_configured';
  if (snapshot.providers?.length && snapshot.providers.every(provider => provider.open)) return 'circuit_open';
  if (snapshot.lastCall?.status === 'failed') return 'unhealthy';
  if (snapshot.lastCall?.status === 'completed' || snapshot.lastCall?.status === 'cache-hit') return 'healthy';
  return 'not_checked';
}

const skillRegistry = await loadSkillsFromDirectory(join(rootDir, 'skills'));
for (const skill of skillRegistry.list()) {
  const usedMetricIds = new Set();
  skill.metrics = (skill.metrics || []).map((metric, index) => {
    const preferred = String(metric.id || '').trim();
    const safe = /^[a-z][a-z0-9_]{0,40}$/i.test(preferred) ? preferred : `metric_${index + 1}`;
    let id = safe;
    let suffix = 2;
    while (usedMetricIds.has(id)) id = `${safe}_${suffix++}`;
    usedMetricIds.add(id);
    return { ...metric, id };
  });
}
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
const smartQueryCompatibilityAdapter = createSmartQueryCompatibilityAdapter({ mode: platformMigrationMode });
const candidateSmartQueryOrchestrator = createCandidateSmartQueryOrchestrator({
  normalize: value => smartQueryCompatibilityAdapter.normalizeRequest(value).request,
});
const candidateInsightOrchestrator = createCandidateInsightOrchestrator({
  execute: ({ record, prompt, ...diagnosticContext }) => callConfiguredLlm(record, prompt, diagnosticContext),
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
    const llmSnapshot = explorationGateway.snapshot();
    const llmHealthStatus = llmHealthStatusFor(explorationGateway, llmSnapshot);
    sendJson(response, upstream.ok ? 200 : 502, {
      connected: upstream.ok,
      server: config.wynBaseUrl,
      listenHost: config.host,
      viewProxyPort: config.viewProxyPort,
      llmConfigured: explorationGateway.enabled,
      runtimeDataDir: dataDir,
      runtimeDataFallback: runtimeData.fallback,
      llmModel: effectiveLlmModel || 'Atlas 内置洞察引擎',
      llmProvider: explorationGateway.enabled ? 'llm-gateway' : 'local-fallback',
      platformMigrationMode,
      llmEndpointHost,
      llmHealthStatus,
      platformGateway: platformGatewayManager.snapshot(),
      llmGateway: { version: 'wynai.llm-gateway/v1', exploration: llmSnapshot, intent: intentGateway.snapshot(), policy: { requestTimeoutMs: config.llmTimeoutMs, intentRequestTimeoutMs: config.intentLlmTimeoutMs, connectTimeoutMs: config.llmConnectTimeoutMs, responseHeaderWarningMs: config.llmResponseHeaderWarningMs, responseHeaderTimeoutMs: config.llmResponseHeaderTimeoutMs || config.llmTimeoutMs, responseBodyTimeoutMs: config.llmResponseBodyTimeoutMs || config.llmTimeoutMs, operationTimeoutMs: { insightPlanner: config.llmPlannerTimeoutMs, insightCritic: config.llmCriticTimeoutMs, insightNarrator: config.llmNarratorTimeoutMs, insightNarratorRepair: config.llmNarratorRepairTimeoutMs, agentReport: config.llmAgentReportTimeoutMs }, maxAttempts: config.llmMaxAttempts, retryBaseDelayMs: config.llmRetryBaseDelayMs, retryMaxDelayMs: config.llmRetryMaxDelayMs, retryJitterMs: config.llmRetryJitterMs } },
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
  if (!explorationGateway.enabled) return null;
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
  let lastError;
  const validationErrors = [];
  const outputPreviews = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const report = await explorationGateway.completeJson(messages, { operation: 'agent-report', maxOutputTokens: 4096 });
        const content = JSON.stringify(report);
        outputPreviews.push(content.slice(0, 4000));
        const structured = validateStructuredReport(prepareStructuredReport(report, analysis), analysis);
        return { structured, markdown: structuredReportMarkdown(structured), attempts: attempt + 1 };
      } catch (error) {
        lastError = error;
        validationErrors.push(error.message);
        if (attempt < 2) {
          const content = outputPreviews.at(-1) || '{}';
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
}

function handlePlatformMigrationStatus(response) {
  const gateway = platformGatewayManager.snapshot();
  const llmSnapshot = explorationGateway.snapshot();
  const llmHealthStatus = llmHealthStatusFor(explorationGateway, llmSnapshot);
  sendJson(response, 200, {
    schema: 'wynai.platform-migration-status/v1',
    version: 1,
    mode: platformMigrationMode,
    rollbackMode: 'legacy',
    adapters: {
      dataInsight: { schema: dataInsightCompatibilityAdapter.schema, version: dataInsightCompatibilityAdapter.version, mode: dataInsightCompatibilityAdapter.mode },
      smartQuery: { schema: smartQueryCompatibilityAdapter.schema, version: smartQueryCompatibilityAdapter.version, mode: smartQueryCompatibilityAdapter.mode },
    },
    runtime: { schema: platformMigrationRuntime.schema, version: 1, mode: platformMigrationRuntime.mode, dynamicRouting: platformMigrationRuntime.dynamicRouting === true, shadowResultVisible: false },
    routing: platformMigrationRoutingPolicy.snapshot(),
    gateway,
    llm: { status: llmHealthStatus, configured: explorationGateway.enabled, endpointHost: llmEndpointHost },
    policy: {
      rollbackSupported: true,
      runtimeModeChange: false,
      requestRouting: true,
      note: '默认模式由 PLATFORM_MIGRATION_MODE 配置；可用模块、主体和比例规则进行请求级灰度，故障时重启为 legacy 回滚。',
    },
  });
}

async function handleLlmHealth(response) {
  if (!explorationGateway.enabled) {
    sendJson(response, 503, { ok: false, status: 'not_configured', code: 'INSIGHT_LLM_REQUIRED', gateway: explorationGateway.snapshot() });
    return;
  }
  try {
    const result = await explorationGateway.probe();
    const ok = result.ok === true;
    sendJson(response, ok ? 200 : 503, { ok, status: ok ? 'healthy' : 'unhealthy', code: ok ? null : 'LLM_PROBE_CONTRACT_FAILED', model: result.model, latencyMs: result.latencyMs, gateway: explorationGateway.snapshot() });
  } catch (error) {
    sendJson(response, 503, { ok: false, status: error.code === 'LLM_CIRCUIT_OPEN' ? 'circuit_open' : 'unhealthy', code: error.code || 'LLM_REQUEST_FAILED', message: error.message, error: serializeError(error), gateway: explorationGateway.snapshot() });
  }
}

async function handleLlmDiagnostics(response) {
  if (!explorationGateway.enabled) {
    sendJson(response, 503, { ok: false, status: 'not_configured', code: 'INSIGHT_LLM_REQUIRED', providers: [] });
    return;
  }
  try {
    const providers = await explorationGateway.diagnose();
    const ok = providers.some(item => item.network?.tcp?.ok);
    sendJson(response, ok ? 200 : 503, { ok, status: ok ? 'network-reachable' : 'network-unreachable', providers });
  } catch (error) {
    sendJson(response, 503, { ok: false, status: 'diagnostic-failed', code: error.code || 'LLM_DIAGNOSTIC_FAILED', message: error.message, error: serializeError(error) });
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
      llmModel: effectiveLlmModel || null,
    };
    queryWarnings.forEach(message => appendReportWarning(analysis, message));
    try {
      const aiReport = await callAgentReportLlm(analysis, metadata);
      if (!aiReport?.markdown) throw new Error('严格分析未生成 AI 报告');
      analysis.report.aiNarrative = aiReport?.markdown || null;
      analysis.report.aiStructured = aiReport?.structured || null;
      analysis.report.model = analysis.report.aiNarrative ? effectiveLlmModel : 'Atlas 确定性分析引擎';
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
      analysis.report.model = analysis.report.aiNarrative ? effectiveLlmModel : 'Atlas V2.1 确定性降级引擎';
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
  const conversationInput = conversations.get(conversationId);
  const interactionInput = { ...body, dataset: body.dataset || conversationInput?.dataset || null, conversationId };
  let migrationRun;
  try {
    migrationRun = await platformMigrationRuntime.run({
      module: 'smart-query-request',
      input: interactionInput,
      context: identity,
      legacy: value => normalizeAIInteractionRequest(value),
      candidate: value => candidateSmartQueryOrchestrator.run(value),
      snapshot: value => {
        const request = value?.request || value;
        return {
          numericResults: [],
          filters: request.context?.activeFilters || [],
          permissions: { dataset: request.dataset || null, conversationId: request.conversationId || null },
          evidenceRelations: [],
          terminalStatus: 'accepted',
          skillSemantics: request.skills || [],
          userVisibleAnswer: null,
        };
      },
    });
  } catch (error) {
    return sendJson(response, error.status || 400, { code: error.code || 'SMART_QUERY_CONTRACT_INVALID', message: error.message, details: error.details || [] });
  }
  const controller = new AbortController();
  const traceId = createTraceId();
  operationalEventLog.record({ traceId, conversationId, datasetId: conversationInput?.dataset?.id, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, event: 'request.accepted', phase: 'transport', details: { method: request.method, path: request.url } });

  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error('客户端已取消智能问数请求'));
  };
  request.once('aborted', abort);
  response.once('close', abort);
  let result;
  try {
    const askInput = ['canary', 'platform'].includes(migrationRun.mode) ? (migrationRun.result?.request || migrationRun.result) : body;
    result = await conversations.ask(conversationId, { ...askInput, signal: controller.signal, traceId });
  } catch (error) {
    if (controller.signal.aborted || error?.code === 'REQUEST_ABORTED') {
      operationalEventLog.record({ traceId, conversationId, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, event: 'request.cancelled', phase: 'transport', outcome: 'cancelled', durationMs: Date.now() - startedAt });
      requestAudit.record({ method: request.method, path: request.url, status: 499, durationMs: Date.now() - startedAt, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, requestId: traceId, plannerMode: 'cancelled', planningDurationMs: Date.now() - startedAt });
      if (!response.destroyed && !response.writableEnded) sendJson(response, 499, { message: '本轮智能问数已取消' });
      return;
    }
    operationalEventLog.record({
      traceId,
      conversationId,
      actor: identity.actor,
      organizationId: identity.organizationId,
      userId: identity.userId,
      event: 'request.failed',
      phase: 'transport',
      outcome: 'failed',
      durationMs: Date.now() - startedAt,
      details: {
        ...buildQualityDetails({}, error),
        code: error?.code || null,
        status: error?.status || 500,
        message: error?.message || '智能问数请求失败',
        attempts: error?.attempts || [],
      },
    });
    error.traceId = traceId;
    throw error;
  } finally {
    request.removeListener('aborted', abort);
    response.removeListener('close', abort);
  }
  const planning = result.response?.planningDiagnostics || {};
  result.response = {
    ...(result.response || {}),
    trace: {
      traceId,
      ...(result.response?.trace || {}),
      platformMigration: { schema: migrationRun.schema, version: 1, mode: migrationRun.mode, routing: migrationRun.routing || null, comparison: migrationRun.comparison, fallback: migrationRun.fallback, candidateMetadata: migrationRun.candidateMetadata || null },
    },
  };
  const turnId = result.response.trace?.turnId;
  if (result.response.status === 'ok' && turnId && result.response.resultSets?.some(item => item?.rows?.length)) {
    try {
      const insight = independentQueryInsightAdapter.registerTurn({
        conversationId,
        turnId,
        traceId,
        question: body.question,
        conversation: result.conversation,
        response: result.response,
      });
      if (insight) {
        const detail = dataInsightStore.get(insight.insightId);
        const existingInsightRuns = insightRunStore.list({ mode: 'interpret', insightId: insight.insightId });
        const datasetIds = (detail?.input?.datasets || []).map(item => item.id);
        const resolvedSkills = datasetIds.flatMap(datasetId => skillRegistry.resolve({ datasetId, question: detail?.input?.title || body.question }).map(skill => ({ id: skill.id, version: skill.version, diagnostics: skill.diagnostics || [] })));
        const insightRun = existingInsightRuns[0] || await insightRunStore.create({ mode: 'interpret', insightId: insight.insightId, datasetIds, question: detail?.input?.title || body.question, actor: identity.actor, organizationId: identity.organizationId, skill: { refs: resolvedSkills.map(skill => `${skill.id}@${skill.version}`), diagnostics: resolvedSkills.flatMap(skill => skill.diagnostics) }, metadata: { source: detail?.input?.source || null, conversationId, turnId, traceId } });
        await recordInsightDiagnostic(insight.insightId, 'run.created', { run: { id: insightRun.id, mode: insightRun.mode, status: insightRun.status, datasetIds: insightRun.datasetIds, question: insightRun.question, skill: insightRun.skill, metadata: insightRun.metadata, createdAt: insightRun.createdAt } }, { actor: identity.actor, organizationId: identity.organizationId, runId: insightRun.id, source: detail?.input?.source || null });
        result.response.dataInsight = {
          schema: 'wynai.data-insight-reference/v1',
          insightId: insight.insightId,
          inputSchema: insight.input.schema,
        };
      }
    } catch (error) {
      console.error('独立问数结果注册数据洞察失败', error);
    }
  }
  operationalEventLog.record({ traceId, conversationId, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, event: 'platform.migration.run', phase: 'migration', outcome: migrationRun.comparison ? (migrationRun.comparison.passed ? 'matched' : 'blocked') : (migrationRun.fallback ? 'fallback' : 'selected'), details: { module: migrationRun.module, mode: migrationRun.mode, routing: migrationRun.routing || null, comparison: migrationRun.comparison, fallback: migrationRun.fallback, candidateMetadata: migrationRun.candidateMetadata || null, schema: migrationRun.schema } });
  operationalEventLog.record({ traceId, conversationId, datasetId: conversationInput?.dataset?.id, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, event: 'request.completed', phase: 'transport', outcome: result.response.status || 'ok', durationMs: Date.now() - startedAt, details: { ...buildQualityDetails(result.response), plannerMode: planning.route, risk: planning.riskAssessment } });
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
  const reasonLabels = { not_answered: '没有回答我的问题', wrong_metric: '指标或维度不对', wrong_time_filter: '时间范围或筛选条件不对', wrong_sort: '排序或排名不对', wrong_calculation: '计算方式或汇总结果不对', incomplete_data: '数据不完整或与预期不符', wrong_format: '单位或格式不对', unclear_display: '图表或表格展示不清楚', other: '其他' };
  const reasonSummary = Array.isArray(body.reasons) ? body.reasons.map(reason => reasonLabels[reason] || '').filter(Boolean).join('、') : '';
  const feedbackInput = { ...body, category: body.category === 'wrong_answer' ? (Array.isArray(body.reasons) && body.reasons.includes('wrong_calculation') ? 'wrong_metric' : 'wrong_understanding') : body.category, correction: [reasonSummary ? `反馈原因：${reasonSummary}` : '', body.comment || body.correction || ''].filter(Boolean).join('；') };
  const result = await feedbackLearning.submit(feedbackInput, {
    conversationId, turnId: turnId || assistant?.turnId, traceId: body.traceId || assistant?.traceId, datasetId: conversation.dataset.id,
    organizationId: identity.organizationId, userId: identity.userId, question: user?.content || '', answer: assistant?.content || '',
    semanticSnapshot: { intent: conversation.activeBusinessIntent, queryRequest: conversation.activeQueryRequest, skillRefs: conversation.loadedSkillRefs || [] },
  });
  operationalEventLog.record({ traceId: result.feedback.traceId || createTraceId(), conversationId, turnId: result.feedback.turnId, datasetId: conversation.dataset.id, actor: identity.actor, organizationId: identity.organizationId, userId: identity.userId, event: 'feedback.received', phase: 'learning', outcome: result.feedback.category, details: { feedbackId: result.feedback.id, candidateId: result.candidate.id, reasons: result.feedback.reasons, comment: result.feedback.comment, correction: result.feedback.correction } });
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
    actor: detail.actor || null,
    organizationId: detail.organizationId || null,
    datasets: detail.input.datasets || [],
    resultSetCount: detail.input.resultSets.length,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    document: detail.document || null,
    versions: detail.versions || [],
    ...summary,
  };
}

function handleQueryQuality(request, response) {
  if (!requireSkillAdmin(request, response)) return;
  const params = new URL(request.url, 'http://localhost').searchParams;
  const items = operationalEventLog.list({ limit: 10000 });
  response.setHeader('Cache-Control', 'no-store');
  const report = summarizeQueryQuality(items, Object.fromEntries(params));
  if (params.get('traceId')) {
    const record = report.records.find(item => item.traceId === params.get('traceId'));
    return sendJson(response, record ? 200 : 404, record || { message: '记录不存在或已超过保留范围' });
  }
  const page = Math.max(1, Number(params.get('page')) || 1);
  if (params.get('format') === 'json') {
    response.setHeader('Content-Disposition', 'attachment; filename="query-quality-report.json"');
    return sendJson(response, 200, report);
  }
  return sendJson(response, 200, { ...report, page, pageSize: 50, records: report.records.slice((page - 1) * 50, page * 50).map(({ events, ...record }) => record) });
}

function handleDataInsights(pathname, requestUrl, request, response) {
  const insightId = pathname.slice('/api/data-insights/'.length);
  if (!insightId) {
    const items = dataInsightStore.list({ sourceType: requestUrl.searchParams.get('sourceType'), sourceId: requestUrl.searchParams.get('sourceId') });
    const llmSnapshot = explorationGateway.snapshot();
    const llmHealthStatus = llmHealthStatusFor(explorationGateway, llmSnapshot);
    sendJson(response, 200, { items, total: items.length, llmConfigured: explorationGateway.enabled, llmHealthStatus, llmProvider: explorationGateway.enabled ? 'llm-gateway' : 'local-fallback', llmModel: effectiveLlmModel || null, llmEndpointHost, platformMigrationMode, platformGateway: platformGatewayManager.snapshot(), llmGateway: llmSnapshot });
    return;
  }
  const detail = dataInsightStore.get(insightId);
  if (!detail) return sendJson(response, 404, { message: '数据洞察结果不存在或已过期' });
  const identity = requestIdentity(request);
  if (detail.actor && detail.actor !== 'anonymous' && detail.actor !== identity.actor && (!detail.organizationId || detail.organizationId !== identity.organizationId)) {
    return sendJson(response, 403, { code: 'DATA_INSIGHT_FORBIDDEN', message: '无权访问该数据洞察' });
  }
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
    const identity = requestIdentity(request);
    const idempotencyKey = request.headers['idempotency-key'] || null;
    const migrationRun = await platformMigrationRuntime.run({
      module: 'data-insight-input',
      input: body,
      context: identity,
      legacy: value => normalizeInsightInput(value),
      candidate: value => dataInsightCompatibilityAdapter.adapt(value).input,
      snapshot: value => dataInsightCompatibilityAdapter.snapshot({ input: value, status: 'accepted' }),
    });
    const adaptedInput = migrationRun.result;
    const result = dataInsightStore.register(adaptedInput, { idempotencyKey, actor: identity.actor, organizationId: identity.organizationId });
    const existingRuns = insightRunStore.list({ mode: 'interpret', insightId: result.record.insightId });
    const datasetIds = (result.record.input.datasets || []).map(item => item.id);
    const skillQuestion = [result.record.input.title, result.record.input.context?.question, result.record.input.context?.query?.name].filter(Boolean).join(' ');
    const resolvedSkills = datasetIds.flatMap(datasetId => skillRegistry.resolve({ datasetId, question: skillQuestion }).map(skill => ({ id: skill.id, version: skill.version, diagnostics: skill.diagnostics || [] })));
    const run = existingRuns[0] || await insightRunStore.create({ mode: 'interpret', insightId: result.record.insightId, datasetIds, question: result.record.input.title, actor: identity.actor, organizationId: identity.organizationId, skill: { refs: resolvedSkills.map(skill => `${skill.id}@${skill.version}`), diagnostics: resolvedSkills.flatMap(skill => skill.diagnostics) }, metadata: { source: result.record.input.source || null } });
    const diagnosticContext = { actor: identity.actor, organizationId: identity.organizationId, runId: run.id, source: result.record.input.source || null };
    await recordInsightDiagnostic(result.record.insightId, 'input.accepted', { input: result.record.input, created: result.created, idempotencyKey: idempotencyKey || null }, diagnosticContext);
    await recordInsightDiagnostic(result.record.insightId, 'platform.migration.run', { module: migrationRun.module, mode: migrationRun.mode, routing: migrationRun.routing || null, comparison: migrationRun.comparison, fallback: migrationRun.fallback, schema: migrationRun.schema }, diagnosticContext);
    await recordInsightDiagnostic(result.record.insightId, 'run.created', { run: { id: run.id, mode: run.mode, status: run.status, datasetIds: run.datasetIds, question: run.question, skill: run.skill, metadata: run.metadata, createdAt: run.createdAt } }, diagnosticContext);
    sendJson(response, result.created ? 201 : 200, { schema: 'wynai.insight-input-ack/v1', insightId: result.record.insightId, runId: run.id, status: result.created ? 'accepted' : 'updated' });
  } catch (error) {
    if (error?.name === 'InsightInputError') return sendJson(response, error.status || 422, { code: error.code, path: error.path, message: error.message });
    throw error;
  }
}

async function executeExploreInsightRun(run) {
  if (!run || run.mode !== 'explore') throw new Error('仅 explore 运行支持自动执行');
  if (!explorationGateway.enabled) {
    const error = new Error('Explore 运行必须配置外部 LLM');
    error.code = 'INSIGHT_LLM_REQUIRED';
    error.status = 503;
    throw error;
  }
  const diagnosticInsightId = run.insightId || run.metadata?.sourceInsightId || null;
  const diagnosticContext = { actor: run.actor, organizationId: run.organizationId, runId: run.id, source: run.metadata?.source || null };
  await recordInsightDiagnostic(diagnosticInsightId, 'generation.started', { runId: run.id, attempt: run.attempt || 1, attemptId: run.attemptId || null, mode: run.mode, question: run.question }, diagnosticContext);
  await insightRunStore.transition(run.id, 'planning');
  await recordInsightDiagnostic(diagnosticInsightId, 'run.transition', { runId: run.id, mode: run.mode, status: 'planning' }, diagnosticContext);
  await insightRunStore.transition(run.id, 'running');
  await recordInsightDiagnostic(diagnosticInsightId, 'run.transition', { runId: run.id, mode: run.mode, status: 'running' }, diagnosticContext);
  const datasetId = run.datasetIds[0];
  try {
    const metadata = await loadDatasetMetadata(datasetId);
    const skills = skillRegistry.resolve({ datasetId, question: run.question });
    const inherited = run.metadata?.inheritedScope || {};
    const inheritedRange = inherited.scope?.timeRange;
    const inheritedFilters = Array.isArray(inherited.context?.filters) ? inherited.context.filters : [];
    const timeField = metadata.fields?.find(field => field.role === 'time' || field.type === 'date' || field.type === 'datetime')?.name || null;
    const rangeFilters = inheritedRange && timeField ? [
      ...(inheritedRange.start ? [{ field: timeField, operator: 'gte', value: String(inheritedRange.start).length === 7 ? `${inheritedRange.start}-01` : inheritedRange.start, fieldType: 'time' }] : []),
      ...(inheritedRange.end ? [{ field: timeField, operator: 'lt', value: String(inheritedRange.end).length === 7 ? `${inheritedRange.end}-01` : inheritedRange.end, fieldType: 'time' }] : []),
    ] : [];
    const result = await runAutonomousAnalysis({
      metadata,
      focus: run.question,
      constraints: run.metadata?.constraints || { filters: [...inheritedFilters, ...rangeFilters] },
      executeDatasetQuery,
      analyzeDataset,
      explorationAgent: explorationLlm,
      skills,
      strictMode: true,
    });
    const report = await callAgentReportLlm(result.analysis, metadata);
    if (!report?.markdown) throw Object.assign(new Error('Explore 未生成 LLM 报告'), { code: 'INSIGHT_LLM_INVALID_OUTPUT', status: 502 });
    result.analysis.report.aiNarrative = report.markdown;
    result.analysis.report.aiStructured = report.structured;
    result.analysis.report.model = explorationGateway.model;
    const document = composeInsightDocument({ result, question: run.question });
    const completed = await insightRunStore.complete(run.id, {
      plan: result.analysis.plan,
      toolCalls: result.queries.map(item => ({ id: item.request?.id, hypothesisId: item.request?.hypothesisId || null, status: item.status, mode: item.request?.mode || null, adapter: item.executionPlan?.adapter || null })),
      evidenceIds: result.analysis.evidence.map(item => item.id),
      document,
      metadata: { ...(run.metadata || {}), analysis: result.analysis, resultSets: result.resultSets, audit: result.audit, provider: 'llm-orchestrated', model: explorationGateway.model, gateway: explorationGateway.snapshot() },
    });
    await recordInsightDiagnostic(diagnosticInsightId, 'explore.completed', { run: completed, analysis: result.analysis }, diagnosticContext);
    await recordInsightDiagnostic(diagnosticInsightId, 'generation.finished', { status: 'completed', runId: run.id, attempt: completed.attempt || 1, attemptId: completed.attemptId || null, provider: 'llm-orchestrated', model: explorationGateway.model, gateway: explorationGateway.snapshot() }, diagnosticContext);
    insightGovernance.record({ actor: run.actor, organizationId: run.organizationId, insightId: null, runId: run.id, action: 'insight.explore', status: 'completed', model: explorationGateway.model, prompt: run.question, toolCalls: completed.toolCalls, skillRefs: skills.map(skill => `${skill.id}@${skill.version}`), externalDataPolicy: { rawRowsToLlm: false }, gateway: explorationGateway.snapshot() });
    return completed;
  } catch (error) {
    await insightRunStore.fail(run.id, error);
    await recordInsightDiagnostic(diagnosticInsightId, 'run.failed', { runId: run.id, error: { code: error.code || 'INSIGHT_EXPLORE_FAILED', message: error.message, stack: error.stack || null } }, diagnosticContext);
    await recordInsightDiagnostic(diagnosticInsightId, 'generation.finished', { status: 'failed', runId: run.id, attempt: run.attempt || 1, attemptId: run.attemptId || null, error: { code: error.code || 'INSIGHT_EXPLORE_FAILED', message: error.message }, gateway: explorationGateway.snapshot() }, diagnosticContext);
    insightGovernance.record({ actor: run.actor, organizationId: run.organizationId, runId: run.id, action: 'insight.explore', status: 'failed', model: explorationGateway.model, prompt: run.question, errorCode: error.code || 'INSIGHT_EXPLORE_FAILED', externalDataPolicy: { rawRowsToLlm: false }, gateway: explorationGateway.snapshot() });
    throw error;
  }
}

async function handleInsightRunCreate(request, response) {
  const body = await readJson(request);
  try {
    const identity = requestIdentity(request);
    const mode = body.mode || 'explore';
    const run = await insightRunStore.create({ mode, insightId: body.insightId || null, datasetIds: body.datasetIds || (body.datasetId ? [body.datasetId] : []), question: body.question || body.focus || '', actor: identity.actor, organizationId: identity.organizationId, skill: body.skill || null, metadata: { ...(body.metadata || {}), constraints: body.constraints || { filters: body.filters || [] } } });
    if (mode === 'explore' && body.execute !== false) {
      try { return sendJson(response, 201, await executeExploreInsightRun(run)); }
      catch (error) { return sendJson(response, error.status || 502, { ...insightRunStore.get(run.id), code: error.code || 'INSIGHT_EXPLORE_FAILED', message: error.message }); }
    }
    sendJson(response, 201, run);
  } catch (error) {
    sendJson(response, 422, { code: 'INVALID_INSIGHT_RUN', message: error.message });
  }
}

async function handleInsightRuns(pathname, request, response) {
  const match = pathname.match(/^\/api\/data-insight-runs\/([A-Za-z0-9-]{8,100})(\/retry)?$/);
  if (!match) {
    const url = new URL(request.url, 'http://localhost');
    const identity = requestIdentity(request);
    const items = insightRunStore.list({ mode: url.searchParams.get('mode'), status: url.searchParams.get('status'), insightId: url.searchParams.get('insightId') }).filter(run => run.actor === 'anonymous' || run.actor === identity.actor || (run.organizationId && run.organizationId === identity.organizationId));
    return sendJson(response, 200, { schema: 'wynai.insight-run-list/v1', items });
  }
  const id = match[1];
  const run = insightRunStore.get(id);
  if (!run) return sendJson(response, 404, { message: '洞察运行不存在' });
  const identity = requestIdentity(request);
  if (run.actor !== 'anonymous' && run.actor !== identity.actor && (!run.organizationId || run.organizationId !== identity.organizationId)) return sendJson(response, 403, { code: 'INSIGHT_RUN_FORBIDDEN', message: '无权访问该洞察运行' });
  if (request.method === 'POST' && match[2] === '/retry') {
    try {
      const retried = await insightRunStore.retry(id);
      if (retried.mode === 'explore') return sendJson(response, 200, await executeExploreInsightRun(retried));
      return sendJson(response, 200, retried);
    }
    catch (error) { return sendJson(response, 422, { code: 'INSIGHT_RUN_RETRY_FAILED', message: error.message }); }
  }
  return sendJson(response, 200, run);
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

function buildLocalInsight(record, prompt, factPack = null) {
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
    content: `## 核心结论\n\n本次数据洞察基于 Wyn 返回的 **${summary.rowCount} 行、${summary.columnCount} 列**结构化结果集。${qualityText}\n\n## 指标扫描\n\n${numericText}\n\n## 针对分析目标\n\n${prompt || '请从业务趋势、异常和风险角度解读当前结果。'}\n\n- 将关键结论与原始字段逐项核验，避免把空值或格式化文本当作真实数值。\n- 对时间、地区、产品等维度继续下钻，比较环比、同比和贡献度。\n- 对异常点回查明细记录与筛选条件，再形成可执行的业务动作。\n\n## 建议动作\n\n1. 优先处理完整度低于 80% 的字段。\n2. 将有效指标按核心维度分组，并保留 Top/Bottom 贡献项。\n3. 由业务负责人确认指标口径后，再生成面向管理层的智能报告。`,
  };
}

async function callConfiguredLlm(record, prompt, diagnosticContext = {}) {
  const sensitiveFields = Array.isArray(record.input.context?.sensitiveFields) ? record.input.context.sensitiveFields : [];
  const redacted = redactInsightInput(record.input, sensitiveFields);
  const modelCapability = normalizeModelCapability({ provider: llmEndpointHost, model: effectiveLlmModel, contextWindowTokens: config.llmContextWindowTokens, maxInputTokens: config.llmMaxInputTokens, maxOutputTokens: config.llmMaxOutputTokens, safetyReserveTokens: config.llmSafetyReserveTokens, protocolOverheadTokens: config.llmProtocolOverheadTokens, source: 'server-env' });
  const modelBudget = resolveModelBudget(modelCapability);
  const evidencePack = buildEvidencePack(redacted.input, { maxTokens: modelBudget.inputBudgetTokens });
  const evidenceTransport = validatePlatformEvidenceTransport(evidencePack);
  const resolvedSkills = resolveInsightSkillsForRecord(record, prompt);
  const businessFacts = buildBusinessFactPack({ input: redacted.input, evidencePack, skills: resolvedSkills });
  const enrichedEvidencePack = { ...evidencePack, businessFacts };
  const skillsForLlm = resolvedSkills.map(skill => ({
    id: skill.id,
    version: skill.version,
    name: skill.name,
    diagnostics: skill.diagnostics || [],
    requiredEvidence: skill.requiredEvidence || [],
    requiredFacts: skill.requiredFacts || [],
    insightMethods: skill.insightMethods || [],
    coreMethods: skill.coreMethods || [],
    optionalMethods: skill.optionalMethods || [],
    extendedMethods: skill.extendedMethods || [],
    requiredFields: skill.requiredFields || [],
    evidenceRequirements: skill.evidenceRequirements || {},
    rowLevelMethods: skill.rowLevelMethods || [],
    methodPolicies: skill.methodPolicies || {},
    blockingRules: skill.blockingRules || [],
    partialCompletionRules: skill.partialCompletionRules || [],
    metricDefinitions: skill.metricDefinitions || skill.metrics || [],
    businessSemantics: skill.businessSemantics || [],
    fallbackNarrative: skill.fallbackNarrative || [],
    qualityThresholds: skill.qualityThresholds || {},
    riskRules: skill.riskRules || [],
    playbook: skill.playbook || [],
    assumptions: skill.assumptions || [],
  }));
  const skillPlan = compileSkillPlan({
    skills: skillsForLlm,
    schema: redacted.input.resultSets?.flatMap(resultSet => resultSet.schema || []) || [],
    question: prompt || record.input.title,
  });
  const capabilityCoverage = assessCapabilityCoverage({
    question: prompt || record.input.title,
    schema: redacted.input.resultSets?.flatMap(resultSet => resultSet.schema || []) || [],
  });
  const effectiveSkillPlan = { ...skillPlan, capabilityCoverage, transportPolicy: { ...skillPlan.transportPolicy, mode: config.insightTransportMode } };
  enrichedEvidencePack.capabilityCoverage = capabilityCoverage;
  const platformContext = compilePlatformContextManifest({ question: prompt || record.input.title, input: redacted.input, skills: resolvedSkills, skillPlan: effectiveSkillPlan, evidencePack: enrichedEvidencePack, permissions: { actor: diagnosticContext.actor || null, organizationId: diagnosticContext.organizationId || null, scope: redacted.input.scope || null } });
  await recordInsightDiagnostic(record.insightId, 'evidence.pack.created', { evidencePack: enrichedEvidencePack, evidenceTransport, platformContext, redactionPolicy: redacted.policy, skills: resolvedSkills, skillPlan: effectiveSkillPlan, modelCapability, modelBudget }, diagnosticContext);
  const orchestration = await runInsightLlmOrchestration({
    llm: explorationLlm,
    prompt: prompt || record.input.title,
    input: enrichedEvidencePack,
    skills: skillsForLlm,
    skillPlan: effectiveSkillPlan,
    signal: diagnosticContext.signal || null,
    onStageEvent: event => recordInsightDiagnostic(record.insightId, `llm.stage.${event.stage}`, { ...event, attempt: diagnosticContext.attempt || null, attemptId: diagnosticContext.attemptId || null }, diagnosticContext),
    onGatewayEvent: event => recordInsightDiagnostic(record.insightId, event.type || 'gateway.attempt', { ...event, attempt: diagnosticContext.attempt || null, attemptId: diagnosticContext.attemptId || null }, diagnosticContext),
  });
  await recordInsightDiagnostic(record.insightId, 'orchestration.completed', { orchestration }, diagnosticContext);
  if (!['completed', 'completed-partial'].includes(orchestration.status)) {
    const error = new Error('LLM 洞察结果未通过完整证据校验，不生成降级洞察');
    error.code = 'INSIGHT_CLAIM_VALIDATION_FAILED';
    error.status = 422;
    error.diagnostics = orchestration.diagnostics || null;
    throw error;
  }
  return {
    provider: 'llm-orchestrated',
    model: orchestration.model || effectiveLlmModel,
    status: orchestration.status || 'completed',
    diagnostics: orchestration.diagnostics || null,
    findings: orchestration.narrative.keyFindings,
    content: orchestration.markdown,
    structured: orchestration.narrative,
    orchestration: {
      schema: orchestration.schema,
      planner: orchestration.planner,
      critic: orchestration.critic,
      evidence: orchestration.evidence,
      skillPlan: orchestration.skillPlan || null,
      stageAudit: orchestration.stageAudit || [],
      externalDataPolicy: { ...redacted.policy, sampleStrategy: evidencePack.policy.sampleStrategy, rawRowsToLlm: false },
      businessFacts,
      capabilityCoverage,
      gateway: explorationGateway.snapshot(),
    },
  };
}

async function loadInsightSkillProfiles(directory = join(rootDir, 'config', 'insight-skills')) {
  const profiles = {};
  let entries = [];
  try { entries = await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const profile = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
      if (profile?.id) profiles[profile.id] = profile;
    } catch (error) { console.warn(`Insight Skill profile ignored: ${entry.name}`, error.message); }
  }
  return Object.freeze(profiles);
}

const INSIGHT_SKILL_PROFILES = await loadInsightSkillProfiles();

function resolveInsightSkillsForRecord(record, prompt = '') {
  const datasetIds = (record?.input?.datasets || []).map(item => item.id).filter(Boolean);
  const question = [record?.input?.title, record?.input?.context?.question, record?.input?.context?.query?.name, prompt].filter(Boolean).join(' ');
  const resolved = datasetIds.flatMap(datasetId => skillRegistry.resolve({ datasetId, question }));
  const scoped = resolved.length ? resolved : datasetIds.flatMap(datasetId => skillRegistry.list().filter(skill => skill.status === 'approved' && (skill.scope === 'system' || (skill.scope === 'dataset' && skill.datasetIds.includes(datasetId)))));
  return scoped.map(skill => ({ ...skill, ...(INSIGHT_SKILL_PROFILES[skill.id] || {}) }));
}

function factPackNarrative(factPack) {
  const lines = [];
  for (const item of factPack?.facts || []) {
    if (item.id.endsWith('-total')) lines.push(`- ${item.title}：${formatNumber(item.value?.value)}（${item.value?.aggregation || 'sum'}）`);
    if (item.id === 'average-order-value') lines.push(`- ${item.title}：${formatNumber(item.value?.value)}（${item.value?.formula}）`);
    if (item.id === 'concentration' && Number.isFinite(item.value?.share)) lines.push(`- ${item.title}：头部 ${item.value.topN} 项贡献约 ${formatNumber(item.value.share * 100)}%`);
  }
  for (const item of (factPack?.facts || []).filter(item => item.id.endsWith('-total') || item.id === 'average-order-value').slice(0, 4)) {
    findings.push({ tone: 'green', label: item.title, value: formatNumber(item.value?.value), detail: `确定性计算：${item.method}。证据 ${item.evidenceIds.join('、') || '待补充'}。` });
  }

  for (const item of (factPack?.facts || []).filter(item => item.id.endsWith('-total') || item.id === 'average-order-value').slice(0, 4)) {
    findings.push({ tone: 'green', label: item.title, value: formatNumber(item.value?.value), detail: `确定性计算：${item.method}。证据 ${item.evidenceIds.join('、') || '待补充'}。` });
  }
  if (factPack?.quality) lines.push(`- 数据质量：${factPack.quality.rowCount} 行，完整度 ${factPack.quality.completeness}%`);
  return lines.length ? lines.join('\n') : '- 当前没有可核验的业务事实。';
}

function deterministicInsightDocument(record, prompt, reasonCode, reasonMessage) {
  const error = new Error('数据洞察失败时禁止生成确定性降级结果');
  error.code = reasonCode || 'INSIGHT_GENERATION_FAILED';
  error.causeMessage = reasonMessage || null;
  throw error;
}

function isRecoverableInsightError(error) {
  return ['INSIGHT_LLM_REQUIRED', 'LLM_UPSTREAM_ERROR', 'LLM_TIMEOUT', 'LLM_CONNECT_TIMEOUT', 'LLM_RESPONSE_HEADER_TIMEOUT', 'LLM_RESPONSE_BODY_TIMEOUT', 'LLM_RATE_LIMITED', 'LLM_EMPTY_RESPONSE', 'LLM_CIRCUIT_OPEN', 'LLM_CONTEXT_LIMIT', 'NARRATOR_SCHEMA_INVALID', 'INSIGHT_LLM_INVALID_OUTPUT', 'INSIGHT_CLAIM_VALIDATION_FAILED', 'EVIDENCE_INSUFFICIENT', 'NARRATOR_UNSUPPORTED_CLAIM'].includes(error?.code);
}

async function handleSecondaryInsight(request, response, providedBody = null) {
  const body = providedBody || await readJson(request);
  const insightId = String(body.insightId || '').trim();
  const prompt = String(body.prompt || '').trim().slice(0, 4000);
  const detail = dataInsightStore.get(insightId);
  if (!detail) return sendJson(response, 404, { message: '数据洞察结果不存在或已过期，请重新提交标准结果。' });
  const identity = requestIdentity(request);
  if (detail.actor && detail.actor !== 'anonymous' && detail.actor !== identity.actor && (!detail.organizationId || detail.organizationId !== identity.organizationId)) {
    return sendJson(response, 403, { code: 'DATA_INSIGHT_FORBIDDEN', message: '无权生成该数据洞察' });
  }
  const requestController = new AbortController();
  const abortGeneration = () => {
    if (!requestController.signal.aborted && !response.writableEnded) requestController.abort(new Error('客户端已取消数据洞察请求'));
  };
  request.once('aborted', abortGeneration);
  response.once('close', abortGeneration);
  const record = insightRecord(detail);
  let releaseGeneration = null;
  try {
    releaseGeneration = insightGovernance.beginGeneration(identity);
  } catch (error) {
    request.removeListener('aborted', abortGeneration);
    response.removeListener('close', abortGeneration);
    return sendJson(response, error.status || 429, { code: error.code, message: error.message, retryAfterMs: error.retryAfterMs || null, retryable: true });
  }
  let run = insightRunStore.list({ mode: 'interpret', insightId }).at(0) || null;
  if (!run) {
    const datasetIds = (record.input.datasets || []).map(item => item.id).filter(Boolean);
    const skillQuestion = [record.input.title, record.input.context?.question, prompt].filter(Boolean).join(' ');
    const resolvedSkills = datasetIds.flatMap(datasetId => skillRegistry.resolve({ datasetId, question: skillQuestion }).map(skill => ({ id: skill.id, version: skill.version, diagnostics: skill.diagnostics || [] })));
    run = await insightRunStore.create({ mode: 'interpret', insightId, datasetIds, question: prompt || record.input.title, actor: identity.actor, organizationId: identity.organizationId, skill: { refs: resolvedSkills.map(skill => `${skill.id}@${skill.version}`), diagnostics: resolvedSkills.flatMap(skill => skill.diagnostics) }, metadata: { source: record.input.source || null, createdDuringGeneration: true } });
    await recordInsightDiagnostic(insightId, 'run.created', { run: { id: run.id, mode: run.mode, status: run.status, datasetIds: run.datasetIds, question: run.question, skill: run.skill, metadata: run.metadata, createdAt: run.createdAt } }, { actor: identity.actor, organizationId: identity.organizationId, runId: run.id, source: record.input.source || null });
  }
  let diagnosticContext = { actor: identity.actor, organizationId: identity.organizationId, runId: run?.id || null, attempt: run?.attempt || 1, attemptId: run?.attemptId || null, source: record.input.source || null, signal: requestController.signal };
  if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) {
    try {
      run = await insightRunStore.retry(run.id);
      run = await insightRunStore.transition(run.id, 'running', { metadata: { ...(run.metadata || {}), generationPrompt: prompt } });
      diagnosticContext = { ...diagnosticContext, runId: run.id, attempt: run.attempt, attemptId: run.attemptId };
    } catch (error) {
      request.removeListener('aborted', abortGeneration);
      response.removeListener('close', abortGeneration);
      return sendJson(response, 409, { code: 'INSIGHT_RUN_STATE_ERROR', message: error.message });
    }
  } else if (run?.status === 'queued') {
    try {
      await insightRunStore.transition(run.id, 'planning', { metadata: { ...(run.metadata || {}), generationPrompt: prompt } });
      run = await insightRunStore.transition(run.id, 'running');
    } catch (error) {
      request.removeListener('aborted', abortGeneration);
      response.removeListener('close', abortGeneration);
      return sendJson(response, 409, { code: 'INSIGHT_RUN_STATE_ERROR', message: error.message });
    }
  }

  try {
    // A retry must not expose the previous successful document while the new LLM run is pending.
    await dataInsightStore.clearDocument(insightId);
    await recordInsightDiagnostic(insightId, 'generation.started', { prompt, input: record.input, runId: run?.id || null, attempt: run?.attempt || 1, attemptId: run?.attemptId || null, gateway: explorationGateway.snapshot() }, diagnosticContext);
    if (!explorationGateway.enabled) {
      const error = new Error('正式数据洞察必须配置外部 LLM；固定统计仅作为数据准备诊断');
      error.code = 'INSIGHT_LLM_REQUIRED';
      error.status = 503;
      throw error;
    }
    const generationMigrationRun = await platformMigrationRuntime.run({
      module: 'data-insight-orchestration',
      input: { insightId, prompt, runId: run?.id || null, inputSchema: record.input.schema },
      context: identity,
      legacy: () => callConfiguredLlm(record, prompt, { ...diagnosticContext, migrationPath: 'legacy' }),
      candidate: () => candidateInsightOrchestrator.run({ record, prompt, diagnosticContext }),
      snapshot: value => dataInsightCompatibilityAdapter.snapshot({ input: record.input, status: value?.status || 'failed', document: value?.structured || null, result: value }),
    });
    const result = { ...generationMigrationRun.result, platformMigration: { schema: generationMigrationRun.schema, version: 1, mode: generationMigrationRun.mode, routing: generationMigrationRun.routing || null, comparison: generationMigrationRun.comparison, fallback: generationMigrationRun.fallback, candidateMetadata: generationMigrationRun.candidateMetadata || null, candidateError: generationMigrationRun.candidateError || null } };
    await recordInsightDiagnostic(insightId, 'platform.migration.orchestration', { module: generationMigrationRun.module, mode: generationMigrationRun.mode, routing: generationMigrationRun.routing || null, comparison: generationMigrationRun.comparison, fallback: generationMigrationRun.fallback, candidateMetadata: generationMigrationRun.candidateMetadata || null, candidateError: generationMigrationRun.candidateError || null, schema: generationMigrationRun.schema }, diagnosticContext);
    const orchestration = result.orchestration || {};
    const narrative = result.structured || {};
    const evidence = orchestration.evidence || [];
    const blocks = [
      ...(result.status === 'completed' ? [] : []),
      { id: 'ai-narrative-summary', type: 'ai-narrative', title: '管理摘要', content: (narrative.managementSummary || []).map(item => item.text).join('\n'), evidenceIds: (narrative.managementSummary || []).flatMap(item => item.evidenceIds || []) },
      { id: 'ai-narrative-findings', type: 'ai-narrative', title: '关键发现', content: (narrative.keyFindings || []).map(item => item.text).join('\n'), evidenceIds: (narrative.keyFindings || []).flatMap(item => item.evidenceIds || []) },
      { id: 'ai-narrative-risks', type: 'ai-narrative', title: '风险判断', content: (narrative.risks || []).map(item => item.text).join('\n'), evidenceIds: (narrative.risks || []).flatMap(item => item.evidenceIds || []) },
      { id: 'ai-narrative-actions', type: 'ai-narrative', title: '行动建议', content: (narrative.actions || []).map(item => item.text).join('\n'), evidenceIds: (narrative.actions || []).flatMap(item => item.evidenceIds || []) },
    ].filter(block => block.content);
    const insightDocument = normalizeInsightDocument({
      documentType: 'business-insight',
      title: record.input.title,
      scope: { datasetId: record.input.datasets?.[0]?.id || null, datasets: (record.input.datasets || []).map(item => item.id), filters: record.input.context?.filters || [], timeRange: record.input.scope?.timeRange || null, accuracy: record.input.quality?.accuracy || 'unknown', isSample: Boolean(record.input.quality?.isSample), isTruncated: Boolean(record.input.quality?.isTruncated) },
      blocks,
      evidence,
      followUpActions: [],
      nextQuestions: narrative.followUps?.map(item => item.question).filter(Boolean) || [],
    });
    const capabilityCoverage = orchestration.capabilityCoverage || null;
    const responseStatus = orchestration.status === 'completed-partial' || orchestration.diagnostics?.reasonCode === 'PARTIAL_EVIDENCE' || orchestration.diagnostics?.reasonCode === 'PARTIAL_CAPABILITY_COVERAGE' ? 'completed-partial' : 'completed';
    const unavailableCapabilities = Array.isArray(capabilityCoverage?.unavailable) ? capabilityCoverage.unavailable : [];
    if (unavailableCapabilities.length) {
      insightDocument.blocks.push({
        id: 'capability-coverage',
        type: 'warning',
        title: '部分请求未执行',
        content: `以下请求能力因结果集缺少对应字段未执行：${unavailableCapabilities.map(item => item.label || item.id).join('、')}。已继续执行可用能力。`,
        message: unavailableCapabilities.map(item => `${item.label || item.id}：缺少字段`).join('；'),
        unavailableCapabilities,
        evidenceIds: [],
      });
    }
    let exploreRun = null;
    const inputDatasetIds = (record.input.datasets || []).map(item => item.id).filter(Boolean);
    if (orchestration.critic?.verdict === 'insufficient' && inputDatasetIds.length) {
      exploreRun = await insightRunStore.create({
        mode: 'explore',
        parentRunId: run?.id || null,
        datasetIds: inputDatasetIds,
        question: prompt || record.input.title,
        actor: identity.actor,
        organizationId: identity.organizationId,
        skill: run?.skill || null,
        metadata: { reason: 'interpret-evidence-insufficient', sourceInsightId: insightId, followUps: narrative.followUps || [], inheritedScope: { scope: record.input.scope || null, context: record.input.context || null, quality: record.input.quality || null } },
      });
      await recordInsightDiagnostic(insightId, 'run.created', { run: exploreRun, mode: 'explore', parentRunId: run?.id || null }, { ...diagnosticContext, runId: exploreRun.id });
      try {
        exploreRun = await executeExploreInsightRun(exploreRun);
      } catch (error) {
        exploreRun = insightRunStore.get(exploreRun.id) || { ...exploreRun, status: 'failed', error: { message: error.message, code: error.code || 'INSIGHT_EXPLORE_FAILED' } };
      }
    }
    if (orchestration.critic?.verdict === 'insufficient' && !exploreRun) {
      insightDocument.nextQuestions = [...new Set([...(insightDocument.nextQuestions || []), '请补充可访问的数据集标识，以便发起受控 Explore 分析。'])].slice(0, 8);
    }
    if (responseStatus === 'completed-partial' && !insightDocument.blocks.some(block => block.id === 'analysis-completeness')) {
      const incomplete = orchestration.diagnostics?.incompleteAssessments || [];
      const detail = incomplete.map(item => `${item.hypothesisId || '未命名分析'}（${item.priority || 'extended'}）：${item.reason || '证据不足'}`).join('；');
      insightDocument.blocks.push({ id: 'analysis-completeness', type: 'warning', title: '部分分析未完成', content: '核心分析已完成；部分扩展分析或请求能力因当前输入限制未执行。', message: detail || '部分分析未完成', incompleteItems: incomplete });
    }
    await dataInsightStore.saveDocument(insightId, insightDocument, { runId: run?.id || null, actor: identity.actor, organizationId: identity.organizationId });
    await recordInsightDiagnostic(insightId, 'result.document.saved', { document: insightDocument, result: { provider: result.provider, model: result.model, status: result.status, diagnostics: result.diagnostics || null }, exploreRunId: exploreRun?.id || null }, diagnosticContext);
    if (run) await insightRunStore.complete(run.id, { error: null, document: insightDocument, metadata: { ...(run.metadata || {}), generatedAt: new Date().toISOString(), provider: result.provider, model: result.model, status: result.status, orchestrationSchema: orchestration.schema || null, exploreRunId: exploreRun?.id || null, gateway: orchestration.gateway || null } });
    insightGovernance.record({ actor: identity.actor, organizationId: identity.organizationId, insightId, runId: run?.id || null, action: 'insight.generate', status: 'completed', model: result.model, prompt, toolCalls: orchestration.planner?.toolRequests || [], stageAudit: orchestration.stageAudit || [], skillRefs: run?.skill?.refs || [], externalDataPolicy: orchestration.externalDataPolicy || { rawRowsToLlm: false }, gateway: orchestration.gateway || explorationGateway.snapshot() });
    await recordInsightDiagnostic(insightId, 'generation.finished', { status: 'completed', runId: run?.id || null, attempt: run?.attempt || 1, attemptId: run?.attemptId || null, provider: result.provider, model: result.model, stageAudit: orchestration.stageAudit || [], gateway: orchestration.gateway || explorationGateway.snapshot() }, diagnosticContext);
    sendJson(response, 200, { ...result, status: responseStatus, document: insightDocument, insightId, exploreRun, generatedAt: new Date().toISOString() });
  } catch (error) {
    if (requestController.signal.aborted || error?.code === 'REQUEST_ABORTED') {
      const interruptionReason = request.aborted ? 'client-disconnected' : 'request-aborted';
      if (run) await insightRunStore.interrupt(run.id, interruptionReason);
      await recordInsightDiagnostic(insightId, 'generation.interrupted', { status: 'interrupted', reason: interruptionReason, attempt: run?.attempt || 1, attemptId: run?.attemptId || null, error: { code: error.code || 'REQUEST_ABORTED', message: error.message }, gateway: explorationGateway.snapshot() }, diagnosticContext);
      if (!response.destroyed && !response.writableEnded) sendJson(response, 499, { schema: 'wynai.insight-generation-result/v1', insightId, status: 'interrupted', retryable: true, error: { code: 'INSIGHT_RUN_INTERRUPTED', message: '数据洞察请求已中断，可稍后重试。' } });
      return;
    }
    if (isRecoverableInsightError(error)) {
      if (run) await insightRunStore.fail(run.id, error);
      insightGovernance.record({ actor: identity.actor, organizationId: identity.organizationId, insightId, runId: run?.id || null, action: 'insight.generate', status: 'failed', model: explorationGateway.model, prompt, skillRefs: run?.skill?.refs || [], externalDataPolicy: { rawRowsToLlm: false }, errorCode: error.code || 'INSIGHT_GENERATION_FAILED', gateway: explorationGateway.snapshot() });
      await recordInsightDiagnostic(insightId, 'generation.finished', { status: 'failed', runId: run?.id || null, attempt: run?.attempt || 1, attemptId: run?.attemptId || null, provider: 'llm-orchestrated', model: explorationGateway.model, error: { code: error.code || 'INSIGHT_GENERATION_FAILED', message: error.message }, diagnostics: error.diagnostics || null, gateway: explorationGateway.snapshot() }, diagnosticContext);
      return sendJson(response, error.status || 502, { schema: 'wynai.insight-generation-result/v1', insightId, status: 'failed', retryable: !['EVIDENCE_INSUFFICIENT', 'INSIGHT_CLAIM_VALIDATION_FAILED'].includes(error.code), error: { code: error.code || 'INSIGHT_GENERATION_FAILED', message: error.message }, diagnostics: error.diagnostics || null, generatedAt: new Date().toISOString() });
    }
    if (run) await insightRunStore.fail(run.id, error);
    insightGovernance.record({ actor: identity.actor, organizationId: identity.organizationId, insightId, runId: run?.id || null, action: 'insight.generate', status: 'failed', model: explorationGateway.model, prompt, skillRefs: run?.skill?.refs || [], externalDataPolicy: { rawRowsToLlm: false }, errorCode: error.code || 'INSIGHT_LLM_FAILED', gateway: explorationGateway.snapshot() });
    await recordInsightDiagnostic(insightId, 'generation.failed', { runId: run?.id || null, attempt: run?.attempt || 1, attemptId: run?.attemptId || null, error: { code: error.code || 'INSIGHT_LLM_FAILED', message: error.message, stack: error.stack || null }, gateway: explorationGateway.snapshot() }, diagnosticContext);
    sendJson(response, error.status || 502, { code: error.code || 'INSIGHT_LLM_FAILED', message: `项目 LLM 数据洞察失败（${llmEndpointHost || '未配置端点'}）：${error.message}`, retryable: true });
  } finally {
    request.removeListener('aborted', abortGeneration);
    response.removeListener('close', abortGeneration);
    releaseGeneration?.();
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
    if (request.method === 'GET' && pathname === '/api/platform/migration') return handlePlatformMigrationStatus(response);
    if (request.method === 'GET' && pathname === '/api/llm/health') return await handleLlmHealth(response);
    if (request.method === 'GET' && pathname === '/api/llm/diagnostics') return await handleLlmDiagnostics(response);
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
    if (request.method === 'GET' && pathname === '/api/smart-query/query-quality') return handleQueryQuality(request, response);
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
    const insightCompareRoute = pathname.match(/^\/api\/data-insights\/([^/]+)\/versions\/compare$/);
    if (request.method === 'GET' && insightCompareRoute) {
      const detail = dataInsightStore.get(insightCompareRoute[1]);
      if (!detail) return sendJson(response, 404, { message: '数据洞察结果不存在' });
      const identity = requestIdentity(request);
      if (detail.actor && detail.actor !== 'anonymous' && detail.actor !== identity.actor && (!detail.organizationId || detail.organizationId !== identity.organizationId)) return sendJson(response, 403, { code: 'DATA_INSIGHT_FORBIDDEN', message: '无权访问该数据洞察' });
      const from = requestUrl.searchParams.get('from');
      const to = requestUrl.searchParams.get('to');
      const comparison = dataInsightStore.compareVersions(detail.insightId, from, to);
      return comparison ? sendJson(response, 200, comparison) : sendJson(response, 404, { code: 'INSIGHT_VERSION_NOT_FOUND', message: '指定的洞察版本不存在' });
    }
    const insightExportRoute = pathname.match(/^\/api\/data-insights\/([^/]+)\/export$/);
    if (request.method === 'GET' && insightExportRoute) {
      const detail = dataInsightStore.get(insightExportRoute[1]);
      if (!detail) return sendJson(response, 404, { message: '数据洞察结果不存在' });
      const identity = requestIdentity(request);
      if (detail.actor && detail.actor !== 'anonymous' && detail.actor !== identity.actor && (!detail.organizationId || detail.organizationId !== identity.organizationId)) return sendJson(response, 403, { code: 'DATA_INSIGHT_FORBIDDEN', message: '无权导出该数据洞察' });
      if (!detail.document) return sendJson(response, 409, { code: 'INSIGHT_DOCUMENT_NOT_READY', message: '洞察文档尚未生成' });
      try {
        const audit = insightGovernance.list({ actor: identity.actor, organizationId: identity.organizationId }).find(item => item.insightId === detail.insightId && item.status === 'completed') || {};
        return sendDownload(response, buildInsightDocumentExport(detail.document, requestUrl.searchParams.get('format') || 'html', audit));
      } catch (error) { return sendJson(response, error.status || 400, { code: 'INSIGHT_EXPORT_FAILED', message: error.message }); }
    }
    const insightDiagnosticsRoute = pathname.match(/^\/api\/data-insights\/([^/]+)\/diagnostics$/);
    if (request.method === 'GET' && insightDiagnosticsRoute) {
      try {
        let diagnostic;
        try {
          diagnostic = insightDiagnosticStore.get(insightDiagnosticsRoute[1]);
        } catch (lookupError) {
          if (!(lookupError instanceof InsightDiagnosticLookupError) || lookupError.code !== 'INSIGHT_DIAGNOSTIC_NOT_FOUND') throw lookupError;
          const requested = insightDiagnosticsRoute[1];
          const matches = dataInsightStore.list().map(item => item.insightId).filter(id => id.startsWith(requested));
          if (matches.length > 1) throw new InsightDiagnosticLookupError('INSIGHT_DIAGNOSTIC_PREFIX_AMBIGUOUS', 'Insight ID prefix matches multiple insights', matches);
          if (matches.length !== 1) throw lookupError;
          const legacyDetail = dataInsightStore.get(matches[0]);
          const legacyRuns = insightRunStore.list({ insightId: matches[0] });
          const legacyAudit = insightGovernance.list({ limit: 500 }).filter(item => item.insightId === matches[0]);
          await recordInsightDiagnostic(matches[0], 'legacy.snapshot', { coverage: 'legacy-available-records', input: legacyDetail.input, document: legacyDetail.document, versions: legacyDetail.versions, runs: legacyRuns, audit: legacyAudit }, { actor: legacyDetail.actor, organizationId: legacyDetail.organizationId, source: legacyDetail.source || legacyDetail.input?.source || null });
          diagnostic = insightDiagnosticStore.get(matches[0]);
        }
        const detail = dataInsightStore.get(diagnostic.insightId);
        const identity = requestIdentity(request);
        const actor = detail?.actor || diagnostic.actor;
        const organizationId = detail?.organizationId || diagnostic.organizationId;
        if (actor && actor !== 'anonymous' && actor !== identity.actor && (!organizationId || organizationId !== identity.organizationId)) return sendJson(response, 403, { code: 'DATA_INSIGHT_FORBIDDEN', message: '无权访问该数据洞察诊断日志' });
         return sendJson(response, 200, { ...diagnostic, lifecycle: summarizeDiagnosticLifecycle(diagnostic.events), access: { scope: 'backend-diagnostic', redacted: false, uiExport: false } });
      } catch (error) {
        if (error instanceof InsightDiagnosticLookupError) return sendJson(response, error.status || 404, { code: error.code, message: error.message, matches: error.matches || [] });
        throw error;
      }
    }
    const insightGovernanceRoute = pathname.match(/^\/api\/data-insights\/([^/]+)\/(versions|archive|restore|delete)$/);
    if (request.method === 'GET' && insightGovernanceRoute?.[2] === 'versions') {
      const detail = dataInsightStore.get(insightGovernanceRoute[1]);
      if (!detail) return sendJson(response, 404, { message: '数据洞察结果不存在' });
      const identity = requestIdentity(request);
      if (detail.actor && detail.actor !== 'anonymous' && detail.actor !== identity.actor && (!detail.organizationId || detail.organizationId !== identity.organizationId)) return sendJson(response, 403, { code: 'DATA_INSIGHT_FORBIDDEN', message: '无权访问该数据洞察' });
      return sendJson(response, 200, { insightId: detail.insightId, versions: dataInsightStore.getVersions(detail.insightId) || [] });
    }
    if (request.method === 'POST' && insightGovernanceRoute && ['archive', 'delete'].includes(insightGovernanceRoute[2])) {
      const detail = dataInsightStore.get(insightGovernanceRoute[1]);
      if (!detail) return sendJson(response, 404, { message: '数据洞察结果不存在' });
      const identity = requestIdentity(request);
      if (detail.actor && detail.actor !== 'anonymous' && detail.actor !== identity.actor && (!detail.organizationId || detail.organizationId !== identity.organizationId)) return sendJson(response, 403, { code: 'DATA_INSIGHT_FORBIDDEN', message: '无权修改该数据洞察' });
      try {
        const result = insightGovernanceRoute[2] === 'archive'
          ? await dataInsightStore.archive(detail.insightId, identity)
          : insightGovernanceRoute[2] === 'restore'
            ? await dataInsightStore.restore(detail.insightId, identity)
            : await dataInsightStore.softDelete(detail.insightId, identity);
        insightGovernance.record({ ...identity, insightId: detail.insightId, action: `insight.${insightGovernanceRoute[2]}`, status: 'completed' });
        return sendJson(response, 200, result);
      } catch (error) { return sendJson(response, 422, { code: 'DATA_INSIGHT_GOVERNANCE_FAILED', message: error.message }); }
    }
    if (request.method === 'POST' && pathname === '/api/data-insight-runs') {
      return await handleInsightRunCreate(request, response);
    }
    if (request.method === 'GET' && (pathname === '/api/data-insight-runs' || /^\/api\/data-insight-runs\/[A-Za-z0-9-]{8,100}$/.test(pathname))) {
      return await handleInsightRuns(pathname, request, response);
    }
    if (request.method === 'GET' && pathname === '/api/data-insights/audit') {
      const identity = requestIdentity(request);
      return sendJson(response, 200, { schema: 'wynai.insight-audit-list/v1', items: insightGovernance.list({ actor: identity.actor, organizationId: identity.organizationId, limit: Number(requestUrl.searchParams.get('limit')) || 100 }) });
    }
    if (request.method === 'POST' && /^\/api\/data-insight-runs\/[A-Za-z0-9-]{8,100}\/retry$/.test(pathname)) {
      return await handleInsightRuns(pathname, request, response);
    }
    const dataInsightGenerateRoute = pathname.match(/^\/api\/data-insights\/([A-Za-z0-9-]{8,100})\/generate$/);
    if (request.method === 'POST' && dataInsightGenerateRoute) {
      const body = await readJson(request);
      return await handleSecondaryInsight(request, response, { ...body, insightId: dataInsightGenerateRoute[1] });
    }
    if (request.method === 'GET' && (pathname === '/api/data-insights' || pathname.startsWith('/api/data-insights/'))) {
      return handleDataInsights(pathname, requestUrl, request, response);
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
        code: error.code || 'INTERNAL_ERROR',
        message: error.name === 'AbortError' ? 'Wyn 响应超时，请稍后重试' : error.message,
        traceId: error.traceId || null,
        retryable: String(error.code || '').startsWith('LLM_'),
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
console.log(`Runtime data: ${dataDir}${runtimeData.fallback ? ' (fallback)' : ''}`);

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
