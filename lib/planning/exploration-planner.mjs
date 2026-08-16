import { createHash } from 'node:crypto';
import { isGroupableField, toDate, toNumber } from '../analysis-core.mjs';
import { classifyAnalysisIntent } from '../semantics/capability-profiler.mjs';
import { normalizeCanonicalQueryRequest } from './query-request-schema.mjs';

const INTENTS = new Set(['profitability', 'customer', 'product', 'anomaly', 'open']);
const GUIDED_METHODS = new Set([
  'profit_trend', 'profit_structure', 'customer_concentration', 'customer_region',
  'product_portfolio', 'category_portfolio', 'anomaly_trend',
  'open_trend', 'open_customer', 'open_product', 'open_region',
  'operational_trend', 'operational_efficiency', 'compliance_rate',
  'process_status', 'critical_response', 'outsourcing_performance',
]);

function canonicalExternalId(value) {
  const raw = String(value || '').trim().replace(/_/g, '-');
  if (/^[a-z][a-z0-9-]{1,79}$/i.test(raw)) return raw;
  const hash = createHash('sha256').update(raw || 'empty').digest('hex').slice(0, 10);
  const ascii = raw.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
  const base = /^[a-z]/i.test(ascii) ? ascii : `id-${ascii || 'external'}`;
  return `${base.slice(0, 68).replace(/-+$/g, '')}-${hash}`;
}

function sanitizeExternalRequest(item = {}) {
  const originalSelect = Array.isArray(item.select) ? item.select
    : Array.isArray(item.dimensions) ? item.dimensions
      : Array.isArray(item.fields) ? item.fields
        : Array.isArray(item.groupBy) ? item.groupBy : [];
  const selectMeasures = originalSelect.filter(field => field && typeof field === 'object' && (field.aggregation || field.operation));
  const rawSelect = originalSelect.filter(field => !selectMeasures.includes(field));
  const explicitMeasures = Array.isArray(item.measures) ? item.measures
    : Array.isArray(item.metrics) ? item.metrics : [];
  const rawMeasures = [...explicitMeasures, ...selectMeasures];
  const normalizedMode = ({
    timeSeries: 'compare',
    timeseries: 'compare',
    ranking: 'aggregate',
    groupBy: 'aggregate',
    distribution: 'aggregate',
    drilldown: 'verify',
    rawDetail: 'detail',
  })[String(item.mode || '')] || item.mode;
  const result = {
    ...item,
    mode: normalizedMode,
    select: rawSelect.map((field, index) => typeof field === 'string'
      ? { field, alias: `dimension${index + 1}` }
      : { ...field, field: field?.field || field?.name, alias: field?.alias || `dimension${index + 1}` })
      .filter(field => String(field?.field || '').trim()),
    measures: rawMeasures.map((metric, index) => typeof metric === 'string'
      ? { field: metric, aggregation: 'sum', alias: `metric${index + 1}` }
      : {
        ...metric,
        field: metric?.field || metric?.name,
        aggregation: ({ avg: 'average', count: 'countRows' })[metric?.aggregation || metric?.operation] || metric?.aggregation || metric?.operation,
        alias: metric?.alias || `metric${index + 1}`,
      }).filter(metric => {
      const aggregation = String(metric?.aggregation || '').trim();
      return aggregation && (aggregation === 'countRows' || String(metric?.field || '').trim());
    }),
    filters: Array.isArray(item.filters) ? item.filters.map(filter => {
      if (filter?.value == null && ['eq', 'neq', 'isNull', 'isNotNull'].includes(String(filter?.operator || 'eq'))) {
        return { ...filter, operator: ['neq', 'isNotNull'].includes(String(filter?.operator)) ? 'isNotNull' : 'isNull', value: null };
      }
      return filter;
    }).filter(filter => {
      if (!String(filter?.field || '').trim()) return false;
      if (['isNull', 'isNotNull'].includes(filter?.operator)) return true;
      if (filter?.value == null) return false;
      if (typeof filter.value === 'string' && !filter.value.trim()) return false;
      return true;
    }) : [],
    orderBy: Array.isArray(item.orderBy) ? item.orderBy.filter(order => String(order?.field || '').trim()) : [],
  };
  const aliasRepairs = [];
  const aliasMap = new Map();
  const usedAliases = new Set();
  const repairAliases = (entries, prefix) => entries.forEach((entry, index) => {
    const original = String(entry.alias || '').trim();
    let alias = /^[a-z][a-z0-9_]{0,40}$/i.test(original) && !usedAliases.has(original) ? original : `${prefix}${index + 1}`;
    let suffix = 2;
    while (usedAliases.has(alias)) alias = `${prefix}${index + 1}_${suffix++}`;
    if (alias !== original) aliasRepairs.push({ from: original, to: alias });
    if (original && !aliasMap.has(original)) aliasMap.set(original, alias);
    entry.alias = alias;
    usedAliases.add(alias);
  });
  repairAliases(result.measures, 'metric');
  repairAliases(result.select, 'dimension');
  result.filters = result.filters.map(filter => ({ ...filter, field: aliasMap.get(filter.field) || filter.field }));
  result.orderBy = result.orderBy.map(order => ({ ...order, field: aliasMap.get(order.field) || order.field }));
  result.fieldComparisons = (Array.isArray(item.fieldComparisons) ? item.fieldComparisons : []).map(comparison => ({
    ...comparison,
    left: aliasMap.get(comparison?.left) || comparison?.left,
    right: aliasMap.get(comparison?.right) || comparison?.right,
  }));
  Object.defineProperty(result, 'aliasRepairs', { value: aliasRepairs, enumerable: false });
  const measureAliases = new Set(result.measures.map(metric => metric.alias));
  const suppliedResultFilters = Array.isArray(item.resultFilters)
    ? item.resultFilters.map(filter => ({ ...filter, field: aliasMap.get(filter.field) || filter.field }))
    : [];
  result.resultFilters = [...suppliedResultFilters, ...result.filters.filter(filter => measureAliases.has(String(filter.field || '').trim()))];
  result.filters = result.filters.filter(filter => !measureAliases.has(String(filter.field || '').trim()));
  const aliases = new Set([...result.select.map(field => field.alias), ...result.measures.map(metric => metric.alias)]);
  result.orderBy = result.orderBy.filter(order => aliases.has(String(order.field || '').trim()));
  if (!result.orderBy.length && result.measures.length) result.orderBy = [{ field: result.measures[0].alias, direction: 'desc' }];
  return result;
}

function first(values) {
  return Array.isArray(values) ? values.find(Boolean) || null : null;
}

function hypothesis(id, question, businessValue, priority, requiredEvidence, generatedBy) {
  return {
    id,
    question,
    businessValue,
    priority,
    status: 'candidate',
    requiredEvidence,
    parentHypothesisId: null,
    generatedBy,
    stopReason: null,
  };
}

