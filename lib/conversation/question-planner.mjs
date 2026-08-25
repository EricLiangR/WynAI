import { randomUUID } from 'node:crypto';
import { normalizeCanonicalQueryRequest } from '../planning/query-request-schema.mjs';
import { assessPlanningRisk, planningRiskAtLeast } from '../planning/risk-router.mjs';
import { normalizeInsightDocument } from '../protocol/interaction-contract.mjs';
import { buildFollowUpActions } from './followup-actions.mjs';
import { decideVisualization } from '../visualization/visualization-spec.mjs';
import {
  buildBusinessQueryIntent,
  compileBusinessQueryIntent,
  normalizeBusinessQueryIntentV2,
  validateIntentCoverage,
  validateResultAgainstIntent,
} from '../semantics/business-query-intent.mjs';

const NUMBER_WORDS = new Map([
  ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
  ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
]);

const INTENT_CIRCUIT_FAILURE_THRESHOLD = 2;
const INTENT_CIRCUIT_COOLDOWN_MS = 60_000;
const intentPlannerCircuits = new WeakMap();

function intentCircuit(llm) {
  const current = intentPlannerCircuits.get(llm) || { failures: 0, openUntil: 0 };
  intentPlannerCircuits.set(llm, current);
  return current;
}

function plannerResult(plan, plannerMode, startedAt, diagnostics = {}) {
  return {
    ...plan,
    plannerMode,
    plannerDiagnostics: {
      route: plannerMode,
      planningDurationMs: Date.now() - startedAt,
      llmAttempted: false,
      llmDurationMs: 0,
      circuitOpen: false,
      ...diagnostics,
    },
  };
}

function deterministicPlanIsComplete(plan) {
  if (plan.status !== 'supported' || !plan.intent) return false;
  const coverage = validateIntentCoverage(plan.intent);
  const unresolved = (plan.intent.constraints || []).some(item => item.required && item.status !== 'resolved');
  return coverage.valid && !unresolved;
}

function sameSemanticSlot(left, right) {
  return Boolean(
    (left?.concept && right?.concept && left.concept === right.concept)
    || (left?.alias && right?.alias && left.alias === right.alias)
    || (left?.field && right?.field && left.field === right.field)
  );
}

function reconcileInternalDimensions(intent, deterministicIntent) {
  const internalDimensions = (deterministicIntent?.dimensions || []).filter(item => item.internal);
  if (!internalDimensions.length) return intent;
  return {
    ...intent,
    dimensions: (intent.dimensions || []).map(item => {
      const baseline = internalDimensions.find(candidate =>
        sameSemanticSlot(item, candidate)
        || (item?.grain && item.grain === candidate.grain && item?.field === candidate.field)
      );
      return baseline ? { ...item, internal: true } : item;
    }),
  };
}

function validateIntentNonExpansion(intent, deterministicIntent) {
  const errors = [];
  const allowedMetrics = deterministicIntent?.metrics || [];
  const allowedDimensions = (deterministicIntent?.dimensions || []).filter(item => !item.internal);
  const allowedFilters = deterministicIntent?.filters || [];
  for (const item of intent?.metrics || []) {
    if (!allowedMetrics.some(candidate => sameSemanticSlot(item, candidate))) errors.push(`模型新增了用户未要求的指标：${item.field || item.alias || item.concept}`);
  }
  for (const item of (intent?.dimensions || []).filter(candidate => !candidate.internal)) {
    if (!allowedDimensions.some(candidate => sameSemanticSlot(item, candidate))) errors.push(`模型新增了用户未要求的维度：${item.field || item.alias || item.concept}`);
  }
  for (const item of intent?.filters || []) {
    if (!allowedFilters.some(candidate =>
      candidate.field === item.field
      && candidate.operator === item.operator
      && JSON.stringify(candidate.value) === JSON.stringify(item.value)
    )) errors.push(`模型新增了用户未要求的筛选：${item.field || 'unknown'}`);
  }
  return { valid: errors.length === 0, errors };
}

function hasField(metadata, name) {
  return (metadata.fields || []).some(field => field.name === name);
}

function firstField(metadata, names, roles = []) {
  for (const name of names) if (hasField(metadata, name)) return name;
  return (metadata.fields || []).find(field => roles.includes(field.role))?.name || null;
}

function parseTopLimit(question) {
  const match = question.match(/(?:前|top\s*)(\d{1,3}|[一二两三四五六七八九十])(?:名|个|项)?/i);
  if (!match) return null;
  return Math.max(1, Math.min(100, Number(match[1]) || NUMBER_WORDS.get(match[1]) || 10));
}

