import { randomUUID } from 'node:crypto';
import { normalizeInsightDocument } from '../protocol/interaction-contract.mjs';
import { buildFollowUpActions } from './followup-actions.mjs';
import { buildResultPresentationPlan } from '../result-presentation-plan.mjs';
import { buildSemanticCatalog, validateSemanticMapping } from '../../semantic-catalog.mjs';
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

function listValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' || typeof value === 'number') return [value];
  return [];
}

export const CURRENT_NL_CAPABILITIES = Object.freeze([
  'query.aggregate', 'query.compare', 'query.time-series', 'query.filter',
  'query.sort', 'query.rank', 'query.follow-up', 'interaction.greeting',
  'interaction.clarification', 'interaction.cancel', 'ui.refresh',
  'ui.export', 'ui.switch-dataset',
]);

function aggregationLabel(value) {
  return ({ sum: '求和', average: '平均值', min: '最小值', max: '最大值', countRows: '计数', distinctCount: '去重计数' })[value] || value || '聚合';
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

function validateLlmTimeGrouping(intent, coverage, question = '') {
  const errors = [...(coverage?.errors || [])];
  const questionText = String(question || '');
  const explicitlyRequestedGrain = /年月|年\s*月|每月|逐月|按月|月份/.test(questionText)
    ? 'month'
    : /每年|逐年|按年|年度/.test(questionText) ? 'year' : null;
  const timeDimensions = (intent?.dimensions || []).filter(item => item?.grain);
  if (explicitlyRequestedGrain && !timeDimensions.length) {
    errors.push(`问题明确要求按${explicitlyRequestedGrain === 'month' ? '月' : '年'}分组，但意图遗漏了时间分组字段`);
  } else if (explicitlyRequestedGrain && !timeDimensions.some(item => item.grain === explicitlyRequestedGrain)) {
    errors.push(`问题明确要求按${explicitlyRequestedGrain === 'month' ? '月' : '年'}分组，但意图时间粒度不一致`);
  }
  const expectsTimeSeries = intent?.expectedResult?.shape === 'time-series'
    || Boolean(intent?.time?.grain)
    || (intent?.expectedResult?.requiredPeriods || []).length > 0;
  if (expectsTimeSeries && !(intent?.dimensions || []).some(item => item?.grain)) {
    errors.push('时间序列缺少按指定粒度的时间分组字段');
  }
  if ((intent?.time?.periods || []).length && intent?.time?.field
      && !(intent?.filters || []).some(item => item?.field === intent.time.field)) {
    errors.push('明确时间期间缺少对应的时间范围过滤');
  }
  const hasExplicitPeriod = /(?:19|20)\d{2}年|去年|今年|本年度/.test(questionText);
  const hasTimeRangeFilter = (intent?.filters || []).some(item => ['gte', 'gt', 'lt', 'lte'].includes(item?.operator));
  if (hasExplicitPeriod && !hasTimeRangeFilter) {
    errors.push('问题明确指定了时间期间，但意图没有生成时间范围');
  }
  const relativeRange = (() => {
    const timeZone = intent?.time?.timeZone || 'Asia/Shanghai';
    const currentYear = Number(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(new Date()));
    if (/去年/.test(questionText) && /前年/.test(questionText)) return { start: `${currentYear - 2}-01-01`, endExclusive: `${currentYear}-01-01` };
    if (/去年/.test(questionText)) return { start: `${currentYear - 1}-01-01`, endExclusive: `${currentYear}-01-01` };
    if (/前年/.test(questionText)) return { start: `${currentYear - 2}-01-01`, endExclusive: `${currentYear - 1}-01-01` };
    return null;
  })();
  if (relativeRange && (intent?.time?.range?.start !== relativeRange.start || intent?.time?.range?.endExclusive !== relativeRange.endExclusive)) {
    errors.push(`相对时间范围与当前日期不一致，应为 ${relativeRange.start} 至 ${relativeRange.endExclusive}`);
  }
  return { ...coverage, valid: errors.length === 0, errors };
}

function materializeLlmTimeFilters(intent) {
  const range = intent?.time?.range;
  const field = intent?.time?.field;
  if (!field || !range?.start || !range?.endExclusive) return intent;
  const filters = intent.filters || [];
  if (filters.some(item => item?.field === field && ['gte', 'gt', 'lt', 'lte'].includes(item?.operator))) return intent;
  return {
    ...intent,
    filters: [...filters, { field, operator: 'gte', value: range.start }, { field, operator: 'lt', value: range.endExclusive }],
  };
}

function materializeLlmPeriods(intent) {
  const time = intent?.time;
  const range = time?.range;
  const grain = time?.grain;
  const periods = listValue(time?.periods).map(String);
  if (!periods.length || !range?.start || !range?.endExclusive || !['year', 'month'].includes(grain)) return intent;
  const concretePattern = grain === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}$/;
  if (periods.every(period => concretePattern.test(period))) return intent;
  const start = new Date(`${range.start}T00:00:00Z`);
  const end = new Date(`${range.endExclusive}T00:00:00Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start >= end) return intent;
  const cursor = new Date(start);
  if (grain === 'year') cursor.setUTCMonth(0, 1);
  else cursor.setUTCDate(1);
  const concrete = [];
  while (cursor < end && concrete.length < 240) {
    concrete.push(grain === 'year'
      ? String(cursor.getUTCFullYear())
      : `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    if (grain === 'year') cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  if (!concrete.length) return intent;
  const requiredPeriods = listValue(intent.expectedResult?.requiredPeriods).map(String);
  return {
    ...intent,
    time: { ...time, periods: concrete },
    expectedResult: {
      ...(intent.expectedResult || {}),
      requiredPeriods: requiredPeriods.some(period => !concretePattern.test(period)) ? concrete : requiredPeriods,
    },
  };
}

function materializeLlmRanking(intent) {
  const ranking = intent?.ranking;
  if (!ranking || ranking.orderBy || !ranking.by) return intent;
  const metric = (intent.metrics || []).find(item => item.alias === ranking.by || item.field === ranking.by || item.concept === ranking.by);
  if (!metric?.alias) return intent;
  return { ...intent, ranking: { ...ranking, orderBy: metric.alias, direction: ranking.direction || ranking.order || 'desc' } };
}

function normalizeSkillRefs(outputRefs, loadedSkills = [], fallbackRefs = []) {
  const available = new Map();
  for (const skill of loadedSkills || []) {
    if (!skill?.id || !skill?.version) continue;
    const ref = `${skill.id}@${skill.version}`;
    available.set(ref, ref);
    available.set(String(skill.id), ref);
    available.set(String(skill.name || '').trim(), ref);
  }
  const requested = Array.isArray(outputRefs) && outputRefs.length ? outputRefs : fallbackRefs;
  const normalized = [];
  for (const value of requested || []) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    const resolved = available.get(raw) || (raw.includes('@') ? available.get(raw.split('@')[0]) : null);
    if (resolved && !normalized.includes(resolved)) normalized.push(resolved);
  }
  return normalized;
}