function measure(field, alias) {
  return field ? { field, aggregation: 'sum', alias } : null;
}

function aggregateMeasure(field, aggregation, alias, resultType = 'number') {
  if (aggregation !== 'countRows' && !field) return null;
  return { field: field || null, aggregation, alias, resultType };
}

function baseRequest(metadata, filters, input) {
  return {
    ...input,
    dataset: { id: metadata.id, revision: metadata.revision },
    filters: [...filters, ...(input.filters || [])],
    limit: input.limit || 100,
    sensitivity: input.sensitivity || 'aggregate-only',
  };
}

export function buildSystemProbeRequests(metadata, profile, filters = []) {
  const revenue = first(profile.roles.revenue);
  const profit = first(profile.roles.profit);
  const date = first(profile.roles.time);
  const orderId = first(profile.roles.orderId);
  return [
    baseRequest(metadata, filters, {
      id: 'qry-system-quality',
      hypothesisId: 'hyp-system-baseline',
      purpose: '读取受控质量样本并确认可分析字段范围',
      mode: 'detail',
      topic: 'quality',
      select: (metadata.fields || []).slice(0, 64).map((field, index) => ({ field: field.name, alias: `field${index + 1}` })),
      measures: [],
      limit: 5000,
      sensitivity: 'controlled-detail',
    }),
    baseRequest(metadata, filters, {
      id: 'qry-system-overview',
      hypothesisId: 'hyp-system-baseline',
      purpose: '计算完整数据集的最小经营基线口径',
      mode: 'aggregate',
      topic: 'baseline',
      select: [],
      measures: [
        { alias: 'source_rows', aggregation: 'countRows' },
        measure(revenue, 'total'),
        orderId ? { alias: 'orders', aggregation: 'distinctCount', field: orderId } : { alias: 'orders', aggregation: 'countRows' },
        measure(profit, 'profit'),
        date ? { alias: 'date_min', aggregation: 'min', field: date } : null,
        date ? { alias: 'date_max', aggregation: 'max', field: date } : null,
      ].filter(Boolean),
      limit: 1,
    }),
  ];
}

function timeRequest(metadata, filters, { id, hypothesisId, purpose, topic, profile, measures }) {
  const date = first(profile.roles.time);
  if (!date || !measures.filter(Boolean).length) return null;
  return baseRequest(metadata, filters, {
    id,
    hypothesisId,
    purpose,
    mode: 'compare',
    topic,
    select: [{ field: date, alias: 'period', grain: 'month' }],
    measures: measures.filter(Boolean),
    orderBy: [{ field: 'period', direction: 'asc' }],
    limit: 5000,
    comparison: { type: 'period_over_period', current: 'latest_complete_period', baseline: 'previous_period' },
  });
}

function dimensionRequest(metadata, filters, { id, hypothesisId, purpose, topic, field, measures, limit = 20, queryFilters = [] }) {
  if (!field || !measures.filter(Boolean).length) return null;
  return baseRequest(metadata, filters, {
    id,
    hypothesisId,
    purpose,
    mode: 'aggregate',
    topic,
    select: [{ field, alias: 'entity' }],
    measures: measures.filter(Boolean),
    filters: queryFilters,
    orderBy: [{ field: measures.filter(Boolean)[0].alias, direction: 'desc' }],
    limit,
  });
}

function catalogField(profile, patterns, roles = []) {
  return profile.fieldCatalog.find(field => (!roles.length || roles.includes(field.role))
    && patterns.some(pattern => pattern.test(`${field.name} ${field.description || ''}`)))?.name || null;
}

function addOperationalOpenPlan({ metadata, profile, filters, focus = '', add }) {
  const time = first(profile.roles.time);
  const organization = first(profile.roles.organization)
    || catalogField(profile, [/科室|部门|专业组|团队|机构|实验室/], ['dimension']);
  const durations = profile.roles.duration.slice(0, 4);
  const flags = profile.roles.flag.slice(0, 2);
  const status = first(profile.roles.status);
  const detectionItem = profile.fieldCatalog.find(field => field.name === '危急值检测项目名称' && field.role === 'dimension')?.name
    || catalogField(profile, [/危急值检测项目|检测项目|项目名称/], ['dimension']);
  const notificationMode = catalogField(profile, [/通知方式|通知渠道/], ['dimension']);
  const notificationDuration = catalogField(profile, [/通知耗时/], ['measure']);
  const timelyFlag = catalogField(profile, [/是否及时通知/], ['measure']);
  const courier = catalogField(profile, [/快递|承运商|参考实验室|供应商/], ['dimension']);
  const externalDuration = catalogField(profile, [/参考实验室TAT|运输时长|延误时长/], ['measure']);
  const delayFlag = catalogField(profile, [/是否延误/], ['measure']);

  if (time) {
    const item = hypothesis('hyp-operational-trend', '运营业务量随时间如何变化，是否存在显著波动？', '识别容量变化和异常期间', 1, ['月度记录量'], 'deterministic-fallback/v2.1');
    add(item, timeRequest(metadata, filters, {
      id: 'qry-operational-trend', hypothesisId: item.id, purpose: '分析月度运营业务量变化', topic: 'open', profile,
      measures: [aggregateMeasure(null, 'countRows', 'record_count')],
    }));
  }
  if (organization && durations.length) {
    const item = hypothesis('hyp-operational-efficiency', `不同${organization}的处理效率是否存在显著差异？`, '定位流程效率瓶颈', 0.98, ['组织维度平均处理时长'], 'deterministic-fallback/v2.1');
    add(item, dimensionRequest(metadata, filters, {
      id: 'qry-operational-efficiency', hypothesisId: item.id, purpose: `比较各${organization}的平均处理时长`, topic: 'open', field: organization,
      measures: [...durations.map((field, index) => aggregateMeasure(field, 'average', `duration_${index + 1}`)), aggregateMeasure(null, 'countRows', 'record_count')], limit: 30,
    }));
  }
  if (organization && flags.length) {
    const item = hypothesis('hyp-compliance-rate', `不同${organization}的达标与准时表现是否存在差异？`, '定位交付和合规风险', 0.96, ['组织维度达标率'], 'deterministic-fallback/v2.1');
    add(item, dimensionRequest(metadata, filters, {
      id: 'qry-compliance-rate', hypothesisId: item.id, purpose: `比较各${organization}的达标率与准时率`, topic: 'open', field: organization,
      measures: [...flags.map((field, index) => aggregateMeasure(field, 'average', `compliance_${index + 1}`, 'percentage')), aggregateMeasure(null, 'countRows', 'record_count')], limit: 30,
    }));
  }
  if (status) {
    const item = hypothesis('hyp-process-status', '流程状态分布是否存在积压或异常结构？', '识别流程滞留和结构风险', 0.9, ['状态分布'], 'deterministic-fallback/v2.1');
    add(item, dimensionRequest(metadata, filters, {
      id: 'qry-process-status', hypothesisId: item.id, purpose: `分析${status}分布`, topic: 'open', field: status,
      measures: [aggregateMeasure(null, 'countRows', 'record_count')], limit: 30,
    }));
  }
  const criticalDimension = notificationMode || detectionItem;
  if (criticalDimension && (notificationDuration || timelyFlag)) {
    const item = hypothesis('hyp-critical-response', `危急值通知响应是否及时，哪些${criticalDimension}风险较高？`, '降低危急值闭环风险', 0.92, [`${criticalDimension}通知耗时与及时率`], 'deterministic-fallback/v2.1');
    add(item, dimensionRequest(metadata, filters, {
      id: 'qry-critical-response', hypothesisId: item.id, purpose: `比较不同${criticalDimension}的通知耗时与及时率`, topic: 'open', field: criticalDimension,
      measures: [aggregateMeasure(notificationDuration, 'average', 'notification_duration'), aggregateMeasure(timelyFlag, 'average', 'timely_rate', 'percentage'), aggregateMeasure(null, 'countRows', 'record_count')], limit: 30,
      queryFilters: [
        notificationDuration ? { field: notificationDuration, operator: 'isNotNull', value: null } : null,
        timelyFlag ? { field: timelyFlag, operator: 'isNotNull', value: null } : null,
      ].filter(Boolean),
    }));
    if (detectionItem && detectionItem !== criticalDimension && /危急值|检测项目|按.*项目/.test(focus)) {
      const projectItem = hypothesis('hyp-critical-by-project', `哪些${detectionItem}的通知风险较高？`, '定位高风险危急值检测项目', 0.91, [`${detectionItem}通知耗时与及时率`], 'deterministic-fallback/v2.1');
      add(projectItem, dimensionRequest(metadata, filters, {
        id: 'qry-critical-by-project', hypothesisId: projectItem.id, purpose: `按${detectionItem}比较通知耗时与及时率`, topic: 'open', field: detectionItem,
        measures: [aggregateMeasure(notificationDuration, 'average', 'notification_duration'), aggregateMeasure(timelyFlag, 'average', 'timely_rate', 'percentage'), aggregateMeasure(null, 'countRows', 'record_count')], limit: 30,
        queryFilters: [
          notificationDuration ? { field: notificationDuration, operator: 'isNotNull', value: null } : null,
          timelyFlag ? { field: timelyFlag, operator: 'isNotNull', value: null } : null,
        ].filter(Boolean),
      }));
    }
  } else if (courier && (externalDuration || delayFlag)) {
    const item = hypothesis('hyp-outsourcing-performance', '委外与物流合作方是否存在时效和延误风险？', '优化外部合作方和物流效率', 0.9, ['合作方时长与延误率'], 'deterministic-fallback/v2.1');
    add(item, dimensionRequest(metadata, filters, {
      id: 'qry-outsourcing-performance', hypothesisId: item.id, purpose: '比较委外或物流合作方的时效与延误率', topic: 'open', field: courier,
      measures: [aggregateMeasure(externalDuration, 'average', 'external_duration'), aggregateMeasure(delayFlag, 'average', 'delay_rate', 'percentage'), aggregateMeasure(null, 'countRows', 'record_count')], limit: 30,
    }));
  }
}

