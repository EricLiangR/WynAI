import { randomUUID } from 'node:crypto';
import { normalizeCanonicalFilters, normalizeCanonicalQueryRequest } from '../planning/query-request-schema.mjs';
import { parseBusinessTimeSemantics } from './time-semantics.mjs';
import { classifyQuestionDimensionRoles, extractQuestionSemanticFrame, semanticFrameConstraintIds } from './question-semantic-frame.mjs';
import { compileQueryProgram } from '../query/query-program.mjs';

const METRIC_CONCEPTS = [
  { id: 'profit', terms: ['利润', '毛利', '盈利'], aliases: ['订单利润', '利润', '毛利', '毛利润'] },
  { id: 'revenue', terms: ['销售额', '收入', '营收', '金额'], aliases: ['订单金额', '销售额', '收入', '营业收入'] },
  { id: 'orderCount', terms: ['订单数量', '订单数', '订单量', '订单笔数'], aliases: ['订单编号'], defaultAggregation: 'distinctCount', defaultAlias: 'order_count' },
  { id: 'quantity', terms: ['数量', '销量', '件数'], aliases: ['购买数量', '销售数量', '销量', '数量'] },
];

const DIMENSION_CONCEPTS = [
  { id: 'category', aliases: ['类别名称', '商品类别', '产品类别', '品类'] },
  { id: 'product', terms: ['商品', '产品'], aliases: ['商品名称', '产品名称'] },
  { id: 'region', aliases: ['客户地区', '销售大区', '大区', '销售区域', '区域', '地区'] },
  { id: 'customerProvince', aliases: ['客户省份', '客户省份简称'] },
  { id: 'headquarterProvince', aliases: ['总部省份'] },
  { id: 'province', aliases: ['客户省份', '客户省份简称', '总部省份'] },
  { id: 'city', aliases: ['客户城市', '销售城市', '城市'] },
  { id: 'customer', aliases: ['客户名称', '顾客名称'] },
  { id: 'supplier', aliases: ['供应商名称', '供应商'] },
  { id: 'employee', terms: ['员工', '销售经理', '销售员', '业务员', '销售代表'], aliases: ['员工姓名', '销售经理', '销售员', '业务员', '销售代表'] },
  { id: 'payment', aliases: ['支付方式', '付款方式'] },
  { id: 'shipper', aliases: ['运货商', '承运商'] },
];

const NUMBER_WORDS = new Map([
  ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
  ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
]);

function textOf(field) {
  return [field?.name, field?.displayName, field?.description, field?.semanticDescription, ...(field?.synonyms || [])]
    .filter(Boolean).join(' ').toLowerCase();
}

function isTimeField(field) {
  return field?.role === 'time' || /date|time|日期|时间/i.test(`${field?.type || ''} ${field?.rawType || ''} ${field?.name || ''}`);
}

function isMeasureField(field) {
  return field?.role === 'measure' || /number|decimal|double|float|int|long/i.test(`${field?.type || ''} ${field?.rawType || ''}`);
}

function isDimensionField(field) {
  return ['dimension', 'geography', 'identifier'].includes(field?.role) || (!isTimeField(field) && !isMeasureField(field));
}

function fieldByExactAlias(metadata, aliases, predicate) {
  const fields = (metadata?.fields || []).filter(predicate);
  for (const alias of aliases) {
    const exact = fields.find(field => field.name === alias || field.displayName === alias);
    if (exact) return exact;
  }
  return fields.find(field => aliases.some(alias => textOf(field).includes(alias.toLowerCase()))) || null;
}

function mentionedConcept(question, concepts) {
  const candidates = concepts
    .map(concept => ({ concept, term: concept.terms.filter(term => question.includes(term)).sort((a, b) => b.length - a.length)[0] }))
    .filter(item => item.term)
    .sort((left, right) => right.term.length - left.term.length);
  return candidates[0]?.concept || null;
}

function previousField(previousIntent, kind) {
  return kind === 'metric' ? previousIntent?.metrics?.[0]?.field : previousIntent?.dimensions?.[0]?.field;
}

function catalogField(metadata, name) {
  return (metadata?.fields || []).find(field => field.name === name) || null;
}

function mentionedCatalogField(metadata, question, predicate) {
  const candidates = (metadata?.fields || []).filter(predicate).flatMap(field => [field.name, field.displayName, ...(field.synonyms || [])]
    .filter(value => String(value || '').trim().length >= 2)
    .map(value => ({ field, value: String(value).trim() })))
    .sort((left, right) => right.value.length - left.value.length);
  return candidates.find(item => question.includes(item.value))?.field || null;
}

function mentionedCatalogFields(metadata, question, predicate) {
  const matches = (metadata?.fields || []).filter(predicate).flatMap(field =>
    [field.name, field.displayName, ...(field.synonyms || [])]
      .map(value => String(value || '').trim())
      .filter(value => value.length >= 2 && question.includes(value))
      .map(value => ({ field, value })))
    .sort((left, right) => right.value.length - left.value.length);
  return matches.filter((item, index) => matches.findIndex(candidate => candidate.field.name === item.field.name) === index);
}

function explicitOutputClause(question) {
  const text = String(question || '');
  const match = text.match(/(?:返回|列出|列举|展示|显示|输出|给出|字段(?:为|包括)?|信息(?:为|包括)?)[：:，,、\s]*(.+)$/);
  return match?.[1] || '';
}

function isRawDetailRequest(question) {
  return /(?:原始(?:记录|明细)|逐条(?:记录|明细)|每条(?:原始)?(?:记录|明细)|不(?:做)?聚合|不(?:做)?去重|保留重复|raw\s+(?:record|row)|without\s+(?:aggregation|deduplication))/i.test(String(question || ''));
}

function mentionedSkillOutputFields(metadata, question, skills = []) {
  const clause = explicitOutputClause(question);
  if (!clause) return [];
  const fields = new Map((metadata?.fields || []).map(field => [field.name, field]));
  return (skills || []).flatMap(skill => (skill?.businessEntities || []).flatMap(entity => {
    const field = fields.get(entity?.field);
    if (!field || !(isDimensionField(field) || isTimeField(field))) return [];
    const terms = [entity.name, ...(entity.synonyms || [])]
      .map(value => String(value || '').trim())
      .filter(value => value.length >= 2)
      .sort((left, right) => right.length - left.length);
    const source = terms.find(term => clause.includes(term));
    return source ? [{ field, value: source, concept: entity.concept || entity.id || 'dimension' }] : [];
  })).filter((item, index, values) => values.findIndex(candidate => candidate.field.name === item.field.name) === index);
}

function conceptRoot(value) {
  return String(value || '').replace(/(?:Category|Subcategory|Name|Type|Level\d*)$/i, '').toLowerCase();
}

function mentionedSkillGroupingFields(metadata, question, skills = []) {
  const clauses = [...String(question || '').matchAll(/(?:按|以)([^，,。；;]{1,40}?)(?:统计|汇总|分组|分析|计算)/g)]
    .map(match => match[1]);
  if (!clauses.length) return [];
  const fields = new Map((metadata?.fields || []).map(field => [field.name, field]));
  const matches = clauses.flatMap((clause, clauseIndex) => (skills || []).flatMap(skill => (skill?.businessEntities || []).flatMap(entity => {
    const field = fields.get(entity?.field);
    if (!field || !(isDimensionField(field) || isTimeField(field))) return [];
    const terms = [entity.name, ...(entity.synonyms || [])]
      .map(value => String(value || '').trim()).filter(value => value.length >= 2)
      .sort((left, right) => right.length - left.length);
    const value = terms.find(term => clause.toLowerCase().includes(term.toLowerCase()));
    return value ? [{ field, value, concept: entity.concept || entity.id || 'dimension', clauseIndex }] : [];
  })));
  const mostSpecific = new Map();
  for (const match of matches) {
    const key = `${match.clauseIndex}:${conceptRoot(match.concept)}`;
    const current = mostSpecific.get(key);
    if (!current || match.value.length > current.value.length) mostSpecific.set(key, match);
  }
  return [...mostSpecific.values()];
}

