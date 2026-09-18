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

import { fiscalYearForDate } from '../semantics/time-semantics.mjs';
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
  'query.aggregate', 'query.detail', 'query.compare', 'query.time-series', 'query.filter',
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

function explicitTimeGrain(question = '') {
  const questionText = String(question);
  return /年月|年\s*月|每月|逐月|按月|月份/.test(questionText)
    ? 'month'
    : /每年|逐年|按年|年度/.test(questionText) ? 'year' : null;
}

function validateLlmTimeGrouping(intent, coverage, question = '') {
  const errors = [...(coverage?.errors || [])];
  const questionText = String(question || '');
  const explicitlyRequestedGrain = explicitTimeGrain(questionText);
  const timeDimensions = (intent?.dimensions || []).filter(item => item?.grain);
  if (explicitlyRequestedGrain && !timeDimensions.length) {
    errors.push(`问题明确要求按${explicitlyRequestedGrain === 'month' ? '月' : '年'}分组，但意图遗漏了时间分组字段`);
  } else if (explicitlyRequestedGrain && !timeDimensions.some(item => item.grain === explicitlyRequestedGrain)) {
    errors.push(`问题明确要求按${explicitlyRequestedGrain === 'month' ? '月' : '年'}分组，但意图时间粒度不一致`);
  }
  const explicitGrouping = Boolean(intent?.time?.groupingExplicit || intent?.time?.grouping)
    || Boolean(explicitlyRequestedGrain)
    || /(?:按|每|逐)(?:季度|季|周|日|天)|时间趋势|时间序列|逐期|月度|季度|年度|年月|月份/.test(questionText);
  const derivedNeedsTime = (intent?.derivedMetrics || []).some(item => ['yoy', 'mom'].includes(item?.type));
  const expectsTimeSeries = explicitGrouping && (intent?.expectedResult?.shape === 'time-series'
    || Boolean(intent?.time?.grain)
    || (intent?.expectedResult?.requiredPeriods || []).length > 0);
  if ((expectsTimeSeries || derivedNeedsTime) && !(intent?.dimensions || []).some(item => item?.grain)) {
    errors.push('时间序列缺少按指定粒度的时间分组字段');
  }
  if ((intent?.time?.periods || []).length && intent?.time?.field
      && !(intent?.filters || []).some(item => item?.field === intent.time.field)) {
    errors.push('明确时间期间缺少对应的时间范围过滤');
  }
  const hasExplicitPeriod = /(?:19|20)\d{2}年|去年|今年|本年度/.test(questionText);
  const hasTimePeriodFilter = (intent?.filters || []).some(item => item?.field === intent?.time?.field);
  if (hasExplicitPeriod && !hasTimePeriodFilter) {
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
  if (intent?.time?.calendar !== 'fiscal' && relativeRange && (intent?.time?.range?.start !== relativeRange.start || intent?.time?.range?.endExclusive !== relativeRange.endExclusive)) {
    errors.push(`相对时间范围与当前日期不一致，应为 ${relativeRange.start} 至 ${relativeRange.endExclusive}`);
  }
  return { ...coverage, valid: errors.length === 0, errors };
}

function temporalMetadataField(metadata, fieldName) {
  const field = (metadata?.fields || []).find(item => item?.name === fieldName);
  if (!field) return false;
  return field.role === 'time'
    || field.valueKind === 'temporal'
    || /date|time/i.test(String(field.type || ''))
    || /date|time/i.test(String(field.rawType || ''));
}

function fiscalPeriodValue(value) {
  const match = String(value ?? '').trim().match(/^(?:FY\s*)?(\d{2}|\d{4})$/i);
  return match ? match[1].slice(-2) : null;
}

function materializeLlmTimeFilters(intent, metadata = null) {
  const range = intent?.time?.range;
  const field = intent?.time?.field;
  if (!field || !range?.start || !range?.endExclusive) return intent;
  const filters = intent.filters || [];
  if (!temporalMetadataField(metadata, field)) {
    const periods = listValue(intent?.time?.periods).map(fiscalPeriodValue).filter(Boolean);
    const exactPeriodFilter = filters.some(item => item?.field === field && ['eq', 'in'].includes(item?.operator));
    if (intent?.time?.calendar !== 'fiscal' && !exactPeriodFilter) {
      throw new Error('日期范围不能应用到非日期字段：' + field);
    }
    const cleanedFilters = filters.filter(item => !(
      item?.field === field
      && ['gt', 'gte', 'lt', 'lte'].includes(item?.operator)
      && /^\d{4}-\d{2}-\d{2}$/.test(String(item?.value || ''))
    ));
    if (!exactPeriodFilter && periods.length) {
      cleanedFilters.push({
        field,
        operator: periods.length === 1 ? 'eq' : 'in',
        value: periods.length === 1 ? periods[0] : periods,
      });
    }
    return {
      ...intent,
      filters: cleanedFilters,
      time: { ...(intent.time || {}), range: null },
    };
  }
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

function semanticItemKey(item) {
  // Concepts are LLM labels; the executable identity is the catalog field and grain.
  return [item?.field, item?.grain || null].map(value => String(value || '')).join('|');
}

function alignLlmInternalDimensions(intent, baseline) {
  const baselineByKey = new Map((baseline?.dimensions || []).map(item => [semanticItemKey(item), item]));
  const requiredAliases = new Set(intent?.expectedResult?.requiredDimensions || []);
  return {
    ...intent,
    dimensions: (intent?.dimensions || []).map(item => {
      const reference = baselineByKey.get(semanticItemKey(item));
      return reference?.internal && !requiredAliases.has(item.alias) ? { ...item, internal: true } : item;
    }),
  };
}

function normalizedConstraintValue(value) {
  return Array.isArray(value)
    ? value.map(item => String(item)).sort()
    : value == null ? null : String(value);
}

function intentFilterSignature(filter) {
  return JSON.stringify({
    field: String(filter?.field || ''),
    operator: String(filter?.operator || 'eq'),
    value: normalizedConstraintValue(filter?.value),
    negated: Boolean(filter?.negated),
  });
}

function semanticConceptRoot(value) {
  return String(value || '').replace(/(?:Category|Subcategory|Name|Type|Level\d*)$/i, '').toLowerCase();
}

function validateLlmConstraintPreservation(intent, baseline, question = '', skills = [], metadata = null) {
  const errors = [];
  const candidateDimensions = new Set((intent?.dimensions || []).filter(item => !item?.internal).map(semanticItemKey));
  const candidateFiltersByField = new Set((intent?.filters || []).map(item => item?.field).filter(Boolean));
  const candidateFilterConceptRoots = new Set();
  for (const skill of skills || []) {
    for (const entity of skill?.businessEntities || []) {
      if (candidateFiltersByField.has(entity?.field)) {
        candidateFilterConceptRoots.add(semanticConceptRoot(entity.concept || entity.id || entity.name));
      }
    }
  }
  const timeFields = new Set([baseline?.time?.field, intent?.time?.field].filter(Boolean).map(String));
  const requiredDimensionAliases = new Set((intent?.expectedResult?.requiredDimensions || []).map(String));
  const requiredDimensions = new Map();

  for (const item of baseline?.dimensions || []) {
    if (item?.internal) continue;
    const resolvedAsRelatedFilter = candidateFilterConceptRoots.has(semanticConceptRoot(item?.concept));
    const candidateUsesAsFilterOnly = (candidateFiltersByField.has(item?.field) || resolvedAsRelatedFilter)
      && !requiredDimensionAliases.has(String(item?.alias || ''));
    if (candidateUsesAsFilterOnly) continue;
    requiredDimensions.set(semanticItemKey(item), item);
  }

  // Dataset-bound Skill terms are reliable semantic references even when the
  // generic pre-parser does not know their business vocabulary.
  for (const skill of skills || []) {
    for (const entity of skill?.businessEntities || []) {
      const terms = [entity.name, ...(entity.synonyms || [])].filter(Boolean).map(String);
      const field = String(entity.field || '');
      if (!field || !terms.some(term => String(question || '').includes(term))) continue;
      if (metadata && !metadata.fields?.some(item => item.name === field)) continue;
      // Concept/id values are model-authored labels, not executable field
      // identities. Only governed field and business names may establish this
      // additional field-level requirement.
      const entityAliases = [entity.name, field].filter(Boolean).map(String);
      const explicitlyRequired = entityAliases.some(alias => requiredDimensionAliases.has(alias))
        || (intent.dimensions || []).some(item => item.field === field && requiredDimensionAliases.has(item.alias));
      if (!explicitlyRequired) continue;
      requiredDimensions.set(semanticItemKey({ field, grain: null }), { field, grain: null });
    }
  }

  for (const [key, item] of requiredDimensions) {
    if (!candidateDimensions.has(key)) errors.push('用户明确要求的维度未保留：' + (item.field || item.alias || item.concept || '未知'));
  }

  const baselineHasExplicitMetrics = Boolean(baseline?.semanticFrame?.metrics?.length)
    || Boolean(baseline?.transition?.inheritsPriorContext);
  if (baselineHasExplicitMetrics) {
    const candidateMetrics = new Set((intent?.metrics || []).filter(item => !item?.internal).map(semanticItemKey));
    for (const item of baseline?.metrics || []) {
      const projectedAsRawField = intent?.expectedResult?.shape === 'detail-table'
        && candidateDimensions.has(semanticItemKey(item));
      if (!item?.internal && !candidateMetrics.has(semanticItemKey(item)) && !projectedAsRawField) {
        errors.push('用户明确要求的指标未保留：' + (item.field || item.alias || item.concept || '未知'));
      }
    }
  }

  const actualFilterSignatures = new Set((intent?.filters || []).map(intentFilterSignature));
  for (const filter of baseline?.filters || []) {
    // Relative and fiscal time expressions are normalized by the dedicated
    // time contract. Their executable field or range may legitimately change
    // during materialization, so generic business-filter equality must not
    // reject an otherwise equivalent or more complete time interpretation.
    if (timeFields.has(String(filter?.field || ''))) continue;
    if (!actualFilterSignatures.has(intentFilterSignature(filter))) {
      errors.push('用户明确要求的筛选条件未保留：' + (filter.field || '未知字段'));
    }
  }

  for (const skill of skills || []) {
    for (const entity of skill?.businessEntities || []) {
      const patterns = Array.isArray(entity.sourceValuePatterns) ? entity.sourceValuePatterns : [];
      const actual = (intent?.filters || []).find(filter => filter.field === entity.field);
      if (!actual || Array.isArray(actual.value)) continue;
      for (const source of patterns) {
        let match = null;
        try { match = String(question || '').match(new RegExp(source, 'u')); } catch { continue; }
        if (match?.[0] && String(actual.value) !== match[0]) {
          errors.push(`筛选值必须保留数据集源值原文：${entity.field}=${match[0]}`);
        }
      }
    }
  }

  for (const expected of baseline?.derivedMetrics || []) {
    const expectedSourceField = (baseline?.metrics || []).find(item => item.alias === expected.sourceAlias)?.field || null;
    const actual = (intent?.derivedMetrics || []).find(item => {
      if (item.type !== expected.type) return false;
      if (expected.metricId && item.metricId !== expected.metricId) return false;
      const actualSourceField = (intent?.metrics || []).find(metric => metric.alias === item.sourceAlias)?.field || null;
      return !expectedSourceField || actualSourceField === expectedSourceField;
    });
    if (!actual) errors.push('用户明确要求的派生指标未保留：' + (expected.source || expected.metricId || expected.alias || '未知'));
  }

  if (baseline?.ranking) {
    const actual = intent?.ranking;
    if (!actual
      || actual.limit !== baseline.ranking.limit
      || actual.direction !== baseline.ranking.direction
      || (actual.percentage || null) !== (baseline.ranking.percentage || null)) {
      errors.push('用户明确要求的排名约束未保留');
    }
  }

  if (baseline?.visualizationIntent?.explicit
      && intent?.visualizationIntent?.type !== baseline.visualizationIntent.type) {
    errors.push('用户明确要求的图表类型未保留：' + baseline.visualizationIntent.type);
  }

  return errors;
}
function unsupportedCapabilityClarification(error, previousInvalidIntent = null) {
  const message = String(error?.message || '');
  const missing = message.match(/意图字段不在语义目录中：([^；;]+)/)?.[1]
    || message.match(/原问题(?:指标|维度)未覆盖：([^；;]+)/)?.[1]
    || message.match(/必需(?:指标|维度)\s+([^\s；;]+)未引用/)?.[1]
    || null;
  const label = missing ? `“${missing}”` : '该字段或指标';
  return {
    status: 'needs_clarification',
    clarification: `当前数据集不包含${label}，且无法根据现有字段计算得到。请修改问题，或选择仅查询当前数据集支持的字段。`,
    options: ['修改问题后重试', '仅查询当前数据集支持的字段'],
    intent: previousInvalidIntent,
  };
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

function enforceSkillTemporalAmbiguity(intent, question = '', skills = []) {
  const text = String(question || '');
  if (!/(?:去年|前年|今年|本年|当年)/.test(text)) return intent;
  const skill = (skills || []).find(item => item?.defaultCalendar || item?.calendarPolicy?.default);
  const explicitNatural = /自然年|日历年/.test(text);
  if (skill?.defaultCalendar === 'fiscal' || skill?.calendarPolicy?.default === 'fiscal') {
    const calendar = explicitNatural ? 'gregorian' : 'fiscal';
    const assumptions = [...new Set([
      ...(intent.assumptions || []),
      explicitNatural
        ? '用户明确自然年，按赢单日期口径统计，覆盖数据集默认财年。'
        : (skill.calendarPolicy?.displayAssumption || '未明确自然年时，相对年份按赢单财年解释。'),
    ])];
    return {
      ...intent,
      time: { ...(intent.time || {}), calendar },
      assumptions,
      ambiguities: (intent.ambiguities || []).filter(item => !/自然年|财年|时间口径/.test(String(item?.question || ''))),
    };
  }
  const clarification = text.match(/用户澄清[：:]([^；;]*)/)?.[1] || '';
  if (/自然年|日历年|财年|FY/i.test(clarification)) return intent;
  const declared = skills.some(skill => [
    ...(skill.temporalSemantics || []),
    ...(skill.relativeTemporalSemantics || []),
  ].some(item => /自然年.*财年|财年.*自然年|必须澄清|先确认口径/.test(String(item?.ambiguity || ''))));
  if (!declared) return intent;
  if ((intent.ambiguities || []).some(item => /自然年|财年|时间口径/.test(String(item?.question || '')))) return intent;
  const ambiguity = normalizeAmbiguity({
    id: 'relative-year-calendar',
    slotId: 'relative-year-calendar',
    question: '这里的相对年份按自然年还是赢单财年统计？',
    options: ['按自然年（赢单日期）', '按赢单财年'],
    blocking: true,
    required: true,
  }, (intent.ambiguities || []).length, intent);
  return { ...intent, ambiguities: [...(intent.ambiguities || []), ambiguity] };
}

function normalizeSkillFiscalFilter(intent, question = '', skills = [], metadata = null, now = new Date(), timeZone = 'Asia/Shanghai') {
  const text = String(question || '');
  if (!/(?:去年|前年|今年|本年|当年)/.test(text) || /自然年|日历年/.test(text)) return intent;
  const skill = (skills || []).find(item => (item?.defaultCalendar || item?.calendarPolicy?.default) === 'fiscal');
  const policy = skill?.calendarPolicy;
  if (!policy?.fiscalYearField || !(metadata?.fields || []).some(field => field.name === policy.fiscalYearField)) return intent;
  const offset = /前年/.test(text) ? -2 : /去年/.test(text) ? -1 : 0;
  const fiscal = fiscalYearForDate(now, { fiscalYearStart: policy.fiscalYearStart, timeZone });
  if (!fiscal) return intent;
  const fiscalValue = String(fiscal.endYear + offset).slice(-2);
  const fiscalLabel = `FY${fiscalValue}`;
  const replacedFields = new Set([policy.fiscalYearField, policy.dateField, intent?.time?.field].filter(Boolean));
  return {
    ...intent,
    filters: [
      ...(intent.filters || []).filter(item => !replacedFields.has(item?.field)),
      { field: policy.fiscalYearField, operator: 'eq', value: fiscalValue },
    ],
    time: { ...(intent.time || {}), field: policy.fiscalYearField, calendar: 'fiscal', periods: [fiscalValue], range: null,
      materialization: { anchorFiscalYear: fiscal.value, relativeOffset: offset, fiscalYearStart: policy.fiscalYearStart || '01-01' } },
    assumptions: [...new Set([...(intent.assumptions || []), `${policy.displayAssumption || '相对年份按赢单财年解释。'} 本次相对年份物化为 ${fiscalLabel}。`])],
  };
}

function membershipGroupingErrors(intent) {
  const groups = new Map();
  for (const filter of intent.filters || []) {
    if (filter.operator !== 'containsAny' || listValue(filter.value).length !== 1) continue;
    const members = groups.get(filter.field) || new Set();
    members.add(String(listValue(filter.value)[0]));
    groups.set(filter.field, members);
  }
  return [...groups].filter(([, members]) => members.size > 1).map(([field]) =>
    `字段 ${field} 的多个单值 containsAny 在 filters 之间会按 AND 执行。请依据用户原意明确改为一个 containsAny（任一成员）或 containsAll（全部成员），值使用数组；不得静默把并集变成交集。`);
}

function fiscalMaterializationErrors(intent, reference) {
  if (reference?.calendar !== 'fiscal' || reference.periods?.length !== 1) return [];
  const expected = String(reference.periods[0]);
  const yearValue = value => String(value ?? '').trim().match(/^(?:FY\s*)?(\d{2}|\d{4})$/i)?.[1]?.slice(-2);
  const errors = [];
  const values = [
    ...(intent.time?.periods || []),
    ...(intent.expectedResult?.requiredPeriods || []),
    ...(intent.filters || []).filter(item => item.field === reference.field)
      .flatMap(item => Array.isArray(item.value) ? item.value : [item.value]),
  ];
  if (values.some(value => yearValue(value) && yearValue(value) !== expected)) {
    errors.push(`时间筛选或期间与已配置日历不一致，本次相对年份应为 FY${expected}`);
  }
  // Check explicit fiscal labels, without rewriting model-authored explanations.
  // Comparative reasoning may legitimately mention more than one fiscal period.
  if (!intent.comparison && !(intent.derivedMetrics || []).some(item => ['yoy', 'mom'].includes(item.type))) {
    const descriptions = [
      ...(intent.constraints || []).filter(item => ['time', 'time-scope'].includes(item.type)).map(item => ({ text: JSON.stringify(item.normalized), allowAnchor: false })),
      ...(intent.assumptions || []).filter(item => /今年|去年|前年|本年|当年|相对年份/.test(item)).map(text => ({ text, allowAnchor: true })),
    ];
    const conflicts = descriptions.filter(({ text, allowAnchor }) => [...String(text).matchAll(/\bFY\s*(\d{4}|\d{2})(?!\d)/gi)].some(match => {
      const prefix = String(text).slice(0, match.index);
      const isAnchor = allowAnchor && /(?:当前(?:日期[^，,。；;]{0,40})?(?:所属)?财年|当前日期\s*\d{4}-\d{2}-\d{2}|今年|本年|当年)(?:对应|为|是|等于|属于|：|:|\s)*$/.test(prefix);
      const referenceYear = isAnchor && reference.anchorFiscalYear ? reference.anchorFiscalYear : expected;
      return match[1].slice(-2) !== referenceYear;
    }));
    if (conflicts.length) {
      errors.push(`时间账本或相对年份说明与执行期间冲突，应由模型统一为 FY${expected}。请在查询口径中明确描述目标 FY${expected}；冲突片段：${conflicts.map(item => String(item.text).slice(0, 240)).join('；')}`);
    }
  }
  return errors;
}

function normalizeUnregisteredShareFormula(intent, metadata, question = '', skills = []) {
  if (!/占比|比例|份额/.test(String(question || ''))) return intent;
  const governedIds = new Set((skills || []).flatMap(skill => (skill.metrics || []).filter(metric => metric.formula).map(metric => metric.id)));
  const candidate = (intent?.derivedMetrics || []).find(item => ['formula', 'ratio'].includes(item?.type) && ['divide', 'ratio', 'percentage'].includes(item?.operator) && !governedIds.has(item.metricId));
  if (!candidate) return intent;
  const filter = (intent.filters || []).find(item => ['eq', 'in'].includes(item?.operator) && item?.field && !/日期|时间|年|月/.test(item.field));
  const source = (intent.metrics || []).find(item => !item.internal) || intent.metrics?.[0];
  if (!filter || !source) return intent;
  const existing = (intent.dimensions || []).find(item => item.field === filter.field);
  const dimension = existing || { field: filter.field, alias: 'share_dimension', concept: /产品小类/.test(filter.field) ? 'productSubcategory' : 'dimension', grain: null };
  const dimensions = existing ? intent.dimensions : [...(intent.dimensions || []), dimension];
  const derived = {
    ...candidate,
    type: 'share-of-total',
    source: candidate.source || `${filter.field}占比`,
    sourceConcept: source.concept,
    sourceAlias: source.alias,
    alias: candidate.alias || `${source.alias}_share`,
    shareDimensionConcept: dimension.concept,
    shareDimensionAlias: dimension.alias,
    partitionBy: [],
    denominatorScope: 'filtered-result',
    status: 'resolved',
  };
  return { ...intent, dimensions, derivedMetrics: [...(intent.derivedMetrics || []).filter(item => item !== candidate), derived] };
}

function enforceResultLimitContract(intent) {
  if (!intent?.expectedResult || intent.ranking) return intent;
  return {
    ...intent,
    expectedResult: {
      ...intent.expectedResult,
      maximumRows: 20000,
      minimumRows: Math.min(20000, Number(intent.expectedResult.minimumRows) || 0),
    },
  };
}

function ensureExecutableListMetric(intent, metadata) {
  if (intent?.expectedResult?.shape === 'detail-table' || (intent?.metrics || []).length || !(intent?.dimensions || []).length) return intent;
  const identifier = (metadata?.fields || []).find(field => field?.role === 'identifier');
  const metric = identifier
    ? { field: identifier.name, fieldRef: identifier.name, aggregation: 'distinctCount', alias: 'record_count', concept: 'recordCount', internal: true }
    : { field: null, fieldRef: null, aggregation: 'countRows', alias: 'record_count', concept: 'recordCount', internal: true };
  return { ...intent, metrics: [metric] };
}

function normalizeProjectionShapeByFieldRoles(intent, metadata) {
  const dimensions = intent?.dimensions || [];
  if (!dimensions.length) return intent;
  const fieldMap = new Map((metadata?.fields || []).map(field => [field.name, field]));
  const isProjectionField = item => {
    const field = fieldMap.get(item?.field);
    if (!field || item?.grain) return false;
    return field.role === 'measure'
      || field.role === 'time'
      || /number|decimal|double|float|int|long|date|time/i.test(`${field.type || ''} ${field.rawType || ''}`);
  };
  const projectionFields = dimensions.filter(isProjectionField);
  if (!projectionFields.length) {
    if (intent?.expectedResult?.shape !== 'detail-table') return intent;
    return { ...intent, expectedResult: { ...intent.expectedResult, shape: 'grouped-table' } };
  }

  const projectedSources = new Set(projectionFields.map(item => item.field));
  const removedMetricAliases = new Set();
  const metrics = (intent?.metrics || []).filter(metric => {
    const removable = metric?.internal || projectedSources.has(metric?.field);
    if (removable && metric?.alias) removedMetricAliases.add(metric.alias);
    return !removable;
  });
  const canProject = !metrics.length
    && !(intent?.derivedMetrics || []).length
    && !(intent?.resultFilters || []).length
    && !intent?.ranking;
  if (!canProject) return intent;

  const requiredDimensions = new Set(intent?.expectedResult?.requiredDimensions || []);
  for (const item of projectionFields) if (item?.alias) requiredDimensions.add(item.alias);
  return {
    ...intent,
    metrics: [],
    expectedResult: {
      ...(intent.expectedResult || {}),
      shape: 'detail-table',
      requiredMetrics: (intent?.expectedResult?.requiredMetrics || []).filter(alias => !removedMetricAliases.has(alias)),
      requiredDimensions: [...requiredDimensions],
    },
  };
}

function applyGovernedDisplayLabels(intent, question, skills = [], metadata = null) {
  const outputClause = String(question || '').match(/(?:返回|列出|列举|展示|显示|输出|给出|字段(?:为|包括)?|信息(?:为|包括)?)[：:，,、\s]*(.+)$/)?.[1] || '';
  const catalog = new Map((metadata?.fields || []).map(field => [field.name, field]));
  const candidatesFor = (field, aggregation = null) => (skills || []).flatMap(skill => [
    ...(skill?.businessEntities || []).filter(item => item?.field === field).map(item => ({ name: item.name, synonyms: item.synonyms || [], priority: 1 })),
    ...(skill?.metrics || []).filter(item => item?.field === field && (!aggregation || !item?.aggregation || item.aggregation === aggregation))
      .map(item => ({ name: item.name, synonyms: item.synonyms || [], priority: 2 })),
  ]);
  const labelFor = item => {
    if (item?.displayName || item?.label) return item.displayName || item.label;
    const candidates = candidatesFor(item?.field, item?.aggregation);
    const terms = candidates.flatMap(candidate => [candidate.name, ...candidate.synonyms]
      .filter(Boolean).map(term => ({ term: String(term), priority: candidate.priority })))
      .sort((left, right) => right.term.length - left.term.length || right.priority - left.priority);
    const explicit = terms.find(value => outputClause.includes(value.term)) || terms.find(value => String(question || '').includes(value.term));
    if (explicit) return explicit.term;
    const governed = candidates.sort((left, right) => right.priority - left.priority).find(candidate => candidate.name)?.name;
    return governed || catalog.get(item?.field)?.displayName || catalog.get(item?.field)?.label || item?.field;
  };
  return {
    ...intent,
    dimensions: (intent?.dimensions || []).map(item => ({ ...item, displayName: labelFor(item) })),
    metrics: (intent?.metrics || []).map(item => ({ ...item, displayName: labelFor(item) })),
  };
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
  const resultFilters = Array.isArray(source.resultFilters) ? source.resultFilters.map(item => ({
    field: String(item?.field || item?.alias || '').trim(),
    operator: String(item?.operator || '').trim(),
    value: Number(item?.value),
  })).filter(item => item.field) : [];
  let derivedMetrics = Array.isArray(source.derivedMetrics)
    ? source.derivedMetrics.slice(0, 8).map(item => normalizeDerivedMetricShape(item, metrics)).filter(Boolean)
    : [];
  const formulaDependencyIds = new Set(derivedMetrics
    .filter(item => item?.type === 'formula' && item?.required !== false)
    .flatMap(item => (item.dependencies || []).map(dependency => dependency.metricId || dependency.sourceAlias))
    .filter(Boolean).map(String));
  const explicitlyMentionedConcepts = new Set();
  for (const skill of skills || []) {
    for (const metric of skill.metrics || []) {
      const terms = [metric.id, metric.concept, metric.name, ...(metric.synonyms || []), metric.field]
        .filter(Boolean).map(String);
      const formulaOutputRequested = metric.formula && terms.some(term => String(question || '').includes(term));
      // Short dependency synonyms such as “毛利” must not match a governed
      // output phrase such as “毛利率”; only the dependency's canonical name,
      // id, concept, or source field counts as an explicit user request.
      const dependencyTerms = [metric.id, metric.concept, metric.name, metric.field].filter(Boolean).map(String);
      const dependencyOnly = !metric.formula && dependencyTerms.some(term => String(question || '').includes(term));
      if (formulaOutputRequested || dependencyOnly) {
        explicitlyMentionedConcepts.add(String(metric.id || metric.concept || metric.name));
        explicitlyMentionedConcepts.add(String(metric.concept || metric.id || metric.name));
      }
    }
  }
  // The model may omit internal=false/true metadata. A dependency that exists
  // only to execute a governed formula is internal unless the user explicitly
  // requested its business concept/name in the question.
  for (const metric of metrics) {
    if (!formulaDependencyIds.has(String(metric.metricId || metric.concept || metric.alias))) continue;
    const explicit = [metric.concept, metric.metricId, metric.alias, metric.field]
      .filter(Boolean).some(term => String(question || '').includes(String(term)))
      || explicitlyMentionedConcepts.has(String(metric.metricId || metric.concept || metric.alias));
    if (!explicit) metric.internal = true;
  }
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
    resultFilters,
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

function documentTimeRange(plan) {
  const range = plan?.intent?.time?.range;
  if (range?.start && (range.endExclusive || range.end)) {
    return { start: range.start, end: range.endExclusive || range.end };
  }
  const year = Number(plan?.semantic?.year);
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
  return { start: `${year}-01-01`, end: `${year + 1}-01-01` };
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
  let intent = buildBusinessQueryIntent({ metadata, question: text, previousIntent, previousRequest, skillRefs, skills, now, timeZone });
  intent = enforceResultLimitContract(normalizeSkillFiscalFilter(intent, text, skills, metadata, now, timeZone));
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
  const planningNow = input.now || new Date();
  const timeZone = input.timeZone || 'Asia/Shanghai';
  const resolvedTime = normalizeSkillFiscalFilter({}, input.question, input.skills || [], input.metadata, planningNow, timeZone).time || null;
  const temporalReference = resolvedTime ? { ...resolvedTime, ...resolvedTime.materialization, scope: 'requested-period' } : null;
  const llmStartedAt = Date.now();  const deterministicBaseline = buildBusinessQueryIntent({
    metadata: input.metadata,
    question: input.question,
    previousIntent: input.previousIntent,
    previousRequest: input.previousRequest,
    skillRefs: input.skillRefs || [],
    skills: input.skills || [],
    now: planningNow,
    timeZone,
  });
  const vagueEntity = (deterministicBaseline.semanticFrame?.dimensions || []).find(item => {
    const source = String(item?.source || '');
    return source && new RegExp(`(?:某个|某一|某位|一个)[^，,。；;]{0,8}${source}`).test(String(input.question || ''));
  });
  if (vagueEntity && !(deterministicBaseline.filters || []).length) {
    return plannerResult({
      status: 'needs_clarification',
      clarification: `请明确要查询的${vagueEntity.source}具体值。`,
      options: [],
      intent: deterministicBaseline,
    }, 'semantic-clarification', startedAt, {
      reason: 'unresolved-entity-reference', llmAttempted: false,
    });
  }
  let repairAttempted = false;
  let repairFeedback = null;
  let llmCalls = 0;
  let previousInvalidIntent = null;
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
      timeZone,
      currentDate: new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(planningNow),
      temporalReference,
      signal: input.signal || null,
      onEvent: input.onLlmEvent || null,
    };
    while (llmCalls < 3) {
      llmCalls += 1;
      const output = await llm.planQueryIntent({ ...intentInput,
        ...(repairFeedback ? { repairFeedback, previousInvalidIntent, repairAttempt: llmCalls - 1 } : {}) });
      previousInvalidIntent = structuredClone(output);
      let adaptedOutput = enforceClarificationResolution(
        enforceSkillTemporalAmbiguity(
          enforceGrowthBindingAmbiguity(normalizeLlmIntentShape(output, input.question, input.skillRefs, input.skills || []), input.question),
          input.question,
          input.skills || [],
        ),
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
          reason: repairAttempted ? 'intent-ambiguity-after-repair' : 'intent-ambiguity',
          llmAttempted: true,
          llmDurationMs: Date.now() - llmStartedAt,
          repairAttempted,
          llmCalls,
        });
      }
      let intent;
      let temporalErrors = [];
      try {
        intent = normalizeBusinessQueryIntentV2({
          ...adaptedOutput,
          source: { planner: 'llm-first-intent-planner', version: '3.0' },
        }, { metadata: input.metadata });
        temporalErrors = fiscalMaterializationErrors(intent, temporalReference);
        intent = normalizeSkillFiscalFilter(intent, input.question, input.skills || [], input.metadata, planningNow, timeZone);
        intent = normalizeUnregisteredShareFormula(intent, input.metadata, input.question, input.skills || []);
        intent = normalizeProjectionShapeByFieldRoles(intent, input.metadata);
        intent = ensureExecutableListMetric(intent, input.metadata);
        intent = enforceResultLimitContract(intent);
        intent = expandExplicitSeparateGrowth(intent, input.question);
        intent = materializeLlmPeriods(materializeLlmRanking(materializeLlmTimeFilters(
          ensureDerivedSourceMetrics(intent, null),
          input.metadata,
        )));
        intent = alignLlmInternalDimensions(intent, deterministicBaseline);
        intent = applyGovernedDisplayLabels(intent, input.question, input.skills || [], input.metadata);
      } catch (error) {
        const validationMessage = String(error?.message || '');
        const recoverableModelShape = /BusinessQueryIntent v2|意图字段不在语义目录/.test(validationMessage);
        if (!recoverableModelShape) throw error;
        if (llmCalls < 3) {
          repairAttempted = true;
          repairFeedback = validationMessage;
          continue;
        }
        throw Object.assign(new Error(validationMessage), { code: 'SEMANTIC_MAPPING_INVALID', details: [validationMessage] });
      }

      // An explicitly unresolved required slot is a user-facing clarification,
      // not a transient model-shape failure. Preserve it instead of retrying the
      // same unresolved intent and eventually turning it into a generic error.
      const unresolved = (intent.constraints || []).filter(item => item.required && item.status !== 'resolved');
      if (unresolved.length) {
        const clarification = clarificationForErrors(unresolved.map(item => `未解析约束：${item.type}`), intent);
        return plannerResult({
          status: 'needs_clarification',
          clarification: clarification.question,
          options: clarification.options,
          intent,
        }, 'llm-clarification', startedAt, {
          reason: 'intent-unresolved-required-slot',
          llmAttempted: true,
          llmDurationMs: Date.now() - llmStartedAt,
          repairAttempted,
          llmCalls,
        });
      }

      const mappingValidation = validateSemanticMapping({ intent, metadata: input.metadata, skills: input.skills || [] });
      const mappingErrors = [
        ...temporalErrors,
        ...membershipGroupingErrors(intent),
        ...(mappingValidation.errors || []),
      ];
      const coverage = validateLlmTimeGrouping(intent, validateIntentCoverage(intent), input.question);
      const coverageErrors = [
        ...(coverage.errors || []),
        ...validateLlmConstraintPreservation(intent, deterministicBaseline, input.question, input.skills || [], input.metadata),
      ];
      let compiled = null;
      let compileErrors = [];
      if (!mappingErrors.length && !coverageErrors.length) {
        try {
          compiled = compileBusinessQueryIntent(input.metadata, intent);
          if (compiled.status !== 'supported') compileErrors = compiled.errors?.length ? compiled.errors : ['意图模型输出无法编译为受控查询'];
        } catch (error) {
          compileErrors = [String(error?.message || '意图模型输出无法编译为受控查询')];
        }
      }
      const validationErrors = [...mappingErrors, ...coverageErrors, ...compileErrors];
      if (validationErrors.length) {
        const validationCode = mappingErrors.length
          ? 'SEMANTIC_MAPPING_INVALID'
          : coverageErrors.length ? 'INTENT_COVERAGE_INVALID' : 'INTENT_COMPILE_INVALID';
        if (llmCalls < 3) {
          repairAttempted = true;
          repairFeedback = validationErrors.join('；');
          continue;
        }
        throw Object.assign(new Error(validationErrors.join('；')), { code: validationCode, details: validationErrors });
      }
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
        llmCalls,
      });
    }
    throw Object.assign(new Error('意图模型修复轮次已用尽'), { code: 'INTENT_VALIDATION_FAILED' });
  } catch (error) {
    if (input.signal?.aborted || error?.code === 'REQUEST_ABORTED') throw error;
    const semanticContractFailure = ['INTENT_COVERAGE_INVALID', 'INTENT_COMPILE_INVALID', 'SEMANTIC_MAPPING_INVALID'].includes(error?.code);
    const modelOutputFailure = ['LLM_EMPTY_RESPONSE', 'NARRATOR_SCHEMA_INVALID', 'INSIGHT_LLM_INVALID_OUTPUT'].includes(error?.code);
    const providerFailure = String(error?.code || '').startsWith('LLM_') && !modelOutputFailure;
    const unsupportedCapability = error?.code === 'SEMANTIC_MAPPING_INVALID'
      && /意图字段不在语义目录|映射字段不存在于 Wyn 返回字段/.test(String(error?.message || ''));
    if (unsupportedCapability) {
      return plannerResult(unsupportedCapabilityClarification(error, previousInvalidIntent), 'llm-clarification', startedAt, {
        reason: 'unsupported-dataset-capability',
        errorMessage: String(error?.message || '').slice(0, 500),
        failureCategory: 'capability-unavailable',
        llmAttempted: true,
        llmDurationMs: Date.now() - llmStartedAt,
        repairAttempted,
        repairFeedback,
        llmCalls,
      });
    }
    const code = semanticContractFailure
      ? 'INTENT_VALIDATION_FAILED'
      : modelOutputFailure ? 'LLM_OUTPUT_INVALID'
        : providerFailure ? error.code : 'PLATFORM_INTENT_PROCESSING_FAILED';
    const message = semanticContractFailure
      ? `大模型理解结果在有限修复后仍未通过查询约束：${String(error?.message || '').slice(0, 300)}`
      : modelOutputFailure
        ? '大模型返回结构无法处理，平台已完成有限重试，请稍后重试。'
        : providerFailure
          ? '大模型服务暂时不可用，平台已完成有限重试，请稍后重试。'
          : '平台处理大模型返回结果时发生异常，请使用跟踪编号联系管理员。';
    return plannerResult({
      status: 'error',
      code,
      message,
    }, 'llm-error', startedAt, {
      reason: error?.code || 'intent-llm-failed',
      errorMessage: String(error?.message || '').slice(0, 500),
      failureCategory: semanticContractFailure ? 'semantic-validation' : modelOutputFailure ? 'model-output' : providerFailure ? 'provider' : 'platform-processing',
      llmAttempted: true,
      llmDurationMs: Date.now() - llmStartedAt,
      repairAttempted,
      repairFeedback,
      llmCalls,
      rejectedTimeContext: semanticContractFailure ? {
        time: previousInvalidIntent?.time || null,
        expectedPeriods: previousInvalidIntent?.expectedResult?.requiredPeriods || [],
        constraints: (previousInvalidIntent?.constraints || []).filter(item => ['time', 'time-scope'].includes(item?.type)),
        assumptions: previousInvalidIntent?.assumptions || [],
        temporalReference,
      } : null,
    });
  }
}

function formatValue(value, metric, unitFamily = null) {
  if (value == null || value === '') return '—';
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
  const primaryResultField = (resultSet?.schema || []).find(item => item?.name === metricAlias) || null;
  const metric = primaryResultField?.displayName || primaryMeasure.displayName || primaryMeasure.field || primaryMeasure.alias;
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
      timeRange: documentTimeRange(plan),
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
