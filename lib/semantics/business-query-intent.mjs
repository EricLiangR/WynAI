import { randomUUID } from 'node:crypto';
import { normalizeCanonicalQueryRequest } from '../planning/query-request-schema.mjs';
import { parseBusinessTimeSemantics } from './time-semantics.mjs';
import { extractQuestionSemanticFrame, semanticFrameConstraintIds } from './question-semantic-frame.mjs';
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
  const directField = mentionedCatalogField(metadata, question, isMeasureField);
  if (directField) return { field: directField, concept: inferMetricConcept(directField), explicit: true };
  const concept = METRIC_CONCEPTS.find(item => item.id === requestedConcept) || mentionedConcept(question, METRIC_CONCEPTS);
  if (concept) return { field: fieldByExactAlias(metadata, concept.aliases, field => isMeasureField(field) || concept.defaultAggregation === 'distinctCount'), concept, explicit: true, aggregation: concept.defaultAggregation };
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
    constraints.push(constraint('frame-derived-' + (index + 1), 'derived-metric', mention.source, source ? { type: mention.type, sourceField: source.field.name, alias: mention.alias } : null));
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
  const semanticFrame = extractQuestionSemanticFrame(text, { time, skills });
  // Dataset catalog names are first-class semantic references, including custom business fields.
  if (!semanticFrame.metrics.length) {
    const field = mentionedCatalogField(metadata, text, isMeasureField);
    if (field) semanticFrame.metrics.push({ concept: inferMetricConcept(field).id, source: field.name, required: true });
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
    ? semanticFrame.metrics.map(mention => ({ ...resolveMetric(metadata, text, priorMetricIntent, mention.concept, skills), mentionSource: mention.source }))
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
    const resolution = resolveDimension(metadata, text, priorDimensionIntent, modifier, mention.concept, skills);
    if (mention.concept === 'province' && resolution.field?.name === '客户省份') {
      return { ...resolution, concept: DIMENSION_CONCEPTS.find(item => item.id === 'customerProvince'), defaulted: true };
    }
    return resolution;
  });
  let ranking = semanticFrame.ranking || parseRanking(text) || (modifier ? previousIntent?.ranking || null : null);
  const dimensions = [];
  for (const resolution of dimensionResolutions) {
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
      if (!governed) return null;
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
    return { ...item, sourceConcept, alias: sourceConcept + '_' + item.type, sourceAlias: sourceMetric?.alias || null };
  }).filter(item => item && (item.type === 'formula' ? item.dependencies?.length >= 2 : item.sourceAlias));
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
    ...(region ? [constraint('region', 'filter', region.source, { field: region.field, operator: region.operator, value: region.value, values: region.values })] : []),
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
    time: { ...time, field: timeField?.name || null },
    ranking,
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
  return intent;
}

export function normalizeBusinessQueryIntentV2(input = {}, { metadata } = {}) {
  if (!input || typeof input !== 'object') throw new Error('BusinessQueryIntent v2 必须是对象');
  if (['sql', 'wax', 'query', 'payload', 'pivotPayload'].some(key => input[key] != null)) throw new Error('BusinessQueryIntent v2 禁止原始查询字段');
  const fields = new Set((metadata?.fields || []).map(field => field.name));
  const normalized = {
    ...input,
    schema: 'wynai.business-query-intent/v2',
    businessQuestion: String(input.businessQuestion || '').trim(),
    metrics: Array.isArray(input.metrics) ? input.metrics.slice(0, 8) : [],
    derivedMetrics: Array.isArray(input.derivedMetrics) ? input.derivedMetrics.slice(0, 8) : [],
    dimensions: Array.isArray(input.dimensions) ? input.dimensions.slice(0, 8) : [],
    filters: Array.isArray(input.filters) ? input.filters.slice(0, 8) : [],
    constraints: Array.isArray(input.constraints) ? input.constraints.slice(0, 32) : [],
    assumptions: Array.isArray(input.assumptions) ? input.assumptions.slice(0, 16).map(String) : [],
    skillRefs: Array.isArray(input.skillRefs) ? [...new Set(input.skillRefs.map(String))].slice(0, 16) : [],
    semanticFrame: input.semanticFrame && typeof input.semanticFrame === 'object' ? input.semanticFrame : null,
  };
  if (!normalized.businessQuestion) throw new Error('BusinessQueryIntent v2 缺少 businessQuestion');
  for (const item of [...normalized.metrics, ...normalized.dimensions, ...normalized.filters]) {
    if (metadata && item?.field && !fields.has(item.field)) throw new Error(`意图字段不在语义目录中：${item.field}`);
  }
  return normalized;
}

