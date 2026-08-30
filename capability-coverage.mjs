const VERSION = 'wynai.insight-capability-coverage/v1';

const CAPABILITY_DEFINITIONS = [
  { id: 'time', kind: 'dimension', label: '时间', terms: ['时间', '日期', '年度', '每年', '年', '季度', '每季', '月份', '每月', '月度', 'period', 'date'] },
  { id: 'supplier', kind: 'dimension', label: '供应商', terms: ['供应商', '供货商', 'supplier'] },
  { id: 'customer', kind: 'dimension', label: '客户', terms: ['客户', 'customer'] },
  { id: 'region', kind: 'dimension', label: '地区/区域', terms: ['地区', '区域', 'region'] },
  { id: 'category', kind: 'dimension', label: '产品类别', terms: ['产品类别', '商品类别', '类别', '品类', 'category'] },
  { id: 'product', kind: 'dimension', label: '产品', terms: ['产品', '商品', 'product', 'item'], exclude: ['产品类别', '商品类别'] },
  { id: 'revenue', kind: 'metric', label: '销售额/收入', terms: ['销售额', '销售收入', '营业收入', '营收', '收入', '订单金额', 'revenue', 'sales'] },
  { id: 'profit', kind: 'metric', label: '利润', terms: ['利润', '毛利', 'profit', 'margin'] },
  { id: 'quantity', kind: 'metric', label: '销量/数量', terms: ['销量', '销售数量', '购买数量', '数量', 'quantity', 'volume'] },
];

function text(value) { return String(value || '').trim(); }
function normalized(value) { return text(value).toLowerCase().replace(/[\s_\-]/g, ''); }
function unique(values) { return [...new Set((values || []).filter(Boolean))]; }
function fieldLabels(field) { return unique([field?.name, field?.displayName, field?.sourceField, field?.metricId, field?.semanticType].map(text)); }
function matchesDefinition(definition, value) {
  let candidate = normalized(value);
  if (!candidate) return false;
  for (const term of definition.exclude || []) candidate = candidate.replaceAll(normalized(term), '');
  return definition.terms.some(term => candidate.includes(normalized(term)));
}
function requestedDefinitions(question) { return CAPABILITY_DEFINITIONS.filter(definition => matchesDefinition(definition, question)); }
function availableField(definition, fields) {
  const candidates = fields.filter(field => {
    const labels = fieldLabels(field);
    if (definition.id === 'time') return field?.role === 'time' || ['date', 'datetime'].includes(field?.type) || labels.some(label => matchesDefinition(definition, label));
    return labels.some(label => matchesDefinition(definition, label));
  });
  return candidates[0] || null;
}

/** Compare explicitly requested capabilities with the caller-provided schema. */
export function assessCapabilityCoverage({ question = '', schema = [] } = {}) {
  const fields = Array.isArray(schema) ? schema : [];
  const requested = requestedDefinitions(question);
  const available = [];
  const unavailable = [];
  for (const definition of requested) {
    const field = availableField(definition, fields);
    const item = { id: definition.id, kind: definition.kind, label: definition.label, requestedTerms: definition.terms };
    if (field) available.push({ ...item, field: field.name, fieldType: field.type || null, role: field.role || null });
    else unavailable.push({ ...item, reason: 'missing-field' });
  }
  const execution = requested.length === 0 ? 'unclassified' : available.length === 0 ? 'blocked' : unavailable.length ? 'partial' : 'full';
  return { schema: VERSION, question: text(question).slice(0, 4000), requested, available, unavailable, execution, canProceed: execution !== 'blocked', platformRule: 'missing-requested-capability-isolated' };
}

export const capabilityCoverageVersion = VERSION;