function normalizeDerivedMetricShape(value, metrics = []) {
  if (!value || typeof value !== 'object') return null;
  const dependencyValues = Array.isArray(value.dependencies) ? value.dependencies : [];
  const dependencies = dependencyValues.map(item => {
    if (typeof item === 'string') return { metricId: item, sourceAlias: item };
    return { ...item, metricId: item?.metricId || item?.alias || item?.sourceAlias || null, sourceAlias: item?.sourceAlias || item?.alias || item?.metricId || null };
  }).filter(item => item.metricId || item.sourceAlias);
  const rawType = String(value.type || '').trim().toLowerCase();
  const rawOperator = String(value.operator || '').trim().toLowerCase();
  const growthIdentity = `${value.metricId || ''} ${value.alias || ''} ${value.concept || ''}`;
  const isPeriodGrowth = ['yoy', 'year-over-year', 'growthrate', 'growth-rate', '同比', '同比增长率', 'mom', 'month-over-month', '环比', '环比增长率'].includes(rawType)
    || ['yoy', 'year-over-year', 'growthrate', 'growth-rate', '同比', '同比增长率', 'mom', 'month-over-month', '环比', '环比增长率'].includes(rawOperator)
    || /growth[ _-]?rate|year[ _-]?over[ _-]?year|month[ _-]?over[ _-]?month|(?:^|[ _-])yoy(?:[ _-]|$)|(?:^|[ _-])mom(?:[ _-]|$)|同比|环比/i.test(growthIdentity);
  if (isPeriodGrowth) {
    const isMom = ['mom', 'month-over-month', '环比', '环比增长率'].includes(rawType)
      || ['mom', 'month-over-month', '环比', '环比增长率'].includes(rawOperator)
      || /month[ _-]?over[ _-]?month|(?:^|[ _-])mom(?:[ _-]|$)|环比/i.test(growthIdentity);
    const sourceAlias = value.sourceAlias || dependencies[0]?.sourceAlias || dependencies[0]?.metricId
      || metrics.find(item => item.concept === value.sourceConcept || item.alias === value.sourceConcept)?.alias
      || (metrics.length === 1 ? metrics[0].alias : null);
    if (!sourceAlias) return { ...value, dependencies, type: isMom ? 'mom' : 'yoy', sourceAlias: null, status: 'unresolved' };
    const sourceMetric = metrics.find(item => item.alias === sourceAlias);
    const metricLabel = ({ revenue: '销售额', profit: '利润', orderCount: '订单数量', quantity: '销量' })[sourceMetric?.concept]
      || sourceMetric?.field || sourceAlias;
    return {
      ...value,
      type: isMom ? 'mom' : 'yoy',
      sourceAlias,
      sourceConcept: value.sourceConcept || sourceMetric?.concept || null,
      alias: value.alias && !/growth|year[ _-]?over[ _-]?year|month[ _-]?over[ _-]?month|(?:^|[ _-])yoy(?:[ _-]|$)|(?:^|[ _-])mom(?:[ _-]|$)|同比|环比/i.test(String(value.alias)) ? value.alias : `${sourceAlias}_${isMom ? 'mom' : 'yoy'}`,
      source: value.source && !/^[a-z0-9_ -]+$/i.test(String(value.source)) ? value.source : `${metricLabel}${isMom ? '环比增长率' : '同比增长率'}`,
      dependencies,
      offset: Number(value.offset) > 0 ? Number(value.offset) : 1,
      resultType: 'percentage',
      status: value.status || 'resolved',
      required: value.required !== false,
    };
  }
  if (rawType === 'formula' || value.operator || value.metricId) {
    return { ...value, type: rawType || 'formula', dependencies, status: value.status || 'resolved' };
  }
  return value;
}