function preferExplicitCatalogMentions(frame, metadata, question, skills = []) {
  const detailOutput = isRawDetailRequest(question);
  const replace = (items, matches, kind) => {
    let resolved = [...items];
    for (const match of matches) {
      const shadows = resolved.filter(item => item.source && match.value !== item.source && match.value.includes(item.source));
      if (shadows.length) resolved = resolved.filter(item => !shadows.includes(item));
      if (!resolved.some(item => item.source === match.field.name)) {
        resolved.push({
          concept: kind === 'metric' ? inferMetricConcept(match.field).id : kind,
          source: match.field.name,
          required: true,
        });
      }
    }
    return resolved;
  };
  // In a raw-detail request, a numeric field named in the output list is a
  // projected source column, not an aggregate metric constraint.
  const metricMentions = mentionedCatalogFields(metadata, question, isMeasureField)
    .filter(match => !detailOutput || !explicitOutputClause(question).includes(match.value));
  const metrics = replace(frame.metrics || [], metricMentions, 'metric');
  const dimensions = replace([
    ...(frame.dimensions || []),
  ], [
    ...mentionedCatalogFields(metadata, question, isDimensionField),
    ...mentionedSkillOutputFields(metadata, question, skills),
  ], 'dimension');
  const skillGroupingFields = mentionedSkillGroupingFields(metadata, question, skills);
  const skillDimensionFields = [
    ...mentionedSkillOutputFields(metadata, question, skills),
    ...skillGroupingFields,
  ].filter((item, index, values) => values.findIndex(candidate => candidate.field.name === item.field.name) === index);
  for (const match of skillDimensionFields) {
    const item = dimensions.find(value => value.source === match.field.name);
    if (item && item.concept === 'dimension') item.concept = match.concept;
  }
  for (const match of skillDimensionFields) {
    const root = conceptRoot(match.concept);
    for (let index = dimensions.length - 1; index >= 0; index -= 1) {
      const item = dimensions[index];
      if (item.source !== match.field.name && root && conceptRoot(item.concept) === root) dimensions.splice(index, 1);
    }
    if (!dimensions.some(item => item.source === match.field.name)) {
      dimensions.push({ concept: match.concept, source: match.field.name, required: true });
    }
  }
  const groupingFieldNames = new Set(skillGroupingFields.map(item => item.field.name));
  const classifiedDimensions = classifyQuestionDimensionRoles(question, dimensions, metrics)
    .map(item => groupingFieldNames.has(item.source) ? { ...item, outputRole: 'grouping' } : item);
  return {
    ...frame,
    metrics,
    dimensions: classifiedDimensions,
    requestedOutputs: [
      ...classifiedDimensions.filter(item => item.outputRole !== 'scope')
        .map(item => ({ kind: 'entity', concept: item.concept, source: item.source, required: true })),
      ...metrics.map(item => ({ kind: 'metric', concept: item.concept, source: item.source, required: true })),
      ...(frame.requestedOutputs || []).filter(item => !['entity', 'metric'].includes(item.kind)),
    ],
  };
}

function inferMetricConcept(field) {
  return METRIC_CONCEPTS.find(concept => concept.aliases.some(alias => textOf(field).includes(alias.toLowerCase()))) || { id: 'metric' };
}

function skillMetricResolution(metadata, question, requestedConcept, skills = []) {
  for (const skill of skills || []) {
    if (skill.status && skill.status !== 'approved') continue;
    for (const metric of skill.metrics || []) {
      const terms = [metric.name, metric.id, ...(metric.synonyms || [])].map(String).filter(Boolean).sort((a, b) => b.length - a.length);
      const conceptId = metric.concept || METRIC_CONCEPTS.find(item => terms.some(term => item.terms?.includes(term)))?.id || requestedConcept;
      if (requestedConcept && conceptId && requestedConcept !== conceptId) continue;
      if (!terms.some(term => question.includes(term)) && requestedConcept !== conceptId) continue;
      const field = catalogField(metadata, metric.field);
      if (!field) continue;
      const concept = METRIC_CONCEPTS.find(item => item.id === conceptId) || { id: conceptId || 'metric' };
      return {
        field,
        concept,
        explicit: true,
        skillMetricId: metric.id || metric.name,
        aggregation: metric.aggregation || concept.defaultAggregation || 'sum',
        unitFamily: metric.unitFamily || null,
      };
    }
  }
  return null;
}

function governedFormulaMetric(skills, mention) {
  for (const skill of skills || []) {
    if (skill.status && skill.status !== 'approved') continue;
    const metric = (skill.metrics || []).find(item =>
      item.formula
      && (item.id === mention.metricId || item.concept === mention.concept || item.outputAlias === mention.alias)
    );
    if (!metric) continue;
    const dependencies = (metric.formula.inputs || []).map(metricId => (skill.metrics || []).find(item => item.id === metricId && item.field && !item.formula));
    if (dependencies.some(item => !item)) return null;
    return { skill, metric, dependencies };
  }
  return null;
}

function resolveMetric(metadata, question, previousIntent, requestedConcept = null, skills = []) {
  const skillResolution = skillMetricResolution(metadata, question, requestedConcept, skills);
  if (skillResolution) return skillResolution;
  const concept = METRIC_CONCEPTS.find(item => item.id === requestedConcept) || mentionedConcept(question, METRIC_CONCEPTS);
  if (concept) {
    const conceptField = mentionedCatalogField(metadata, question, field =>
      (isMeasureField(field) || concept.defaultAggregation === 'distinctCount')
      && concept.aliases.some(alias => textOf(field).includes(alias.toLowerCase()))
    ) || fieldByExactAlias(metadata, concept.aliases, field => isMeasureField(field) || concept.defaultAggregation === 'distinctCount');
    return { field: conceptField, concept, explicit: true, aggregation: concept.defaultAggregation };
  }
  const directField = mentionedCatalogField(metadata, question, isMeasureField);
  if (directField) return { field: directField, concept: inferMetricConcept(directField), explicit: true };
  const inherited = catalogField(metadata, previousField(previousIntent, 'metric'));
  if (inherited) return { field: inherited, concept: { id: previousIntent.metrics[0].concept || inferMetricConcept(inherited).id }, explicit: false, aggregation: previousIntent.metrics[0].aggregation, unitFamily: previousIntent.metrics[0].unitFamily };
  return { field: null, concept: null, explicit: false };
}

