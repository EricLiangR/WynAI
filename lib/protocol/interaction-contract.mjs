import { randomUUID } from 'node:crypto';
import { normalizeFollowUpActions } from '../conversation/followup-actions.mjs';
export { normalizeBusinessQueryIntentV2 } from '../semantics/business-query-intent.mjs';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,99}$/i;
const BLOCK_TYPES = new Set(['kpi', 'text', 'ai-narrative', 'manual-content', 'chart', 'table', 'filter-summary', 'metric-definition', 'warning', 'divider']);
const QUERY_FORBIDDEN_KEYS = new Set(['sql', 'wax', 'query', 'payload', 'pivotPayload', 'adapter']);

function contractError(message, details = []) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'CONTRACT_INVALID';
  error.details = details;
  return error;
}

function boundedText(value, fallback = '', maximum = 2000) {
  return String(value ?? fallback).trim().slice(0, maximum);
}

function safeId(value, label) {
  const id = boundedText(value);
  if (!ID_PATTERN.test(id)) throw contractError(`${label} 无效：${id || '(empty)'}`);
  return id;
}

function uniqueStrings(values, maximum = 32) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => boundedText(value, '', 200)).filter(Boolean))].slice(0, maximum);
}

function validateNoRawQuery(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach((item, index) => validateNoRawQuery(item, `${path}[${index}]`));
  for (const [key, child] of Object.entries(value)) {
    if (QUERY_FORBIDDEN_KEYS.has(key)) throw contractError(`交互契约禁止原始查询字段：${path}.${key}`);
    validateNoRawQuery(child, `${path}.${key}`);
  }
}

export function normalizeAIInteractionRequest(input = {}) {
  validateNoRawQuery(input);
  const datasetId = safeId(input.dataset?.id || input.datasetId, '数据集 ID');
  const conversationId = input.conversationId ? safeId(input.conversationId, '会话 ID') : null;
  const messages = Array.isArray(input.messages) ? input.messages.slice(-20).map(item => ({
    role: ['user', 'assistant', 'system'].includes(item?.role) ? item.role : 'user',
    content: boundedText(item?.content, '', 4000),
  })).filter(item => item.content) : [];
  if (!messages.length && !boundedText(input.question)) throw contractError('交互请求缺少 question 或 messages');
  return {
    schema: 'wynai.ai-interaction-request/v1',
    type: 'query.interaction',
    requestId: input.requestId ? safeId(input.requestId, '请求 ID') : `req-${randomUUID()}`,
    dataset: { id: datasetId, revision: input.dataset?.revision ?? null },
    conversationId,
    question: boundedText(input.question, '', 4000),
    messages,
    context: {
      activeMetrics: uniqueStrings(input.context?.activeMetrics),
      activeDimensions: uniqueStrings(input.context?.activeDimensions),
      activeFilters: Array.isArray(input.context?.activeFilters) ? input.context.activeFilters.slice(0, 8) : [],
      previousResultSetIds: uniqueStrings(input.context?.previousResultSetIds, 8),
      previousInsightDocumentId: input.context?.previousInsightDocumentId ? boundedText(input.context.previousInsightDocumentId, '', 100) : null,
    },
    skills: uniqueStrings(input.skills, 16),
    semanticRevision: input.semanticRevision == null ? null : boundedText(input.semanticRevision, '', 100),
    locale: boundedText(input.locale, 'zh-CN', 20) || 'zh-CN',
  };
}

export function normalizeBusinessQueryIntent(input = {}) {
  validateNoRawQuery(input);
  const question = boundedText(input.businessQuestion || input.question, '', 4000);
  if (!question) throw contractError('业务查询意图缺少 businessQuestion');
  const datasetIds = uniqueStrings(input.datasetIds || input.datasets?.map(item => item?.id), 16);
  const shape = ['scalar', 'scalar-with-comparison', 'time-series', 'grouped-table', 'detail-table', 'matrix', 'chart', 'ai-narrative', 'unknown'].includes(input.expectedResult?.shape)
    ? input.expectedResult.shape : 'unknown';
  return {
    schema: 'wynai.business-query-intent/v1',
    intentId: input.intentId ? safeId(input.intentId, '业务意图 ID') : `bqi-${randomUUID()}`,
    businessQuestion: question,
    userLanguage: boundedText(input.userLanguage, 'zh-CN', 20) || 'zh-CN',
    datasets: datasetIds.map(id => ({ id })),
    context: {
      reportPeriod: input.context?.reportPeriod || null,
      organization: boundedText(input.context?.organization, '', 200) || null,
      filters: Array.isArray(input.context?.filters) ? input.context.filters.slice(0, 16) : [],
    },
    expectedResult: {
      shape,
      fields: uniqueStrings(input.expectedResult?.fields, 32),
      maximumRows: Math.max(1, Math.min(5000, Number(input.expectedResult?.maximumRows) || 100)),
    },
    presentation: {
      targetBlockType: boundedText(input.presentation?.targetBlockType, 'text', 40),
      format: boundedText(input.presentation?.format, 'general', 40),
      unit: boundedText(input.presentation?.unit, '', 40) || null,
      precision: Math.max(0, Math.min(8, Number.isFinite(Number(input.presentation?.precision)) ? Number(input.presentation.precision) : 2)),
    },
    semanticCandidates: Array.isArray(input.semanticCandidates) ? input.semanticCandidates.slice(0, 16) : [],
    requiresUserConfirmation: input.requiresUserConfirmation !== false,
  };
}