export function buildFallbackExplorationPlan({ metadata, profile, focus = '', filters = [] }) {
  const intent = classifyAnalysisIntent(focus, profile);
  const revenue = first(profile.roles.revenue);
  const profit = first(profile.roles.profit);
  const customer = first(profile.roles.customer);
  const product = first(profile.roles.product);
  const category = first(profile.roles.category);
  const region = first(profile.roles.region);
  const revenueMeasure = measure(revenue, 'revenue');
  const profitMeasure = measure(profit, 'profit');
  const hypotheses = [];
  const requests = [];
  const add = (item, request) => {
    hypotheses.push(item);
    if (request) requests.push(request);
  };

  if (intent === 'profitability') {
    const h1 = hypothesis('hyp-profit-trend', '收入与利润是否同向变化，经营质量发生了什么变化？', '区分规模增长与盈利改善', 1, ['收入与利润时间序列'], 'deterministic-fallback/v2.1');
    add(h1, timeRequest(metadata, filters, { id: 'qry-profit-trend', hypothesisId: h1.id, purpose: '比较月度收入与利润变化', topic: intent, profile, measures: [revenueMeasure, profitMeasure] }));
    const entity = product || category || region;
    const h2 = hypothesis('hyp-profit-structure', `哪些${entity || '业务实体'}形成高收入低利润或亏损风险？`, '定位经营质量问题来源', 0.95, ['实体收入与利润'], 'deterministic-fallback/v2.1');
    add(h2, dimensionRequest(metadata, filters, { id: 'qry-profit-structure', hypothesisId: h2.id, purpose: `比较${entity || '业务实体'}的收入与利润结构`, topic: intent, field: entity, measures: [revenueMeasure, profitMeasure], limit: 30 }));
  } else if (intent === 'customer') {
    const h1 = hypothesis('hyp-customer-concentration', '经营结果是否过度集中于少数客户？', '识别客户依赖和集中风险', 1, ['客户收入及利润排名'], 'deterministic-fallback/v2.1');
    add(h1, dimensionRequest(metadata, filters, { id: 'qry-customer-concentration', hypothesisId: h1.id, purpose: '计算客户收入集中度并检查客户利润质量', topic: intent, field: customer, measures: [revenueMeasure, profitMeasure], limit: 100 }));
    if (region) {
      const h2 = hypothesis('hyp-customer-region', '客户风险是否集中在特定区域？', '定位客户组合风险的空间分布', 0.8, ['区域收入与利润'], 'deterministic-fallback/v2.1');
      add(h2, dimensionRequest(metadata, filters, { id: 'qry-customer-region', hypothesisId: h2.id, purpose: '比较各区域客户组合的收入与利润', topic: intent, field: region, measures: [revenueMeasure, profitMeasure], limit: 30 }));
    }
  } else if (intent === 'product') {
    const entity = product || category;
    const h1 = hypothesis('hyp-product-portfolio', '哪些产品处于高收入低利润或低收入高利润位置？', '评估产品组合健康度', 1, ['产品收入与利润'], 'deterministic-fallback/v2.1');
    add(h1, dimensionRequest(metadata, filters, { id: 'qry-product-portfolio', hypothesisId: h1.id, purpose: `分析${entity || '产品'}收入与利润组合`, topic: intent, field: entity, measures: [revenueMeasure, profitMeasure], limit: 50 }));
    if (category && category !== entity) {
      const h2 = hypothesis('hyp-category-portfolio', '产品组合问题是否集中在特定类别？', '识别组合优化优先级', 0.85, ['类别收入与利润'], 'deterministic-fallback/v2.1');
      add(h2, dimensionRequest(metadata, filters, { id: 'qry-category-portfolio', hypothesisId: h2.id, purpose: '比较类别收入与利润组合', topic: intent, field: category, measures: [revenueMeasure, profitMeasure], limit: 30 }));
    }
  } else if (intent === 'anomaly') {
    const h1 = hypothesis('hyp-anomaly-trend', '时间序列中是否存在需要解释的显著波动？', '识别异常期间并决定下钻方向', 1, ['月度经营指标序列'], 'deterministic-fallback/v2.1');
    add(h1, timeRequest(metadata, filters, { id: 'qry-anomaly-trend', hypothesisId: h1.id, purpose: '识别月度经营指标的异常波动', topic: intent, profile, measures: [revenueMeasure, profitMeasure] }));
  } else {
    if (!revenue && (profile.capabilities.operationalEfficiency || profile.capabilities.compliance || profile.capabilities.processStatus)) {
      addOperationalOpenPlan({ metadata, profile, filters, focus, add });
    } else {
      const h1 = hypothesis('hyp-open-trend', '经营规模与质量随时间如何变化？', '发现值得进一步解释的时间信号', 1, ['收入与利润趋势'], 'deterministic-fallback/v2.1');
      add(h1, timeRequest(metadata, filters, { id: 'qry-open-trend', hypothesisId: h1.id, purpose: '开放探索经营规模与利润时间变化', topic: intent, profile, measures: [revenueMeasure, profitMeasure] }));
      const customerHyp = hypothesis('hyp-open-customer', '客户结构是否存在集中或利润质量风险？', '发现客户经营风险', 0.9, ['客户收入与利润'], 'deterministic-fallback/v2.1');
      add(customerHyp, dimensionRequest(metadata, filters, { id: 'qry-open-customer', hypothesisId: customerHyp.id, purpose: '开放探索客户收入与利润结构', topic: 'customer', field: customer, measures: [revenueMeasure, profitMeasure], limit: 50 }));
      const entity = product || category;
      const productHyp = hypothesis('hyp-open-product', '产品组合中有哪些规模与利润不匹配现象？', '发现产品组合机会与风险', 0.88, ['产品收入与利润'], 'deterministic-fallback/v2.1');
      add(productHyp, dimensionRequest(metadata, filters, { id: 'qry-open-product', hypothesisId: productHyp.id, purpose: '开放探索产品收入与利润组合', topic: 'product', field: entity, measures: [revenueMeasure, profitMeasure], limit: 40 }));
      if (region) {
        const regionHyp = hypothesis('hyp-open-region', '区域经营表现是否存在显著分化？', '发现区域增长与质量差异', 0.75, ['区域收入与利润'], 'deterministic-fallback/v2.1');
        add(regionHyp, dimensionRequest(metadata, filters, { id: 'qry-open-region', hypothesisId: regionHyp.id, purpose: '开放探索区域收入与利润差异', topic: 'open', field: region, measures: [revenueMeasure, profitMeasure], limit: 30 }));
      }
    }
  }

  return {
    intent,
    summary: `根据用户问题和语义能力选择 ${intent} 分析路径`,
    mode: 'deterministic-fallback',
    model: null,
    degradedReason: null,
    hypotheses: hypotheses.filter(item => requests.some(request => request?.hypothesisId === item.id)),
    requests: requests.filter(Boolean),
  };
}