function yearRange(question, now) {
  const explicit = question.match(/(?:^|\D)((?:19|20)\d{2})年?/);
  const year = explicit ? Number(explicit[1]) : /去年/.test(question) ? now.getFullYear() - 1 : null;
  if (!year) return null;
  return {
    year,
    start: `${year}-01-01`,
    end: `${year + 1}-01-01`,
  };
}

function withoutTimeFilters(filters, timeField) {
  return (filters || []).filter(filter => filter.field !== timeField);
}

function replaceFieldFilter(filters, field, value) {
  return [...(filters || []).filter(filter => filter.field !== field), { field, operator: 'eq', value }];
}

function metricForQuestion(question, metadata, previous) {
  if (/利润|毛利|盈利/.test(question)) return firstField(metadata, ['订单利润', '利润', '毛利', '毛利润'], ['measure']);
  if (/销售额|销售|收入|营收|金额/.test(question)) return firstField(metadata, ['订单金额', '销售额', '收入', '营业收入'], ['measure']);
  if (/数量|销量/.test(question)) return firstField(metadata, ['购买数量', '销售数量', '销量'], ['measure']);
  return previous?.measures?.[0]?.field || null;
}

function dimensionForQuestion(question, metadata) {
  if (/商品种类|产品种类|商品类别|产品类别|品类|类别/.test(question)) return firstField(metadata, ['类别名称', '商品类别', '产品类别'], ['dimension']);
  if (/商品|产品/.test(question)) return firstField(metadata, ['商品名称', '产品名称'], ['dimension']);
  if (/客户地区|区域|地区/.test(question)) return firstField(metadata, ['客户地区', '区域', '地区'], ['geography', 'dimension']);
  if (/客户/.test(question)) return firstField(metadata, ['客户名称'], ['dimension']);
  return null;
}

function isExplicitScalar(question) {
  return /总额|合计|总计|一共|是多少|多少/.test(question) && !/排名|排行|前\s*\d|top|按月|月份|趋势|分别|各/.test(question);
}

function isModifier(question) {
  return /^(继续|再|改成|换成|只看|仅看|按)/.test(question.trim());
}

function clarificationForErrors(errors = [], intent = null) {
  const joined = errors.join('；');
  const unresolvedTypes = new Set((intent?.constraints || []).filter(item => item.required && item.status !== 'resolved').map(item => item.type));
  if (/partitioned-ranking|分组内排名/.test(joined)) {
    return {
      question: '请确认分组内排名的比较层级和排名对象。',
      options: ['每年按城市取前三名', '每年按省份取前三名', '每个大区按产品取前三名'],
    };
  }
  if (/维度/.test(joined) || unresolvedTypes.has('dimension') || unresolvedTypes.has('requested-output')) {
    return {
      question: '还缺少明确的分析维度。你希望按哪个业务对象分组？',
      options: ['按销售大区分析', '按省份分析', '按城市分析', '按销售经理分析'],
    };
  }
  if (/指标/.test(joined) || unresolvedTypes.has('metric')) {
    return {
      question: '还缺少明确的指标口径。你希望计算哪个指标？',
      options: ['查看销售额', '查看利润', '查看订单数', '查看销量'],
    };
  }
  if (/时间/.test(joined) || unresolvedTypes.has('time-field') || unresolvedTypes.has('time-grouping')) {
    return {
      question: '时间要求尚未形成可执行范围。请确认分析期间和时间粒度。',
      options: ['查看去年全年', '按年分析', '按月分析'],
    };
  }
  return {
    question: '还有业务约束未能可靠解析：' + joined + '。请直接补充缺少的指标、时间或维度。',
    options: [],
  };
}

function filtersForQuestion({ question, metadata, previous, now }) {
  const timeField = firstField(metadata, ['订购日期', '订单日期', '销售日期', '日期'], ['time']);
  let filters = isModifier(question) ? [...(previous?.filters || [])] : [];
  const range = yearRange(question, now);
  if (range && timeField) {
    filters = withoutTimeFilters(filters, timeField);
    filters.push({ field: timeField, operator: 'gte', value: range.start });
    filters.push({ field: timeField, operator: 'lt', value: range.end });
  }
  const regionField = firstField(metadata, ['客户地区', '区域', '地区'], ['geography', 'dimension']);
  const region = question.match(/(?:只看|仅看|筛选|限定|看)(华东|华北|华南|华中|西南|西北|东北)/)?.[1]
    || question.match(/(华东|华北|华南|华中|西南|西北|东北)(?:地区|区域)?/)?.[1];
  if (region && regionField) filters = replaceFieldFilter(filters, regionField, region);
  return { filters, timeField, range };
}

