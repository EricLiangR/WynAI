import { randomUUID } from 'node:crypto';
import { normalizeAIInteractionRequest, normalizeAIInteractionResponse, normalizeInsightDocument } from '../protocol/interaction-contract.mjs';
import { normalizeCanonicalFilters } from '../planning/query-request-schema.mjs';
import { composeInsightDocument } from '../report/insight-document.mjs';
import { composeQuestionDocument, planBusinessQuestionAsync } from './question-planner.mjs';
import { validateResultAgainstIntent } from '../semantics/business-query-intent.mjs';
import { resolveApplicableSkills } from '../../semantic-catalog.mjs';
import { applyQueryProgram, materializeRankedDrilldownRequest, validateRankedDrilldownSeed } from '../query/query-program.mjs';

function conversationId() {
  return `conv-${randomUUID()}`;
}

export function requestForResultPresentation(executedRequest, displayRequest = null) {
  if (!executedRequest) return displayRequest;
  if (!displayRequest) return executedRequest;
  const displaySelect = new Map((displayRequest.select || []).map(item => [item.alias, item]));
  const displayMeasures = new Map((displayRequest.measures || []).map(item => [item.alias, item]));
  return {
    ...executedRequest,
    select: (executedRequest.select || []).map(item => ({ ...item, ...(displaySelect.get(item.alias) || {}) })),
    measures: (executedRequest.measures || []).map(item => ({ ...item, ...(displayMeasures.get(item.alias) || {}) })),
  };
}

function unresolvedSlots(intent) {
  return (intent?.constraints || []).filter(item => item.required && item.status !== 'resolved').map(item => ({ id: item.id, type: item.type, source: item.source }));
}

const DERIVED_SYNONYMS = { revenue: ['销售额', '销售收入', '营收', '收入'], profit: ['利润', '毛利'], orderCount: ['订单数量', '订单数', '订单量', '订单笔数'], quantity: ['销量', '购买数量', '销售数量', '件数'] };
function pendingDerivedSelection(pending, reply, selection = null) {
  const unresolved = (pending?.intent?.semanticFrame?.derivedMetrics || []).find(item => item.status === 'unresolved' && ['yoy', 'mom'].includes(item.type));
  const growthAmbiguity = (pending?.intent?.ambiguities || []).find(item => /同比|环比|增长率|增幅/.test(String(item?.question || '')));
  if (!unresolved && !growthAmbiguity) return null;
  const optionConcepts = (growthAmbiguity?.options || []).flatMap(option => Array.isArray(option?.concepts) ? option.concepts : []);
  const candidates = [unresolved?.bindingCandidates, growthAmbiguity?.candidates, optionConcepts]
    .find(values => Array.isArray(values) && values.length)
    || pending.intent.metrics?.filter(item => !item.internal).map(item => item.concept)
    || [];
  if (selection?.concepts?.length) return [...new Set(selection.concepts.filter(item => candidates.includes(item)))];
  const text = String(reply || '');
  if (/(?:三个|三项|全部|都|均|以上指标|这些指标|各项指标|全选)/.test(text)) return [...new Set(candidates)];
  return [...new Set(candidates.filter(concept => (DERIVED_SYNONYMS[concept] || []).some(term => text.includes(term))))];
}
export function applyDerivedSelection(pending, concepts) {
  if (!concepts?.length) return null;
  const intent = structuredClone(pending.intent);
  const frame = intent.semanticFrame;
  const target = (frame.derivedMetrics || []).find(item => item.status === 'unresolved' && ['yoy', 'mom'].includes(item.type));
  if (!target) return null;
  const replacement = concepts.map(concept => ({ ...target, slotId: `derived-binding:${target.type}:${concept}`, sourceConcept: concept, alias: `${concept}_${target.type}`, status: 'resolved', bindingCandidates: undefined }));
  const index = frame.derivedMetrics.indexOf(target);
  frame.derivedMetrics.splice(index, 1, ...replacement);
  // Clear stale unbound comparison slots/outputs before adding the selected
  // bindings. This matters when a question combines a governed formula
  // metric (for example 毛利率) with a generic "同比" phrase.
  const staleAliases = new Set([
    target.alias,
    ...(frame.derivedMetrics || [])
      .filter(item => item.status === 'unresolved' && ['yoy', 'mom'].includes(item.type))
      .map(item => item.alias),
  ]);
  frame.derivedMetrics = (frame.derivedMetrics || [])
    .filter(item => !staleAliases.has(item.alias) || item.status === 'resolved');
  frame.requestedOutputs = (frame.requestedOutputs || [])
    .filter(item => !staleAliases.has(item.alias) && item.concept != null);
  for (const item of replacement) frame.requestedOutputs.push({ kind: 'derived-metric', concept: item.sourceConcept, derivation: item.type, alias: item.alias, source: item.source, required: true });
  intent.derivedMetrics = (intent.derivedMetrics || [])
    .filter(item => !staleAliases.has(item.alias) && (item.type === 'formula' || item.sourceAlias));
  for (const item of replacement) {
    const source = intent.metrics.find(metric => metric.concept === item.sourceConcept && !metric.internal);
    if (source) intent.derivedMetrics.push({ ...item, sourceAlias: source.alias });
  }
  const replacementAliases = new Set(replacement.map(item => item.alias));
  const requiredMetrics = (intent.expectedResult?.requiredMetrics || [])
    .filter(alias => !staleAliases.has(alias) && alias !== 'unresolved_yoy_binding');
  intent.expectedResult = {
    ...(intent.expectedResult || {}),
    requiredMetrics: [...new Set([...requiredMetrics, ...replacementAliases])],
  };
  intent.constraints = (intent.constraints || []).filter(item => item.status === 'resolved');
  frame.derivedMetrics.forEach((item, derivedIndex) => intent.constraints.push({ id: `frame-derived-${derivedIndex + 1}`, type: 'derived-metric', source: item.source, required: true, status: 'resolved', value: { type: item.type, sourceField: intent.metrics.find(metric => metric.concept === item.sourceConcept)?.field, alias: item.alias } }));
  frame.requestedOutputs.forEach((output, outputIndex) => intent.constraints.push({ id: `frame-output-${outputIndex + 1}`, type: 'requested-output', source: output.source, required: true, status: 'resolved', value: { kind: output.kind, concept: output.concept } }));
  intent.confidence = 1;
  return intent;
}
function clarificationPatch(pending, reply, selection = null, concepts = []) {
  const operations = [];
  if (concepts.length) operations.push({ op: 'resolve', path: `/derivedMetrics/bySlot/${pending?.intent?.semanticFrame?.derivedMetrics?.find(item => item.status === 'unresolved')?.slotId || 'unknown'}`, concepts });
  if (/销售额|收入|营收/.test(reply)) operations.push({ op: 'replace', path: '/metrics', value: 'revenue' });
  if (/利润|毛利/.test(reply)) operations.push({ op: 'replace', path: '/metrics', value: 'profit' });
  if (/订单数量|订单数|订单量|订单笔数/.test(reply)) operations.push({ op: 'replace', path: '/metrics', value: 'orderCount' });
  if (/销量|购买数量|销售数量|件数/.test(reply)) operations.push({ op: 'replace', path: '/metrics', value: 'quantity' });
  if (/销售经理|销售员|业务员|销售代表|员工/.test(reply)) operations.push({ op: 'replace', path: '/dimensions', value: 'employee' });
  if (/省份|城市|大区|地区|区域|类别|产品|商品|客户|供应商|运货商|承运商|支付方式|付款方式/.test(reply)) operations.push({ op: 'replace', path: '/dimensions', value: reply.slice(0, 120) });
  if (/\d{4}年|去年|前年|今年|过去|近\d|每年|每月|按月|按年/.test(reply)) operations.push({ op: 'replace', path: '/time', value: reply.slice(0, 120) });
  return {
    schema: 'wynai.intent-patch/v1',
    basedOnIntentId: pending?.intent?.intentId || null,
    sourceTurn: pending?.sourceTurn || null,
    operations: operations.slice(0, 8),
    selection: selection || null,
    reply: String(reply || '').slice(0, 1000),
    createdAt: new Date().toISOString(),
  };
}