function normalizeHypotheses(input = [], generatedBy = 'ai-planner/v2.1') {
  if (!Array.isArray(input)) throw new Error('Planner hypotheses 必须是数组');
  return input.slice(0, 8).map(item => {
    const id = canonicalExternalId(item?.id);
    if (!/^[a-z][a-z0-9-]{1,79}$/i.test(id)) throw new Error(`Planner 假设 ID 无效：${id}`);
    const priority = Number(item?.priority);
    const normalized = hypothesis(
      id,
      String(item?.question || '').trim().slice(0, 500) || '未命名分析假设',
      String(item?.businessValue || '').trim().slice(0, 500) || '验证用户关注问题',
      Number.isFinite(priority) ? Math.max(0, Math.min(1, priority)) : 0.8,
      Array.isArray(item?.requiredEvidence) ? item.requiredEvidence.map(value => String(value).slice(0, 200)).slice(0, 8) : [],
      generatedBy,
    );
    normalized.parentHypothesisId = item?.parentHypothesisId ? canonicalExternalId(item.parentHypothesisId) : null;
    return normalized;
  });
}

export function normalizeExternalExplorationPlan({ metadata, profile, focus, filters = [], rawPlan, maxRequests = 5, model = null }) {
  if (!rawPlan || typeof rawPlan !== 'object') throw new Error('AI Planner 未返回 JSON 对象');
  const hypotheses = normalizeHypotheses(rawPlan.hypotheses);
  const hypothesisIds = new Set(hypotheses.map(item => item.id));
  if (!hypotheses.length) throw new Error('AI Planner 未返回候选假设');
  if (!Array.isArray(rawPlan.requests) || !rawPlan.requests.length) throw new Error('AI Planner 未返回查询需求');
  const intent = INTENTS.has(String(rawPlan.intent)) ? String(rawPlan.intent) : classifyAnalysisIntent(focus, profile);
  const requests = rawPlan.requests.slice(0, maxRequests).map(item => {
    const hypothesisId = canonicalExternalId(item?.hypothesisId);
    if (!hypothesisIds.has(hypothesisId)) throw new Error(`查询引用未知假设：${item?.hypothesisId || ''}`);
    if (/^qry-system-/i.test(canonicalExternalId(item?.id))) throw new Error('AI Planner 不得占用系统探针 ID');
    const sanitized = sanitizeExternalRequest(item);
    return normalizeCanonicalQueryRequest(metadata, {
      ...sanitized,
      id: canonicalExternalId(item?.id),
      hypothesisId,
      topic: INTENTS.has(String(item.topic || rawPlan.intent)) ? String(item.topic || rawPlan.intent) : intent,
      filters: [...filters, ...sanitized.filters],
      dataset: { id: metadata.id, revision: metadata.revision },
    });
  });
  const selectedFields = requests.flatMap(request => request.select.map(item => item.field));
  const measureFields = requests.flatMap(request => request.measures.map(item => item.field).filter(Boolean));
  if (intent === 'profitability' && !measureFields.some(field => profile.roles.profit.includes(field))) throw new Error('利润问题的 AI 计划没有使用利润指标');
  if (intent === 'customer' && !selectedFields.some(field => profile.roles.customer.includes(field))) throw new Error('客户问题的 AI 计划没有使用客户维度');
  if (intent === 'product' && !selectedFields.some(field => [...profile.roles.product, ...profile.roles.category].includes(field))) throw new Error('产品问题的 AI 计划没有使用产品或类别维度');
  if (intent === 'anomaly' && !requests.some(request => request.select.some(item => item.grain && profile.roles.time.includes(item.field)))) throw new Error('异常问题的 AI 计划没有使用时间序列');
  return {
    intent,
    summary: String(rawPlan.summary || 'AI 根据问题和语义目录生成探索计划').slice(0, 1000),
    mode: 'ai-planner',
    model,
    degradedReason: null,
    hypotheses,
    requests,
  };
}