export function planBusinessQuestion({ metadata, question, previousRequest = null, previousIntent = null, skillRefs = [], skills = [], now = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const text = String(question || '').trim();
  if (!text || !metadata?.fields?.length) return { status: 'unsupported' };
  const intent = buildBusinessQueryIntent({ metadata, question: text, previousIntent, previousRequest, skillRefs, skills, now, timeZone });
  const compiled = compileBusinessQueryIntent(metadata, intent);
  if (compiled.status !== 'supported') {
    const clarification = clarificationForErrors(compiled.errors, intent);
    return {
      status: 'needs_clarification',
      clarification: clarification.question,
      options: clarification.options,
      intent,
    };
  }
  return {
    ...compiled,
    semantic: {
      metric: intent.metrics[0]?.field || null,
      dimension: intent.dimensions[0]?.field || null,
      year: intent.time.periods.length === 1 ? intent.time.periods[0] : null,
      periods: intent.time.periods,
      topN: intent.ranking?.limit || null,
      timeField: intent.time.field,
      grain: intent.time.grain,
      timeZone: intent.time.timeZone,
    },
    assumptions: intent.assumptions,
  };
}

export async function planBusinessQuestionAsync({ llm = null, ...input } = {}) {
  const startedAt = Date.now();
  const deterministic = planBusinessQuestion(input);
  const riskAssessment = assessPlanningRisk({ question: input.question, plan: deterministic, skillRefs: input.skillRefs || [] });
  const deterministicComplete = deterministicPlanIsComplete(deterministic);
  const complexity = deterministic.intent?.semanticFrame?.complexity || 0;
  if (deterministicComplete && riskAssessment.level === 'low') {
    return plannerResult(deterministic, 'deterministic-fast-path', startedAt, {
      reason: 'deterministic-intent-validated',
      complexity,
      riskAssessment,
    });
  }
  if (!llm?.enabled || typeof llm.planQueryIntent !== 'function') {
    if (planningRiskAtLeast(riskAssessment, 'high')) {
      if (deterministic.status === 'needs_clarification') {
        return plannerResult(deterministic, 'risk-gated-clarification', startedAt, {
          reason: 'high-risk-intent-needs-business-clarification',
          complexity,
          riskAssessment,
        });
      }
      return plannerResult({
        status: 'needs_clarification',
        clarification: '这个问题涉及高影响业务判断，但当前意图模型不可用。请明确关键业务口径后重试。',
        options: ['明确指标定义', '明确分析维度', '明确时间范围'],
        intent: deterministic.intent,
      }, 'risk-gated-clarification', startedAt, {
        reason: 'high-risk-intent-llm-unavailable',
        complexity,
        riskAssessment,
      });
    }
    return plannerResult(deterministic, 'deterministic-clarification', startedAt, {
      reason: 'intent-llm-unavailable',
      complexity,
      riskAssessment,
    });
  }
  const circuit = intentCircuit(llm);
  if (circuit.openUntil > Date.now()) {
    if (planningRiskAtLeast(riskAssessment, 'high')) {
      if (deterministic.status === 'needs_clarification') {
        return plannerResult(deterministic, 'risk-gated-clarification', startedAt, { reason: 'high-risk-intent-llm-circuit-open', complexity, circuitOpen: true, retryAfterMs: circuit.openUntil - Date.now(), riskAssessment });
      }
      return plannerResult({
        status: 'needs_clarification',
        clarification: '高风险问题的意图模型暂时不可用，请明确关键业务口径或稍后重试。',
        options: ['明确指标定义', '明确分析维度', '明确时间范围'],
        intent: deterministic.intent,
      }, 'risk-gated-clarification', startedAt, { reason: 'high-risk-intent-llm-circuit-open', complexity, circuitOpen: true, retryAfterMs: circuit.openUntil - Date.now(), riskAssessment });
    }
    return plannerResult(deterministic, 'deterministic-clarification', startedAt, {
      reason: 'intent-llm-circuit-open',
      complexity,
      circuitOpen: true,
      retryAfterMs: circuit.openUntil - Date.now(),
      riskAssessment,
    });
  }
  const llmStartedAt = Date.now();
  try {
    const output = await llm.planQueryIntent({
      metadata: input.metadata,
      question: input.question,
      previousIntent: input.previousIntent,
      skills: input.skills || [],
      timeZone: input.timeZone || 'Asia/Shanghai',
      deterministicIntent: deterministic.intent || null,
      signal: input.signal || null,
    });
    let intent = normalizeBusinessQueryIntentV2({
      ...(deterministic.intent || {}),
      ...output,
      businessQuestion: input.question,
      semanticFrame: deterministic.intent?.semanticFrame || output.semanticFrame,
      skillRefs: input.skillRefs,
      source: { planner: 'hybrid-llm-intent-planner', version: '2.1' },
    }, { metadata: input.metadata });
    intent = reconcileInternalDimensions(intent, deterministic.intent);
    const coverage = validateIntentCoverage(intent);
    if (!coverage.valid) throw Object.assign(new Error('意图模型输出未通过约束覆盖校验'), { code: 'INTENT_COVERAGE_INVALID' });
    if (deterministicComplete) {
      const nonExpansion = validateIntentNonExpansion(intent, deterministic.intent);
      if (!nonExpansion.valid) throw Object.assign(new Error(`意图模型输出超出原问题范围：${nonExpansion.errors.join('；')}`), { code: 'INTENT_SCOPE_EXPANSION_INVALID' });
    }
    const compiled = compileBusinessQueryIntent(input.metadata, intent);
    if (compiled.status !== 'supported') throw Object.assign(new Error('意图模型输出无法编译为受控查询'), { code: 'INTENT_COMPILE_INVALID' });
    circuit.failures = 0;
    circuit.openUntil = 0;
    return plannerResult({
      ...compiled,
      semantic: {
        metric: intent.metrics[0]?.field || null,
        dimension: intent.dimensions[0]?.field || null,
        year: intent.time?.periods?.length === 1 ? intent.time.periods[0] : null,
        periods: intent.time?.periods || [],
        topN: intent.ranking?.limit || null,
        timeField: intent.time?.field || null,
        grain: intent.time?.grain || null,
        timeZone: intent.time?.timeZone || 'Asia/Shanghai',
      },
      assumptions: intent.assumptions || [],
    }, 'hybrid-llm-validated', startedAt, {
      reason: 'intent-llm-validated',
      complexity,
      llmAttempted: true,
      llmDurationMs: Date.now() - llmStartedAt,
      riskAssessment,
    });
  } catch (error) {
    if (input.signal?.aborted || error?.code === 'REQUEST_ABORTED') throw error;
    const providerFailure = !['INTENT_COVERAGE_INVALID', 'INTENT_SCOPE_EXPANSION_INVALID', 'INTENT_COMPILE_INVALID', 'CONTRACT_INVALID'].includes(error?.code);
    if (providerFailure) {
      circuit.failures += 1;
      if (circuit.failures >= INTENT_CIRCUIT_FAILURE_THRESHOLD) circuit.openUntil = Date.now() + INTENT_CIRCUIT_COOLDOWN_MS;
    }
    if (deterministicComplete && riskAssessment.level === 'medium') {
      return plannerResult(deterministic, 'deterministic-risk-fallback', startedAt, {
        reason: error?.code || 'intent-llm-failed',
        complexity,
        llmAttempted: true,
        llmDurationMs: Date.now() - llmStartedAt,
        circuitOpen: circuit.openUntil > Date.now(),
        riskAssessment,
      });
    }
    if (planningRiskAtLeast(riskAssessment, 'high') && deterministic.status !== 'needs_clarification') {
      deterministic.status = 'needs_clarification';
      deterministic.clarification = '本轮高风险业务意图尚未通过联合校验，请明确关键业务口径后重试。';
      deterministic.options = ['明确指标定义', '明确分析维度', '明确时间范围'];
    }
    return plannerResult(deterministic, 'deterministic-clarification', startedAt, {
      reason: error?.code || 'intent-llm-failed',
      complexity,
      llmAttempted: true,
      llmDurationMs: Date.now() - llmStartedAt,
      circuitOpen: circuit.openUntil > Date.now(),
      riskAssessment,
    });
  }
}

function formatValue(value, metric) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '—');
  const formatted = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(numeric);
  return /金额|利润|收入|销售额/.test(metric || '') ? `¥${formatted}` : formatted;
}

