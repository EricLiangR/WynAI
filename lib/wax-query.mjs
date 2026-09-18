import { selectAnalysisFields, toDate, toNumber } from './analysis-core.mjs';

const AGGREGATIONS = new Set(['sum', 'average', 'min', 'max', 'countRows', 'distinctCount']);
const STRING_MEMBERSHIP_OPERATORS = new Set(['containsAny', 'containsAll', 'notContainsAny', 'notContainsAll']);
const OPERATORS = new Map([
  ['eq', '='],
  ['neq', '<>'],
  ['gt', '>'],
  ['gte', '>='],
  ['lt', '<'],
  ['lte', '<='],
  ['in', 'IN'],
  ['isNotNull', 'NONEMPTY'],
]);
const MAX_FILTERS = 8;
const MAX_GROUPS = 8;
const MAX_MEASURES = 8;
const MAX_RESULT_ROWS = 20000;

function queryError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function waxName(value) {
  return String(value || '').replaceAll("'", "''");
}

function waxColumnName(value) {
  return String(value || '').replaceAll(']', ']]');
}

function tableRef(metadata) {
  if (!metadata?.name) throw queryError('数据集缺少可用于 WAX 的名称');
  return `'${waxName(metadata.name)}'`;
}

function columnRef(metadata, fieldName) {
  return `${tableRef(metadata)}[${waxColumnName(fieldName)}]`;
}

function findField(metadata, fieldName) {
  const field = (metadata?.fields || []).find(item => item.name === fieldName);
  if (!field) throw queryError(`字段不在数据集语义目录中：${fieldName}`);
  return field;
}

function normalizeAlias(value, fallback) {
  const alias = String(value || fallback || '').trim();
  if (!/^[a-z][a-z0-9_]{0,40}$/i.test(alias)) throw queryError(`无效的查询别名：${alias}`);
  return alias;
}

function isNumericField(field) {
  return field?.role === 'measure' || /number|decimal|double|float|int|long/i.test(`${field?.type} ${field?.rawType}`);
}

function isTimeField(field) {
  return field?.role === 'time' || /date|time/i.test(`${field?.type} ${field?.rawType}`);
}

function normalizeScalarFilterValue(field, value) {
  if (isNumericField(field)) {
    const numeric = toNumber(value);
    if (numeric == null) throw queryError(`字段“${field.name}”需要数字筛选值`);
    return numeric;
  }
  if (isTimeField(field)) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
    if (!match || !toDate(text)) throw queryError(`字段“${field.name}”需要 YYYY-MM-DD 日期`);
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim();
  if (!text) throw queryError(`字段“${field.name}”的筛选值不能为空`);
  if (text.length > 200) throw queryError(`字段“${field.name}”的筛选值过长`);
  return text;
}

function normalizeFilterValue(field, value, operator) {
  if (operator === 'isNotNull') return null;
  if (operator !== 'in' && !STRING_MEMBERSHIP_OPERATORS.has(operator)) return normalizeScalarFilterValue(field, value);
  const values = Array.isArray(value) ? value : [value];
  const label = STRING_MEMBERSHIP_OPERATORS.has(operator) ? operator : 'in';
  if (!values.length || values.length > 50) throw queryError(`字段“${field.name}”的 ${label} 筛选需要 1 至 50 个值`);
  if (STRING_MEMBERSHIP_OPERATORS.has(operator) && (isNumericField(field) || isTimeField(field))) {
    throw queryError(`字段“${field.name}”的 ${operator} 仅支持字符串字段`);
  }
  return [...new Set(values.map(item => normalizeScalarFilterValue(field, item)))];
}

