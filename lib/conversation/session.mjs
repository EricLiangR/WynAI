import { randomUUID } from 'node:crypto';
import { normalizeAIInteractionRequest, normalizeAIInteractionResponse, normalizeInsightDocument } from '../protocol/interaction-contract.mjs';
import { normalizeCanonicalFilters } from '../planning/query-request-schema.mjs';
import { composeInsightDocument } from '../report/insight-document.mjs';
import { composeQuestionDocument, planBusinessQuestionAsync } from './question-planner.mjs';
import { validateResultAgainstIntent, compileBusinessQueryIntent } from '../semantics/business-query-intent.mjs';
import { applyQueryProgram } from '../query/query-program.mjs';

function conversationId() {
  return `conv-${randomUUID()}`;
}

function unresolvedSlots(intent) {
  return (intent?.constraints || []).filter(item => item.required && item.status !== 'resolved').map(item => ({ id: item.id, type: item.type, source: item.source }));
}

const DERIVED_SYNONYMS = { revenue: ['销售额', '销售收入', '营收', '收入'], profit: ['利润', '毛利'], orderCount: ['订单数量', '订单数', '订单量', '订单笔数'], quantity: ['销量', '购买数量', '销售数量', '件数'] };
function pendingDerivedSelection(pending, reply, selection = null) {
  const unresolved = (pending?.intent?.semanticFrame?.derivedMetrics || []).find(item => item.status === 'unresolved' && ['yoy', 'mom'].includes(item.type));
  if (!unresolved) return null;
  const candidates = unresolved.bindingCandidates || pending.intent.metrics?.filter(item => !item.internal).map(item => item.concept) || [];
  if (selection?.concepts?.length) return [...new Set(selection.concepts.filter(item => candidates.includes(item)))];
  const text = String(reply || '');
  if (/(?:三个|三项|全部|都|均|以上指标|这些指标|各项指标|全选)/.test(text)) return [...new Set(candidates)];
  return [...new Set(candidates.filter(concept => (DERIVED_SYNONYMS[concept] || []).some(term => text.includes(term))))];
}
function applyDerivedSelection(pending, concepts) {
  if (!concepts?.length) return null;
  const intent = structuredClone(pending.intent);
  const frame = intent.semanticFrame;
  const target = (frame.derivedMetrics || []).find(item => item.status === 'unresolved' && ['yoy', 'mom'].includes(item.type));
  if (!target) return null;
  const replacement = concepts.map(concept => ({ ...target, slotId: `derived-binding:${target.type}:${concept}`, sourceConcept: concept, alias: `${concept}_${target.type}`, status: 'resolved', bindingCandidates: undefined }));
  const index = frame.derivedMetrics.indexOf(target);
  frame.derivedMetrics.splice(index, 1, ...replacement);
  frame.requestedOutputs = (frame.requestedOutputs || []).filter(item => item.alias !== target.alias);
  for (const item of replacement) frame.requestedOutputs.push({ kind: 'derived-metric', concept: item.sourceConcept, derivation: item.type, alias: item.alias, source: item.source, required: true });
  intent.derivedMetrics = (intent.derivedMetrics || []).filter(item => item.alias !== target.alias && item.sourceAlias);
  for (const item of replacement) {
    const source = intent.metrics.find(metric => metric.concept === item.sourceConcept && !metric.internal);
    if (source) intent.derivedMetrics.push({ ...item, sourceAlias: source.alias });
  }
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
  return /^(?:新问题|重新问|另外|换个问题)/.test(value) || (/^(?:请|帮我)?(?:查看|分析|统计|比较|查询|计算)/.test(value) && /销售额|利润|销量|收入/.test(value));
}
function fallbackRuntimeStatus(diagnostics) {
  const reason = diagnostics?.reason || '';
  const validationFailures = new Set(['INTENT_COVERAGE_INVALID', 'INTENT_SCOPE_EXPANSION_INVALID', 'INTENT_COMPILE_INVALID', 'CONTRACT_INVALID']);
  if (validationFailures.has(reason)) {
    return { level: 'warning', mode: 'deterministic-risk-fallback', message: 'AI 复核建议未通过语义约束校验，本轮采用已通过校验的受控规划' };
  }
  if (reason === 'LLM_TIMEOUT') {
    return { level: 'warning', mode: 'deterministic-risk-fallback', message: 'AI 意图复核超时，本轮采用已通过校验的受控规划' };
  }
  return { level: 'warning', mode: 'deterministic-risk-fallback', message: 'AI 意图复核暂不可用，本轮采用已通过校验的受控规划' };
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
    let pendingPlanOverride = null;
    if (item.pendingContext) {
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
      if (isFreshQuestion(question)) {
        item.pendingContext = null;
        item.conversationState = 'ready';
      } else {
        const pending = item.pendingContext;
        const selectedConcepts = pendingDerivedSelection(pending, question, request.clarificationSelection);
        if (selectedConcepts?.length) {
          const patchedIntent = applyDerivedSelection(pending, selectedConcepts);
          const compiled = patchedIntent ? compileBusinessQueryIntent(metadata, patchedIntent) : null;
          if (compiled?.status === 'supported') pendingPlanOverride = { ...compiled, plannerMode: 'clarification-patch', semantic: { year: compiled.intent.time.periods?.length === 1 ? compiled.intent.time.periods[0] : null, periods: compiled.intent.time.periods || [], grain: compiled.intent.time.grain || null, timeField: compiled.intent.time.field || null }, plannerDiagnostics: { patchApplied: true, selectedConcepts } };
          intentPatch = clarificationPatch(pending, question, request.clarificationSelection, selectedConcepts);
        } else intentPatch = clarificationPatch(pending, question, request.clarificationSelection, []);
        pending.patchHistory = [...(pending.patchHistory || []), intentPatch].slice(-20);
        planningQuestion = pending.originalQuestion + '；用户澄清：' + question;
        displayQuestion = pending.originalQuestion;
      }
    }
    const skillResolution = this.skillRegistry?.resolveForQuestion({ datasetId: item.dataset.id, organizationId: item.organizationId, userId: item.userId, question: planningQuestion }) || { skills: [], conflicts: [], refs: [] };
    if (this.skillGovernance) await this.skillGovernance.recordResolution({ datasetId: item.dataset.id, organizationId: item.organizationId, userId: item.userId, question: planningQuestion, refs: skillResolution.refs, conflicts: skillResolution.conflicts });
    trace('skill.resolved', 'skills', { skillRefs: skillResolution.refs, conflicts: skillResolution.conflicts }, skillResolution.conflicts.length ? 'conflict' : 'success');
    if (skillResolution.conflicts.length) {
      return {
        conversation: item,
        response: {
          ...normalizeAIInteractionResponse({
          status: 'needs_clarification',
          clarification: {
            question: '当前 Skill 对同名指标存在不同口径，请确认使用哪一套定义。',
            options: skillResolution.conflicts.map(conflict => `${conflict.metric}: ${conflict.left} / ${conflict.right}`),
          },
          diagnostics: { skillRefs: skillResolution.refs, semanticWarnings: ['skill-conflict'] },
          queryRequests: [],
          }),
          document: null,
        },
      };
    }
    const candidateSkillRefs = [...new Set([...(item.loadedSkillRefs || []), ...skillResolution.refs])];
    const directPlan = pendingPlanOverride || (item.datasets.length === 1 && this.executeQuery
      ? await planBusinessQuestionAsync({
        metadata,
        question: planningQuestion,
        previousRequest: item.activeQueryRequest,
        previousIntent: item.activeBusinessIntent,
        skillRefs: skillResolution.refs,
        skills: skillResolution.skills,
        timeZone: item.businessTimeZone || this.businessTimeZone,
        llm: this.intentLlm,
        signal,
      })
      : { status: 'unsupported' });
    trace('planning.completed', 'planning', { status: directPlan.status, plannerMode: directPlan.plannerMode, diagnostics: directPlan.plannerDiagnostics }, directPlan.status);
    const effectiveSkillRefs = directPlan.intent?.skillRefs || skillResolution.refs || candidateSkillRefs;
    item.loadedSkillRefs = effectiveSkillRefs;
    if (directPlan.status === 'needs_clarification') {
      const at = new Date().toISOString();
      const nextUnresolved = unresolvedSlots(directPlan.intent);
      const nextSignature = nextUnresolved.map(slot => `${slot.id}:${slot.type}`).join('|');
      const previousSignature = item.pendingContext?.unresolvedSlots?.map(slot => `${slot.id}:${slot.type}`).join('|');
      const noProgress = item.pendingContext && nextSignature && nextSignature === previousSignature && !intentPatch?.operations?.some(operation => operation.op === 'resolve');
      const noProgressCount = noProgress ? (item.pendingContext?.noProgressCount || 0) + 1 : 0;
      item.pendingContext = {
        schema: 'wynai.pending-query-context/v1',
        sourceTurn: item.messages.filter(message => message.role === 'user').length + 1,
        originalQuestion: displayQuestion,
        planningQuestion,
        intent: directPlan.intent,
        unresolvedSlots: nextUnresolved,
        candidates: directPlan.options || [],
        patchHistory: item.pendingContext?.patchHistory || [],
        createdAt: item.pendingContext?.createdAt || at,
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
    if (directPlan.status === 'supported' && this.executeQuery) {
      const queryStartedAt = Date.now();
      const execution = await this.executeQuery({ requests: [directPlan.request] });
      trace('query.executed', 'query', { request: directPlan.request, resultSetId: execution.resultSets[0]?.id, rowCount: execution.resultSets[0]?.statistics?.rowCount }, 'success', Date.now() - queryStartedAt);
      const resultSet = applyQueryProgram(execution.resultSets[0], directPlan.queryProgram);
      const semanticValidation = validateResultAgainstIntent(resultSet, directPlan.intent);
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
      const document = composeQuestionDocument({ metadata, question: displayQuestion, plan: { ...directPlan, request: directPlan.displayRequest || directPlan.request }, resultSet, previousVisualization: item.activeVisualization });
      const at = new Date().toISOString();
      const documentId = `doc-${randomUUID()}`;
      item.messages.push(
        { role: 'user', content: question, turnId, traceId, at },
        { role: 'assistant', content: document.blocks.find(block => block.id === 'answer-summary')?.content || document.title, documentId, turnId, traceId, at },
      );
      item.resultSetIds = [resultSet.id];
      const committedRequest = directPlan.displayRequest || directPlan.request;
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
            analysisMethod: { id: directPlan.plannerMode || 'deterministic-question-planner', version: '2.1' },
            followUp: { enabled: true, suggestions: document.nextQuestions, actions: document.followUpActions },
            diagnostics: { skillRefs: effectiveSkillRefs },
          }),
          businessIntent: directPlan.intent,
          trace: { traceId, turnId },
          queryProgram: directPlan.queryProgram,
          intentPatch,
          semanticValidation: document.evidence?.[0]?.semanticValidation || null,
          planningDiagnostics: directPlan.plannerDiagnostics || null,
          runtimeStatus: directPlan.plannerMode === 'hybrid-llm-validated'
            ? { level: 'ok', mode: 'hybrid-intent-planner', message: '本轮由混合语义规划生成，并通过原问题约束校验' }
            : directPlan.plannerMode === 'deterministic-risk-fallback'
              ? fallbackRuntimeStatus(directPlan.plannerDiagnostics)
              : { level: 'ok', mode: 'controlled-semantic-parser', message: '本轮由受控语义规则生成，并通过原问题约束校验' },
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
      strictMode: false,
    })));
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
      rows: (resultSet.rows || []).slice(0, 200),
      statistics: resultSet.statistics,
      scope: resultSet.scope,
      quality: resultSet.quality,
    }));
    const degraded = results.flatMap(result => result.audit?.warnings || []).some(message => /AI Planner|AI Critic/.test(message));
    const runtimeStatus = degraded
      ? { level: 'warning', mode: 'deterministic-fallback', message: 'AI 规划暂不可用，本轮使用受控确定性分析路径' }
      : { level: 'ok', mode: 'ai-or-deterministic-analysis', message: '分析规划和受控查询已完成' };
    return { conversation: item, response: { ...interactionResponse, runtimeStatus, document, documents, resultSets } };
  }
}