function escapedPattern(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aggregationForMetric(question, resolution, inheritedAggregation = null) {
  const terms = [
    resolution?.mentionSource,
    resolution?.field?.name,
    ...(resolution?.concept?.terms || []),
  ].map(value => String(value || '').trim()).filter(Boolean);
  const locallyAveraged = terms.some(term => {
    const escaped = escapedPattern(term);
    return new RegExp(`(?:平均|均值)[^，,。；;、和及]{0,8}${escaped}|${escaped}(?:的)?(?:平均|均值)`).test(question);
  });
  if (locallyAveraged) return 'average';
  return resolution?.aggregation || resolution?.concept?.defaultAggregation || inheritedAggregation || 'sum';
}
function skillEntityResolution(metadata, question, requestedConcept, skills = []) {
  for (const skill of skills || []) {
    for (const entity of skill.businessEntities || []) {
      const terms = [entity.name, ...(entity.synonyms || [])].filter(Boolean);
      if (requestedConcept && entity.concept && requestedConcept !== entity.concept) continue;
      if (!terms.some(term => question.includes(term))) continue;
      const field = catalogField(metadata, entity.field);
      if (!field || !isDimensionField(field)) continue;
      const concept = DIMENSION_CONCEPTS.find(item => item.id === (entity.concept || requestedConcept)) || { id: entity.concept || requestedConcept || entity.id };
      return { field, concept, explicit: true, skillEntityId: entity.id };
    }
  }
  return null;
}
function resolveDimension(metadata, question, previousIntent, modifier, requestedConcept = null, skills = []) {
  const directField = requestedConcept && requestedConcept !== 'dimension' ? null : mentionedCatalogField(metadata, question, isDimensionField);
  if (directField) return { field: directField, concept: { id: 'dimension' }, explicit: true };
  const skillResolution = skillEntityResolution(metadata, question, requestedConcept, skills);
  if (skillResolution) return skillResolution;
  const concept = DIMENSION_CONCEPTS.find(item => item.id === requestedConcept) || mentionedConcept(question, DIMENSION_CONCEPTS.filter(item => item.terms));
  if (concept) return { field: fieldByExactAlias(metadata, concept.aliases, isDimensionField), concept, explicit: true };
  const inherited = modifier ? catalogField(metadata, previousField(previousIntent, 'dimension')) : null;
  if (inherited) return { field: inherited, concept: { id: previousIntent.dimensions[0].concept || 'inherited' }, explicit: false };
  return { field: null, concept: null, explicit: false };
}

function resolveTimeField(metadata, previousIntent) {
  const previous = catalogField(metadata, previousIntent?.time?.field);
  if (previous && isTimeField(previous)) return previous;
  const preferred = ['订购日期', '订单日期', '销售日期', '业务日期', '日期'];
  return fieldByExactAlias(metadata, preferred, isTimeField) || (metadata?.fields || []).find(isTimeField) || null;
}

function parseRanking(question) {
  const percent = question.match(/(?:前|top\s*)(\d{1,3})\s*%/i) || question.match(/(?:后|倒数|bottom\s*)(\d{1,3})\s*%/i);
  if (percent) return {
    limit: 20000,
    percentage: Math.max(1, Math.min(100, Number(percent[1]))),
    direction: /后|倒数|bottom/i.test(percent[0]) ? 'asc' : 'desc',
    explicit: true,
    kind: 'rank-percentage',
    source: percent[0],
  };
  const top = question.match(/(?:前|top\s*)(\d{1,3}|[一二两三四五六七八九十])(?:名|个|项)?/i);
  const bottom = question.match(/(?:后|倒数)(\d{1,3}|[一二两三四五六七八九十])(?:名|个|项)?/i);
  const match = top || bottom;
  if (!match) {
    const superlative = question.match(/最高|最大|最多|第一|最优|最低|最小|最少|最后/);
    if (!superlative) return null;
    return {
      limit: 1,
      direction: /最低|最小|最少|最后/.test(superlative[0]) ? 'asc' : 'desc',
      explicit: true,
      kind: 'superlative',
      source: superlative[0],
    };
  }
  return {
    limit: Math.max(1, Math.min(100, Number(match[1]) || NUMBER_WORDS.get(match[1]) || 10)),
    direction: bottom || /最低|最少/.test(question) ? 'asc' : 'desc',
    explicit: true,
    kind: 'rank',
    source: match[0],
  };
}

function regionFilter(question, metadata) {
  const field = fieldByExactAlias(metadata, ['客户地区', '区域', '地区'], isDimensionField);
  if (!field) return null;
  const values = [...new Set([...question.matchAll(/(华东|华北|华南|华中|西南|西北|东北)(?:地区|区域)?/g)].map(match => match[1]))];
  if (!values.length) return null;
  const source = values.join('、');
  return values.length === 1
    ? { field: field.name, operator: 'eq', value: values[0], values, source }
    : { field: field.name, operator: 'in', value: values, values, source };
}

function removeFields(filters, fields) {
  return (filters || []).filter(filter => !fields.has(filter.field));
}

function constraint(id, type, source, normalized, required = true) {
  return { id, type, source, normalized, required, status: normalized == null ? 'unresolved' : 'resolved' };
}

function normalizeFilterLedgerValue(value) {
  return Array.isArray(value) ? value.map(item => String(item)).sort() : value == null ? null : String(value);
}

function filterLedgerConstraints(filters = [], source = '') {
  return (filters || []).map((filter, index) => constraint(
    `filter-ledger-${index + 1}`,
    'filter',
    filter?.source || source || filter?.field || 'filter',
    filter?.field ? {
      field: filter.field,
      operator: filter.operator || 'eq',
      value: normalizeFilterLedgerValue(filter.value),
      negated: Boolean(filter.negated),
    } : null,
  ));
}

function withFilterLedger(intent) {
  const constraints = (intent?.constraints || []).filter(item => !/^filter-ledger-\d+$/.test(String(item?.id || '')));
  return {
    ...intent,
    constraints: [...constraints, ...filterLedgerConstraints(intent?.filters, intent?.businessQuestion)],
  };
}

function filterSignature(filter) {
  return JSON.stringify({
    field: String(filter?.field || ''),
    operator: String(filter?.operator || 'eq'),
    value: normalizeFilterLedgerValue(filter?.value),
  });
}

function expectedShape({ dimensions, time, scalar, ranking }) {
  if (!dimensions.length) return 'scalar';
  if (dimensions.length > 1) return 'grouped-table';
  if (dimensions.some(item => item.grain) || time.grain) return 'time-series';
  return ranking ? 'grouped-table' : scalar ? 'scalar' : 'grouped-table';
}

function dimensionAlias(concept) {
  return ({
    category: 'category', product: 'product', region: 'region', customerProvince: 'province',
    headquarterProvince: 'province', province: 'province', city: 'city', customer: 'customer',
    supplier: 'supplier', employee: 'employee', payment: 'payment', shipper: 'shipper',
  })[concept] || 'dimension';
}

function conceptsCompatible(expected, actual) {
  if (expected === actual) return true;
  return expected === 'province' && ['customerProvince', 'headquarterProvince', 'province'].includes(actual);
}

function frameConstraints(frame, resolutions, { timeField, ranking, time }) {
  const constraints = [];
  frame.metrics.forEach((mention, index) => {
    const resolution = resolutions.metrics[index];
    constraints.push(constraint(`frame-metric-${index + 1}`, 'metric', mention.source, resolution?.field?.name || null));
  });
  frame.dimensions.forEach((mention, index) => {
    if (mention.outputRole === 'scope') return;
    const resolution = resolutions.dimensions[index];
    constraints.push(constraint(`frame-dimension-${index + 1}`, 'dimension', mention.source, resolution?.field ? {
      field: resolution.field.name, concept: resolution.concept?.id, level: mention.level,
    } : null));
  });
  if (frame.time.scopeExplicit) constraints.push(constraint('frame-time-scope', 'time-scope', frame.time.source || frame.question, time.range && timeField ? {
    field: timeField.name, range: time.range,
  } : null));
  if (frame.time.grouping) constraints.push(constraint('frame-time-grouping', 'time-grouping', frame.time.source || frame.question, timeField ? {
    field: timeField.name, grain: frame.time.grouping,
  } : null));
  if (frame.accumulation.required) constraints.push(constraint('frame-accumulation', 'accumulation', frame.accumulation.source, {
    mode: frame.accumulation.mode,
  }));
  if (frame.ranking) constraints.push(constraint('frame-ranking', 'ranking', frame.ranking.source, ranking ? {
    limit: ranking.limit, direction: ranking.direction,
  } : null));
  if (frame.visualizationIntent?.explicit) constraints.push(constraint('frame-visualization', 'visualization', frame.visualizationIntent.source, {
    type: frame.visualizationIntent.type,
    source: 'user',
  }));
  (frame.derivedMetrics || []).forEach((mention, index) => {
    if (mention.type === 'formula') {
      const dependencies = (mention.dependencyMetricIds || []).map(metricId => resolutions.metrics.find(item => item.skillMetricId === metricId && item.field));
      const resolved = dependencies.length >= 2 && dependencies.every(Boolean);
      constraints.push(constraint('frame-derived-' + (index + 1), 'derived-metric', mention.source, resolved ? {
        type: 'formula',
        operator: mention.operator,
        metricId: mention.metricId,
        dependencyFields: dependencies.map(item => item.field.name),
        alias: mention.alias,
        skillRef: mention.skillRef,
      } : null));
      return;
    }
    const source = resolutions.metrics.find(item => item.concept?.id === mention.sourceConcept && item.field);
    const shareDimension = mention.type === 'share-of-total'
      ? resolutions.dimensions.find(item => item.concept?.id === mention.shareDimensionConcept && item.field)
      : null;
    const resolved = source && (mention.type !== 'share-of-total' || shareDimension);
    constraints.push(constraint('frame-derived-' + (index + 1), 'derived-metric', mention.source, resolved ? {
      type: mention.type,
      sourceField: source.field.name,
      shareDimensionField: shareDimension?.field?.name || null,
      denominatorScope: mention.denominatorScope || null,
      alias: mention.alias,
    } : null));
  });
  frame.requestedOutputs.forEach((output, index) => {
    const resolved = output.kind === 'metric'
      ? resolutions.metrics.some(item => item.concept?.id === output.concept && item.field)
      : output.kind === 'derived-metric'
        ? (frame.derivedMetrics || []).some(item => item.alias === output.alias && (item.type !== 'formula' || (item.dependencyMetricIds || []).every(metricId => resolutions.metrics.some(metric => metric.skillMetricId === metricId && metric.field))))
        : resolutions.dimensions.some(item => conceptsCompatible(output.concept, item.concept?.id) && item.field);
    constraints.push(constraint(`frame-output-${index + 1}`, 'requested-output', output.source, resolved ? {
      kind: output.kind, concept: output.concept,
    } : null));
  });
  return constraints;
}

export function buildBusinessQueryIntent({
  metadata,
  question,
  previousIntent = null,
  previousRequest = null,
  skillRefs = [],
  skills = [],
  now = new Date(),
  timeZone = 'Asia/Shanghai',
  source = 'deterministic-semantic-planner',
} = {}) {
  const text = String(question || '').trim();
  const modifier = /^(?:继续|再|然后|接着|改为|改成|换成|只看|仅看|按|同时|增加|加上|再加|另外加|并且)/.test(text);
  const additiveModifier = /^(?:同时|增加|加上|再加|另外加|并且)/.test(text);
  const previousTime = previousIntent?.time || (previousRequest ? {
    field: previousRequest.select?.find(item => item.grain)?.field || previousRequest.filters?.find(item => catalogField(metadata, item.field) && isTimeField(catalogField(metadata, item.field)))?.field,
    grain: previousRequest.select?.find(item => item.grain)?.grain || null,
    range: (() => {
      const filters = previousRequest.filters || [];
      const start = filters.find(item => item.operator === 'gte')?.value;
      const endExclusive = filters.find(item => item.operator === 'lt')?.value;
      return start && endExclusive ? { start, endExclusive } : null;
    })(),
    periods: [],
  } : null);
  const time = parseBusinessTimeSemantics(text, { now, previous: previousTime, timeZone, skills });
  const semanticFrame = preferExplicitCatalogMentions(extractQuestionSemanticFrame(text, { time, skills }), metadata, text, skills);
  // Dataset catalog names are first-class semantic references, including custom business fields.
  if (!semanticFrame.metrics.length) {
    const field = mentionedCatalogField(metadata, text, isMeasureField);
    const isDetailOutputField = isRawDetailRequest(text) && explicitOutputClause(text).includes(field?.name || '');
    if (field && !isDetailOutputField) semanticFrame.metrics.push({ concept: inferMetricConcept(field).id, source: field.name, required: true });
  }
  if (!semanticFrame.dimensions.length) {
    const field = mentionedCatalogField(metadata, text, isDimensionField);
    if (field) {
      semanticFrame.dimensions.push({ concept: 'dimension', level: null, entity: null, source: field.name, required: true });
      semanticFrame.requestedOutputs = semanticFrame.requestedOutputs.map(item => item.kind === 'entity' && item.concept == null ? { ...item, concept: 'dimension', status: 'resolved' } : item);
    }
  }
  if (modifier && !semanticFrame.metrics.length && semanticFrame.derivedMetrics?.some(item => item.type !== 'formula') && previousIntent?.metrics?.[0]?.concept) {
    const inheritedConcept = previousIntent.metrics[0].concept;
    semanticFrame.derivedMetrics = semanticFrame.derivedMetrics.map(item => item.type === 'formula' ? item : ({ ...item, sourceConcept: inheritedConcept, alias: inheritedConcept + '_' + item.type, status: 'resolved', bindingCandidates: undefined }));
    semanticFrame.requestedOutputs = semanticFrame.requestedOutputs.map(item => item.kind === 'derived-metric' && item.derivation !== 'formula' ? { ...item, concept: inheritedConcept, alias: inheritedConcept + '_' + item.derivation } : item);
  }
  const timeField = resolveTimeField(metadata, previousIntent);
  const priorMetricIntent = previousIntent || (previousRequest ? { metrics: previousRequest.measures } : null);
  const priorDimensionIntent = previousIntent || (previousRequest ? { dimensions: previousRequest.select } : null);
  let metricResolutions = semanticFrame.metrics.length
    ? semanticFrame.metrics.map(mention => {
      const directField = catalogField(metadata, mention.source);
      const resolution = directField && isMeasureField(directField)
        ? { field: directField, concept: inferMetricConcept(directField), explicit: true }
        : resolveMetric(metadata, text, priorMetricIntent, mention.concept, skills);
      return { ...resolution, mentionSource: mention.source };
    })
    : semanticFrame.derivedMetrics?.some(item => item.type === 'formula')
      ? []
      : modifier && previousIntent?.metrics?.length
      ? previousIntent.metrics.map(metric => ({ field: catalogField(metadata, metric.field), concept: METRIC_CONCEPTS.find(item => item.id === metric.concept) || { id: metric.concept }, explicit: false, aggregation: metric.aggregation, unitFamily: metric.unitFamily, skillMetricId: metric.metricId, internal: metric.internal })).filter(item => item.field)
      : [resolveMetric(metadata, text, priorMetricIntent, null, skills)];
  if (additiveModifier && previousIntent?.metrics?.length) {
    metricResolutions = [
      ...previousIntent.metrics.map(metric => ({ field: catalogField(metadata, metric.field), concept: METRIC_CONCEPTS.find(item => item.id === metric.concept) || { id: metric.concept }, explicit: false, aggregation: metric.aggregation, unitFamily: metric.unitFamily, skillMetricId: metric.metricId, internal: metric.internal })).filter(item => item.field),
      ...metricResolutions,
    ];
  }
  const explicitMetricConcepts = new Set(semanticFrame.metrics.map(item => item.concept));
  for (const mention of semanticFrame.derivedMetrics || []) {
    if (mention.type !== 'formula') continue;
    const governed = governedFormulaMetric(skills, mention);
    if (!governed) continue;
    for (const dependency of governed.dependencies) {
      const existing = metricResolutions.find(item => item.skillMetricId === dependency.id || item.concept?.id === dependency.concept || item.field?.name === dependency.field);
      if (existing) {
        if (explicitMetricConcepts.has(dependency.concept)) existing.internal = false;
        continue;
      }
      const field = catalogField(metadata, dependency.field);
      if (!field) continue;
      metricResolutions.push({
        field,
        concept: METRIC_CONCEPTS.find(item => item.id === dependency.concept) || { id: dependency.concept || dependency.id },
        explicit: false,
        skillMetricId: dependency.id,
        aggregation: dependency.aggregation || 'sum',
        unitFamily: dependency.unitFamily || null,
        internal: !explicitMetricConcepts.has(dependency.concept),
      });
    }
  }
  const dimensionResolutions = semanticFrame.dimensions.map(mention => {
    const directField = catalogField(metadata, mention.source);
    const resolution = directField && (isDimensionField(directField) || isTimeField(directField))
      ? { field: directField, concept: { id: mention.concept || 'dimension' }, explicit: true }
      : resolveDimension(metadata, text, priorDimensionIntent, modifier, mention.concept, skills);
    if (mention.concept === 'province' && resolution.field?.name === '客户省份') {
      return { ...resolution, concept: DIMENSION_CONCEPTS.find(item => item.id === 'customerProvince'), defaulted: true };
    }
    return resolution;
  });
  let ranking = semanticFrame.ranking || parseRanking(text) || (modifier ? previousIntent?.ranking || null : null);
  const dimensions = [];
  for (const [index, resolution] of dimensionResolutions.entries()) {
    if (semanticFrame.dimensions[index]?.outputRole === 'scope') continue;
    if (!resolution?.field || dimensions.some(item => item.field === resolution.field.name)) continue;
    dimensions.push({ field: resolution.field.name, alias: dimensionAlias(resolution.concept?.id), grain: null, concept: resolution.concept?.id || 'dimension' });
  }
  if (!semanticFrame.dimensions.length && modifier && previousIntent?.dimensions?.length) {
    for (const previous of previousIntent.dimensions.filter(item => !item.grain && item.concept !== 'time')) {
      if (dimensions.length >= 8 || dimensions.some(item => item.field === previous.field)) continue;
      dimensions.push(previous);
    }
  }
  if (additiveModifier && semanticFrame.dimensions.length && previousIntent?.dimensions?.length) {
    for (const previous of previousIntent.dimensions.filter(item => !item.grain && item.concept !== 'time')) {
      if (dimensions.length >= 8 || dimensions.some(item => item.field === previous.field)) continue;
      dimensions.unshift(previous);
    }
  }
  if (time.grain && timeField && !dimensions.some(item => item.field === timeField.name)) {
    dimensions.push({ field: timeField.name, alias: 'period', grain: time.grain, concept: 'time', internal: time.grainRole === 'derivation' && time.periods.length === 1 });
  }
  if (ranking?.partitionBy?.length) {
    const aliases = ranking.partitionBy.map(value => dimensions.find(item => item.alias === value || item.concept === value)?.alias).filter(Boolean);
    ranking = { ...ranking, partitionBy: aliases };
  }
  const inheritedAggregation = modifier ? previousIntent?.metrics?.[0]?.aggregation || null : null;
  const metrics = metricResolutions.filter(item => item.field).map(item => ({
    field: item.field.name,
    aggregation: aggregationForMetric(text, item, inheritedAggregation),
    alias: item.concept?.defaultAlias || (item.concept?.id === 'profit' ? 'profit' : item.concept?.id === 'quantity' ? 'quantity' : item.concept?.id === 'orderCount' ? 'order_count' : item.concept?.id === 'revenue' ? 'revenue' : item.skillMetricId || 'metric'),
    concept: item.concept?.id || 'metric',
    metricId: item.skillMetricId || null,
    unitFamily: item.unitFamily || null,
    internal: Boolean(item.internal),
  })).filter((item, index, values) => values.findIndex(value => value.field === item.field && value.aggregation === item.aggregation) === index);
  const hasExplicitDerivedMetrics = Boolean(semanticFrame.derivedMetrics?.length);
  const requestedDerivedMetrics = hasExplicitDerivedMetrics
    ? additiveModifier ? [...(previousIntent?.derivedMetrics || []), ...semanticFrame.derivedMetrics] : semanticFrame.derivedMetrics
    : modifier ? previousIntent?.derivedMetrics || [] : [];
  const derivedMetrics = requestedDerivedMetrics.map(item => {
    if (item.type === 'formula') {
      const governed = governedFormulaMetric(skills, item);
      if (!governed) {
        // Do not allow the LLM to invent an executable formula. Surface it as
        // an unresolved derived metric so the caller can clarify or report the
        // missing Skill capability instead of returning an empty value.
        return { ...item, type: 'formula', status: 'unresolved', required: true };
      }
      const dependencies = governed.dependencies.map(dependency => {
        const source = metrics.find(metric => metric.metricId === dependency.id || metric.concept === dependency.concept);
        return source ? { metricId: dependency.id, sourceAlias: source.alias } : null;
      });
      if (dependencies.some(dependency => !dependency)) return null;
      return {
        type: 'formula',
        operator: governed.metric.formula.operator,
        metricId: governed.metric.id,
        concept: governed.metric.concept || governed.metric.id,
        source: item.source || governed.metric.name,
        alias: governed.metric.outputAlias || item.alias || governed.metric.id,
        dependencies,
        resultType: governed.metric.unitFamily === 'percentage' ? 'percentage' : 'number',
        unitFamily: governed.metric.unitFamily || null,
        aggregationOrder: 'aggregate-then-calculate',
        zeroDivision: governed.metric.formula.zeroDivision || 'null',
        skillRef: `${governed.skill.id}@${governed.skill.version}`,
        required: true,
      };
    }
    if (item.status === 'unresolved' || !item.sourceConcept) return null;
    const sourceMetric = metrics.find(metric => metric.concept === item.sourceConcept || metric.alias === item.sourceAlias) || null;
    const sourceConcept = hasExplicitDerivedMetrics ? item.sourceConcept : sourceMetric?.concept || item.sourceConcept;
    if (item.type === 'share-of-total') {
      const shareDimension = dimensions.find(dimension => dimension.concept === item.shareDimensionConcept) || dimensions.at(-1) || null;
      return {
        ...item,
        sourceConcept,
        alias: `${sourceConcept}_share`,
        sourceAlias: sourceMetric?.alias || null,
        shareDimensionAlias: shareDimension?.alias || null,
        partitionBy: dimensions.filter(dimension => dimension.alias !== shareDimension?.alias).map(dimension => dimension.alias),
        denominatorScope: item.denominatorScope || 'filtered-result',
      };
    }
    return { ...item, sourceConcept, alias: sourceConcept + '_' + item.type, sourceAlias: sourceMetric?.alias || null };
  }).filter(item => item && (item.type === 'formula' ? item.dependencies?.length >= 2 : item.sourceAlias));
  // Keep the additive source metric visible whenever a composition/share is
  // requested. It is the exact value used by charts and is also required in
  // the table; the derived percentage remains a separate governed metric.
  if (ranking) {
    const rankingMetric = derivedMetrics[0] || metrics.find(item => !item.internal) || metrics[0];
    ranking = { ...ranking, orderBy: rankingMetric?.alias || null };
  }
  const inheritedFilters = modifier ? (previousIntent?.filters || previousRequest?.filters || []) : [];
  const replaced = new Set(timeField ? [timeField.name] : []);
  let filters = time.range && timeField
    ? [...removeFields(inheritedFilters, replaced), { field: timeField.name, operator: 'gte', value: time.range.start }, { field: timeField.name, operator: 'lt', value: time.range.endExclusive }]
    : [...inheritedFilters];
  const region = regionFilter(text, metadata);
  if (region) filters = [...filters.filter(item => item.field !== region.field), { field: region.field, operator: region.operator, value: region.value }];
  const constraints = [
    ...frameConstraints(semanticFrame, { metrics: metricResolutions, dimensions: dimensionResolutions }, { timeField, ranking, time }),
    ...filterLedgerConstraints(filters, text),
  ];
  if (!semanticFrame.metrics.length) constraints.push(constraint('metric', 'metric', text, metrics[0]?.field || null));
  if ((ranking || /按|每|各|分别|趋势/.test(text)) && !dimensions.length) constraints.push(constraint('dimension', 'dimension', text, null));
  if ((time.scopeExplicit || time.groupingExplicit) && !timeField) constraints.push(constraint('time-field', 'time-field', text, null));
  if (ranking?.partitionBy?.length) constraints.push(constraint('partitioned-ranking', 'partitioned-ranking', text, { partitionBy: ranking.partitionBy, limit: ranking.limit }));
  const maximumRows = ranking?.partitionBy?.length ? (time.periods.length ? ranking.limit * time.periods.length : 20000) : ranking?.limit || (dimensions.length >= 3 ? 20000 : time.grain ? 240 : dimensions.length ? 100 : 1);
  const periodDimension = dimensions.find(item => item.grain);
  const requiredPeriods = time.grain === 'year' && !periodDimension?.internal ? time.periods.map(year => String(year)) : [];
  const explicitScalar = dimensions.length === 0 && !ranking;
  const intent = {
    schema: 'wynai.business-query-intent/v2',
    intentId: `bqi-${randomUUID()}`,
    businessQuestion: text,
    source: { planner: source, version: '2.1' },
    dataset: { id: metadata?.id, revision: metadata?.revision ?? null },
    transition: { mode: modifier ? 'modify' : 'replace', inheritsPriorContext: modifier },
    metrics,
    derivedMetrics,
    dimensions,
    filters,
    resultFilters: modifier ? [...(previousIntent?.resultFilters || previousRequest?.resultFilters || [])] : [],
    time: { ...time, field: timeField?.name || null },
    ranking,
    visualizationIntent: semanticFrame.visualizationIntent || null,
    semanticFrame,
    expectedResult: {
      shape: expectedShape({ dimensions, time, scalar: explicitScalar, ranking }),
      minimumRows: dimensions.length ? Math.max(1, requiredPeriods.length) : 1,
      maximumRows,
      requiredPeriods,
      requiredMetrics: [...metrics.filter(item => !item.internal).map(item => item.alias), ...derivedMetrics.map(item => item.alias)],
      requiredDimensions: dimensions.filter(item => !item.internal).map(item => item.alias),
      timeZone,
    },
    constraints,
    assumptions: [...time.assumptions],
    skillRefs: [...new Set([...(modifier ? previousIntent?.skillRefs || [] : []), ...skillRefs])],
  };
  if (dimensionResolutions.some(item => item.defaulted)) intent.assumptions.push('未明确地理主体时，“省份”按销售发生地解释为客户省份');
  const required = intent.constraints.filter(item => item.required);
  const resolved = required.filter(item => item.status === 'resolved').length;
  intent.confidence = required.length ? resolved / required.length : 0;
  return withFilterLedger(intent);
}

export function normalizeBusinessQueryIntentV2(input = {}, { metadata } = {}) {
  if (!input || typeof input !== 'object') throw new Error('BusinessQueryIntent v2 必须是对象');
  if (['sql', 'wax', 'query', 'payload', 'pivotPayload'].some(key => input[key] != null)) throw new Error('BusinessQueryIntent v2 禁止原始查询字段');
  const fields = new Set((metadata?.fields || []).map(field => field.name));
  const listValue = value => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' || typeof value === 'number') return [value];
    return [];
  };
  const normalized = {
    ...input,
    schema: 'wynai.business-query-intent/v2',
    businessQuestion: String(input.businessQuestion || '').trim(),
    metrics: Array.isArray(input.metrics) ? input.metrics.slice(0, 8) : [],
    derivedMetrics: Array.isArray(input.derivedMetrics) ? input.derivedMetrics.slice(0, 8) : [],
    dimensions: Array.isArray(input.dimensions) ? input.dimensions.slice(0, 8) : [],
    filters: Array.isArray(input.filters) ? input.filters.slice(0, 8) : [],
    resultFilters: Array.isArray(input.resultFilters) ? input.resultFilters.slice(0, 4).map(item => ({
      field: String(item?.field || item?.alias || '').trim(),
      operator: String(item?.operator || '').trim(),
      value: Number(item?.value),
    })) : [],
    constraints: Array.isArray(input.constraints) ? input.constraints.slice(0, 32) : [],
    assumptions: Array.isArray(input.assumptions) ? input.assumptions.slice(0, 16).map(String) : [],
    skillRefs: Array.isArray(input.skillRefs) ? [...new Set(input.skillRefs.map(String))].slice(0, 16) : [],
    semanticFrame: input.semanticFrame && typeof input.semanticFrame === 'object' ? input.semanticFrame : null,
    time: input.time && typeof input.time === 'object'
      ? { ...input.time, periods: listValue(input.time.periods).map(String).slice(0, 64) }
      : { field: null, calendar: null, timeZone: 'Asia/Shanghai', periods: [], range: null, grain: null },
  };
  delete normalized.queryMode;
  const requiredAlias = (value, items) => {
    const text = String(value || '');
    const item = items.find(candidate => [candidate?.alias, candidate?.field, candidate?.concept, candidate?.metricId]
      .filter(Boolean).some(candidateValue => String(candidateValue) === text));
    return item?.alias || text;
  };
  normalized.expectedResult = {
    ...(input.expectedResult && typeof input.expectedResult === 'object' ? input.expectedResult : {}),
    requiredPeriods: [...new Set(listValue(input.expectedResult?.requiredPeriods).map(String))].slice(0, 64),
    requiredMetrics: [...new Set(listValue(input.expectedResult?.requiredMetrics)
      .map(value => requiredAlias(value, normalized.metrics)))],
    requiredDimensions: [...new Set(listValue(input.expectedResult?.requiredDimensions)
      .map(value => requiredAlias(value, normalized.dimensions)))],
  };
  // A staged ranking query is identified by the semantic intent itself. Do
  // not infer it from domain words in the question: the LLM must provide the
  // ranked dimension and explicitly request the drill-down relationship.
  if (normalized.ranking?.thenDrilldown && !normalized.ranking.byDimension) {
    throw new Error('排名下钻缺少 byDimension，无法确定排名对象');
  }
  if (normalized.ranking?.thenDrilldown) {
    normalized.ranking = {
      ...normalized.ranking,
      drilldownDimensions: [...new Set(listValue(normalized.ranking.drilldownDimensions).map(String).filter(Boolean))],
    };
  }
  if (!normalized.businessQuestion) throw new Error('BusinessQueryIntent v2 缺少 businessQuestion');
  for (const item of [...normalized.metrics, ...normalized.dimensions, ...normalized.filters]) {
    if (metadata && item?.field && !fields.has(item.field)) throw new Error(`意图字段不在语义目录中：${item.field}`);
  }
  return withFilterLedger(normalized);
}