function focusForIntent(intent) {
  if (intent === 'profitability') return '利润盈利质量分析';
  if (intent === 'customer') return '客户集中度和客户经营风险分析';
  if (intent === 'product') return '产品和品类结构分析';
  if (intent === 'anomaly') return '异常波动分析';
  return '';
}

export function normalizeAiGuidedPlan({ metadata, profile, focus, filters = [], rawPlan, model = null }) {
  if (!rawPlan || typeof rawPlan !== 'object') throw new Error('AI Guided Planner 未返回 JSON 对象');
  const expectedIntent = classifyAnalysisIntent(focus, profile);
  const rawIntent = INTENTS.has(String(rawPlan.intent)) ? String(rawPlan.intent) : expectedIntent;
  const intent = expectedIntent === 'open' ? 'open' : rawIntent;
  if (expectedIntent !== 'open' && intent !== expectedIntent) throw new Error(`AI Guided Planner 意图 ${intent} 与用户问题 ${expectedIntent} 不一致`);
  let methods = Array.isArray(rawPlan.methods) ? rawPlan.methods.map(value => String(value).trim()).filter(value => GUIDED_METHODS.has(value)) : [];
  if (!methods.length) {
    const text = JSON.stringify(rawPlan);
    if (/利润|盈利|毛利/.test(text)) methods.push('profit_trend', 'profit_structure');
    if (/客户|集中度/.test(text)) methods.push('customer_concentration', 'customer_region');
    if (/产品|商品/.test(text)) methods.push('product_portfolio');
    if (/类别|品类/.test(text)) methods.push('category_portfolio');
    if (/异常|波动|趋势/.test(text)) methods.push(intent === 'anomaly' ? 'anomaly_trend' : 'open_trend');
  }
  methods = [...new Set(methods)];
  const requestedMethods = [...methods];
  if (intent === 'open' && profile.capabilities.operationalEfficiency) {
    const requiredMethods = [];
    const broadOperational = /全面|综合|运营分析|关键指标|从.*(?:视角|方面)/.test(focus);
    const criticalFocus = /危急值|通知/.test(focus);
    const outsourcingFocus = /委外|物流|快递|运输/.test(focus);
    const focusedOperational = /TAT|总耗时|处理耗时|处理时长|周转时长|效率|瓶颈/.test(focus);
    if (broadOperational || (focusedOperational && !criticalFocus && !outsourcingFocus)) requiredMethods.push('operational_efficiency');
    if (broadOperational || /达标|准时|及时率|有效性|合规/.test(focus)) requiredMethods.push('compliance_rate');
    if (broadOperational || /状态|流程/.test(focus)) requiredMethods.push('process_status');
    if (broadOperational || /趋势|变化|波动/.test(focus)) requiredMethods.push('operational_trend');
    if (criticalFocus) requiredMethods.push('critical_response');
    if (outsourcingFocus) requiredMethods.push('outsourcing_performance');
    methods = [...new Set([...methods, ...requiredMethods])];
    if (!broadOperational && criticalFocus) methods = methods.filter(method => method === 'critical_response');
    if (!broadOperational && outsourcingFocus) methods = methods.filter(method => method === 'outsourcing_performance');
  }
  if (intent === 'open' && !methods.some(method => method.startsWith('open-') || method.startsWith('open_') || /^(operational_|compliance_|process_|critical_|outsourcing_)/.test(method))) {
    methods = ['open_trend', 'open_customer', 'open_product', 'open_region'];
  }
  const compiled = buildFallbackExplorationPlan({ metadata, profile, focus: intent === 'open' ? focus : focusForIntent(intent), filters });
  const matchers = {
    profit_trend: /profit-trend/,
    profit_structure: /profit-structure/,
    customer_concentration: /customer-concentration/,
    customer_region: /customer-region/,
    product_portfolio: /product-portfolio/,
    category_portfolio: /category-portfolio/,
    anomaly_trend: /anomaly-trend/,
    open_trend: /open-trend/,
    open_customer: /open-customer/,
    open_product: /open-product/,
    open_region: /open-region/,
    operational_trend: /operational-trend/,
    operational_efficiency: /operational-efficiency/,
    compliance_rate: /compliance-rate/,
    process_status: /process-status/,
    critical_response: /critical-(?:response|by-project)/,
    outsourcing_performance: /outsourcing-performance/,
  };
  const selectedRequests = methods.length
    ? compiled.requests.filter(request => methods.some(method => matchers[method]?.test(request.id)))
    : compiled.requests;
  const requests = selectedRequests.length ? selectedRequests : compiled.requests;
  const hypothesisIds = new Set(requests.map(request => request.hypothesisId));
  return {
    intent,
    summary: String(intent === 'open' && rawIntent !== 'open'
      ? `AI 优先识别 ${rawIntent} 方向；系统按开放探索要求补充多主题覆盖。${rawPlan.summary || ''}`
      : rawPlan.summary || `AI 选择 ${methods.join('、') || intent} 分析方法，由受控编译器生成查询需求`).slice(0, 1000),
    mode: 'ai-guided-planner',
    model,
    degradedReason: null,
    aiMethods: methods,
    aiRequestedMethods: requestedMethods,
    aiHypotheses: normalizeHypotheses(rawPlan.hypotheses || [], 'ai-guided-planner/v2.1'),
    hypotheses: compiled.hypotheses.filter(item => hypothesisIds.has(item.id)).map(item => ({ ...item, generatedBy: 'ai-guided-compiler/v2.1' })),
    requests,
  };
}

export async function createInitialExplorationPlan({ metadata, profile, focus = '', filters = [], budget, aiPlanner = null }) {
  const fallback = buildFallbackExplorationPlan({ metadata, profile, focus, filters });
  if (typeof aiPlanner !== 'function') return fallback;
  let validationError = '';
  let previousPlan = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await aiPlanner({ metadata, profile, focus, filters, budget, validationError, previousPlan });
      previousPlan = response.plan || response;
      const normalized = Array.isArray(previousPlan.methods)
        ? normalizeAiGuidedPlan({ metadata, profile, focus, filters, rawPlan: previousPlan, model: response.model || null })
        : normalizeExternalExplorationPlan({ metadata, profile, focus, filters, rawPlan: previousPlan, maxRequests: Math.min(5, budget.maxQueries - 2), model: response.model || null });
      normalized.attempts = attempt + 1;
      return normalized;
    } catch (error) {
      validationError = error.message;
    }
  }
  return { ...fallback, degradedReason: `AI Planner 降级：${validationError}` };
}