function waxLiteral(field, value) {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE()' : 'FALSE()';
  if (isTimeField(field)) {
    const [year, month, day] = value.split('-').map(Number);
    return `DATE(${year},${month},${day})`;
  }
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function normalizeFilters(metadata, input = []) {
  if (!Array.isArray(input)) throw queryError('筛选条件必须是数组');
  if (input.length > MAX_FILTERS) throw queryError(`筛选条件最多 ${MAX_FILTERS} 个`);
  return input.map(item => {
    const field = findField(metadata, String(item?.field || '').trim());
    const operator = String(item?.operator || 'eq');
    if (!OPERATORS.has(operator) && !STRING_MEMBERSHIP_OPERATORS.has(operator)) throw queryError(`不支持的筛选操作符：${operator}`);
    return {
      field: field.name,
      operator,
      value: normalizeFilterValue(field, item?.value, operator),
      fieldType: field.role,
    };
  });
}

function filterCondition(metadata, filter) {
  const field = findField(metadata, filter.field);
  if (filter.operator === 'isNotNull') {
    const column = columnRef(metadata, field.name);
    if (isNumericField(field)) return `${column} > -1E+300`;
    if (isTimeField(field)) return `YEAR(${column}) > 0`;
    return `LEN(${column}) > 0`;
  }
  if (filter.operator === 'in') return `(${filter.value.map(value => `${columnRef(metadata, field.name)} = ${waxLiteral(field, value)}`).join(' || ')})`;
  if (STRING_MEMBERSHIP_OPERATORS.has(filter.operator)) {
    const column = columnRef(metadata, field.name);
    const matches = filter.value.map(value => `FIND(${waxLiteral(field, value)},${column}) > 0`);
    const misses = filter.value.map(value => `FIND(${waxLiteral(field, value)},${column}) = 0`);
    if (filter.operator === 'containsAny') return `(${matches.join(' || ')})`;
    if (filter.operator === 'containsAll') return `(${matches.join(' && ')})`;
    if (filter.operator === 'notContainsAny') return `(${misses.join(' && ')})`;
    return `(${misses.join(' || ')})`;
  }
  return `${columnRef(metadata, field.name)} ${OPERATORS.get(filter.operator)} ${waxLiteral(field, filter.value)}`;
}

function fieldComparisonCondition(metadata, comparison) {
  const operators = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  return `${columnRef(metadata, comparison.left)} ${operators[comparison.operator]} ${columnRef(metadata, comparison.right)}`;
}

function filterTable(metadata, filters, fieldComparisons = []) {
  const conditions = [...filters.map(item => filterCondition(metadata, item)), ...fieldComparisons.map(item => fieldComparisonCondition(metadata, item))];
  if (!conditions.length) return tableRef(metadata);
  return `FILTER(${tableRef(metadata)},${conditions.join(' && ')})`;
}

function aggregateExpression(metadata, measure, filters, fieldComparisons = []) {
  const table = tableRef(metadata);
  const filteredTable = filterTable(metadata, filters, fieldComparisons);
  const field = measure.field ? findField(metadata, measure.field) : null;
  const column = field ? columnRef(metadata, field.name) : null;

  if (measure.operation === 'countRows') return `COUNTROWS(${filteredTable})`;
  if (measure.operation === 'distinctCount') {
    return filters.length || fieldComparisons.length ? `DISTINCTCOUNTX(${filteredTable},${column})` : `DISTINCTCOUNT(${column})`;
  }
  const functions = { sum: 'SUM', average: 'AVERAGE', min: 'MIN', max: 'MAX' };
  const iteratorFunctions = { sum: 'SUMX', average: 'AVERAGEX', min: 'MINX', max: 'MAXX' };
  return filters.length || fieldComparisons.length
    ? `${iteratorFunctions[measure.operation]}(${filteredTable},${column})`
    : `${functions[measure.operation]}(${column})`;
}

export function normalizeQuerySpec(metadata, input = {}) {
  const groupBy = Array.isArray(input.groupBy) ? input.groupBy.map(value => String(value || '').trim()).filter(Boolean) : [];
  if (groupBy.length > MAX_GROUPS) throw queryError(`分组字段最多 ${MAX_GROUPS} 个`);
  groupBy.forEach(fieldName => findField(metadata, fieldName));

  const rawMeasures = Array.isArray(input.measures) ? input.measures : [];
  if (!rawMeasures.length) throw queryError('查询计划至少需要一个指标');
  if (rawMeasures.length > MAX_MEASURES) throw queryError(`查询指标最多 ${MAX_MEASURES} 个`);
  const aliases = new Set();
  const measures = rawMeasures.map((item, index) => {
    const operation = String(item?.operation || '').trim();
    if (!AGGREGATIONS.has(operation)) throw queryError(`不支持的聚合操作：${operation}`);
    if (operation === 'countRows' && String(item?.field || '').trim()) {
      throw queryError('countRows 只能统计筛选后的记录数，不允许指定字段');
    }
    const field = operation === 'countRows' ? null : findField(metadata, String(item?.field || '').trim());
    const alias = normalizeAlias(item?.alias, `metric${index + 1}`);
    if (aliases.has(alias)) throw queryError(`查询别名重复：${alias}`);
    aliases.add(alias);
    return { alias, operation, field: field?.name || null };
  });

  const limit = Math.max(1, Math.min(MAX_RESULT_ROWS, Number(input.limit) || 100));
  const orderBy = normalizeAlias(input.orderBy, measures[0].alias);
  if (![...aliases, ...groupBy.map((_, index) => `group${index + 1}`)].includes(orderBy)) {
    throw queryError(`排序字段不在查询结果中：${orderBy}`);
  }
  const order = String(input.order || 'DESC').toUpperCase();
  if (!['ASC', 'DESC'].includes(order)) throw queryError('排序方向只能是 ASC 或 DESC');
  const fieldComparisons = (Array.isArray(input.fieldComparisons) ? input.fieldComparisons : []).map(item => {
    findField(metadata, item.left);
    findField(metadata, item.right);
    if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(item.operator)) throw queryError(`不支持的字段比较操作符：${item.operator}`);
    return { left: item.left, operator: item.operator, right: item.right };
  });

  return {
    groupBy,
    measures,
    filters: normalizeFilters(metadata, input.filters || []),
    fieldComparisons,
    limit,
    orderBy,
    order,
  };
}