export function validateIntentCoverage(intent) {
  const unresolved = (intent?.constraints || []).filter(item => item.required && item.status !== 'resolved');
  const errors = [];
  const sourceRowsRequested = intent?.expectedResult?.shape === 'detail-table';
  if (sourceRowsRequested) {
    if (!intent?.dimensions?.length) errors.push('明细查询缺少需要返回的字段');
    if (intent?.metrics?.length) errors.push('明细查询不得包含聚合指标；需要返回的原始字段应放入 dimensions');
    if (intent?.derivedMetrics?.length) errors.push('明细查询不得包含派生指标');
    if (intent?.ranking) errors.push('明细查询不得包含聚合排名');
  } else if (!intent?.metrics?.length) {
    errors.push('缺少可执行指标');
  }
  if (intent?.ranking && !intent?.dimensions?.length) errors.push('排名请求缺少分组维度');
  if (intent?.ranking?.thenDrilldown) {
    const aliases = new Set((intent.dimensions || []).map(item => item.alias).filter(Boolean));
    const partitionAliases = new Set(intent.ranking.partitionBy || []);
    const rankedAlias = String(intent.ranking.byDimension || '');
    const drilldownAliases = [...new Set(intent.ranking.drilldownDimensions || [])];
    if (!aliases.has(rankedAlias)) errors.push(`排名对象 ${rankedAlias || '未指定'} 未引用实际输出维度别名`);
    if (!drilldownAliases.length) errors.push('排名下钻缺少 drilldownDimensions，无法确定下钻返回对象');
    for (const alias of drilldownAliases) {
      if (!aliases.has(alias)) errors.push(`下钻对象 ${alias} 未引用实际输出维度别名`);
      if (alias === rankedAlias) errors.push('排名对象与下钻对象不得相同');
      if (partitionAliases.has(alias)) errors.push(`分区维度 ${alias} 不得同时作为下钻对象`);
    }
    const expectedDrilldowns = (intent.dimensions || [])
      .map(item => item.alias)
      .filter(alias => alias && alias !== rankedAlias && !partitionAliases.has(alias));
    for (const alias of expectedDrilldowns) {
      if (!drilldownAliases.includes(alias)) errors.push(`排名后的返回维度 ${alias} 未进入 drilldownDimensions`);
    }
  }
  if ((intent?.time?.scopeExplicit || intent?.time?.groupingExplicit || intent?.time?.explicit) && !intent?.time?.field) errors.push('时间约束缺少时间字段');
  const metricAliases = new Set([...(intent?.metrics || []).filter(item => !item?.internal).map(item => item?.alias), ...(intent?.derivedMetrics || []).map(item => item?.alias)].filter(Boolean));
  const dimensionAliases = new Set((intent?.dimensions || []).filter(item => !item?.internal).map(item => item?.alias).filter(Boolean));
  for (const alias of intent?.expectedResult?.requiredMetrics || []) {
    if (!metricAliases.has(alias)) errors.push(`必需指标 ${alias} 未引用实际输出指标别名`);
  }
  for (const alias of intent?.expectedResult?.requiredDimensions || []) {
    if (!dimensionAliases.has(alias)) errors.push(`必需维度 ${alias} 未引用实际输出维度别名`);
  }
  for (const filter of intent?.resultFilters || []) {
    if (!metricAliases.has(filter.field)) errors.push(`聚合结果筛选字段 ${filter.field} 未引用实际指标别名`);
    if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(filter.operator) || !Number.isFinite(filter.value)) {
      errors.push(`聚合结果筛选 ${filter.field || '未知指标'} 缺少可执行操作符或数值`);
    }
  }
  const executableResultSignatures = new Set((intent?.resultFilters || []).map(item => `${item.field}|${item.operator}|${Number(item.value)}`));
  for (const item of intent?.constraints || []) {
    if (!item?.required || item?.status !== 'resolved') continue;
    const normalized = item.normalized;
    if (normalized && typeof normalized === 'object' && normalized.scope === 'aggregate-result') {
      const executable = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(normalized.operator)
        && Number.isFinite(Number(normalized.value))
        && normalized.field;
      if (!executable) {
        const rankingSource = String(intent?.ranking?.source || '').trim();
        const constraintSource = String(item.source || '').trim();
        const rankingConstraint = Boolean(intent?.ranking && rankingSource && constraintSource
          && (constraintSource === rankingSource || constraintSource.includes(rankingSource) || rankingSource.includes(constraintSource)));
        if (rankingConstraint) continue;
        errors.push(`聚合结果约束不是可执行数值筛选：${item.source}；若表达排名、TopN或最值，请使用 ranking`);
        continue;
      }
      const signature = `${normalized.field}|${normalized.operator}|${Number(normalized.value)}`;
      if (!executableResultSignatures.has(signature)) errors.push(`聚合结果筛选未进入可执行查询：${item.source}`);
      continue;
    }
    const text = typeof normalized === 'string' ? normalized : '';
    const alias = [...metricAliases].find(candidate => text.includes(candidate));
    if (alias && /聚合后|having/i.test(text) && /(?:>=|<=|!=|=|>|<)/.test(text)
        && !(intent?.resultFilters || []).some(filter => filter.field === alias)) {
      errors.push(`聚合结果筛选必须结构化写入 resultFilters：${item.source}`);
    }
  }
  const frame = intent?.semanticFrame;
  if (frame) {
    const actualConstraintIds = new Set((intent.constraints || []).map(item => item.id));
    for (const id of semanticFrameConstraintIds(frame)) if (!actualConstraintIds.has(id)) errors.push(`原问题语义约束未进入账本：${id}`);
    for (const mention of frame.metrics || []) {
      const coveredByRawProjection = sourceRowsRequested
        && intent.dimensions.some(item => !item.internal && conceptsCompatible(mention.concept, item.concept));
      if (!intent.metrics.some(item => item.concept === mention.concept) && !coveredByRawProjection) {
        errors.push(`原问题指标未覆盖：${mention.source}`);
      }
    }
    for (const mention of (frame.dimensions || []).filter(item => item.outputRole !== 'scope')) {
      if (!intent.dimensions.some(item => conceptsCompatible(mention.concept, item.concept))) errors.push(`原问题维度未覆盖：${mention.source}`);
    }
    if (frame.time?.grouping && !intent.dimensions.some(item => item.grain === frame.time.grouping)) errors.push(`时间分组未覆盖：${frame.time.grouping}`);
    if (frame.accumulation?.mode === 'cumulative-window' && !frame.time?.grouping && intent.dimensions.some(item => item.grain)) errors.push('累计时间窗口不得被静默改为时间分组');
    if (frame.ranking && (!intent.ranking || intent.ranking.limit !== frame.ranking.limit || intent.ranking.direction !== frame.ranking.direction)) errors.push('排名或极值约束未完整覆盖');
    if (frame.visualizationIntent?.explicit && intent.visualizationIntent?.type !== frame.visualizationIntent.type) errors.push(`用户指定图表类型未覆盖：${frame.visualizationIntent.type}`);
    for (const derived of frame.derivedMetrics || []) {
      if (derived.type === 'formula') {
        const actual = intent.derivedMetrics?.find(item => item.type === 'formula' && item.alias === derived.alias && item.metricId === derived.metricId);
        const dependencyIds = (actual?.dependencies || []).map(item => item.metricId);
        if (!actual
          || actual.operator !== derived.operator
          || actual.skillRef !== derived.skillRef
          || actual.aggregationOrder !== 'aggregate-then-calculate'
          || (derived.dependencyMetricIds || []).some(metricId => !dependencyIds.includes(metricId))) {
          errors.push('受治理公式指标未完整覆盖：' + derived.source);
        }
      } else if (derived.type === 'share-of-total') {
        const actual = intent.derivedMetrics?.find(item => item.type === 'share-of-total' && item.alias === derived.alias && item.sourceAlias);
        if (!actual || actual.denominatorScope !== 'filtered-result' || !actual.shareDimensionAlias) errors.push('构成占比未完整覆盖：' + derived.source);
      } else {
        if (!intent.derivedMetrics?.some(item => item.alias === derived.alias && item.sourceAlias)) errors.push('派生指标未覆盖：' + derived.source);
        if (!intent.dimensions.some(item => item.grain)) errors.push('派生期间指标缺少时间分组：' + derived.source);
      }
    }
    for (const derived of intent.derivedMetrics || []) {
      if (derived.type === 'formula' && !(frame.derivedMetrics || []).some(item => item.type === 'formula' && item.metricId === derived.metricId && item.alias === derived.alias)) {
        errors.push('意图包含未经原问题和 Skill 共同确认的公式指标：' + (derived.metricId || derived.alias));
      }
    }
    if (frame.ranking?.partitionBy?.length && !intent.ranking?.partitionBy?.length) errors.push('分组内排名未覆盖');
  }
  if (intent?.ranking && !intent.ranking.thenDrilldown && !intent.ranking.partitionBy?.length && intent.expectedResult?.maximumRows !== intent.ranking.limit) errors.push('排名结果上限与用户要求不一致');
  errors.push(...unresolved.map(item => `未解析约束：${item.type}`));
  return { valid: errors.length === 0, errors, unresolved };
}