export function queryFingerprint(request) {
  const stable = {
    mode: request.mode,
    select: request.select,
    measures: request.measures,
    filters: request.filters,
    resultFilters: request.resultFilters,
    fieldComparisons: request.fieldComparisons,
    comparison: request.comparison,
    orderBy: request.orderBy,
    limit: request.limit,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function periodKey(value) {
  const date = toDate(value);
  return date ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}` : null;
}

function nextMonthStart(period) {
  const [year, month] = period.split('-').map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function deterministicFollowup({ metadata, profile, initialPlan, outcomes, filters, remainingBudget, executedFingerprints }) {
  if (remainingBudget <= 0) return { assessments: [], hypotheses: [], requests: [], mode: 'deterministic-critic', summary: '查询预算已用完' };
  const trendOutcome = outcomes.find(outcome => outcome.request.select.some(item => item.grain) && outcome.resultSet.rows.length >= 2);
  if (!trendOutcome) return { assessments: [], hypotheses: [], requests: [], mode: 'deterministic-critic', summary: '没有可用于结果下钻的时间序列' };
  const metric = trendOutcome.request.measures[0];
  const byPeriod = new Map();
  for (const row of trendOutcome.resultSet.rows) {
    const period = periodKey(row[trendOutcome.request.select[0].alias]);
    const value = toNumber(row[metric.alias]);
    if (period && value != null) byPeriod.set(period, (byPeriod.get(period) || 0) + value);
  }
  const periods = [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (periods.length < 2) return { assessments: [], hypotheses: [], requests: [], mode: 'deterministic-critic', summary: '有效时间周期不足' };
  let strongest = null;
  for (let index = 1; index < periods.length; index += 1) {
    const previous = periods[index - 1];
    const current = periods[index];
    if (!previous[1]) continue;
    const rate = (current[1] - previous[1]) / Math.abs(previous[1]);
    if (!strongest || Math.abs(rate) > Math.abs(strongest.rate)) strongest = { previous, current, rate };
  }
  if (!strongest || Math.abs(strongest.rate) < 0.1) {
    return {
      assessments: [{ hypothesisId: trendOutcome.request.hypothesisId, status: 'supported', reason: '时间序列未出现超过 10% 的相邻期间波动', triggerResultSetIds: [trendOutcome.resultSet.id] }],
      hypotheses: [], requests: [], mode: 'deterministic-critic', summary: '没有达到下钻阈值的波动',
    };
  }
  const dimension = first(profile.roles.region) || first(profile.roles.category) || first(profile.roles.product) || first(profile.roles.customer);
  if (!dimension) return { assessments: [], hypotheses: [], requests: [], mode: 'deterministic-critic', summary: '缺少可下钻业务维度' };
  const id = 'hyp-result-driven-driver';
  const h = hypothesis(id, `${strongest.current[0]} 相比 ${strongest.previous[0]} 的显著变化由哪些${dimension}驱动？`, '解释已发现的最大相邻期间波动', 0.98, ['时间与业务维度交叉贡献'], 'deterministic-critic/v2.1');
  h.parentHypothesisId = trendOutcome.request.hypothesisId;
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-result-driven-driver',
    hypothesisId: id,
    purpose: `验证 ${strongest.current[0]} 较 ${strongest.previous[0]} 的${dimension}变化来源`,
    mode: 'verify',
    topic: initialPlan.intent,
    dataset: { id: metadata.id, revision: metadata.revision },
    select: [
      { field: first(profile.roles.time), alias: 'period', grain: 'month' },
      { field: dimension, alias: 'entity' },
    ],
    measures: trendOutcome.request.measures.map(item => ({ field: item.field, aggregation: item.aggregation, alias: item.alias })),
    filters: [
      ...filters,
      { field: first(profile.roles.time), operator: 'gte', value: `${strongest.previous[0]}-01` },
      { field: first(profile.roles.time), operator: 'lt', value: nextMonthStart(strongest.current[0]) },
    ],
    limit: 5000,
    lineage: {
      parentHypothesisId: trendOutcome.request.hypothesisId,
      triggerResultSetIds: [trendOutcome.resultSet.id],
      reason: `检测到最大相邻期间变化 ${(strongest.rate * 100).toFixed(1)}%`,
    },
  });
  if (executedFingerprints.has(queryFingerprint(request))) return { assessments: [], hypotheses: [], requests: [], mode: 'deterministic-critic', summary: '下钻查询与已执行计划重复' };
  return {
    assessments: [{ hypothesisId: trendOutcome.request.hypothesisId, status: 'needs_followup', reason: request.lineage.reason, triggerResultSetIds: [trendOutcome.resultSet.id] }],
    hypotheses: [h], requests: [request], mode: 'deterministic-critic', summary: request.purpose,
  };
}

function requestFields(request = {}) {
  return new Set([
    ...(request.select || []).map(item => item.field),
    ...(request.measures || []).map(item => item.field),
  ].filter(Boolean));
}

function inferTriggerOutcomes(request, outcomes) {
  const fields = requestFields(request);
  if (!fields.size) return [];
  const scored = outcomes
    .filter(outcome => !outcome.request.id.startsWith('qry-system-'))
    .map(outcome => ({
      outcome,
      score: [...fields].filter(field => requestFields(outcome.request).has(field)).length,
    }))
    .filter(item => item.score > 0);
  const maximum = Math.max(0, ...scored.map(item => item.score));
  return scored.filter(item => item.score === maximum).map(item => item.outcome);
}

function normalizeCriticPlan({ metadata, profile, initialPlan, filters, raw, remainingBudget, executedFingerprints, outcomes = [] }) {
  const hypotheses = normalizeHypotheses(raw.hypotheses || [], 'ai-critic/v2.1');
  const knownHypotheses = new Set([...initialPlan.hypotheses.map(item => item.id), ...hypotheses.map(item => item.id)]);
  const rawAssessments = Array.isArray(raw.assessments) ? raw.assessments : [];
  const validResultSetIds = new Set(outcomes.map(outcome => outcome.resultSet.id));
  const repairs = [];
  const requests = (Array.isArray(raw.requests) ? raw.requests : []).slice(0, Math.min(remainingBudget, 4)).map((item, index) => {
    const requestId = canonicalExternalId(item?.id || `qry-followup-${index + 1}-${item?.hypothesisId || 'analysis'}`);
    const sanitized = sanitizeExternalRequest(item);
    const selectAggregationCount = (Array.isArray(item.select) ? item.select : []).filter(selectItem => selectItem?.aggregation || selectItem?.operation).length;
    if (!item?.id) repairs.push({ requestId, type: 'missing-request-id', generatedId: requestId });
    if (sanitized.aliasRepairs.length) repairs.push({ requestId, type: 'invalid-alias-normalized', aliases: sanitized.aliasRepairs });
    const normalizedNullFilters = (Array.isArray(item.filters) ? item.filters : []).filter(filter => filter?.value == null && ['eq', 'neq'].includes(String(filter?.operator || 'eq')));
    if (normalizedNullFilters.length) repairs.push({ requestId, type: 'null-filter-operator', fields: normalizedNullFilters.map(filter => filter.field) });
    if (selectAggregationCount) repairs.push({ requestId, type: 'select-aggregation-to-measure', fieldCount: selectAggregationCount });
    if (sanitized.resultFilters.length) repairs.push({ requestId, type: 'aggregate-result-filter', aliases: sanitized.resultFilters.map(filter => filter.field) });
    const aliasToField = new Map([
      ...sanitized.select.map(field => [field.alias, field.field]),
      ...sanitized.measures.map(measure => [measure.alias, measure.field]),
    ].filter(([, field]) => field));
    let rawComparisons = Array.isArray(sanitized.fieldComparisons) ? sanitized.fieldComparisons : [];
    const metadataFieldNames = new Set(metadata.fields.map(field => field.name));
    const literalComparisons = rawComparisons.filter(comparison => !metadataFieldNames.has(comparison?.right) && !aliasToField.has(comparison?.right));
    if (literalComparisons.length) {
      for (const comparison of literalComparisons) {
        const measure = sanitized.measures.find(item => item.alias === comparison.left);
        if (measure) sanitized.resultFilters.push({ field: measure.alias, operator: comparison.operator, value: comparison.right });
        else sanitized.filters.push({ field: aliasToField.get(comparison.left) || comparison.left, operator: comparison.operator, value: comparison.right });
      }
      rawComparisons = rawComparisons.filter(comparison => !literalComparisons.includes(comparison));
      sanitized.fieldComparisons = rawComparisons;
      repairs.push({ requestId, type: 'literal-comparison-to-filter', comparisons: literalComparisons });
    }
    const aliasComparisons = rawComparisons.map(comparison => ({
      ...comparison,
      left: aliasToField.get(comparison?.left) || comparison?.left,
      right: aliasToField.get(comparison?.right) || comparison?.right,
    }));
    if (JSON.stringify(aliasComparisons) !== JSON.stringify(rawComparisons)) {
      sanitized.fieldComparisons = aliasComparisons;
      repairs.push({ requestId, type: 'comparison-alias-to-field', comparisons: aliasComparisons });
    }
    const comparisonFilters = sanitized.filters.filter(filter => metadata.fields.some(field => field.name === filter.value));
    if (comparisonFilters.length) {
      const comparisons = [
        ...(Array.isArray(sanitized.fieldComparisons) ? sanitized.fieldComparisons : []),
        ...comparisonFilters.map(filter => ({ left: filter.field, operator: filter.operator, right: filter.value })),
      ];
      sanitized.fieldComparisons = comparisons.filter((comparison, comparisonIndex) => {
        const signature = `${comparison?.left}|${comparison?.operator}|${comparison?.right}`;
        return comparisons.findIndex(candidate => `${candidate?.left}|${candidate?.operator}|${candidate?.right}` === signature) === comparisonIndex;
      });
      sanitized.filters = sanitized.filters.filter(filter => !comparisonFilters.includes(filter));
      repairs.push({ requestId, type: 'field-to-field-comparison', comparisons: sanitized.fieldComparisons });
    }
    const countRowsMeasures = sanitized.measures.filter(measureItem => measureItem.aggregation === 'countRows');
    const countRowsWithField = countRowsMeasures.filter(measureItem => String(measureItem.field || '').trim());
    if (countRowsWithField.length) {
      for (const measureItem of countRowsWithField) measureItem.field = null;
      repairs.push({ requestId, type: 'countrows-field-removed', aliases: countRowsWithField.map(measureItem => measureItem.alias) });
    }
    if (countRowsMeasures.length > 1) {
      const referencedAliases = new Set([
        ...sanitized.orderBy.map(item => item.field),
        ...sanitized.resultFilters.map(item => item.field),
      ]);
      const retainedCount = countRowsMeasures.find(item => referencedAliases.has(item.alias)) || countRowsMeasures[0];
      sanitized.measures = sanitized.measures.filter(item => item.aggregation !== 'countRows' || item === retainedCount);
      repairs.push({
        requestId,
        type: 'duplicate-countrows-removed',
        retainedAlias: retainedCount.alias,
        removedAliases: countRowsMeasures.filter(item => item !== retainedCount).map(item => item.alias),
      });
    }
    const continuousSelect = sanitized.select.filter(selectItem => {
      const field = metadata.fields.find(candidate => candidate.name === selectItem.field);
      return field && !isGroupableField(field) && field.role === 'measure';
    });
    const remainingSelect = sanitized.select.filter(selectItem => !continuousSelect.includes(selectItem));
    if (continuousSelect.length && remainingSelect.length) {
      sanitized.select = remainingSelect;
      const convertedFields = [];
      const duplicateFields = [];
      for (const selectItem of continuousSelect) {
        const explicitMeasure = sanitized.measures.find(measureItem => (
          measureItem.alias === selectItem.alias || measureItem.field === selectItem.field
        ));
        if (explicitMeasure) {
          duplicateFields.push(selectItem.field);
          continue;
        }
        sanitized.measures.push({
          field: selectItem.field,
          aggregation: 'average',
          alias: selectItem.alias,
          resultType: 'number',
        });
        convertedFields.push(selectItem.field);
      }
      if (convertedFields.length) repairs.push({ requestId, type: 'continuous-select-to-average', fields: convertedFields });
      if (duplicateFields.length) repairs.push({ requestId, type: 'duplicate-measure-removed', fields: duplicateFields });
    }
    const comparisonFields = new Set((Array.isArray(sanitized.fieldComparisons) ? sanitized.fieldComparisons : [])
      .flatMap(comparison => [comparison?.left, comparison?.right]).filter(Boolean));
    const comparisonSelect = sanitized.select.filter(selectItem => comparisonFields.has(selectItem.field));
    const businessSelect = sanitized.select.filter(selectItem => !comparisonFields.has(selectItem.field));
    const hasBusinessGrouping = businessSelect.some(selectItem => {
      const field = metadata.fields.find(candidate => candidate.name === selectItem.field);
      return field && (isGroupableField(field) || (field.role === 'identifier' && sanitized.mode === 'verify'));
    });
    if (comparisonSelect.length && hasBusinessGrouping) {
      sanitized.select = businessSelect;
      repairs.push({ requestId, type: 'comparison-fields-removed-from-select', fields: comparisonSelect.map(selectItem => selectItem.field) });
    }
    const timeOrderIntent = /时间.*(?:顺序|逻辑|先后)|时序|时间戳|早于|晚于/i.test(`${sanitized.purpose || ''} ${item?.lineage?.reason || ''}`);
    const selectedTimeLikeFields = sanitized.select.filter(selectItem => /时间|日期/.test(selectItem.field));
    if (timeOrderIntent && selectedTimeLikeFields.length >= 2 && !(sanitized.fieldComparisons || []).length) {
      throw new Error('时间顺序验证必须使用 fieldComparisons，不能只按两个时间字段分组');
    }
    const hasIdentifierSelect = sanitized.select.some(selectItem => metadata.fields.some(field => field.name === selectItem.field && field.role === 'identifier'));
    if (hasIdentifierSelect && sanitized.mode === 'aggregate') {
      sanitized.mode = 'verify';
      repairs.push({ requestId, type: 'identifier-verification-mode', from: 'aggregate', to: 'verify' });
    }
    const hypothesisId = canonicalExternalId(item?.hypothesisId);
    let hypothesisItem = hypotheses.find(candidate => candidate.id === hypothesisId);
    const inferredOutcomes = inferTriggerOutcomes(sanitized, outcomes);
    let parentHypothesisId = canonicalExternalId(item?.lineage?.parentHypothesisId || hypothesisItem?.parentHypothesisId || hypothesisId);
    if (!knownHypotheses.has(hypothesisId)) {
      const inferredParent = knownHypotheses.has(parentHypothesisId)
        ? parentHypothesisId
        : inferredOutcomes.length === 1 ? inferredOutcomes[0].request.hypothesisId : null;
      if (!inferredParent || !knownHypotheses.has(inferredParent)) throw new Error(`Critic 查询引用未知假设：${item?.hypothesisId || ''}`);
      hypothesisItem = hypothesis(
        hypothesisId,
        sanitized.purpose || `验证 ${inferredParent} 的结果信号`,
        String(item?.lineage?.reason || sanitized.purpose || '验证首轮结果中发现的信号'),
        0.5,
        [sanitized.purpose || '后续验证结果'],
        'ai-critic-normalizer/v2.1',
      );
      hypothesisItem.parentHypothesisId = inferredParent;
      hypotheses.push(hypothesisItem);
      knownHypotheses.add(hypothesisId);
      parentHypothesisId = inferredParent;
      repairs.push({ requestId, type: 'implicit-hypothesis', hypothesisId, parentHypothesisId: inferredParent });
    } else if (!knownHypotheses.has(parentHypothesisId) && inferredOutcomes.length === 1) {
      parentHypothesisId = inferredOutcomes[0].request.hypothesisId;
      repairs.push({ requestId, type: 'parent-hypothesis', parentHypothesisId });
    }
    const assessment = rawAssessments.find(candidate => canonicalExternalId(candidate?.hypothesisId) === parentHypothesisId)
      || rawAssessments.find(candidate => canonicalExternalId(candidate?.hypothesisId) === hypothesisId);
    const declaredTriggers = (Array.isArray(item?.lineage?.triggerResultSetIds) ? item.lineage.triggerResultSetIds.map(canonicalExternalId) : [])
      .filter(id => validResultSetIds.has(id));
    const assessedTriggers = (Array.isArray(assessment?.triggerResultSetIds) ? assessment.triggerResultSetIds.map(canonicalExternalId) : [])
      .filter(id => validResultSetIds.has(id));
    const parentTriggers = outcomes.filter(outcome => outcome.request.hypothesisId === parentHypothesisId).map(outcome => outcome.resultSet.id);
    const explorationOutcomes = outcomes.filter(outcome => !outcome.request.id.startsWith('qry-system-'));
    const inferredTriggers = inferredOutcomes.map(outcome => outcome.resultSet.id);
    const fallbackTriggers = explorationOutcomes.length === 1 ? [explorationOutcomes[0].resultSet.id] : [];
    const triggerResultSetIds = [...new Set([...declaredTriggers, ...assessedTriggers, ...parentTriggers, ...inferredTriggers, ...fallbackTriggers])].slice(0, 8);
    if (!declaredTriggers.length && !assessedTriggers.length && !parentTriggers.length && inferredTriggers.length) {
      repairs.push({ requestId, type: 'trigger-result-set', triggerResultSetIds: inferredTriggers });
    }
    const lineage = {
      parentHypothesisId,
      triggerResultSetIds,
      reason: String(item?.lineage?.reason || assessment?.reason || '基于已执行结果进一步验证').slice(0, 1000),
    };
    const normalized = normalizeCanonicalQueryRequest(metadata, {
      ...sanitized,
      id: requestId,
      hypothesisId,
      lineage,
      topic: INTENTS.has(String(item.topic || initialPlan.intent)) ? String(item.topic || initialPlan.intent) : initialPlan.intent,
      filters: [...filters, ...sanitized.filters],
      dataset: { id: metadata.id, revision: metadata.revision },
    });
    if (!normalized.lineage?.triggerResultSetIds?.length) throw new Error(`Critic 查询 ${normalized.id} 缺少触发结果集`);
    return normalized;
  }).filter(request => !executedFingerprints.has(queryFingerprint(request)));
  const assessments = rawAssessments.map(item => ({
    hypothesisId: canonicalExternalId(item?.hypothesisId),
    status: ['supported', 'rejected', 'inconclusive', 'needs_followup'].includes(item?.status) ? item.status : 'inconclusive',
    reason: String(item?.reason || '').slice(0, 1000),
    triggerResultSetIds: Array.isArray(item?.triggerResultSetIds) ? item.triggerResultSetIds.map(String).slice(0, 8) : [],
  }));
  return { assessments, hypotheses, requests, repairs, mode: 'ai-critic', summary: String(raw.summary || '').slice(0, 1000) };
}

export async function createFollowupPlan(args) {
  const fallback = deterministicFollowup(args);
  if (typeof args.aiCritic !== 'function') return fallback;
  let validationError = '';
  let previousPlan = null;
  const validationErrors = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await args.aiCritic({
        metadata: args.metadata,
        profile: args.profile,
        focus: args.focus,
        initialPlan: args.initialPlan,
        outcomes: args.outcomes,
        remainingBudget: args.remainingBudget,
        validationError,
        previousPlan,
      });
      previousPlan = response.plan || response;
      const normalized = normalizeCriticPlan({ ...args, raw: previousPlan });
      normalized.attempts = attempt + 1;
      normalized.validationErrors = validationErrors;
      if (!normalized.requests.length && fallback.requests.length) {
        return {
          ...fallback,
          mode: 'hybrid-critic',
          summary: `AI Critic 未追加查询；确定性 Critic 检测到可解释信号：${fallback.summary}`,
          aiAssessments: normalized.assessments,
          attempts: attempt + 1,
        };
      }
      return normalized;
    } catch (error) {
      validationError = error.message;
      validationErrors.push(validationError);
    }
  }
  return { ...fallback, attempts: 3, validationErrors, lastInvalidCritique: previousPlan, degradedReason: `AI Critic 降级：${validationError}` };
}