function isCancellation(text) { return /^(?:取消|算了|不用了|放弃|退出澄清)/.test(String(text || '').trim()); }

function isFreshQuestion(text) {
  const value = String(text || '').trim();
  if (/^(?:新问题|重新问|另外|换个问题)/.test(value)) return true;
  if (/^(?:请|帮我)?(?:查看|分析|统计|比较|查询|计算)/.test(value) && /销售额|利润|销量|收入/.test(value)) return true;
  // Users often restate a complete request without a verb (for example
  // "2023至2025年每年销售额和利润"). Treat that as a new question while
  // a clarification is pending, but keep short replies such as "销售额"
  // attached to the pending slot.
  const hasTimeScope = /(?:\d{4}年|过去|最近|近\d|每年|每月|按年|按月)/.test(value);
  const hasMetric = /销售额|利润|销量|收入|订单数量|订单数/.test(value);
  const hasMultipleClauses = /(?:和|与|、|以及)/.test(value);
  return hasTimeScope && hasMetric && hasMultipleClauses;
}

function correctionTransition(text) {
  const value = String(text || '').trim();
  const correctionCue = /(?:不是(?:这个|这样|我说的)?意思|不对|理解(?:有误|错了?|不正确)|搞错了?|我说的是|我的意思是|应该(?:理解)?为|改为|改成|纠正一下|重新理解)/.test(value);
  if (!correctionCue) return null;
  const hasBusinessSubject = /销售|收入|营收|利润|毛利|销量|数量|订单|客户|商品|产品|地区|区域|省份|城市|类别|占比|比例|份额|构成|同比|环比/.test(value);
  const hasRequestedAction = /分析|统计|查询|查看|展示|显示|计算|比较|排名|趋势|分布|图|表|按|每|各/.test(value);
  if (!hasBusinessSubject || !hasRequestedAction) return null;
  return { mode: 'correction-replace', reason: 'explicit-correction-with-complete-restatement' };
}
export class SmartQueryConversationStore {
  constructor({ loadMetadata, runAnalysis, executeQuery = null, intentLlm = null, skillRegistry = null, skillGovernance = null, eventLog = null, persistence = null, maxItems = 100, businessTimeZone = 'Asia/Shanghai' } = {}) {
    this.loadMetadata = loadMetadata;
    this.runAnalysis = runAnalysis;
    this.executeQuery = executeQuery;
    this.eventLog = eventLog;
    this.intentLlm = intentLlm;
    this.skillRegistry = skillRegistry;
    this.skillGovernance = skillGovernance;
    this.persistence = persistence;
    this.maxItems = maxItems;
    this.businessTimeZone = businessTimeZone;
    this.items = new Map();
  }