export function validateIntentCoverage(intent) {
  const unresolved = (intent?.constraints || []).filter(item => item.required && item.status !== 'resolved');
  const errors = [];
  if (!intent?.metrics?.length) errors.push('缺少可执行指标');
  if (intent?.ranking && !intent?.dimensions?.length) errors.push('排名请求缺少分组维度');
  if ((intent?.time?.scopeExplicit || intent?.time?.groupingExplicit || intent?.time?.explicit) && !intent?.time?.field) errors.push('时间约束缺少时间字段');
  const frame = intent?.semanticFrame;
  if (frame) {
    const actualConstraintIds = new Set((intent.constraints || []).map(item => item.id));
    for (const id of semanticFrameConstraintIds(frame)) if (!actualConstraintIds.has(id)) errors.push(`原问题语义约束未进入账本：${id}`);
    for (const mention of frame.metrics || []) {
      if (!intent.metrics.some(item => item.concept === mention.concept)) errors.push(`原问题指标未覆盖：${mention.source}`);
    }
    for (const mention of frame.dimensions || []) {
      if (!intent.dimensions.some(item => conceptsCompatible(mention.concept, item.concept))) errors.push(`原问题维度未覆盖：${mention.source}`);
    }
    if (frame.time?.grouping && !intent.dimensions.some(item => item.grain === frame.time.grouping)) errors.push(`时间分组未覆盖：${frame.time.grouping}`);
    if (frame.accumulation?.mode === 'cumulative-window' && !frame.time?.grouping && intent.dimensions.some(item => item.grain)) errors.push('累计时间窗口不得被静默改为时间分组');
    if (frame.ranking && (!intent.ranking || intent.ranking.limit !== frame.ranking.limit || intent.ranking.direction !== frame.ranking.direction)) errors.push('排名或极值约束未完整覆盖');
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
  if (intent?.ranking && !intent.ranking.partitionBy?.length && intent.expectedResult?.maximumRows !== intent.ranking.limit) errors.push('排名结果上限与用户要求不一致');
  errors.push(...unresolved.map(item => `未解析约束：${item.type}`));
  return { valid: errors.length === 0, errors, unresolved };
}

export function compileBusinessQueryIntent(metadata, intent) {
  const coverage = validateIntentCoverage(intent);
  if (!coverage.valid) return { status: 'needs_clarification', errors: coverage.errors };
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: `qry-intent-${randomUUID().slice(0, 8)}`,
    purpose: intent.businessQuestion,
    mode: intent.dimensions.length ? (intent.dimensions.some(item => item.grain) ? 'compare' : 'aggregate') : 'aggregate',
    topic: intent.metrics[0]?.concept === 'profit' ? 'profitability' : intent.dimensions[0]?.concept === 'customer' ? 'customer' : intent.dimensions.length ? 'product' : 'open',
    dataset: intent.dataset,
    select: intent.dimensions,
    measures: intent.metrics,
    filters: intent.filters,
    orderBy: intent.dimensions.length ? (() => {
      if (intent.ranking && intent.metrics.some(item => item.alias === intent.ranking.orderBy)) return [{ field: intent.ranking.orderBy, direction: intent.ranking.direction }];
      if (intent.ranking) return [];
      const timeDimension = intent.dimensions.find(item => item.grain);
      return timeDimension ? [{ field: timeDimension.alias, direction: 'asc' }] : [{ field: intent.metrics[0].alias, direction: 'desc' }];
    })() : [],
    limit: intent.expectedResult.maximumRows,
    expectedResult: intent.expectedResult,
  });
  const queryProgram = compileQueryProgram({ intent, request });
  const internalAliases = new Set(intent.dimensions.filter(item => item.internal).map(item => item.alias));
  const internalMetricAliases = new Set(intent.metrics.filter(item => item.internal).map(item => item.alias));
  const derivedDisplayMeasures = intent.derivedMetrics.map(item => ({
    field: item.source || item.metricId || item.alias,
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

export function validateResultAgainstIntent(resultSet, intent) {
  const rows = resultSet?.rows || [];
  const columns = new Set((resultSet?.schema || []).map(item => item.name));
  const errors = [];
  const warnings = [];
  if (rows.length < (intent.expectedResult?.minimumRows || 0)) errors.push(`结果行数 ${rows.length} 少于预期 ${intent.expectedResult.minimumRows}`);
  for (const field of [...(intent.expectedResult?.requiredMetrics || []), ...(intent.expectedResult?.requiredDimensions || [])]) {
    if (!columns.has(field)) errors.push(`结果缺少必需字段 ${field}`);
  }
  const requiredPeriods = intent.expectedResult?.requiredPeriods || [];
  const periodAlias = intent.dimensions?.find(item => item.grain)?.alias;
  if (requiredPeriods.length && periodAlias) {
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
      if (!actual.has(value)) errors.push(`结果缺少筛选值 ${filter.field}=${value}`);
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