function ensureShareSourceMetrics(intent, metadata) {
  let metrics = [...(intent?.metrics || [])];
  let derivedMetrics = [...(intent?.derivedMetrics || [])];
  for (const derived of derivedMetrics) {
    if (derived?.type !== 'share-of-total') continue;
    let source = metrics.find(metric => metric.alias === derived.sourceAlias || metric.concept === derived.sourceConcept);
    if (!source) {
      const field = (metadata?.fields || []).find(candidate => inferMetricConcept(candidate).id === derived.sourceConcept);
      const concept = field ? inferMetricConcept(field) : METRIC_CONCEPTS.find(item => item.id === derived.sourceConcept);
      if (field && concept) {
        source = { field: field.name, aggregation: concept.defaultAggregation || 'sum', alias: concept.defaultAlias || concept.id, concept: concept.id, resultType: 'number', internal: false };
        metrics.push(source);
      }
    }
    if (source) {
      source.internal = false;
      derived.sourceAlias = source.alias;
    }
  }
  const requiredMetrics = new Set(intent?.expectedResult?.requiredMetrics || []);
  for (const derived of derivedMetrics) if (derived?.sourceAlias) requiredMetrics.add(derived.sourceAlias);
  return { ...intent, metrics, derivedMetrics, expectedResult: { ...(intent?.expectedResult || {}), requiredMetrics: [...requiredMetrics] } };
}