function enforceClarificationResolution(intent, resolution = null) {
  if (resolution?.kind !== 'period-growth-binding' || !Array.isArray(resolution.concepts) || !resolution.concepts.length) return intent;
  const type = resolution.type === 'mom' ? 'mom' : 'yoy';
  const selected = new Set(resolution.concepts.map(String));
  const sourceMetrics = (intent.metrics || []).filter(metric => !metric.internal && selected.has(String(metric.concept || metric.alias)));
  if (!sourceMetrics.length) return intent;
  const periodGrowth = sourceMetrics.map(metric => {
    const label = ({ revenue: '销售额', profit: '利润', orderCount: '订单数量', quantity: '销量' })[metric.concept]
      || metric.field || metric.alias;
    return {
      type,
      source: `${label}${type === 'mom' ? '环比增长率' : '同比增长率'}`,
      sourceConcept: metric.concept || metric.alias,
      sourceAlias: metric.alias,
      alias: `${metric.alias}_${type}`,
      offset: 1,
      resultType: 'percentage',
      required: true,
      status: 'resolved',
    };
  });
  const oldGrowthAliases = new Set((intent.derivedMetrics || [])
    .filter(item => ['yoy', 'mom'].includes(item.type) || /growth|year[ _-]?over[ _-]?year|month[ _-]?over[ _-]?month|(?:^|[ _-])yoy(?:[ _-]|$)|(?:^|[ _-])mom(?:[ _-]|$)|同比|环比/i.test(`${item.alias || ''} ${item.metricId || ''} ${item.concept || ''}`))
    .map(item => item.alias).filter(Boolean));
  const requiredMetrics = (intent.expectedResult?.requiredMetrics || []).filter(alias => !oldGrowthAliases.has(alias));
  return {
    ...intent,
    derivedMetrics: [...(intent.derivedMetrics || []).filter(item => !oldGrowthAliases.has(item.alias)), ...periodGrowth],
    expectedResult: {
      ...(intent.expectedResult || {}),
      requiredMetrics: [...new Set([...requiredMetrics, ...periodGrowth.map(item => item.alias)])],
    },
    ambiguities: (intent.ambiguities || []).filter(item => !/同比|环比|增长率|增幅/.test(String(item?.question || ''))),
  };
}

function ambiguityOptions(item, intent = null) {
  if (Array.isArray(item?.options) && item.options.length) return item.options;
  const text = String(item?.question || item?.reason || item?.item || item || '');
  const labels = { revenue: '销售额', profit: '利润', orderCount: '订单数量', quantity: '销量' };
  const candidates = (Array.isArray(item?.candidates) ? item.candidates : [])
    .map(value => labels[value] || value).filter(Boolean);
  if (/同比|环比|增长率|增幅/.test(text)) {
    const metrics = (intent?.metrics || []).map(metric => labels[metric.concept] || metric.concept || metric.field).filter(Boolean);
    const values = candidates.length ? candidates : metrics;
    const derivation = /环比/.test(text) ? '环比增长率' : '同比增长率';
    const options = values.map(label => `${label}${derivation}`);
    if (values.length > 1) options.push(`${values.join('、')}都做${derivation}`);
    return options;
  }
  if (/维度|按什么|哪个对象|谁/.test(text)) return ['按销售大区', '按省份', '按城市', '按销售顾问'];
  if (/时间|年份|期间|去年|前年/.test(text)) return ['按最近两个完整自然年', '指定具体年份', '按月分析'];
  return [];
}

function normalizeAmbiguity(value, index, intent = null) {
  const item = value && typeof value === 'object' ? value : { question: String(value || '') };
  const question = String(item.question || item.message || item.reason || item.item || '').trim();
  if (!question) return null;
  const options = ambiguityOptions(item, intent);
  const explicitBlocking = item.blocking === true || item.required === true || item.status === 'unresolved';
  const defaultOnly = item.blocking === false || (/默认|假设|暂按|可按/.test(question) && !/同比|环比|占比|比例|毛利率|维度|口径/.test(question));
  return {
    ...item,
    id: String(item.id || item.slotId || `ambiguity-${index + 1}`),
    question,
    options,
    blocking: defaultOnly ? false : explicitBlocking || /不明确|未明确|歧义|可能指|需要确认|无法确定/.test(question),
    slotId: item.slotId || String(item.id || `ambiguity-${index + 1}`),
  };
}

function blockingAmbiguities(ambiguities = [], intent = null) {
  return ambiguities.filter(item => item?.blocking === true || item?.status === 'unresolved')
    .filter(item => !item?.resolved);
}