export function composeQuestionDocument({ metadata, question, plan, resultSet, previousVisualization = null }) {
  const rows = resultSet?.rows || [];
  const metricAlias = plan.request.measures[0].alias;
  const metric = plan.request.measures[0].field;
  const metricNames = [...plan.request.measures.map(item => item.field), ...(plan.intent?.derivedMetrics || []).map(item => item.source)].join('、');
  const dimensionAlias = plan.request.select[0]?.alias;
  const scalar = !dimensionAlias;
  const blocks = [];
  if (scalar) {
    const value = rows[0]?.[metricAlias] ?? null;
    blocks.push({ id: 'answer-kpi', type: 'kpi', title: metric, value: formatValue(value, metric), evidenceIds: ['answer-evidence'] });
    blocks.push({ id: 'answer-summary', type: 'text', title: '回答', content: `${question}：${formatValue(value, metric)}`, evidenceIds: ['answer-evidence'] });
  } else {
    const rankingText = plan.intent?.ranking
      ? `${plan.intent.ranking.direction === 'asc' ? '从低到高' : '从高到低'}取 ${plan.intent.ranking.limit} 项`
      : '';
    const rangeText = plan.intent?.semanticFrame?.time?.range
      ? `${plan.intent.semanticFrame.time.range.start} 至 ${plan.intent.semanticFrame.time.range.endExclusive}（结束日不含）`
      : '';
    const cumulativeText = plan.intent?.semanticFrame?.accumulation?.mode === 'cumulative-window' ? '累计' : '';
    blocks.push({ id: 'answer-summary', type: 'text', title: '回答', content: `已按${plan.request.select.map(item => item.field).join('、') || '指定维度'}计算${rangeText ? `${rangeText}的` : ''}${cumulativeText}${metricNames}${rankingText ? `，${rankingText}` : ''}。`, evidenceIds: ['answer-evidence'] });
    const visualizationDecision = decideVisualization({ metadata, question, request: plan.request, resultSet, previous: previousVisualization });
    if (visualizationDecision.spec) {
      blocks.push({
        id: 'answer-chart',
        type: 'chart',
        title: question,
        chartType: visualizationDecision.spec.type,
        dataRef: resultSet.id,
        encoding: { x: visualizationDecision.spec.encoding.category.field, y: visualizationDecision.spec.encoding.measures[0].field },
        visualization: visualizationDecision.spec,
        evidenceIds: ['answer-evidence'],
      });
    }
    blocks.push({ id: 'answer-table', type: 'table', title: '查询明细', dataRef: resultSet.id, columns: resultSet.schema.map(column => column.name), evidenceIds: ['answer-evidence'] });
  }
  const semanticValidation = plan.intent ? validateResultAgainstIntent(resultSet, plan.intent) : { valid: true, errors: [], warnings: [] };
  const qualityWarnings = [...(resultSet?.quality?.warnings || []), ...semanticValidation.warnings].filter(message => {
    const text = String(message || '');
    if (/AI Planner|AI Critic|NONE JSON|WAX 原始日期分组|服务端列裁剪|时间粒度.*归并/.test(text)) return false;
    return /样本|截断|达到(?:结果)?上限|估算|不完整|范围不足/.test(text);
  });
  qualityWarnings.forEach((message, index) => blocks.push({ id: `warning-${index + 1}`, type: 'warning', title: '结果范围提示', message, evidenceIds: [] }));
  semanticValidation.errors.forEach((message, index) => blocks.push({ id: `semantic-warning-${index + 1}`, type: 'warning', title: '语义覆盖校验未通过', message, evidenceIds: [] }));
  const isSample = Boolean(resultSet?.quality?.isSample);
  const isTruncated = Boolean(resultSet?.quality?.isTruncated);
  return normalizeInsightDocument({
    documentType: 'analysis-page',
    title: question,
    scope: {
      datasetId: metadata.id,
      datasets: [metadata.id],
      datasetRevision: metadata.revision,
      filters: plan.request.filters,
      timeRange: plan.semantic.year ? { start: `${plan.semantic.year}-01-01`, end: `${plan.semantic.year + 1}-01-01` } : null,
      accuracy: isSample ? 'sample' : isTruncated || !semanticValidation.valid ? 'unknown' : 'exact',
      isSample,
      isTruncated,
    },
    blocks,
    evidence: [{ id: 'answer-evidence', title: question, value: rows, scope: resultSet?.scope || null, semanticValidation }],
    followUpActions: buildFollowUpActions({ metadata, plan, resultSet, question }),
    nextQuestions: [],
  });
}
