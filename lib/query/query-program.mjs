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
  const supported = new Set(['ratio', 'difference', 'percentage']);
  if (!supported.has(step.operator)) throw new Error(`不支持的公式指标算子：${step.operator}`);
  let zeroDivisionCount = 0;
  const outputRows = rows.map(row => {
    const values = step.inputAliases.map(alias => toNumber(row[alias]));
    let value = null;
    if (values.every(item => item != null)) {
      if (step.operator === 'difference') value = values.slice(1).reduce((current, item) => current - item, values[0]);
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

function compareValues(left, right, direction) {
  const a = toNumber(left);
  const b = toNumber(right);
  const comparison = a != null && b != null ? a - b : String(left ?? '').localeCompare(String(right ?? ''));
  return direction === 'asc' ? comparison : -comparison;
}

function partitionRank(rows, step) {
  const partitions = new Map();
  for (const row of rows) {
    const key = rowKey(row, step.partitionBy);
    if (!partitions.has(key)) partitions.set(key, []);
    partitions.get(key).push(row);
  }
  return [...partitions.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN', { numeric: true }))
    .flatMap(([, group]) => [...group]
      .sort((left, right) => compareValues(left[step.orderBy], right[step.orderBy], step.direction))
      .slice(0, step.limit));
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
  const derivedAliases = new Set((intent.derivedMetrics || []).map(item => item.alias));
  const postAggregationRanking = intent.ranking && (intent.ranking.partitionBy?.length || derivedAliases.has(intent.ranking.orderBy));
  if (postAggregationRanking) {
    baseQuery.limit = Math.max(baseQuery.limit, 20000);
    baseQuery.orderBy = [];
    steps.push({
      type: 'partition-rank',
      partitionBy: intent.ranking.partitionBy || [],
      orderBy: intent.ranking.orderBy || intent.metrics[0]?.alias,
      direction: intent.ranking.direction,
      limit: intent.ranking.limit,
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
  steps.push({ type: 'validate', expectedResult: intent.expectedResult });
  return {
    schema: 'wynai.query-program/v1',
    version: 1,
    intentId: intent.intentId,
    baseQuery,
    steps,
    output: {
      schema: 'wynai.canonical-result-set/v1',
      requiredMetrics: intent.expectedResult.requiredMetrics,
      requiredDimensions: intent.expectedResult.requiredDimensions,
    },
  };
}

export function applyQueryProgram(resultSet, program) {
  let rows = (resultSet?.rows || []).map(row => ({ ...row }));
  const schema = [...(resultSet?.schema || [])];
  const warnings = [];
  const sourceRows = rows.length;
  const sourceTotalRowCount = resultSet?.statistics?.totalRowCount;
  const sourceWasLimited = Boolean(resultSet?.quality?.isTruncated || resultSet?.quality?.limitReached);
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
    } else if (step.type === 'partition-rank') {
      rows = partitionRank(rows, step);
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
  const internalCalculationRowCount = Number.isFinite(Number(sourceTotalRowCount)) ? Number(sourceTotalRowCount) : sourceRows;
  const totalRowCount = sourceWasLimited && Number.isFinite(Number(sourceTotalRowCount)) ? Number(sourceTotalRowCount) : (sourceWasLimited ? null : rows.length);
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