function enforceGrowthBindingAmbiguity(intent, question = '') {
  const text = String(question || '');
  const metrics = (intent?.metrics || []).filter(item => !item.internal && item.alias);
  const asksGrowth = /(?:同比|环比)(?:增长率|增幅)?/.test(text);
  const bindsAll = /分别|各自|(?:全部|所有|三个|都)(?:指标)?(?:计算|做|看)?(?:同比|环比)/.test(text);
  const bindsOne = /(?:销售额|销售收入|收入|营收|利润|订单数量|订单数|订单量|销量)(?:的)?(?:同比|环比)(?:增长率|增幅)?/.test(text);
  if (!asksGrowth || metrics.length < 2 || bindsAll || bindsOne) return intent;
  if ((intent.ambiguities || []).some(item => /同比|环比|增长率|增幅/.test(item?.question || ''))) return intent;
  const ambiguity = normalizeAmbiguity({
    id: 'growth-metric-binding', slotId: 'growth-metric-binding',
    question: `“${/环比/.test(text) ? '环比' : '同比'}增长率”要应用到哪个指标？`,
    candidates: metrics.map(metric => metric.concept || metric.alias),
    blocking: true, required: true,
  }, (intent.ambiguities || []).length, intent);
  return { ...intent, ambiguities: [...(intent.ambiguities || []), ambiguity] };
}

function expandExplicitSeparateGrowth(intent, question = '') {
  const text = String(question || '');
  if (!/(?:同比|环比)(?:增长率|增幅)?/.test(text) || !/分别/.test(text)) return intent;
  const metrics = (intent?.metrics || []).filter(item => !item.internal && item.alias);
  if (metrics.length < 2) return intent;
  const type = /环比/.test(text) ? 'mom' : 'yoy';
  const existing = (intent?.derivedMetrics || []).filter(item => ['yoy', 'mom'].includes(item.type) && item.sourceAlias);
  const expanded = metrics.map(metric => {
    const match = existing.find(item => item.sourceAlias === metric.alias || item.sourceConcept === metric.concept);
    const metricLabel = ({ revenue: '销售额', profit: '利润', orderCount: '订单数量', quantity: '销量' })[metric.concept]
      || metric.field || '指标';
    return {
      ...(match || {}),
      type,
      source: `${metricLabel}${type === 'mom' ? '环比增长率' : '同比增长率'}`,
      sourceConcept: metric.concept,
      sourceAlias: metric.alias,
      alias: match?.alias || `${metric.alias}_${type}`,
      offset: match?.offset || 1,
      resultType: match?.resultType || 'percentage',
      required: match?.required !== false,
      status: match?.status || 'resolved',
    };
  });
  const replacedAliases = new Set((intent.derivedMetrics || []).filter(item => ['yoy', 'mom'].includes(item.type)).map(item => item.alias));
  const baseAliases = new Set(metrics.map(metric => metric.alias));
  const expandedAliases = new Set(expanded.map(metric => metric.alias));
  const requiredMetrics = (intent.expectedResult?.requiredMetrics || []).filter(alias => {
    if (replacedAliases.has(alias)) return false;
    if (baseAliases.has(alias) || expandedAliases.has(alias)) return true;
    return !/growth(?:rate)?|同比|环比/i.test(String(alias));
  });
  return {
    ...intent,
    derivedMetrics: expanded,
    expectedResult: { ...(intent.expectedResult || {}), requiredMetrics: [...new Set([...requiredMetrics, ...expanded.map(item => item.alias)])] },
  };
}

function scopePairwiseComparison(plan, intent) {
  const periods = (intent?.time?.periods || []).map(String);
  const comparisonText = `${intent?.businessQuestion || ''} ${(intent?.constraints || []).map(item => item?.source || '').join(' ')}`;
  if (periods.length !== 2 || !/相比|比较|较/.test(comparisonText)) return plan;
  const steps = plan?.queryProgram?.steps || [];
  const projectionIndex = steps.findIndex(step => step.type === 'project-periods');
  const growthIndex = steps.findIndex(step => step.type === 'derive-period-growth');
  if (projectionIndex < 0 || growthIndex < 0 || projectionIndex < growthIndex) return plan;
  const projection = steps[projectionIndex];
  const reordered = steps.filter((_, index) => index !== projectionIndex);
  reordered.splice(growthIndex, 0, projection);
  return { ...plan, queryProgram: { ...plan.queryProgram, steps: reordered } };
}