export function compileWaxQuery(metadata, input = {}) {
  const spec = normalizeQuerySpec(metadata, input);
  if (!spec.groupBy.length) {
    const rowArgs = spec.measures.flatMap(measure => [
      `"${measure.alias}"`,
      aggregateExpression(metadata, measure, spec.filters, spec.fieldComparisons),
    ]);
    return { spec, wax: `EVALUATE ROW(${rowArgs.join(',')})`, countWax: `EVALUATE ROW("total_rows",1)` };
  }

  const groupColumns = spec.groupBy.map(field => columnRef(metadata, field));
  const summaryArgs = [...groupColumns];
  if (spec.filters.length || spec.fieldComparisons.length) summaryArgs.push(filterTable(metadata, spec.filters, spec.fieldComparisons));
  for (const measure of spec.measures) {
    summaryArgs.push(`"${measure.alias}"`, aggregateExpression(metadata, measure, []));
  }
  const selectArgs = spec.groupBy.flatMap((field, index) => [
    `"group${index + 1}"`,
    columnRef(metadata, field),
  ]);
  for (const measure of spec.measures) selectArgs.push(`"${measure.alias}"`, `[${measure.alias}]`);
  const summarized = `SUMMARIZECOLUMNS(${summaryArgs.join(',')})`;
  const selected = `SELECTCOLUMNS(${summarized},${selectArgs.join(',')})`;
  const countWax = `EVALUATE ROW("total_rows",COUNTROWS(${summarized}))`;
  return { spec, wax: `EVALUATE TOPN(${spec.limit},${selected},[${spec.orderBy}],${spec.order})`, countWax };
}

export function compileWaxProjectionQuery(metadata, request) {
  if (!Array.isArray(request.select) || !request.select.length || request.select.length > 64) {
    throw queryError('原始行投影需要 1 至 64 个字段');
  }
  if (request.measures?.length || request.resultFilters?.length || request.select.some(item => item.grain)) {
    throw queryError('原始行投影不支持聚合指标、结果筛选或时间粒度');
  }
  const filters = normalizeFilters(metadata, request.filters || []);
  const comparisons = (request.fieldComparisons || []).map(item => {
    findField(metadata, item.left);
    findField(metadata, item.right);
    if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(item.operator)) {
      throw queryError(`不支持的字段比较操作符：${item.operator}`);
    }
    return item;
  });
  const aliases = new Set();
  const columns = request.select.flatMap(item => {
    const field = findField(metadata, item.field);
    const alias = normalizeAlias(item.alias);
    if (aliases.has(alias)) throw queryError(`原始行投影别名重复：${alias}`);
    aliases.add(alias);
    return [`"${alias}"`, columnRef(metadata, field.name)];
  });
  const filtered = filterTable(metadata, filters, comparisons);
  const projection = `SELECTCOLUMNS(${filtered},${columns.join(',')})`;
  const order = (request.orderBy || []).map(item => {
    if (!aliases.has(item.field)) throw queryError(`排序字段不在原始行投影中：${item.field}`);
    return `[${item.field}],${item.direction === 'asc' ? 'ASC' : 'DESC'}`;
  });
  const userLimit = String(request.limitSource || '').startsWith('user-');
  if (userLimit && !order.length) throw queryError('限制原始行数量时需要明确排序字段');
  const wax = userLimit
    ? `EVALUATE TOPN(${request.limit},${projection},${order.join(',')})`
    : `EVALUATE ${projection}`;
  return {
    wax,
    countWax: `EVALUATE ROW("total_rows",COUNTROWS(${filtered}))`,
  };
}

