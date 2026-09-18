import { toNumber } from '../analysis-core.mjs';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function shiftIsoDate(value, grain, amount) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (grain === 'month') date.setUTCMonth(date.getUTCMonth() + amount);
  else date.setUTCFullYear(date.getUTCFullYear() + amount);
  return date.toISOString().slice(0, 10);
}

function periodToken(value, grain) {
  const match = String(value ?? '').match(/^(\d{4})(?:-(\d{2}))?/);
  if (!match) return String(value ?? '');
  return grain === 'month' ? match[1] + '-' + (match[2] || '01') : match[1];
}

function previousPeriod(value, grain, derivation) {
  const token = periodToken(value, grain);
  if (derivation === 'yoy' && grain === 'month') {
    const match = token.match(/^(\d{4})-(\d{2})$/);
    return match ? String(Number(match[1]) - 1) + '-' + match[2] : null;
  }
  if (grain === 'month') {
    const match = token.match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 2, 1));
    return String(date.getUTCFullYear()) + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
  }
  const year = Number(token.slice(0, 4));
  return Number.isFinite(year) ? String(year - 1) : null;
}

function rowKey(row, aliases) { return JSON.stringify(aliases.map(alias => row[alias] ?? null)); }

function normalizeOrderAlias(orderBy, fallback = null) {
  if (Array.isArray(orderBy)) return normalizeOrderAlias(orderBy[0], fallback);
  if (typeof orderBy === 'string' && orderBy.trim()) return orderBy.trim();
  if (orderBy && typeof orderBy === 'object') {
    const candidate = orderBy.alias || orderBy.field || orderBy.name;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

function deriveGrowth(rows, step) {
  const groups = step.dimensionAliases.filter(alias => alias !== step.periodAlias);
  const index = new Map(rows.map(row => [rowKey(row, groups) + '|' + periodToken(row[step.periodAlias], step.grain), row]));
  return rows.map(row => {
    const previous = index.get(rowKey(row, groups) + '|' + previousPeriod(row[step.periodAlias], step.grain, step.derivation));
    const currentValue = toNumber(row[step.sourceAlias]);
    const previousValue = toNumber(previous?.[step.sourceAlias]);
    return { ...row, [step.outputAlias]: currentValue == null || previousValue == null || previousValue === 0 ? null : (currentValue - previousValue) / previousValue };
  });
}

function deriveFormula(rows, step) {
  const operator = step.operator === 'divide' ? 'ratio' : step.operator;
  const supported = new Set(['ratio', 'difference', 'percentage']);
  if (!supported.has(operator)) throw new Error(`不支持的公式指标算子：${step.operator}`);
  let zeroDivisionCount = 0;
  const outputRows = rows.map(row => {
    const values = step.inputAliases.map(alias => toNumber(row[alias]));
    let value = null;
    if (values.every(item => item != null)) {
      if (operator === 'difference') value = values.slice(1).reduce((current, item) => current - item, values[0]);
      else {
        const denominator = values[1];
        if (denominator === 0) {
          zeroDivisionCount += 1;
          value = step.zeroDivision === 'zero' ? 0 : null;
        } else {
          value = values[0] / denominator;
        }
      }
    }
    return { ...row, [step.outputAlias]: Number.isFinite(value) ? value : null };
  });
  return { rows: outputRows, zeroDivisionCount };
}

function deriveShareOfTotal(rows, step) {
  const totals = new Map();
  for (const row of rows) {
    const key = rowKey(row, step.partitionBy || []);
    const value = toNumber(row[step.sourceAlias]);
    if (value != null) totals.set(key, (totals.get(key) || 0) + value);
  }
  let zeroDivisionCount = 0;
  const zeroPartitions = new Set();
  const outputRows = rows.map(row => {
    const key = rowKey(row, step.partitionBy || []);
    const total = totals.get(key);
    const value = toNumber(row[step.sourceAlias]);
    if (total === 0 && !zeroPartitions.has(key)) {
      zeroPartitions.add(key);
      zeroDivisionCount += 1;
    }
    return { ...row, [step.outputAlias]: value == null || total == null || total === 0 ? null : value / total };
  });
  const selected = new Set((step.selectedValues || []).map(value => String(value)));
  const filteredRows = selected.size && step.shareDimensionAlias
    ? outputRows.filter(row => selected.has(String(row[step.shareDimensionAlias] ?? '')))
    : outputRows;
  return { rows: filteredRows, zeroDivisionCount };
}

function compareValues(left, right, direction) {
  const a = toNumber(left);
  const b = toNumber(right);
  const comparison = a != null && b != null ? a - b : String(left ?? '').localeCompare(String(right ?? ''));
  return direction === 'asc' ? comparison : -comparison;
}

function partitionRank(rows, step) {
  const partitions = new Map();
  for (const row of rows) {
    const key = rowKey(row, step.partitionBy || []);
    if (!partitions.has(key)) partitions.set(key, []);
    partitions.get(key).push(row);
  }
  return [...partitions.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN', { numeric: true }))
    .flatMap(([, group]) => {
      const sorted = [...group].sort((left, right) => compareValues(left[step.orderBy], right[step.orderBy], step.direction));
      const limit = step.percentage
        ? Math.max(1, Math.ceil(sorted.length * step.percentage / 100))
        : step.limit;
      return sorted.slice(0, limit);
    });
}

function rankThenDrilldown(rows, step) {
  const rankingDimension = step.rankingDimension;
  const drilldownDimension = step.drilldownDimension;
  const metric = normalizeOrderAlias(step.orderBy);
  if (!rankingDimension || !drilldownDimension || !metric) return [];
  const totals = new Map();
  for (const row of rows) {
    const key = String(row[rankingDimension] ?? '');
    const value = toNumber(row[metric]);
    if (value != null) totals.set(key, (totals.get(key) || 0) + value);
  }
  const top = [...totals.entries()]
    .sort((a, b) => step.direction === 'asc' ? a[1] - b[1] : b[1] - a[1])
    .slice(0, step.limit || 1)
    .map(([key]) => key);
  const allowed = new Set(top);
  return rows.filter(row => allowed.has(String(row[rankingDimension] ?? '')))
    .sort((a, b) => String(a[drilldownDimension] ?? '').localeCompare(String(b[drilldownDimension] ?? ''), 'zh-CN', { numeric: true }));
}

function resultStatistics(rows, schema) {
  const nullCounts = {};
  const minimums = {};
  const maximums = {};
  for (const column of schema) {
    const values = rows.map(row => row[column.name]).filter(value => value != null && value !== '');
    nullCounts[column.name] = rows.length - values.length;
    if (column.type !== 'number') continue;
    const numbers = values.map(toNumber).filter(value => value != null);
    if (numbers.length) {
      minimums[column.name] = Math.min(...numbers);
      maximums[column.name] = Math.max(...numbers);
    }
  }
  return { rowCount: rows.length, nullCounts, minimums, maximums };
}

export function compileQueryProgram({ intent, request }) {
  const baseQuery = clone(request);
  const steps = [];
  const periodDimension = intent.dimensions.find(item => item.grain);
  const periodDerivedMetrics = (intent.derivedMetrics || []).filter(item => ['yoy', 'mom'].includes(item.type));
  if (periodDerivedMetrics.length && periodDimension) {
    const start = baseQuery.filters.find(item => item.field === intent.time.field && item.operator === 'gte');
    if (start) {
      const candidates = periodDerivedMetrics.map(item => shiftIsoDate(start.value, item.type === 'yoy' ? 'year' : periodDimension.grain, -(item.offset || 1)));
      start.value = candidates.sort()[0];
    }
    baseQuery.limit = Math.max(baseQuery.limit, 20000);
    baseQuery.expectedResult.minimumRows = 0;
    baseQuery.expectedResult.requiredPeriods = [];
    for (const metric of periodDerivedMetrics) steps.push({
      type: 'derive-period-growth',
      derivation: metric.type,
      sourceAlias: metric.sourceAlias,
      outputAlias: metric.alias,
      periodAlias: periodDimension.alias,
      grain: periodDimension.grain,
      dimensionAliases: intent.dimensions.map(item => item.alias),
      label: metric.source,
    });
  }
  for (const metric of (intent.derivedMetrics || []).filter(item => item.type === 'formula')) steps.push({
    type: 'derive-formula',
    operator: metric.operator,
    inputAliases: metric.dependencies.map(item => item.sourceAlias),
    outputAlias: metric.alias,
    label: metric.source || metric.metricId,
    metricId: metric.metricId,
    resultType: metric.resultType || 'number',
    unitFamily: metric.unitFamily || null,
    zeroDivision: metric.zeroDivision || 'null',
    skillRef: metric.skillRef,
  });
  for (const metric of (intent.derivedMetrics || []).filter(item => item.type === 'share-of-total')) {
    const shareDimension = intent.dimensions.find(item => item.alias === metric.shareDimensionAlias || item.concept === metric.shareDimensionConcept)
      || (metric.shareDimensionConcept ? { alias: metric.shareDimensionConcept, concept: metric.shareDimensionConcept } : null);
    const shareField = shareDimension?.field;
    const selectedValues = shareField
      ? baseQuery.filters.filter(filter => filter.field === shareField && ['eq', 'in'].includes(filter.operator)).flatMap(filter => Array.isArray(filter.value) ? filter.value : [filter.value]).filter(value => value != null)
      : [];
    if (shareField && selectedValues.length) {
      baseQuery.filters = baseQuery.filters.filter(filter => filter.field !== shareField);
      if (!baseQuery.select.some(item => item.alias === shareDimension.alias || item.field === shareField)) baseQuery.select.push({ ...shareDimension, role: 'dimension' });
      // The denominator requires the complete slice population before the
      // requested member is projected back out; a scalar default limit would
      // otherwise make every slice appear as 100%.
      baseQuery.limit = Math.max(baseQuery.limit || 0, 20000);
      baseQuery.expectedResult = { ...(baseQuery.expectedResult || {}), maximumRows: Math.max(baseQuery.expectedResult?.maximumRows || 0, 20000) };
    }
    steps.push({
      type: 'derive-share-of-total',
      sourceAlias: metric.sourceAlias,
      outputAlias: metric.alias,
      shareDimensionAlias: metric.shareDimensionAlias || shareDimension?.alias || null,
      partitionBy: metric.partitionBy || [],
      denominatorScope: metric.denominatorScope || 'filtered-result',
      selectedValues,
      label: metric.source || metric.alias,
    });
  }
  const derivedAliases = new Set((intent.derivedMetrics || []).map(item => item.alias));
  const rankingDimension = intent.ranking?.byDimension
    ? (typeof intent.ranking.byDimension === 'string'
      ? intent.dimensions.find(item => item.alias === intent.ranking.byDimension || item.field === intent.ranking.byDimension)
      : intent.ranking.byDimension)
    : null;
  const normalizedRankingOrder = normalizeOrderAlias(intent.ranking?.orderBy, intent.metrics[0]?.alias);
  const partitionAliases = new Set(intent.ranking?.partitionBy || []);
  const declaredDrilldownAliases = new Set(intent.ranking?.drilldownDimensions || []);
  const drilldownDimensions = intent.ranking?.thenDrilldown && rankingDimension
    ? intent.dimensions.filter(item => declaredDrilldownAliases.has(item.alias)
      && item.alias !== rankingDimension.alias && !partitionAliases.has(item.alias))
    : [];
  let stagedQuery = null;
  if (intent.ranking?.thenDrilldown && rankingDimension && drilldownDimensions.length && normalizedRankingOrder) {
    const drilldownRequestTemplate = clone(baseQuery);
    const rankingSelectAliases = new Set([rankingDimension.alias, ...partitionAliases]);
    const rankingRequest = clone(baseQuery);
    rankingRequest.id = `${baseQuery.id}-ranking`;
    rankingRequest.purpose = `${baseQuery.purpose}（排名阶段）`;
    rankingRequest.select = rankingRequest.select.filter(item => rankingSelectAliases.has(item.alias));
    rankingRequest.orderBy = [{ field: normalizedRankingOrder, direction: intent.ranking.direction || 'desc' }];
    rankingRequest.limit = intent.ranking.limit || 1;
    rankingRequest.limitSource = 'user-ranking';
    rankingRequest.expectedResult = {
      ...(rankingRequest.expectedResult || {}),
      shape: 'grouped-table',
      maximumRows: rankingRequest.limit,
      requiredDimensions: rankingRequest.select.map(item => item.alias),
      requiredMetrics: [normalizedRankingOrder],
    };
    drilldownRequestTemplate.id = `${baseQuery.id}-drilldown`;
    drilldownRequestTemplate.purpose = `${baseQuery.purpose}（下钻阶段）`;
    drilldownRequestTemplate.limit = 20000;
    drilldownRequestTemplate.limitSource = 'default';
    drilldownRequestTemplate.orderBy = drilldownDimensions.map(item => ({ field: item.alias, direction: 'asc' }));
    stagedQuery = {
      type: 'wyn-rank-then-drilldown',
      rankingRequest,
      drilldownRequestTemplate,
      rankingDimension: { field: rankingDimension.field, alias: rankingDimension.alias },
      drilldownDimensions: drilldownDimensions.map(item => ({ field: item.field, alias: item.alias })),
    };
    Object.assign(baseQuery, rankingRequest);
  }
  const postAggregationRanking = intent.ranking && (intent.ranking.partitionBy?.length || derivedAliases.has(intent.ranking.orderBy) || intent.ranking.percentage);
  if (postAggregationRanking) {
    baseQuery.limit = Math.max(baseQuery.limit, 20000);
    baseQuery.orderBy = [];
    steps.push({
      type: 'partition-rank',
      partitionBy: intent.ranking.partitionBy || [],
      orderBy: normalizedRankingOrder,
      direction: intent.ranking.direction,
      limit: intent.ranking.limit,
      percentage: intent.ranking.percentage || null,
    });
  }
  if (periodDimension && intent.time.periods?.length) steps.push({
    type: 'project-periods',
    periodAlias: periodDimension.alias,
    periods: intent.time.periods.map(String),
    grain: periodDimension.grain,
  });
  const internalDimensions = intent.dimensions.filter(item => item.internal).map(item => item.alias);
  if (internalDimensions.length) steps.push({ type: 'drop-internal-dimensions', aliases: internalDimensions });
  const internalMetrics = intent.metrics.filter(item => item.internal).map(item => item.alias);
  if (internalMetrics.length) steps.push({ type: 'drop-internal-metrics', aliases: internalMetrics });
  if (steps.some(step => ['derive-period-growth', 'derive-share-of-total', 'partition-rank'].includes(step.type))) {
    baseQuery.limitSource = 'internal-calculation';
  }
  steps.push({ type: 'validate', expectedResult: intent.expectedResult });
  return {
    schema: 'wynai.query-program/v1',
    version: 1,
    intentId: intent.intentId,
    baseQuery,
    stagedQuery,
    steps,
    output: {
      schema: 'wynai.canonical-result-set/v1',
      requiredMetrics: intent.expectedResult.requiredMetrics,
      requiredDimensions: intent.expectedResult.requiredDimensions,
    },
  };
}

export function materializeRankedDrilldownRequest(program, rankingResultSet) {
  const staged = program?.stagedQuery;
  if (staged?.type !== 'wyn-rank-then-drilldown') return null;
  const alias = staged.rankingDimension?.alias;
  const values = [...new Set((rankingResultSet?.rows || [])
    .map(row => row?.[alias])
    .filter(value => value != null && String(value).trim() !== ''))];
  if (!values.length) return null;
  const request = clone(staged.drilldownRequestTemplate);
  request.filters = [
    ...(request.filters || []).filter(filter => filter.field !== staged.rankingDimension.field),
    {
      field: staged.rankingDimension.field,
      operator: values.length === 1 ? 'eq' : 'in',
      value: values.length === 1 ? values[0] : values,
    },
  ];
  return request;
}

export function validateRankedDrilldownSeed(program, rankingResultSet) {
  const staged = program?.stagedQuery;
  if (staged?.type !== 'wyn-rank-then-drilldown') return { valid: true, errors: [] };
  const alias = staged.rankingDimension?.alias;
  const limit = Math.max(1, Number(staged.rankingRequest?.limit) || 1);
  const rows = Array.isArray(rankingResultSet?.rows) ? rankingResultSet.rows : [];
  const errors = [];
  if (!alias) errors.push('排名阶段缺少排名对象别名');
  if (rows.length && alias && rows.some(row => row?.[alias] == null || String(row[alias]).trim() === '')) {
    errors.push(`排名阶段结果缺少排名对象字段 ${alias}`);
  }
  const values = alias ? [...new Set(rows.map(row => row?.[alias]).filter(value => value != null && String(value).trim() !== '').map(String))] : [];
  if (rows.length && !values.length) errors.push('排名阶段没有返回可用于下钻的排名对象');
  if (values.length > limit) errors.push(`排名阶段返回 ${values.length} 个排名对象，超过要求的 ${limit} 个`);
  return { valid: errors.length === 0, errors, values };
}

export function applyQueryProgram(resultSet, program) {
  let rows = (resultSet?.rows || []).map(row => ({ ...row }));
  const schema = [...(resultSet?.schema || [])];
  const warnings = [];
  const sourceRows = rows.length;
  const sourceTotalRowCount = resultSet?.statistics?.totalRowCount;
  const sourceWasLimited = Boolean(resultSet?.quality?.isTruncated || resultSet?.quality?.limitReached);
  const sourceUserLimitApplied = Boolean(resultSet?.quality?.userLimitApplied || String(resultSet?.quality?.limitSource || '').startsWith('user-'));
  for (const step of program?.steps || []) {
    if (step.type === 'derive-period-growth') {
      rows = deriveGrowth(rows, step);
      if (!schema.some(column => column.name === step.outputAlias)) schema.push({
        name: step.outputAlias,
        sourceField: step.label || step.sourceAlias,
        displayName: step.label || step.outputAlias,
        type: 'number',
        role: 'derived-measure',
        aggregation: step.derivation,
        format: 'percentage',
      });
      if (rows.some(row => row[step.outputAlias] == null)) warnings.push(step.outputAlias + ' 的部分期间缺少可比基期或基期为 0');
    } else if (step.type === 'derive-formula') {
      const derived = deriveFormula(rows, step);
      rows = derived.rows;
      if (!schema.some(column => column.name === step.outputAlias)) schema.push({
        name: step.outputAlias,
        sourceField: step.label || step.metricId || step.outputAlias,
        displayName: step.label || step.outputAlias,
        type: 'number',
        role: 'derived-measure',
        aggregation: step.operator,
        resultType: step.resultType,
        unitFamily: step.unitFamily,
        format: step.resultType === 'percentage' || step.unitFamily === 'percentage' ? 'percentage' : 'number',
      });
      if (derived.zeroDivisionCount) warnings.push(`${step.label || step.outputAlias}有 ${derived.zeroDivisionCount} 行因分母为 0 返回空值`);
    } else if (step.type === 'derive-share-of-total') {
      const derived = deriveShareOfTotal(rows, step);
      rows = derived.rows;
      if (!schema.some(column => column.name === step.outputAlias)) schema.push({
        name: step.outputAlias,
        sourceField: step.label || step.sourceAlias,
        displayName: step.label || step.outputAlias,
        type: 'number',
        role: 'derived-measure',
        aggregation: 'share-of-total',
        resultType: 'percentage',
        unitFamily: 'percentage',
        format: 'percentage',
      });
      if (derived.zeroDivisionCount) warnings.push(`${step.label || step.outputAlias}有 ${derived.zeroDivisionCount} 个分区因合计值为 0 返回空值`);
    } else if (step.type === 'partition-rank') {
      rows = partitionRank(rows, step);
    } else if (step.type === 'rank-then-drilldown') {
      rows = rankThenDrilldown(rows, step);
    } else if (step.type === 'project-periods') {
      const allowed = new Set(step.periods);
      rows = rows.filter(row => { const token = periodToken(row[step.periodAlias], step.grain); return allowed.has(token) || allowed.has(token.slice(0, 4)); });
    } else if (step.type === 'drop-internal-dimensions' || step.type === 'drop-internal-metrics') {
      const dropped = new Set(step.aliases || []);
      rows = rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !dropped.has(key))));
      for (let index = schema.length - 1; index >= 0; index -= 1) if (dropped.has(schema[index].name)) schema.splice(index, 1);
    }
  }
  // Recompute visible cardinality after internal comparison-period projection.
  const hasKnownSourceTotal = sourceTotalRowCount != null && Number.isFinite(Number(sourceTotalRowCount));
  const internalCalculationRowCount = hasKnownSourceTotal ? Number(sourceTotalRowCount) : sourceRows;
  const totalRowCount = (sourceWasLimited || sourceUserLimitApplied) && hasKnownSourceTotal
    ? Number(sourceTotalRowCount)
    : (sourceWasLimited ? null : rows.length);
  return {
    ...resultSet,
    schema,
    rows,
    statistics: {
      ...resultStatistics(rows, schema),
      totalRowCount,
      returnedRowCount: rows.length,
      internalCalculationRowCount,
      internalReturnedRowCount: sourceRows,
    },
    quality: { ...(resultSet?.quality || {}), totalRowCount, returnedRowCount: rows.length, internalCalculationRowCount, internalReturnedRowCount: sourceRows, warnings: [...new Set([...(resultSet?.quality?.warnings || []), ...warnings])] },
    queryProgram: { schema: program?.schema, version: program?.version, intentId: program?.intentId },
  };
}