function normalizeLlmIntentShape(output, question, skillRefs = [], skills = []) {
  const source = output && typeof output === 'object' ? output : {};
  const metrics = Array.isArray(source.metrics) ? source.metrics.map(item => ({
    ...item,
    field: String(item?.field || item?.fieldRef || '').trim() || null,
    fieldRef: String(item?.fieldRef || item?.field || '').trim() || null,
    concept: item?.concept || item?.conceptId || null,
    conceptId: item?.conceptId || item?.concept || null,
  })).filter(item => item.field) : [];
  const dimensions = Array.isArray(source.dimensions) ? source.dimensions.map(item => ({
    ...item,
    field: String(item?.field || item?.fieldRef || '').trim() || null,
    fieldRef: String(item?.fieldRef || item?.field || '').trim() || null,
    concept: item?.concept || item?.conceptId || null,
    conceptId: item?.conceptId || item?.concept || null,
  })).filter(item => item.field) : [];
  const filters = Array.isArray(source.filters) ? source.filters.map(item => ({
    ...item,
    field: String(item?.field || item?.fieldRef || '').trim() || null,
    fieldRef: String(item?.fieldRef || item?.field || '').trim() || null,
  })).filter(item => item.field) : [];
  let derivedMetrics = Array.isArray(source.derivedMetrics)
    ? source.derivedMetrics.slice(0, 8).map(item => normalizeDerivedMetricShape(item, metrics)).filter(Boolean)
    : [];
  // If the model names a governed Skill metric in the requested outputs but
  // omits its execution recipe, restore that recipe from the loaded Skill.
  // This does not choose a business meaning; it only materializes an already
  // governed formula so the query program can execute and expose it.
  for (const skill of skills || []) {
    for (const metric of skill.metrics || []) {
      if (!metric.formula || !metric.id) continue;
      const terms = [metric.id, metric.concept, metric.name, ...(metric.synonyms || []), metric.outputAlias]
        .filter(Boolean).map(String);
      const requested = terms.some(term => String(question || '').includes(term))
        || listValue(source.expectedResult?.requiredMetrics).includes(metric.outputAlias || metric.id);
      if (!requested) continue;
      const dependencies = (metric.formula.inputs || []).map(metricId => ({ metricId, sourceAlias: metricId }));
      const governed = {
        type: 'formula', operator: metric.formula.operator, metricId: metric.id,
        concept: metric.concept || metric.id, source: metric.name || metric.id,
        alias: metric.outputAlias || metric.id, dependencies,
        resultType: metric.unitFamily === 'percentage' ? 'percentage' : 'number',
        unitFamily: metric.unitFamily || null, aggregationOrder: metric.formula.aggregationOrder || 'aggregate-then-calculate',
        zeroDivision: metric.formula.zeroDivision || 'null', skillRef: `${skill.id}@${skill.version}`, required: true,
      };
      const existingIndex = derivedMetrics.findIndex(item => item.metricId === metric.id || item.alias === metric.outputAlias);
      if (existingIndex < 0) derivedMetrics.push(governed);
      else derivedMetrics[existingIndex] = { ...derivedMetrics[existingIndex], ...governed };
      for (const dependencyId of metric.formula.inputs || []) {
        if (metrics.some(item => item.metricId === dependencyId || item.concept === dependencyId || item.alias === dependencyId)) continue;
        const dependency = (skill.metrics || []).find(item => item.id === dependencyId && item.field);
        if (!dependency) continue;
        metrics.push({
          field: dependency.field,
          fieldRef: dependency.field,
          aggregation: dependency.aggregation || 'sum',
          alias: dependency.id,
          concept: dependency.concept || dependency.id,
          conceptId: dependency.concept || dependency.id,
          metricId: dependency.id,
          unitFamily: dependency.unitFamily || null,
          internal: true,
        });
      }
    }
  }
  const governedAliases = new Map();
  for (const skill of skills || []) for (const metric of skill.metrics || []) {
    if (!metric.formula || !metric.outputAlias) continue;
    for (const key of [metric.id, metric.concept, metric.name, metric.outputAlias, ...(metric.synonyms || [])].filter(Boolean)) governedAliases.set(String(key), metric.outputAlias);
  }
  listValue(source.derivedMetrics).forEach((item, index) => {
    const normalized = derivedMetrics[index];
    if (item?.alias && normalized?.alias) governedAliases.set(String(item.alias), normalized.alias);
  });
  const expectedResult = source.expectedResult && typeof source.expectedResult === 'object'
    ? {
      ...source.expectedResult,
      requiredMetrics: listValue(source.expectedResult.requiredMetrics).map(value => governedAliases.get(String(value)) || value),
    }
    : source.expectedResult;
  return {
    ...source,
    businessQuestion: source.businessQuestion || question,
    metrics,
    dimensions,
    filters,
    derivedMetrics,
    expectedResult,
    // Skill references are provenance, not a second semantic decision. Accept
    // model-emitted short IDs/names but always bind them to loaded versions.
    skillRefs: normalizeSkillRefs(source.skillRefs, skills, skillRefs),
    mappingEvidence: Array.isArray(source.mappingEvidence) ? source.mappingEvidence : [],
    ambiguities: (Array.isArray(source.ambiguities) ? source.ambiguities : [])
      .map((item, index) => normalizeAmbiguity(item, index, { ...source, metrics }))
      .filter(Boolean),
  };
}

