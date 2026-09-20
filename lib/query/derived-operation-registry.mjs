import { toNumber } from '../analysis-core.mjs';

function rowKey(row, aliases) { return JSON.stringify((aliases || []).map(alias => row[alias] ?? null)); }

function periodToken(value, grain) {
  const match = String(value ?? '').match(/^(\d{4})(?:-(\d{2}))?/);
  if (!match) return String(value ?? '');
  return grain === 'month' ? `${match[1]}-${match[2] || '01'}` : match[1];
}

function previousPeriod(value, grain, derivation) {
  const token = periodToken(value, grain);
  if (derivation === 'yoy' && grain === 'month') {
    const match = token.match(/^(\d{4})-(\d{2})$/);
    return match ? `${Number(match[1]) - 1}-${match[2]}` : null;
  }
  if (grain === 'month') {
    const match = token.match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 2, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const year = Number(token.slice(0, 4));
  return Number.isFinite(year) ? String(year - 1) : null;
}

function derivePeriodGrowth(rows, step) {
  const groups = step.dimensionAliases.filter(alias => alias !== step.periodAlias);
  const index = new Map(rows.map(row => [rowKey(row, groups) + '|' + periodToken(row[step.periodAlias], step.grain), row]));
  return { rows: rows.map(row => {
    const previous = index.get(rowKey(row, groups) + '|' + previousPeriod(row[step.periodAlias], step.grain, step.derivation));
    const currentValue = toNumber(row[step.sourceAlias]);
    const previousValue = toNumber(previous?.[step.sourceAlias]);
    return { ...row, [step.outputAlias]: currentValue == null || previousValue == null || previousValue === 0 ? null : (currentValue - previousValue) / previousValue };
  }), warnings: [] };
}

function deriveFormula(rows, step) {
  let zeroDivisionCount = 0;
  const output = rows.map(row => {
    const values = step.inputAliases.map(alias => toNumber(row[alias]));
    let value = null;
    if (values.every(item => item != null)) {
      if (step.operationId === 'difference') value = values.slice(1).reduce((current, item) => current - item, values[0]);
      else if (values[1] === 0) { zeroDivisionCount += 1; value = step.zeroDivision === 'zero' ? 0 : null; }
      else value = values[0] / values[1];
    }
    return { ...row, [step.outputAlias]: Number.isFinite(value) ? value : null };
  });
  return { rows: output, warnings: zeroDivisionCount ? [`${step.label || step.outputAlias}有 ${zeroDivisionCount} 行因分母为 0 返回空值`] : [] };
}

function deriveShareOfTotal(rows, step) {
  const totals = new Map();
  for (const row of rows) {
    const key = rowKey(row, step.partitionBy);
    const value = toNumber(row[step.sourceAlias]);
    if (value != null) totals.set(key, (totals.get(key) || 0) + value);
  }
  const zeroPartitions = new Set();
  const projected = rows.map(row => {
    const key = rowKey(row, step.partitionBy);
    const total = totals.get(key);
    const value = toNumber(row[step.sourceAlias]);
    if (total === 0) zeroPartitions.add(key);
    return { ...row, [step.outputAlias]: value == null || total == null || total === 0 ? null : value / total };
  });
  const selected = new Set((step.selectedValues || []).map(String));
  return {
    rows: selected.size && step.shareDimensionAlias ? projected.filter(row => selected.has(String(row[step.shareDimensionAlias] ?? ''))) : projected,
    warnings: zeroPartitions.size ? [`${step.label || step.outputAlias}有 ${zeroPartitions.size} 个分区因合计值为 0 返回空值`] : [],
  };
}

const registry = new Map([
  ['period-growth@1', { operationId: 'period-growth', operationVersion: 1, allowedGrains: ['year', 'month'], execute: derivePeriodGrowth }],
  ['ratio@1', { operationId: 'ratio', operationVersion: 1, execute: deriveFormula }],
  ['difference@1', { operationId: 'difference', operationVersion: 1, execute: deriveFormula }],
  ['percentage@1', { operationId: 'percentage', operationVersion: 1, execute: deriveFormula }],
  ['share-of-total@1', { operationId: 'share-of-total', operationVersion: 1, execute: deriveShareOfTotal }],
]);

export function resolveDerivedOperation(operationId, operationVersion) { return registry.get(`${operationId}@${operationVersion}`) || null; }
export function listDerivedOperations() { return [...registry.values()].map(({ execute, ...definition }) => ({ ...definition })); }