export function requestsRawDetailRows(question = '') {
  return /(?:原始(?:记录|明细)|逐条(?:记录|明细)|每条(?:原始)?(?:记录|明细)|不(?:做)?聚合|不(?:做)?去重|保留重复|raw\s+(?:record|row)|without\s+(?:aggregation|deduplication))/i.test(String(question || ''));
}
function suppressImplicitTimeGrouping(intent) {
  // Only the deterministic semantic frame is authoritative for whether the
  // user asked for a time grouping; an LLM must not invent one.
  const frameTime = intent?.semanticFrame?.time;
  const groupingExplicit = frameTime ? Boolean(frameTime.groupingExplicit || frameTime.grouping) : Boolean(intent?.time?.groupingExplicit || intent?.time?.grouping);
  const needsPeriodForDerived = (intent?.derivedMetrics || []).some(item => ['yoy', 'mom'].includes(item.type));
  if (groupingExplicit || needsPeriodForDerived) return intent;
  const removed = new Set((intent?.dimensions || []).filter(item => item.grain || item.concept === 'time').map(item => item.alias));
  const implicitTime = Boolean(intent?.time?.grain || intent?.time?.grouping || intent?.expectedResult?.shape === 'time-series');
  if (!removed.size && !implicitTime) return intent;
  return {
    ...intent,
    dimensions: (intent.dimensions || []).filter(item => !removed.has(item.alias)),
    time: { ...(intent.time || {}), grain: null, grouping: null, groupingExplicit: false },
    expectedResult: {
      ...(intent.expectedResult || {}),
      shape: (intent.dimensions || []).some(item => !removed.has(item.alias)) ? 'table' : 'scalar',
      requiredPeriods: [],
      requiredDimensions: (intent.expectedResult?.requiredDimensions || []).filter(alias => !removed.has(alias)),
    },
  };
}