  async init() {
    if (!this.persistence) return this;
    const loaded = await this.persistence.init();
    for (const item of loaded) {
      if (['wynai.smart-query-conversation/v1', 'wynai.smart-query-conversation/v2', 'wynai.smart-query-conversation/v3'].includes(item?.schema) && item.id) this.items.set(item.id, { conversationState: 'ready', pendingContext: null, committedContext: null, activeVisualization: null, ...item });
    }
    this.trim();
    return this;
  }

  async save(item) {
    if (this.persistence) await this.persistence.save({ ...item, lastResult: undefined });
    return item;
  }

  trim() {
    while (this.items.size > this.maxItems) this.items.delete(this.items.keys().next().value);
  }

  async create(input = {}) {
    if (['sql', 'wax', 'query', 'payload', 'pivotPayload'].some(key => input[key] != null)) throw Object.assign(new Error('会话创建禁止原始查询字段'), { status: 400 });
    const datasetIds = [...new Set([...(Array.isArray(input.datasetIds) ? input.datasetIds : []), input.datasetId].map(value => String(value || '').trim()).filter(Boolean))].slice(0, 8);
    if (!datasetIds.length) throw Object.assign(new Error('数据集不能为空'), { status: 400 });
    const metadataItems = await Promise.all(datasetIds.map(datasetId => this.loadMetadata(datasetId)));
    const metadata = metadataItems[0];
    const item = {
      schema: 'wynai.smart-query-conversation/v3',
      id: conversationId(),
      dataset: { id: metadata.id, revision: metadata.revision ?? null, name: metadata.name },
      datasets: metadataItems.map(item => ({ id: item.id, revision: item.revision ?? null, name: item.name })),
      organizationId: input.organizationId ? String(input.organizationId).slice(0, 100) : null,
      userId: input.userId ? String(input.userId).slice(0, 100) : null,
      messages: [],
      activeMetrics: [],
      activeDimensions: [],
      activeFilters: [],
      resultSetIds: [],
      insightDocumentId: null,
      activeQueryRequest: null,
      activeBusinessIntent: null,
      activeVisualization: null,
      constraintLedger: [],
      conversationState: 'ready',
      committedContext: null,
      pendingContext: null,
      businessTimeZone: input.businessTimeZone || this.businessTimeZone,
      loadedSkillRefs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.items.set(item.id, item);
    this.trim();
    await this.save(item);
    return item;
  }

  get(id) {
    return this.items.get(id);
  }

  canAccess(id, { userId = null, organizationId = null } = {}) {
    const item = this.get(id);
    if (!item) return false;
    if ((item.userId || userId) && item.userId !== userId) return false;
    if ((item.organizationId || organizationId) && item.organizationId !== organizationId) return false;
    return true;
  }

  async ask(id, input = {}) {
    const signal = input.signal || null;
    const item = this.items.get(id);
    if (!item) throw Object.assign(new Error('会话不存在或已过期'), { status: 404 });
    const traceId = String(input.traceId || '').slice(0, 120) || `trace-${randomUUID()}`;
    const turnId = `turn-${randomUUID()}`;
    const trace = (event, phase, details = {}, outcome = null, durationMs = null) => this.eventLog?.record({
      traceId, turnId, conversationId: item.id, datasetId: item.dataset.id,
      organizationId: item.organizationId, userId: item.userId, actor: item.userId || 'anonymous',
      event, phase, outcome, durationMs,
      versions: { conversation: item.schema, intent: 'wynai.business-query-intent/v2', canonicalQuery: 'v1' },
      details,
    });
    trace('turn.received', 'input', {
      question: input.question || input.messages?.at(-1)?.content || '',
      conversationState: item.conversationState,
      datasetRevision: item.dataset.revision,
    });
    const metadata = await this.loadMetadata(item.dataset.id);
    const requestedFilters = input.context?.activeFilters ?? item.activeFilters;
    const activeFilters = normalizeCanonicalFilters(metadata, Array.isArray(requestedFilters) ? requestedFilters : []);
    const request = normalizeAIInteractionRequest({
      ...input,
      dataset: item.dataset,
      conversationId: item.id,
      context: {
        ...(input.context || {}),
        activeMetrics: item.activeMetrics,
        activeDimensions: item.activeDimensions,
        activeFilters,
        previousResultSetIds: item.resultSetIds,
        previousInsightDocumentId: item.insightDocumentId,
        activeVisualization: item.activeVisualization,
      },
    });
    const question = request.question || request.messages.at(-1)?.content || '';
    let planningQuestion = question;
    let displayQuestion = question;
    let intentPatch = null;
    let clarificationResolution = null;
    let priorPendingContext = null;
    if (item.pendingContext) {
      priorPendingContext = item.pendingContext;
      if (isCancellation(question)) {
        const at = new Date().toISOString();
        item.messages.push({ role: 'user', content: question, at }, { role: 'assistant', content: '已取消待澄清的问题，之前已确认的分析上下文保持不变。', at });
        item.pendingContext = null;
        item.conversationState = 'ready';
        item.updatedAt = at;
        await this.save(item);
        return {
          conversation: item,
          response: {
            ...normalizeAIInteractionResponse({ status: 'ok', intent: { name: 'clarification-cancelled', confidence: 1, summary: '已取消待澄清问题' }, queryRequests: [] }),
            document: null,
            runtimeStatus: { level: 'ok', mode: 'clarification-state-machine', message: '已恢复到上一份已确认上下文' },
          },
        };
      }
      const correction = correctionTransition(question);
      if (correction) {
        intentPatch = {
          schema: 'wynai.intent-patch/v1',
          basedOnIntentId: priorPendingContext?.intent?.intentId || null,
          sourceTurn: priorPendingContext?.sourceTurn || null,
          transition: correction,
          operations: [{ op: 'replace', path: '/', value: { question: question.slice(0, 1000) } }],
          selection: request.clarificationSelection || null,
          reply: question.slice(0, 1000),
          createdAt: new Date().toISOString(),
        };
        item.pendingContext = null;
        item.conversationState = 'ready';
        planningQuestion = question;
        displayQuestion = question;
        trace('clarification.corrected', 'clarification', {
          previousQuestion: priorPendingContext.originalQuestion,
          correctedQuestion: question,
          transition: correction.mode,
        }, 'success');
      } else if (isFreshQuestion(question)) {
        item.pendingContext = null;
        item.conversationState = 'ready';
        // A fresh question starts a new semantic context. Keep the message
        // history for audit, but do not let active metrics, dimensions or a
        // previous intent leak into the new plan after an abandoned
        // clarification.
        item.activeMetrics = [];
        item.activeDimensions = [];
        item.activeFilters = [];
        item.activeQueryRequest = null;
        item.activeBusinessIntent = null;
        item.activeVisualization = null;
        item.constraintLedger = [];
        item.committedContext = null;
      } else {
        const pending = item.pendingContext;
        const selectedConcepts = pendingDerivedSelection(pending, question, request.clarificationSelection);
        intentPatch = clarificationPatch(pending, question, request.clarificationSelection, selectedConcepts || []);
        if (selectedConcepts?.length) {
          const ambiguityText = (pending.intent?.ambiguities || []).map(item => item?.question || '').join(' ');
          clarificationResolution = {
            kind: 'period-growth-binding',
            type: /环比/.test(`${ambiguityText} ${question}`) ? 'mom' : 'yoy',
            concepts: selectedConcepts,
          };
        }
        pending.patchHistory = [...(pending.patchHistory || []), intentPatch].slice(-20);
        planningQuestion = pending.originalQuestion + '；用户澄清：' + question;
        displayQuestion = pending.originalQuestion;
      }
    }
    const skillResolution = resolveApplicableSkills(this.skillRegistry, { datasetId: item.dataset.id, organizationId: item.organizationId, userId: item.userId });
    if (this.skillGovernance) await this.skillGovernance.recordResolution({ datasetId: item.dataset.id, organizationId: item.organizationId, userId: item.userId, question: planningQuestion, refs: skillResolution.refs, conflicts: skillResolution.conflicts });
    trace('skill.resolved', 'skills', { skillRefs: skillResolution.refs, conflicts: skillResolution.conflicts }, skillResolution.conflicts.length ? 'conflict' : 'success');
    const candidateSkillRefs = [...new Set([...(item.loadedSkillRefs || []), ...skillResolution.refs])];
    if (skillResolution.conflicts.length && !this.executeQuery) {
      const at = new Date().toISOString();
      const message = `当前 Skill 存在同名业务口径冲突：${skillResolution.conflicts.map(item => item.metric).join('、')}。请先确认采用哪一个口径。`;
      item.messages.push({ role: 'user', content: question, at }, { role: 'assistant', content: message, status: 'needs_clarification', at });
      item.conversationState = 'awaiting_clarification';
      item.pendingContext = { schema: 'wynai.pending-query-context/v1', originalQuestion: question, planningQuestion, unresolvedSlots: skillResolution.conflicts.map((item, index) => ({ id: `skill-conflict-${index + 1}`, type: 'skill-conflict', source: item.metric })), candidates: [], createdAt: at, updatedAt: at };
      await this.save(item);
      return { conversation: item, response: { ...normalizeAIInteractionResponse({ status: 'needs_clarification', clarification: { question: message, options: skillResolution.conflicts.map(item => `${item.left}：${item.metric}`, item.right) }, queryRequests: [] }), pendingContext: item.pendingContext, document: null } };
    }
    const directPlan = item.datasets.length === 1 && this.executeQuery
      ? await planBusinessQuestionAsync({
        metadata,
        question: planningQuestion,
        previousIntent: intentPatch?.transition?.mode === 'correction-replace' ? null : priorPendingContext?.intent || item.activeBusinessIntent,
        previousRequest: item.activeQueryRequest,
        skillRefs: skillResolution.refs,
        skills: skillResolution.skills,
        skillConflicts: skillResolution.conflicts,
        timeZone: item.businessTimeZone || this.businessTimeZone,
        clarificationResolution,
        llm: this.intentLlm,
        signal,
        onLlmEvent: event => trace(
          event?.type || 'gateway.attempt',
          'llm',
          {
            operation: event?.operation || 'intent',
            attempt: event?.attempt || null,
            provider: event?.provider || null,
            model: event?.model || null,
            responseStatus: event?.responseStatus || null,
            durationMs: event?.durationMs || null,
            timeoutClass: event?.timeoutClass || null,
            error: event?.error ? {
              code: event.error.code || null,
              category: event.error.category || null,
              retryable: event.error.retryable === true,
              circuitCounted: event.error.circuitCounted === true,
              message: event.error.message || null,
            } : null,
          },
          event?.error ? 'failed' : event?.type === 'gateway.slow' ? 'warning' : 'success',
          event?.durationMs || event?.elapsedMs || null,
        ),
      })
      : { status: 'unsupported' };
    trace('planning.completed', 'planning', { status: directPlan.status, plannerMode: directPlan.plannerMode, diagnostics: directPlan.plannerDiagnostics }, directPlan.status);
    const effectiveSkillRefs = directPlan.intent?.skillRefs?.length ? directPlan.intent.skillRefs : (skillResolution.refs.length ? skillResolution.refs : candidateSkillRefs);
    item.loadedSkillRefs = effectiveSkillRefs;
    if (directPlan.status === 'needs_clarification') {
      const at = new Date().toISOString();
      const nextUnresolved = unresolvedSlots(directPlan.intent);
      const nextSignature = nextUnresolved.map(slot => `${slot.id}:${slot.type}`).join('|');
      const previousSignature = priorPendingContext?.unresolvedSlots?.map(slot => `${slot.id}:${slot.type}`).join('|');
      const isReplacement = intentPatch?.transition?.mode === 'correction-replace';
      const noProgress = !isReplacement && priorPendingContext && nextSignature && nextSignature === previousSignature && !intentPatch?.operations?.some(operation => operation.op === 'resolve');
      const noProgressCount = noProgress ? (priorPendingContext?.noProgressCount || 0) + 1 : 0;
      item.pendingContext = {
        schema: 'wynai.pending-query-context/v1',
        sourceTurn: item.messages.filter(message => message.role === 'user').length + 1,
        originalQuestion: displayQuestion,
        planningQuestion,
        intent: directPlan.intent,
        unresolvedSlots: nextUnresolved,
        candidates: directPlan.options || [],
        patchHistory: [...(priorPendingContext?.patchHistory || []), ...(intentPatch ? [intentPatch] : [])].slice(-20),
        createdAt: isReplacement ? at : (priorPendingContext?.createdAt || at),
        updatedAt: at,
        noProgressCount,
      };
      if (noProgress) {
        if (item.pendingContext.noProgressCount >= 2) {
          item.pendingContext.noProgressGuard = true;
          const guardMessage = '当前确认没有改变待解决的业务口径，请直接说明要计算的指标或重新描述问题。';
          item.messages.push({ role: 'user', content: question, at }, { role: 'assistant', content: guardMessage, status: 'needs_clarification', at });
          item.updatedAt = at;
          await this.save(item);
          return { conversation: item, response: { ...normalizeAIInteractionResponse({ status: 'needs_clarification', clarification: { question: guardMessage, options: [] }, queryRequests: [] }), intentPatch, pendingContext: item.pendingContext, document: null } };
        }
      }
      item.conversationState = 'awaiting_clarification';
      item.messages.push(
        { role: 'user', content: question, at },
        { role: 'assistant', content: directPlan.clarification, status: 'needs_clarification', at },
      );
      item.updatedAt = at;
      await this.save(item);
      return {
        conversation: item,
        response: {
          ...normalizeAIInteractionResponse({
            status: 'needs_clarification',
            clarification: { question: directPlan.clarification, options: directPlan.options || [] },
            diagnostics: { skillRefs: effectiveSkillRefs, semanticWarnings: directPlan.intent?.constraints?.filter(entry => entry.status === 'unresolved').map(entry => `unresolved:${entry.type}`) || [] },
            queryRequests: [],
          }),
          intentPatch,
          pendingContext: item.pendingContext,
          planningDiagnostics: directPlan.plannerDiagnostics || null,
          document: null,
        },
      };
    }
    if (directPlan.status === 'error') {
      const error = new Error(directPlan.message || '智能问数规划暂时不可用，请稍后重试。');
      error.code = directPlan.code || 'SMART_QUERY_PLANNING_FAILED';
      error.status = error.code === 'PLATFORM_INTENT_PROCESSING_FAILED'
        ? 500
        : error.code === 'INTENT_VALIDATION_FAILED' ? 422
          : String(error.code).startsWith('LLM_') ? 503 : 502;
      error.details = directPlan.plannerDiagnostics || null;
      trace('planning.failed', 'planning', { code: error.code, message: error.message, diagnostics: error.details }, 'failed');
      throw error;
    }
    if (directPlan.status === 'supported' && this.executeQuery) {
      const queryStartedAt = Date.now();
      trace('query.planned', 'query', {
        requestId: directPlan.request?.id || null,
        mode: directPlan.request?.mode || null,
        purpose: directPlan.request?.purpose || null,
        select: directPlan.request?.select || [],
        measures: directPlan.request?.measures || [],
        filters: directPlan.request?.filters || [],
        orderBy: directPlan.request?.orderBy || [],
        limit: directPlan.request?.limit ?? null,
      }, 'success');
      trace('query.compiled', 'query', {
        requestId: directPlan.request?.id || null,
        queryProgram: directPlan.queryProgram || null,
        plannerMode: directPlan.plannerMode || null,
      }, 'success');
      let execution;
      let executedRequest = directPlan.request;
      try {
        execution = await this.executeQuery({ requests: [directPlan.request] });
        const rankingResultSet = execution.resultSets[0];
        const rankingQuality = rankingResultSet?.quality;
        if (rankingQuality?.isSample || rankingQuality?.isTruncated || rankingQuality?.isEstimated || rankingQuality?.isComplete === false) {
          const error = new Error('排名阶段结果未能证明完整，已停止生成答案；请缩小查询范围后重试。');
          error.code = 'QUERY_RESULT_INCOMPLETE';
          error.status = 422;
          throw error;
        }
        trace('query.executed', 'query', {
          stage: directPlan.queryProgram?.stagedQuery ? 'ranking' : 'single',
          request: directPlan.request,
          resultSetId: rankingResultSet?.id,
          rowCount: rankingResultSet?.statistics?.rowCount,
          adapter: rankingResultSet?.provenance?.adapter || null,
          adapterVersion: rankingResultSet?.provenance?.adapterVersion || null,
          quality: rankingQuality || null,
        }, 'success', Date.now() - queryStartedAt);
        const rankingSeedValidation = validateRankedDrilldownSeed(directPlan.queryProgram, rankingResultSet);
        if (!rankingSeedValidation.valid) {
          const error = new Error(`排名阶段结果未通过多阶段查询契约校验：${rankingSeedValidation.errors.join('；')}`);
          error.code = 'RANKING_STAGE_CONTRACT_INVALID';
          error.status = 422;
          throw error;
        }
        const drilldownRequest = materializeRankedDrilldownRequest(directPlan.queryProgram, rankingResultSet);
        if (drilldownRequest) {
          executedRequest = drilldownRequest;
          trace('query.planned', 'query', {
            stage: 'drilldown', requestId: drilldownRequest.id, purpose: drilldownRequest.purpose,
            select: drilldownRequest.select, measures: drilldownRequest.measures,
            filters: drilldownRequest.filters, orderBy: drilldownRequest.orderBy, limit: drilldownRequest.limit,
          }, 'success');
          const drilldownStartedAt = Date.now();
          execution = await this.executeQuery({ requests: [drilldownRequest] });
          const drilldownResultSet = execution.resultSets[0];
          const drilldownQuality = drilldownResultSet?.quality;
          if (drilldownQuality?.isSample || drilldownQuality?.isTruncated || drilldownQuality?.isEstimated || drilldownQuality?.isComplete === false) {
            const error = new Error('下钻阶段结果未能证明完整，已停止生成答案；请缩小查询范围后重试。');
            error.code = 'QUERY_RESULT_INCOMPLETE';
            error.status = 422;
            throw error;
          }
          trace('query.executed', 'query', {
            stage: 'drilldown', request: drilldownRequest, resultSetId: drilldownResultSet?.id,
            rowCount: drilldownResultSet?.statistics?.rowCount,
            adapter: drilldownResultSet?.provenance?.adapter || null,
            adapterVersion: drilldownResultSet?.provenance?.adapterVersion || null,
            quality: drilldownQuality || null,
          }, 'success', Date.now() - drilldownStartedAt);
          if (Array.isArray(rankingResultSet?.executionLedger)) {
            drilldownResultSet.executionLedger = [
              ...rankingResultSet.executionLedger.map(entry => ({ ...entry, stage: 'ranking' })),
              ...(drilldownResultSet.executionLedger || []).map(entry => ({ ...entry, stage: 'drilldown' })),
            ];
          }
        }
      } catch (error) {
        trace('query.execution.failed', 'query', {
          requestId: executedRequest?.id || null,
          code: error?.code || null,
          status: error?.status || null,
          message: error?.message || '查询执行失败',
          attempts: error?.attempts || [],
        }, 'failed', Date.now() - queryStartedAt);
        throw error;
      }
      const resultSet = applyQueryProgram(execution.resultSets[0], directPlan.queryProgram);
      let semanticValidation = validateResultAgainstIntent(resultSet, directPlan.intent);
      // An explicitly requested period can legitimately have no matching rows
      // (for example, a future year). Keep the empty result visible so the LLM
      // can explain that there is no data instead of asking the user to restate
      // a valid question.
      if (!(resultSet?.rows || []).length && !semanticValidation.valid) {
        semanticValidation = {
          ...semanticValidation,
          valid: true,
          errors: [],
          warnings: [...(semanticValidation.warnings || []), '查询范围没有匹配数据'],
        };
      }
      trace('result.validated', 'validation', { valid: semanticValidation.valid, errors: semanticValidation.errors || [], warnings: semanticValidation.warnings || [] }, semanticValidation.valid ? 'success' : 'failed');
      if (!semanticValidation.valid) {
        const at = new Date().toISOString();
        const message = `查询结果未通过原问题语义校验：${semanticValidation.errors.join('；')}。请调整问题范围后重试。`;
        item.messages.push(
          { role: 'user', content: question, at },
          { role: 'assistant', content: message, status: 'needs_clarification', at },
        );
        item.updatedAt = at;
        await this.save(item);
        return {
          conversation: item,
          response: {
            ...normalizeAIInteractionResponse({
              status: 'needs_clarification',
              clarification: { question: message, options: ['缩小时间范围', '改为查看销售额', '明确分析维度'] },
              diagnostics: { skillRefs: effectiveSkillRefs, semanticWarnings: semanticValidation.errors },
              queryRequests: [directPlan.request],
            }),
            businessIntent: directPlan.intent,
            semanticValidation,
            document: null,
            resultSets: [],
            planningDiagnostics: directPlan.plannerDiagnostics || null,
          },
        };
      }
      let llmAnswer = null;
      const presentationRequest = requestForResultPresentation(executedRequest, directPlan.displayRequest || directPlan.request);
      const presentationPlanInput = { ...directPlan, request: presentationRequest, displayRequest: presentationRequest };
      let narrationWarning = null;
      if (this.intentLlm?.enabled && typeof this.intentLlm.narrateQueryResult === 'function') {
        try {
          llmAnswer = await this.intentLlm.narrateQueryResult({ question: displayQuestion, request: presentationRequest, resultSet, intent: directPlan.intent, signal,
            onEvent: event => trace(event.type || 'gateway.attempt', 'llm', {
              operation: 'narration', attempt: event.attempt ?? null, model: event.model || null, provider: event.provider || null,
              error: event.error ? { code: event.error.code, category: event.error.category } : null,
            }, event.error ? 'failed' : 'success', event.durationMs ?? null),
          });
        } catch (error) {
          if (error?.code !== 'NARRATION_DELIVERY_INVALID') throw error;
          narrationWarning = '自然语言摘要未通过结果证据校验；以下表格和详情保留已验证的 Wyn 查询结果，请以表格为准。未使用替代业务结果。';
          llmAnswer = {
            summary: '查询已完成，但自然语言摘要未通过结果证据校验，请以结果表格和技术详情为准。',
            keyPoints: [],
            limitations: [narrationWarning],
          };
          trace('narration.delivery-rejected', 'llm', {
            operation: 'narration', code: error.code, message: narrationWarning,
          }, 'warning');
        }
      }
      const document = composeQuestionDocument({ metadata, question: displayQuestion, plan: presentationPlanInput, resultSet, previousVisualization: item.activeVisualization, llmAnswer });
      const at = new Date().toISOString();
      const documentId = `doc-${randomUUID()}`;
      item.messages.push(
        { role: 'user', content: question, turnId, traceId, at },
        { role: 'assistant', content: document.blocks.find(block => block.id === 'answer-summary')?.content || document.title, documentId, turnId, traceId, at },
      );
      item.resultSetIds = [resultSet.id];
      const committedRequest = presentationRequest;
      item.activeFilters = committedRequest.filters;
      item.activeMetrics = committedRequest.measures.map(measure => measure.field).filter(Boolean);
      item.activeDimensions = committedRequest.select.map(select => select.field).filter(Boolean);
      item.activeQueryRequest = committedRequest;
      item.activeBusinessIntent = directPlan.intent;
      item.activeVisualization = document.blocks.find(block => block.type === 'chart')?.visualization || null;
      item.constraintLedger = directPlan.intent?.constraints || [];
      item.pendingContext = null;
      item.conversationState = 'ready';
      item.committedContext = { intent: directPlan.intent, request: committedRequest, visualization: item.activeVisualization, resultSetIds: [resultSet.id], committedAt: at };
      item.insightDocumentId = documentId;
      item.updatedAt = at;
      item.lastDocument = document;
      this.items.delete(item.id);
      this.items.set(item.id, item);
      await this.save(item);
      trace('presentation.planned', 'presentation', { documentId, schema: document.presentationPlan?.schema, version: document.presentationPlan?.version, mode: document.presentationPlan?.mode, priority: document.presentationPlan?.priority, chartType: document.presentationPlan?.chart?.visualization?.type || null, tableColumns: document.presentationPlan?.table?.columns || [] }, 'success');
      trace('response.composed', 'response', { documentId, blockTypes: document.blocks.map(block => block.type), resultSetIds: [resultSet.id] }, 'success');
      trace('turn.completed', 'completion', { plannerMode: directPlan.plannerMode, risk: directPlan.plannerDiagnostics?.riskAssessment }, 'success');

      return {
        conversation: item,
        response: {
          ...normalizeAIInteractionResponse({
            status: 'ok',
            intent: { name: 'direct-business-query', confidence: 1, summary: document.title },
            assumptions: directPlan.assumptions,
            semanticRefs: { datasets: [metadata.id], metrics: item.activeMetrics, dimensions: item.activeDimensions, filters: item.activeFilters },
            queryRequests: [committedRequest],
            analysisMethod: { id: directPlan.plannerMode || 'llm-first-intent-planner', version: '3.0' },
            followUp: { enabled: true, suggestions: document.nextQuestions, actions: document.followUpActions },
             diagnostics: {
               skillRefs: effectiveSkillRefs,
               mappingEvidence: directPlan.intent?.mappingEvidence || [],
             },
          }),
          businessIntent: directPlan.intent,
          trace: { traceId, turnId },
          queryProgram: directPlan.queryProgram,
          intentPatch,
          semanticValidation: document.evidence?.[0]?.semanticValidation || null,
          presentationPlan: document.presentationPlan || null,
          planningDiagnostics: directPlan.plannerDiagnostics || null,
          runtimeStatus: { level: narrationWarning ? 'warning' : 'ok', mode: 'llm-first-intent-planner', message: narrationWarning || '本轮由大模型理解并通过查询约束校验' },
          document,
          documents: [document],
          resultSets: [resultSet],
        },
      };
    }
    const results = await Promise.all((item.datasets || [item.dataset]).map(dataset => this.runAnalysis({
      datasetId: dataset.id,
      focus: question,
      constraints: { filters: activeFilters },
      skills: skillResolution.skills,
      strictMode: true,
    })));
    const degradedResult = results.find(result => {
      const planning = result.analysis?.planning || {};
      return planning.plannerMode === 'deterministic-fallback'
        || planning.plannerDegradedReason || planning.criticDegradedReason
        || (result.audit?.warnings || []).some(message => /AI (?:Planner|Critic).*降级/.test(String(message)));
    });
    if (degradedResult) {
      const error = Object.assign(new Error('分析结果包含未获授权的业务降级，未交付替代答案。'), {
        code: 'BUSINESS_FALLBACK_FORBIDDEN', status: 422,
      });
      trace('analysis.rejected', 'analysis', { code: error.code }, 'failed');
      throw error;
    }
    const documents = results.map(result => composeInsightDocument({ result, conversationId: item.id, question }));
    const document = documents.length === 1 ? documents[0] : normalizeInsightDocument({
      documentType: 'analysis-page',
      title: question || '多数据集智能问数',
      scope: { datasetId: null, datasets: (item.datasets || []).map(dataset => dataset.id), accuracy: documents.some(value => value.scope.accuracy === 'sample') ? 'sample' : 'exact', isSample: documents.some(value => value.scope.isSample), isTruncated: documents.some(value => value.scope.isTruncated) },
      blocks: documents.flatMap((value, documentIndex) => value.blocks.map(block => ({ ...block, id: `d${documentIndex + 1}-${block.id}`, title: `${(item.datasets || [])[documentIndex]?.name || '数据集'} · ${block.title || block.id}` }))),
      evidence: documents.flatMap((value, documentIndex) => value.evidence.map(evidence => ({ ...evidence, id: `d${documentIndex + 1}-${evidence.id}` }))),
      followUpActions: documents.flatMap(value => value.followUpActions || []).slice(0, 3),
      nextQuestions: [],
    });
    const assistantMessage = { role: 'assistant', content: document.title, documentId: `doc-${randomUUID()}`, at: new Date().toISOString() };
    item.messages.push({ role: 'user', content: question, at: new Date().toISOString() }, assistantMessage);
    item.resultSetIds = results.flatMap(result => result.resultSets.map(resultSet => resultSet.id)).slice(-20);
    item.activeFilters = activeFilters;
    item.activeMetrics = [...new Set(results.flatMap(result => result.queries.flatMap(query => (query.request.measures || []).map(measure => measure.field).filter(Boolean))))].slice(0, 16);
    item.activeDimensions = [...new Set(results.flatMap(result => result.queries.flatMap(query => (query.request.select || []).map(select => select.field).filter(Boolean))))].slice(0, 16);
    item.insightDocumentId = assistantMessage.documentId;
    item.activeQueryRequest = results[0]?.queries?.at(-1)?.request || item.activeQueryRequest;
    item.updatedAt = new Date().toISOString();
    item.lastResult = results;
    item.lastDocument = document;
    this.items.delete(item.id);
    this.items.set(item.id, item);
    await this.save(item);
    const interactionResponse = normalizeAIInteractionResponse({
      status: 'ok',
      intent: { name: results[0]?.analysis.planning?.intent || 'open', confidence: 1, summary: document.title },
      queryRequests: results.flatMap(result => result.queries.map(query => query.request)),
      diagnostics: { skillRefs: effectiveSkillRefs, semanticWarnings: results.flatMap(result => result.audit?.warnings || []) },
    });
    const resultSets = results.flatMap(result => result.resultSets || []).map(resultSet => ({
      id: resultSet.id,
      schema: resultSet.schema,
      rows: resultSet.rows || [],
      statistics: resultSet.statistics,
      scope: resultSet.scope,
      quality: resultSet.quality,
    }));
    const runtimeStatus = { level: 'ok', mode: 'llm-analysis', message: '分析规划和受控查询已完成' };
    return { conversation: item, response: { ...interactionResponse, runtimeStatus, document, documents, resultSets } };
  }
}
