import { randomUUID } from 'node:crypto';
import { normalizeCanonicalQueryRequest } from '../planning/query-request-schema.mjs';
import { normalizeInsightDocument } from '../protocol/interaction-contract.mjs';
import { buildFollowUpActions } from './followup-actions.mjs';
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

function clarificationForErrors(errors = []) {
  const joined = errors.join('；');
  if (/partitioned-ranking|分组内排名/.test(joined)) {
    return '这个问题要求在每个分组内部再做排名。当前单次受控查询不能可靠完成，请先指定一个城市，或改问“各城市利润前五的产品组合”。';
  }
  if (/维度/.test(joined)) return '我识别到了分组或排名要求，但还不能唯一确定业务维度。请明确是按商品类别、商品名称、客户地区、省份还是城市查看。';
  if (/指标/.test(joined)) return '我还不能确定要计算的指标。请明确是销售额、利润还是销量。';
  if (/时间/.test(joined)) return '我识别到了时间要求，但数据集中没有可可靠绑定的业务日期字段。请调整时间要求或选择其他数据集。';
  return `我还不能可靠覆盖本轮的全部业务约束：${joined}。请补充要看的指标、时间范围或分析维度。`;
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
  if (compiled.status !== 'supported') return {
    status: 'needs_clarification',
    clarification: clarificationForErrors(compiled.errors),
    options: ['查看2025年销售额', '按商品类别看销售额前五名', '按月查看利润趋势'],
    intent,
  };
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
  const deterministic = planBusinessQuestion(input);
  const complexity = deterministic.intent?.semanticFrame?.complexity || 0;
  const shouldUseHybrid = deterministic.status !== 'supported' || complexity >= 3;
  if (!shouldUseHybrid || !llm?.enabled || typeof llm.planQueryIntent !== 'function') return deterministic;
  try {
    const output = await llm.planQueryIntent({
      metadata: input.metadata,
      question: input.question,
      previousIntent: input.previousIntent,
      skills: input.skills || [],
      timeZone: input.timeZone || 'Asia/Shanghai',
      deterministicIntent: deterministic.intent || null,
    });
    const intent = normalizeBusinessQueryIntentV2({
      ...(deterministic.intent || {}),
      ...output,
      businessQuestion: input.question,
      semanticFrame: deterministic.intent?.semanticFrame || output.semanticFrame,
      skillRefs: input.skillRefs,
      source: { planner: 'hybrid-llm-intent-planner', version: '2.1' },
    }, { metadata: input.metadata });
    const coverage = validateIntentCoverage(intent);
    if (!coverage.valid) return deterministic;
    const compiled = compileBusinessQueryIntent(input.metadata, intent);
    return compiled.status === 'supported' ? {
      ...compiled,
      plannerMode: 'hybrid-llm-validated',
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
    } : deterministic;
  } catch {
    return deterministic;
  }
}

function formatValue(value, metric) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '—');
  const formatted = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(numeric);
  return /金额|利润|收入|销售额/.test(metric || '') ? `¥${formatted}` : formatted;
}

export function composeQuestionDocument({ metadata, question, plan, resultSet }) {
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
    const chartIsUnambiguous = plan.request.select.length === 1 && plan.request.measures.length === 1;
    if (chartIsUnambiguous) {
      blocks.push({ id: 'answer-chart', type: 'chart', title: question, chartType: plan.request.select[0].grain ? 'line' : 'bar', dataRef: resultSet.id, encoding: { x: dimensionAlias, y: metricAlias }, evidenceIds: ['answer-evidence'] });
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