function compileExecutionFilters(filters = []) {
  return (filters || []).flatMap(filter => {
    if (!filter?.negated) return [filter];
    const { negated, ...base } = filter;
    if (filter.operator === 'eq') return [{ ...base, operator: 'neq' }];
    if (filter.operator === 'in') {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      return values.map(value => ({ ...base, operator: 'neq', value }));
    }
    const inverseMembershipOperator = {
      containsAny: 'notContainsAny',
      containsAll: 'notContainsAll',
      notContainsAny: 'containsAny',
      notContainsAll: 'containsAll',
    };
    if (inverseMembershipOperator[filter.operator]) return [{ ...base, operator: inverseMembershipOperator[filter.operator] }];
    return [filter];
  });
}

function validateCompiledFilterCoverage(metadata, intentFilters = [], requestFilters = []) {
  // Compare executable values after governed type/list normalization.
  const expected = normalizeCanonicalFilters(metadata, compileExecutionFilters(intentFilters)).map(filterSignature).sort();
  const actual = (requestFilters || []).map(filterSignature).sort();
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    return ['筛选约束未完整编译到 Canonical 查询'];
  }
  return [];
}

export function compileBusinessQueryIntent(metadata, intent) {
  if (intent?.time && !intent.time.field && Array.isArray(intent.filters)) {
    const inferredTimeField = intent.filters.find(filter => metadata?.fields?.some(field => field.name === filter?.field && (field.role === 'time' || /date|time/i.test(`${field.type} ${field.rawType}`))))?.field || null;
    if (inferredTimeField) intent = { ...intent, time: { ...intent.time, field: inferredTimeField } };
  }
  intent = withFilterLedger(suppressImplicitTimeGrouping(ensureShareSourceMetrics(intent, metadata)));
  const coverage = validateIntentCoverage(intent);
  if (!coverage.valid) return { status: 'needs_clarification', errors: coverage.errors };
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: `qry-intent-${randomUUID().slice(0, 8)}`,
    purpose: intent.businessQuestion,
    mode: intent.expectedResult?.shape === 'detail-table'
      ? 'projection'
      : intent.dimensions.length ? (intent.dimensions.some(item => item.grain) ? 'compare' : 'aggregate') : 'aggregate',
    topic: intent.metrics[0]?.concept === 'profit' ? 'profitability' : intent.dimensions[0]?.concept === 'customer' ? 'customer' : intent.dimensions.length ? 'product' : 'open',
    dataset: intent.dataset,
    select: intent.dimensions,
    measures: intent.metrics,
    filters: compileExecutionFilters(intent.filters),
    resultFilters: intent.resultFilters || [],
    orderBy: intent.expectedResult?.shape === 'detail-table' ? [] : intent.dimensions.length ? (() => {
      if (intent.ranking && intent.metrics.some(item => item.alias === intent.ranking.orderBy)) return [{ field: intent.ranking.orderBy, direction: intent.ranking.direction }];
      if (intent.ranking) return [];
      const timeDimension = intent.dimensions.find(item => item.grain);
      return timeDimension ? [{ field: timeDimension.alias, direction: 'asc' }] : [{ field: intent.metrics[0].alias, direction: 'desc' }];
    })() : [],
    limit: intent.expectedResult.maximumRows,
    limitSource: intent.ranking ? 'user-ranking' : 'default',
    expectedResult: intent.expectedResult,
  });
  const filterCoverageErrors = validateCompiledFilterCoverage(metadata, intent.filters, request.filters);
  if (filterCoverageErrors.length) return { status: 'needs_clarification', errors: filterCoverageErrors };
  const queryProgram = compileQueryProgram({ intent, request });
  const internalAliases = new Set(intent.dimensions.filter(item => item.internal).map(item => item.alias));
  const internalMetricAliases = new Set(intent.metrics.filter(item => item.internal).map(item => item.alias));
  const derivedDisplayMeasures = intent.derivedMetrics.map(item => ({
    field: item.type === 'share-of-total' ? `${intent.metrics.find(metric => metric.alias === item.sourceAlias)?.field || item.source || item.alias}占比` : item.source || item.metricId || item.alias,
    aggregation: item.type === 'formula' ? item.operator : item.type,
    alias: item.alias,
    concept: item.concept || item.sourceConcept || item.metricId,
    unitFamily: item.unitFamily || (item.resultType === 'percentage' ? 'percentage' : null),
    resultType: item.resultType || 'number',
    derived: true,
  }));
  const displayRequest = {
    ...request,
    select: request.select.filter(item => !internalAliases.has(item.alias)),
    measures: [
      ...request.measures.filter(item => !internalMetricAliases.has(item.alias)).map(item => {
        const source = intent.metrics.find(metric => metric.alias === item.alias);
        return { ...item, concept: source?.concept, unitFamily: source?.unitFamily };
      }),
      ...derivedDisplayMeasures,
    ],
    orderBy: intent.ranking?.orderBy
      ? [{ field: intent.ranking.orderBy, direction: intent.ranking.direction }]
      : request.orderBy.filter(item => !internalAliases.has(item.field) && !internalMetricAliases.has(item.field)),
  };
  return { status: 'supported', request: queryProgram.baseQuery, displayRequest, queryProgram, intent, coverage };
}