function ensureDerivedSourceMetrics(intent, deterministicIntent) {
  const metrics = [...(intent?.metrics || [])];
  for (const derived of intent?.derivedMetrics || []) {
    if (!derived?.sourceAlias || metrics.some(metric => metric.alias === derived.sourceAlias || metric.metricId === derived.sourceAlias || metric.concept === derived.sourceAlias)) continue;
    const baseline = (deterministicIntent?.metrics || []).find(metric => metric.alias === derived.sourceAlias || metric.concept === derived.sourceConcept);
    if (baseline) metrics.push({ ...baseline, internal: false });
  }
  const requiredMetrics = new Set(intent?.expectedResult?.requiredMetrics || []);
  for (const derived of intent?.derivedMetrics || []) if (derived?.sourceAlias) requiredMetrics.add(derived.sourceAlias);
  return { ...intent, metrics, expectedResult: { ...(intent?.expectedResult || {}), requiredMetrics: [...requiredMetrics] } };
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

function regionValues(question) {
  return [...new Set([...String(question || '').matchAll(/(华东|华北|华南|华中|西南|西北|东北)(?:地区|区域)?/g)].map(match => match[1]))];
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
  const unresolvedDerived = (intent?.semanticFrame?.derivedMetrics || []).find(item => item.status === 'unresolved');
  const derivedNeedsTimeGrouping = (intent?.derivedMetrics || []).some(item => ['yoy', 'mom'].includes(item.type))
    && !(intent?.dimensions || []).some(item => item.grain);
  if (unresolvedDerived || unresolvedTypes.has('derived-metric')) {
    const labels = { revenue: '销售额', profit: '利润', orderCount: '订单数', quantity: '销量' };
    const candidates = (unresolvedDerived?.bindingCandidates || intent?.metrics?.filter(item => !item.internal).map(item => item.concept) || [])
      .map(value => labels[value] || value).filter(Boolean);
    if (unresolvedDerived?.type === 'share-of-total') {
      const options = candidates.map(label => `${label}占比`);
      return {
        question: candidates.length
          ? `已识别构成分析，但“占比”的计算指标不明确。请选择需要计算占比的指标。`
          : '已识别构成分析，但还缺少占比指标或分组维度。请明确“哪个指标按什么维度计算占比”。',
        options,
      };
    }
    if (unresolvedDerived?.type === 'formula') {
      return {
        question: `已识别“${unresolvedDerived.source || '派生指标'}”，但当前 Skill 中没有可执行的受治理计算口径。请补充指标定义或改问已有指标。`,
        options: ['查看销售额', '查看利润', '查看订单数', '查看销量'],
      };
    }
    const derivation = unresolvedDerived?.type === 'mom' ? '环比增长率' : '同比增长率';
    const options = candidates.map(label => `${label}${derivation}`);
    if (candidates.length > 1) options.push(`${candidates.join('和')}都做${derivation}`);
    return {
      question: `已识别指标${candidates.length ? `“${candidates.join('、')}”` : ''}，但“${derivation}”的计算对象不明确。请选择需要计算的指标。`,
      options,
    };
  }  if (/partitioned-ranking|分组内排名/.test(joined)) {
    return {
      question: '请确认分组内排名的比较层级和排名对象。',
      options: ['每年按城市取前三名', '每年按省份取前三名', '每个大区按产品取前三名'],
    };
  }
  if (derivedNeedsTimeGrouping || /时间/.test(joined) || unresolvedTypes.has('time-field') || unresolvedTypes.has('time-grouping')) {
    return {
      question: '已识别指标和比较计算，但时间要求尚未形成可执行范围或粒度。请确认分析期间和时间粒度。',
      options: ['查看去年全年', '按年分析', '按月分析'],
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
  const regions = regionValues(question);
  if (regions.length && regionField) filters = [...filters.filter(filter => filter.field !== regionField), { field: regionField, operator: regions.length > 1 ? 'in' : 'eq', value: regions.length > 1 ? regions : regions[0] }];
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
    ...scopePairwiseComparison(compiled, intent),
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
  if (!llm?.enabled || typeof llm.planQueryIntent !== 'function') {
    return plannerResult({
      status: 'error',
      code: 'LLM_UNAVAILABLE',
      message: '当前智能问数需要大模型理解请求，但模型暂不可用，请稍后重试。',
    }, 'llm-required', startedAt, { reason: 'intent-llm-unavailable', llmAttempted: false });
  }
  const llmStartedAt = Date.now();
  try {
    const intentInput = {
      metadata: input.metadata,
      question: input.question,
      previousIntent: input.previousIntent,
      previousRequest: input.previousRequest,
      skills: input.skills || [],
      skillConflicts: input.skillConflicts || [],
      semanticCatalog: buildSemanticCatalog({ metadata: input.metadata, skills: input.skills || [] }),
      supportedCapabilities: CURRENT_NL_CAPABILITIES,
      timeZone: input.timeZone || 'Asia/Shanghai',
      signal: input.signal || null,
    };
    let output = await llm.planQueryIntent(intentInput);
    let adaptedOutput = enforceClarificationResolution(
      enforceGrowthBindingAmbiguity(normalizeLlmIntentShape(output, input.question, input.skillRefs, input.skills || []), input.question),
      input.clarificationResolution,
    );
    const explicitSeparateGrowth = /(?:同比|环比)(?:增长率|增幅)?/.test(String(input.question || '')) && /分别/.test(String(input.question || ''));
    if (explicitSeparateGrowth) adaptedOutput.ambiguities = adaptedOutput.ambiguities.filter(item => !(/同比|环比|增长率|增幅/.test(item.question)));
    const blocking = blockingAmbiguities(adaptedOutput.ambiguities, adaptedOutput);
    if (blocking.length) {
      const first = blocking[0];
      return plannerResult({
        status: 'needs_clarification',
        clarification: first.question,
        options: first.options,
        intent: adaptedOutput,
      }, 'llm-clarification', startedAt, {
        reason: 'intent-ambiguity',
        llmAttempted: true,
        llmDurationMs: Date.now() - llmStartedAt,
      });
    }
    let intent = normalizeBusinessQueryIntentV2({
      ...adaptedOutput,
      source: { planner: 'llm-first-intent-planner', version: '3.0' },
    }, { metadata: input.metadata });
    intent = expandExplicitSeparateGrowth(intent, input.question);
    intent = materializeLlmPeriods(materializeLlmRanking(materializeLlmTimeFilters(ensureDerivedSourceMetrics(intent, null))));
    const mappingValidation = validateSemanticMapping({ intent, metadata: input.metadata, skills: input.skills || [] });
    if (!mappingValidation.valid) throw Object.assign(new Error(mappingValidation.errors.join('；')), { code: 'SEMANTIC_MAPPING_INVALID' });
    let coverage = validateLlmTimeGrouping(intent, validateIntentCoverage(intent), input.question);
    let repairAttempted = false;
    if (!coverage.valid && typeof llm.planQueryIntent === 'function') {
      repairAttempted = true;
      output = await llm.planQueryIntent({ ...intentInput, repairFeedback: coverage.errors.join('；') });
      adaptedOutput = enforceClarificationResolution(
        enforceGrowthBindingAmbiguity(normalizeLlmIntentShape(output, input.question, input.skillRefs, input.skills || []), input.question),
        input.clarificationResolution,
      );
      const repairedBlocking = blockingAmbiguities(adaptedOutput.ambiguities, adaptedOutput);
      if (repairedBlocking.length) {
        const first = repairedBlocking[0];
        return plannerResult({
          status: 'needs_clarification',
          clarification: first.question,
          options: first.options,
          intent: adaptedOutput,
        }, 'llm-clarification', startedAt, { reason: 'intent-ambiguity-after-repair', llmAttempted: true, llmDurationMs: Date.now() - llmStartedAt, repairAttempted });
      }
      intent = normalizeBusinessQueryIntentV2({ ...adaptedOutput, source: { planner: 'llm-first-intent-planner', version: '3.0' } }, { metadata: input.metadata });
      intent = expandExplicitSeparateGrowth(intent, input.question);
      intent = materializeLlmPeriods(materializeLlmRanking(materializeLlmTimeFilters(ensureDerivedSourceMetrics(intent, null))));
      const repairedMapping = validateSemanticMapping({ intent, metadata: input.metadata, skills: input.skills || [] });
      if (!repairedMapping.valid) throw Object.assign(new Error(repairedMapping.errors.join('；')), { code: 'SEMANTIC_MAPPING_INVALID' });
      coverage = validateLlmTimeGrouping(intent, validateIntentCoverage(intent), input.question);
    }
    if (!coverage.valid) throw Object.assign(new Error(`意图模型输出未通过约束覆盖校验：${coverage.errors.join('；')}`), { code: 'INTENT_COVERAGE_INVALID', details: coverage.errors });
    const compiled = compileBusinessQueryIntent(input.metadata, intent);
    if (compiled.status !== 'supported') throw Object.assign(new Error('意图模型输出无法编译为受控查询'), { code: 'INTENT_COMPILE_INVALID' });
    return plannerResult({
      ...scopePairwiseComparison(compiled, intent),
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
    }, 'llm-first', startedAt, {
      reason: repairAttempted ? 'intent-llm-validated-after-repair' : 'intent-llm-validated',
      llmAttempted: true,
      llmDurationMs: Date.now() - llmStartedAt,
      repairAttempted,
    });
  } catch (error) {
    if (input.signal?.aborted || error?.code === 'REQUEST_ABORTED') throw error;
    const semanticContractFailure = ['INTENT_COVERAGE_INVALID', 'INTENT_COMPILE_INVALID', 'SEMANTIC_MAPPING_INVALID'].includes(error?.code);
    return plannerResult({
      status: 'error',
      code: semanticContractFailure ? 'INTENT_VALIDATION_FAILED' : (error?.code || 'LLM_REQUEST_FAILED'),
      message: semanticContractFailure
        ? '大模型已返回理解结果，但未通过平台查询约束校验，请重试。'
        : '大模型服务暂时不可用，请稍后重试。',
    }, 'llm-error', startedAt, {
      reason: error?.code || 'intent-llm-failed',
      errorMessage: String(error?.message || '').slice(0, 500),
      llmAttempted: true,
      llmDurationMs: Date.now() - llmStartedAt,
    });
  }
}

function formatValue(value, metric, unitFamily = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '—');
  if (unitFamily === 'percentage' || /率|占比|比例|同比|环比/.test(metric || '')) {
    return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 }).format(numeric);
  }
  const formatted = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(numeric);
  return unitFamily === 'currency' || /金额|利润|收入|销售额/.test(metric || '') ? `¥${formatted}` : formatted;
}