function plan(id, purpose, metadata, spec) {
  const compiled = compileWaxQuery(metadata, spec);
  return {
    id,
    purpose,
    queryType: 'WAX',
    sqlAllowed: false,
    ...compiled,
  };
}

export function buildAnalysisQueryBundle(metadata, inputFilters = []) {
  const selected = selectAnalysisFields(metadata);
  const filters = normalizeFilters(metadata, inputFilters);
  const overviewMeasures = [
    { alias: 'source_rows', operation: 'countRows' },
    selected.primaryMeasure && { alias: 'total', operation: 'sum', field: selected.primaryMeasure.name },
    selected.orderId
      ? { alias: 'orders', operation: 'distinctCount', field: selected.orderId.name }
      : { alias: 'orders', operation: 'countRows' },
    selected.profitMeasure && { alias: 'profit', operation: 'sum', field: selected.profitMeasure.name },
    selected.date && { alias: 'date_min', operation: 'min', field: selected.date.name },
    selected.date && { alias: 'date_max', operation: 'max', field: selected.date.name },
  ].filter(Boolean);
  const plans = [plan('overview', '完整数据集经营概览', metadata, { measures: overviewMeasures, filters })];

  const addGroupPlan = (id, purpose, field, limit, order = 'DESC') => {
    if (!field || !selected.primaryMeasure) return;
    plans.push(plan(id, purpose, metadata, {
      groupBy: [field.name],
      measures: [{ alias: 'value', operation: 'sum', field: selected.primaryMeasure.name }],
      filters,
      limit,
      orderBy: id === 'trend' ? 'group1' : 'value',
      order,
    }));
  };
  addGroupPlan('trend', '完整数据集时间趋势', selected.date, MAX_RESULT_ROWS, 'ASC');
  addGroupPlan('category', '完整数据集类别贡献', selected.category, 12);
  addGroupPlan('region', '完整数据集区域贡献', selected.region, 12);
  addGroupPlan('customer', '完整数据集客户贡献', selected.customer, 100);

  return {
    version: 'wyn-query-bundle/v1',
    dataset: { id: metadata.id, name: metadata.name, revision: metadata.revision },
    filters,
    plans,
  };
}

function compareValue(field, actual, expected, operator) {
  if (operator === 'isNotNull') return actual != null && actual !== '';
  if (operator === 'in') return expected.some(value => compareValue(field, actual, value, 'eq'));
  if (STRING_MEMBERSHIP_OPERATORS.has(operator)) {
    const text = actual == null ? '' : String(actual);
    const values = Array.isArray(expected) ? expected.map(String) : [String(expected)];
    const matches = values.map(value => text.includes(value));
    if (operator === 'containsAny') return matches.some(Boolean);
    if (operator === 'containsAll') return matches.every(Boolean);
    if (operator === 'notContainsAny') return matches.every(match => !match);
    return matches.some(match => !match);
  }
  let left = actual;
  let right = expected;
  if (isNumericField(field)) {
    left = toNumber(actual);
    right = toNumber(expected);
  } else if (isTimeField(field)) {
    left = toDate(actual)?.getTime() ?? null;
    right = toDate(expected)?.getTime() ?? null;
  } else {
    left = actual == null ? '' : String(actual);
    right = String(expected);
  }
  if (left == null || right == null) return false;
  if (operator === 'eq') return left === right;
  if (operator === 'neq') return left !== right;
  if (operator === 'gt') return left > right;
  if (operator === 'gte') return left >= right;
  if (operator === 'lt') return left < right;
  return left <= right;
}

export function applyLocalFilters(rows, metadata, inputFilters = []) {
  const filters = normalizeFilters(metadata, inputFilters);
  if (!filters.length) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter(row => filters.every(filter => (
    compareValue(findField(metadata, filter.field), row[filter.field], filter.value, filter.operator)
  )));
}

export function compileFilteredDetailQuery(metadata, inputFilters = []) {
  const filters = normalizeFilters(metadata, inputFilters);
  if (!filters.length) return null;
  return {
    id: 'quality-sample',
    purpose: '筛选范围内的数据质量样本',
    queryType: 'WAX',
    sqlAllowed: false,
    filters,
    wax: `EVALUATE ${filterTable(metadata, filters)}`,
  };
}