function matchesStringMembershipFilter(actual, filter) {
  const text = actual == null ? '' : String(actual);
  const values = (Array.isArray(filter?.value) ? filter.value : [filter?.value]).map(value => String(value));
  const matches = values.map(value => text.includes(value));
  if (filter.operator === 'containsAny') return matches.some(Boolean);
  if (filter.operator === 'containsAll') return matches.every(Boolean);
  if (filter.operator === 'notContainsAny') return matches.every(match => !match);
  return matches.some(match => !match);
}

export function validateResultAgainstIntent(resultSet, intent) {
  const rows = resultSet?.rows || [];
  const columns = new Set((resultSet?.schema || []).map(item => item.name));
  const errors = [];
  const warnings = [];
  // A successfully executed zero-row query is a valid business result. With
  // no rows, Wyn may omit the projected schema, so structural coverage cannot
  // be established from the result payload and must not become clarification.
  if (!rows.length) {
    return {
      valid: true,
      errors,
      warnings: ['查询范围没有匹配数据'],
      checkedAt: new Date().toISOString(),
    };
  }
  const periodDimension = intent.dimensions?.find(item => item?.grain);
  const expectedMinimumRows = intent.expectedResult?.minimumRows || 0;
  // Monthly series can legitimately have gaps when Wyn has no rows for a
  // period; expose that as a data warning instead of blocking the query.
  const strictMinimumRows = periodDimension?.grain === 'year' || !periodDimension;
  if (strictMinimumRows && rows.length < expectedMinimumRows) {
    errors.push(`结果行数 ${rows.length} 少于预期 ${expectedMinimumRows}`);
  } else if (!strictMinimumRows && rows.length < expectedMinimumRows) {
    warnings.push(`时间序列仅返回 ${rows.length} 行，少于理论期间数 ${expectedMinimumRows}，可能存在无数据月份`);
  }
  for (const field of [...(intent.expectedResult?.requiredMetrics || []), ...(intent.expectedResult?.requiredDimensions || [])]) {
    if (!columns.has(field)) errors.push(`结果缺少必需字段 ${field}`);
  }
  const requiredPeriods = intent.expectedResult?.requiredPeriods || [];
  const periodAlias = periodDimension?.alias;
  if (requiredPeriods.length && periodAlias && periodDimension?.grain === 'year') {
    const actual = new Set(rows.map(row => String(row[periodAlias] || '').slice(0, 4)));
    for (const period of requiredPeriods) if (!actual.has(String(period))) errors.push(`结果缺少必需期间 ${period}`);
  }
  for (const filter of intent.filters || []) {
    if (!filter?.field || filter.operator !== 'in') continue;
    const dimension = (intent.dimensions || []).find(item => item.field === filter.field);
    const resultField = dimension?.alias || filter.field;
    const expectedValues = Array.isArray(filter.value) ? filter.value.map(String) : [];
    if (!expectedValues.length || !columns.has(resultField)) continue;
    const actual = new Set(rows.map(row => String(row[resultField] ?? '')));
    for (const value of expectedValues) {
      if (filter.negated ? actual.has(value) : !actual.has(value)) {
        errors.push(filter.negated ? `结果包含被排除的筛选值 ${filter.field}=${value}` : `结果缺少筛选值 ${filter.field}=${value}`);
      }
    }
  }
  for (const filter of intent.filters || []) {
    if (!['containsAny', 'containsAll', 'notContainsAny', 'notContainsAll'].includes(filter?.operator) || !filter?.field) continue;
    const dimension = (intent.dimensions || []).find(item => item.field === filter.field);
    const resultField = dimension?.alias || filter.field;
    // A filter can be intentionally hidden from the result projection. In that
    // case execution-path coverage, rather than row inspection, is authoritative.
    if (!columns.has(resultField)) continue;
    if (rows.some(row => !matchesStringMembershipFilter(row[resultField], filter))) {
      errors.push(`结果包含不符合多值筛选条件的记录：${filter.field}`);
    }
  }
  if (intent.ranking) {
    const metricAlias = intent.metrics?.[0]?.alias;
    const partitionBy = intent.ranking.partitionBy || [];
    const partitions = new Map();
    for (const row of rows) {
      const key = JSON.stringify(partitionBy.map(alias => row[alias] ?? null));
      if (!partitions.has(key)) partitions.set(key, []);
      partitions.get(key).push(row);
    }
    for (const partitionRows of partitions.values()) {
      if (intent.ranking.thenDrilldown) {
        const rankingDimension = intent.ranking.byDimension
          || (intent.dimensions || []).find(item => item.concept === 'product' || item.concept === 'productName')?.alias
          || (intent.dimensions || []).find(item => /product|商品|产品/i.test(`${item.alias || ''} ${item.field || ''}`))?.alias;
        if (rankingDimension) {
          const distinctRanked = new Set(partitionRows.map(row => String(row[rankingDimension] ?? ''))).size;
          if (distinctRanked > (intent.ranking.limit || 1)) errors.push(`下钻结果包含 ${distinctRanked} 个排名对象，超过要求的 ${intent.ranking.limit || 1} 个`);
        }
        // Drilldown rows are intentionally ordered by the secondary dimension,
        // so the primary ranking metric is not expected to be monotonic here.
        continue;
      }
      if (partitionRows.length > intent.ranking.limit) errors.push(`排名结果行数 ${partitionRows.length} 超过每组要求 ${intent.ranking.limit}`);
      const values = partitionRows.map(row => Number(row[metricAlias]));
      for (let index = 1; index < values.length; index += 1) {
        if (!Number.isFinite(values[index - 1]) || !Number.isFinite(values[index])) continue;
        const wrongOrder = intent.ranking.direction === 'asc' ? values[index - 1] > values[index] : values[index - 1] < values[index];
        if (wrongOrder) { errors.push('排名结果顺序与用户要求不一致'); break; }
      }
    }
  }
  for (const dimension of intent.dimensions || []) {
    if (rows.some(row => row[dimension.alias] == null || row[dimension.alias] === '')) warnings.push(`结果包含空的${dimension.field}`);
  }
  if (resultSet?.quality?.isSample) warnings.push('结果来自样本，不能作为完整精确指标');
  if (resultSet?.quality?.isTruncated) warnings.push('结果被截断，可能无法覆盖完整意图');
  return { valid: errors.length === 0, errors, warnings, checkedAt: new Date().toISOString() };
}