export function normalizeAIInteractionResponse(input = {}) {
  validateNoRawQuery(input);
  const status = ['ok', 'needs_clarification', 'rejected', 'error'].includes(input.status) ? input.status : 'error';
  const queryRequests = Array.isArray(input.queryRequests) ? input.queryRequests.slice(0, 12).map(item => {
    if (!item || typeof item !== 'object') throw contractError('queryRequests 必须是对象');
    return item;
  }) : [];
  if (queryRequests.some(item => Object.keys(item).some(key => QUERY_FORBIDDEN_KEYS.has(key)))) {
    throw contractError('queryRequests 只能使用 CanonicalQueryRequest 字段');
  }
  return {
    schema: 'wynai.ai-interaction-response/v1',
    type: 'query.plan',
    status,
    intent: {
      name: boundedText(input.intent?.name, 'open', 80),
      confidence: Math.max(0, Math.min(1, Number(input.intent?.confidence) || 0)),
      summary: boundedText(input.intent?.summary, '', 500),
    },
    clarification: input.clarification ? { question: boundedText(input.clarification.question, '', 1000), options: uniqueStrings(input.clarification.options, 8) } : null,
    assumptions: uniqueStrings(input.assumptions, 16),
    semanticRefs: {
      datasets: uniqueStrings(input.semanticRefs?.datasets),
      metrics: uniqueStrings(input.semanticRefs?.metrics),
      dimensions: uniqueStrings(input.semanticRefs?.dimensions),
      filters: Array.isArray(input.semanticRefs?.filters) ? input.semanticRefs.filters.slice(0, 8) : [],
    },
    queryRequests,
    analysisMethod: { id: boundedText(input.analysisMethod?.id, 'direct-query', 80), version: boundedText(input.analysisMethod?.version, '1.0', 20) },
    presentationIntent: {
      documentType: boundedText(input.presentationIntent?.documentType, 'analysis-page', 80),
      preferredBlocks: uniqueStrings(input.presentationIntent?.preferredBlocks, 12).filter(item => BLOCK_TYPES.has(item)),
    },
    followUp: { enabled: input.followUp?.enabled !== false, suggestions: uniqueStrings(input.followUp?.suggestions, 8), actions: normalizeFollowUpActions(input.followUp?.actions) },
    diagnostics: { skillRefs: uniqueStrings(input.diagnostics?.skillRefs, 16), semanticWarnings: uniqueStrings(input.diagnostics?.semanticWarnings, 16) },
  };
}

function normalizeBlock(block, index) {
  if (!block || typeof block !== 'object' || !BLOCK_TYPES.has(block.type)) throw contractError(`InsightDocument block[${index}] 类型不受支持`);
  const normalized = { ...block, id: safeId(block.id || `block-${index + 1}`, `Block ${index + 1} ID`), type: block.type };
  normalized.evidenceIds = uniqueStrings(block.evidenceIds, 16);
  if (['chart', 'table'].includes(block.type) && block.dataRef && !ID_PATTERN.test(block.dataRef)) throw contractError(`Block ${normalized.id} 的 dataRef 无效`);
  return normalized;
}

export function normalizeInsightDocument(input = {}) {
  validateNoRawQuery(input);
  const blocks = Array.isArray(input.blocks) ? input.blocks.slice(0, 50).map(normalizeBlock) : [];
  if (!blocks.length) throw contractError('InsightDocument 至少需要一个 block');
  return {
    schema: 'wynai.insight-document/v1',
    documentType: boundedText(input.documentType, 'analysis-page', 80),
    title: boundedText(input.title, '智能问数分析', 200),
    scope: {
      datasetId: input.scope?.datasetId ? safeId(input.scope.datasetId, 'scope.datasetId') : null,
      datasets: uniqueStrings(input.scope?.datasets || input.scope?.datasetIds, 16),
      datasetRevision: input.scope?.datasetRevision ?? null,
      filters: Array.isArray(input.scope?.filters) ? input.scope.filters.slice(0, 8) : [],
      timeRange: input.scope?.timeRange || null,
      accuracy: ['exact', 'sample', 'estimated', 'unknown'].includes(input.scope?.accuracy) ? input.scope.accuracy : 'unknown',
      isSample: Boolean(input.scope?.isSample),
      isTruncated: Boolean(input.scope?.isTruncated),
    },
    blocks,
    evidence: Array.isArray(input.evidence) ? input.evidence.slice(0, 100) : [],
    followUpActions: normalizeFollowUpActions(input.followUpActions),
    // Retained for v1 consumers. New clients must render followUpActions only.
    nextQuestions: uniqueStrings(input.nextQuestions, 8),
  };
}

export const interactionContractVersions = Object.freeze({
  request: ['wynai.ai-interaction-request/v1'],
  response: ['wynai.ai-interaction-response/v1'],
  businessIntent: ['wynai.business-query-intent/v1', 'wynai.business-query-intent/v2'],
  semanticFrame: ['wynai.question-semantic-frame/v1', 'wynai.question-semantic-frame/v2'],
  queryProgram: ['wynai.query-program/v1'],
  intentPatch: ['wynai.intent-patch/v1'],
  pendingContext: ['wynai.pending-query-context/v1'],
  document: ['wynai.insight-document/v1'],
});