export function composeQuestionDocument({ metadata, question, plan, resultSet, previousVisualization = null, llmAnswer = null }) {
  const rows = resultSet?.rows || [];
  const primaryMeasure = plan.request.measures[0] || {};
  const metricAlias = primaryMeasure.alias;
  const metric = primaryMeasure.field || primaryMeasure.alias;
  const visibleMeasures = plan.displayRequest?.measures || plan.request.measures;
  const metricNames = [...new Set(visibleMeasures.map(item => item.field || item.alias).filter(Boolean))].join('、');
  const presentationPlan = buildResultPresentationPlan({ metadata, question, request: plan.request, resultSet, previousVisualization });
  const dimensionAlias = presentationPlan.queryProjection.visibleDimensions[0];
  const scalar = !dimensionAlias;
  const blocks = [];
  if (scalar) {
    const value = rows[0]?.[metricAlias] ?? null;
    blocks.push({ id: 'answer-kpi', type: 'kpi', title: metric, value: formatValue(value, metric, primaryMeasure.unitFamily), evidenceIds: ['answer-evidence'] });
    blocks.push({ id: 'answer-summary', type: 'text', title: '回答', content: llmAnswer?.summary || `${question}：${formatValue(value, metric, primaryMeasure.unitFamily)}`, evidenceIds: ['answer-evidence'] });
  } else {
    const rankingMeasure = plan.intent?.ranking?.orderBy
      ? [...(plan.displayRequest?.measures || []), ...(plan.request.measures || [])]
        .find(item => item.alias === plan.intent.ranking.orderBy)
      : null;
    const rankingBasis = rankingMeasure
      ? `${rankingMeasure.field || rankingMeasure.alias}（${aggregationLabel(rankingMeasure.aggregation)}）`
      : null;
    const rankingText = plan.intent?.ranking
      ? plan.intent.ranking.percentage
        ? `按${rankingBasis || '指定指标'}${plan.intent.ranking.direction === 'asc' ? '从低到高' : '从高到低'}排序，取${plan.intent.ranking.direction === 'asc' ? '后' : '前'} ${plan.intent.ranking.percentage}%`
        : `按${rankingBasis || '指定指标'}${plan.intent.ranking.direction === 'asc' ? '从低到高' : '从高到低'}排序，取 ${plan.intent.ranking.limit} 项`
      : '';
    const rangeText = plan.intent?.semanticFrame?.time?.range
      ? `${plan.intent.semanticFrame.time.range.start} 至 ${plan.intent.semanticFrame.time.range.endExclusive}（结束日不含）`
      : '';
    const cumulativeText = plan.intent?.semanticFrame?.accumulation?.mode === 'cumulative-window' ? '累计' : '';
    blocks.push({ id: 'answer-summary', type: 'text', title: '回答', content: llmAnswer?.summary || `已按${plan.request.select.map(item => item.field).join('、') || '指定维度'}计算${rangeText ? `${rangeText}的` : ''}${cumulativeText}${metricNames}${rankingText ? `，${rankingText}` : ''}。`, evidenceIds: ['answer-evidence'] });
    for (const [index, point] of (llmAnswer?.keyPoints || []).entries()) blocks.push({ id: `answer-key-point-${index + 1}`, type: 'text', title: '分析要点', content: point, evidenceIds: ['answer-evidence'] });
    for (const [index, limitation] of (llmAnswer?.limitations || []).entries()) blocks.push({ id: `answer-limitation-${index + 1}`, type: 'warning', title: '数据限制', message: limitation, evidenceIds: ['answer-evidence'] });
    if (presentationPlan.chart?.visualization) {
      const visualization = presentationPlan.chart.visualization;
      blocks.push({
        id: 'answer-chart',
        type: 'chart',
        title: question,
        chartType: visualization.type,
        dataRef: resultSet.id,
        encoding: { x: visualization.encoding.category.field, y: visualization.encoding.measures[0].field },
        visualization,
        evidenceIds: ['answer-evidence'],
      });
    }
    blocks.push({ id: 'answer-table', type: 'table', title: '查询明细', dataRef: resultSet.id, columns: presentationPlan.table.columns, evidenceIds: ['answer-evidence'] });
  }
  const semanticValidation = plan.intent ? validateResultAgainstIntent(resultSet, plan.intent) : { valid: true, errors: [], warnings: [] };
  const qualityWarnings = [...(resultSet?.quality?.warnings || []), ...semanticValidation.warnings].filter(message => {
    const text = String(message || '');
    if (/AI Planner|AI Critic|NONE JSON|WAX 原始日期分组|服务端列裁剪|时间粒度.*归并/.test(text)) return false;
    return /样本|截断|达到(?:结果)?上限|估算|不完整|范围不足|分母为 0|空值/.test(text);
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
    presentationPlan,
    blocks,
    evidence: [{ id: 'answer-evidence', title: question, value: rows, scope: resultSet?.scope || null, semanticValidation }],
    followUpActions: buildFollowUpActions({ metadata, plan, resultSet, question }),
    nextQuestions: [],
  });
}
