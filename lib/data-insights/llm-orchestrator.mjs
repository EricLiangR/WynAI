const PLANNER_SCHEMA = 'wynai.insight-planner/v1';
import { estimateJsonTokens } from '../../model-capability-profile.mjs';
import { decideEvidenceTransport } from '../../evidence-transport-plan.mjs';

const CRITIC_SCHEMA = 'wynai.insight-critic/v1';
const NARRATOR_SCHEMA = 'wynai.insight-narrator/v1';

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function fail(message, code = 'INSIGHT_LLM_INVALID_OUTPUT') { const error = new Error(message); error.code = code; return error; }
function text(value, max = 4000) { return String(value || '').trim().slice(0, max); }

function compactValue(value, maxItems = 12) {
  if (Array.isArray(value)) return value.length <= 500 ? clone(value) : compactAggregateRows(value, 500);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [key, compactValue(item, maxItems)]));
  return value;
}

function summarizeChunk(rows) {
  const fields = new Map();
  for (const row of rows || []) for (const [key, value] of Object.entries(row || {})) {
    const item = fields.get(key) || { field: key, numericCount: 0, sum: 0, min: null, max: null, distinct: new Set(), topValues: new Map() };
    item.distinct.add(String(value));
    const valueKey = String(value);
    item.topValues.set(valueKey, (item.topValues.get(valueKey) || 0) + 1);
    const number = Number(value);
    if (Number.isFinite(number)) {
      item.numericCount += 1;
      item.sum += number;
      item.min = item.min == null ? number : Math.min(item.min, number);
      item.max = item.max == null ? number : Math.max(item.max, number);
    }
    fields.set(key, item);
  }
  return {
    rowCount: rows.length,
    fields: [...fields.values()].map(item => ({ field: item.field, numericCount: item.numericCount, sum: item.numericCount ? item.sum : null, min: item.min, max: item.max, distinctCount: item.distinct.size, topValues: [...item.topValues.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8).map(([value, count]) => ({ value: value.slice(0, 120), count })) })),
  };
}

function compactAggregateRows(rows, maxRows = 500) {
  if (!Array.isArray(rows)) return rows || [];
  if (rows.length <= maxRows) return clone(rows);
  const chunks = [];
  for (let offset = 0; offset < rows.length; offset += maxRows) {
    const chunk = rows.slice(offset, offset + maxRows);
    chunks.push({ index: chunks.length, offset, rowCount: chunk.length, summary: summarizeChunk(chunk) });
  }
  return { rowCount: rows.length, transmittedRows: rows.length, chunkSize: maxRows, chunkCount: chunks.length, transmission: 'chunked-summary-all-rows', chunks };
}

function compactScope(scope) {
  if (!scope || typeof scope !== 'object') return scope || null;
  const keys = ['datasetId', 'datasetRevision', 'timeRange', 'timeField', 'period', 'previousPeriod', 'grain', 'resultLimited', 'totalGroups', 'representedGroups', 'aggregated', 'sample', 'sourceRowCount', 'representedRowCount', 'representedPeriods', 'totalPeriods', 'periodCoverageMode', 'absenceSemantics', 'omissionReason', 'transmission'];
  return Object.fromEntries(keys.filter(key => scope[key] !== undefined && scope[key] !== null).map(key => [key, scope[key]]));
}

function compactCatalogValue(value, maxItems = 4) {
  if (Array.isArray(value)) {
    // The catalog is an ID lookup surface, not a second result transport.
    // Never inline row objects here, even when the result has fewer than 500
    // rows; canonical rows remain in the Evidence Pack for lossless chunks.
    if (!value.length || typeof value[0] !== 'object') return value.length <= maxItems ? clone(value) : { itemCount: value.length, values: value.slice(0, maxItems).map(item => String(item).slice(0, 120)), transmission: 'catalog-summary' };
    return { rowCount: value.length, summary: summarizeChunk(value), transmission: 'chunked-summary-all-rows' };
  }
  if (value && typeof value === 'object') {
    const output = { ...value };
    if (Array.isArray(output.rows)) {
      output.rows = { rowCount: output.rows.length, summary: summarizeChunk(output.rows), transmission: 'chunked-summary-all-rows' };
    }
    return Object.fromEntries(Object.entries(output).slice(0, 24).map(([key, item]) => [key, key === 'rows' ? item : compactValue(item, maxItems)]));
  }
  return value;
}

function compactCatalog(catalog, maxItems = 4, { itemTokenBudget = 1200 } = {}) {
  // A bounded catalog keeps stage prompts below the configured context
  // budget. Full row coverage remains in the pack's chunk summaries; this
  // window is only the evidence-ID lookup surface for the LLM.
  const limit = Math.min(Number(maxItems) || 0, 32);
  const preferred = catalog.filter(item => {
    const key = `${item?.id || ''} ${item?.title || ''}`.toLowerCase();
    return /row-count|column-count|revenue|sales|profit|income|利润|销售|收入|质量|null|trend|期间|变化|total|总额|group/.test(key);
  });
  const ordered = [...new Map([...preferred, ...catalog].map(item => [item.id, item])).values()];
  return ordered.slice(0, limit).map(item => {
    const compacted = { id: item.id, title: item.title, value: compactCatalogValue(item.value, maxItems), scope: compactScope(item.scope), formula: item.formula || null, method: item.method || null };
    // Protect against a single unusually wide row/label set. The complete
    // source remains persisted; the catalog entry is reduced to its contract
    // fields and a scalar size marker when it exceeds the per-item budget.
    if (estimateJsonTokens(compacted) <= itemTokenBudget) return compacted;
    return { id: item.id, title: text(item.title, 160), value: { transmission: 'catalog-summary', tokenBudgetExceeded: true, estimatedTokens: estimateJsonTokens(compacted), rowCount: Array.isArray(item.value) ? item.value.length : null }, scope: compactScope(item.scope), formula: item.formula || null, method: item.method || null };
  });
}

function compactBusinessFacts(businessFacts) {
  if (!businessFacts || typeof businessFacts !== 'object') return null;
  return {
    schema: businessFacts.schema || null,
    skillRefs: Array.isArray(businessFacts.skillRefs) ? [...businessFacts.skillRefs] : [],
    facts: (businessFacts.facts || []).filter(fact => fact?.id).map(fact => ({
      id: String(fact.id),
      title: fact.title || fact.id,
      value: compactValue(fact.value, 6),
      method: fact.method || null,
      evidenceIds: [...new Set((fact.evidenceIds || []).map(String))],
      scope: fact.scope || null,
      formula: fact.formula || null,
    })),
    requiredFacts: (businessFacts.requiredFacts || []).map(fact => ({
      id: fact.id,
      satisfied: Boolean(fact.satisfied),
      evidenceIds: [...new Set((fact.evidenceIds || []).map(String))],
    })),
    quality: businessFacts.quality || null,
    qualityGates: businessFacts.qualityGates || null,
    evidenceIds: [...new Set((businessFacts.evidenceIds || []).map(String))],
  };
}

function compactPack(pack, { rowChunk = null } = {}) {
  return {
    schema: pack.schema,
    title: pack.title,
    source: pack.source,
    datasets: pack.datasets,
    scope: pack.scope,
    quality: pack.quality,
    complexity: pack.complexity,
    coverage: pack.coverage,
    budget: pack.budget,
    policy: pack.policy,
    capabilityCoverage: pack.capabilityCoverage || null,
    inputCoverage: pack.inputCoverage || null,
    resultSets: (pack.resultSets || []).map(resultSet => ({
      id: resultSet.id,
      scope: resultSet.scope,
      quality: resultSet.quality,
      transmission: resultSet.transmission || null,
      statistics: {
        rowCount: resultSet.statistics?.rowCount,
        columnCount: resultSet.statistics?.columnCount,
        fields: Object.fromEntries(Object.entries(resultSet.statistics?.fields || {}).map(([name, metric]) => [name, {
          field: metric.field,
          type: metric.type,
          role: metric.role,
          semanticType: metric.semanticType,
          aggregation: metric.aggregation,
          additivity: metric.additivity,
          nullCount: metric.nullCount,
          distinctCount: metric.distinctCount,
          sum: metric.sum,
          average: metric.average,
          min: metric.min,
          max: metric.max,
          sumSuppressed: metric.sumSuppressed,
        }])),
        derived: {
          itemCount: Array.isArray(resultSet.statistics?.derived) ? resultSet.statistics.derived.length : 0,
          transmission: 'catalog-evidence',
          complete: true,
        },
        groupings: (resultSet.statistics?.groupings || []).map(grouping => ({
          id: grouping.id,
          dimensions: grouping.dimensions,
          measures: grouping.measures,
          totalGroups: grouping.totalGroups,
          resultLimited: grouping.resultLimited,
          rows: {
            rowCount: Array.isArray(grouping.rows) ? grouping.rows.length : 0,
            transmission: 'catalog-evidence',
            complete: grouping.resultLimited !== true,
          },
        })),
      },
      rows: rowChunk?.resultSetId === resultSet.id
        ? {
          rowCount: rowChunk.rows.length,
          sourceRowCount: resultSet.rows.length,
          transmission: 'lossless-chunk',
          chunkIndex: rowChunk.index,
          chunkCount: rowChunk.chunkCount,
          offset: rowChunk.offset,
          complete: rowChunk.offset + rowChunk.rows.length >= resultSet.rows.length,
          data: clone(rowChunk.rows),
        }
        : {
          rowCount: Array.isArray(resultSet.rows) ? resultSet.rows.length : 0,
          transmission: 'catalog-evidence',
          complete: resultSet.quality?.isTruncated !== true,
        },
      samples: (resultSet.samples || []).map(sample => ({ index: sample.index, row: compactValue(sample.row, 12) })),
    })),
  };
}

function rowChunks(pack, chunkSize = 500) {
  const chunks = [];
  for (const resultSet of pack.resultSets || []) {
    const rows = Array.isArray(resultSet.rows) ? resultSet.rows : [];
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      chunks.push({
        resultSetId: resultSet.id,
        index: chunks.length,
        resultSetChunkIndex: Math.floor(offset / chunkSize),
        chunkCount: Math.max(1, Math.ceil(rows.length / chunkSize)),
        offset,
        rows: clone(rows.slice(offset, offset + chunkSize)),
      });
    }
  }
  return chunks;
}

function evidenceCatalog(pack) {
  const items = [];
  if (pack.capabilityCoverage) items.push({
    id: 'capabilityCoverage',
    value: pack.capabilityCoverage,
    title: '请求能力覆盖',
    scope: pack.scope || null,
    method: 'platform.capability-coverage',
  });
  for (const item of pack.evidence || []) if (item?.id) items.push({
    id: String(item.id),
    value: item.value ?? null,
    title: item.title || item.id,
    scope: item.scope || null,
    formula: item.formula || null,
    method: item.method || null,
    unit: item.unit || null,
  });
  for (const fact of pack.businessFacts?.facts || []) if (fact?.id) items.push({
    id: String(fact.id),
    value: fact.value ?? null,
    title: fact.title || fact.id,
    scope: fact.scope || null,
    formula: fact.formula || null,
    method: fact.method || null,
  });
  for (const resultSet of pack.resultSets || []) {
    const stats = resultSet.statistics || {};
    for (const [fieldIndex, [field, metric]] of Object.entries(Object.entries(stats.fields || {}))) {
      const base = `ev-${resultSet.id}-field-${fieldIndex}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 96);
      const scope = { ...(resultSet.scope || {}), ...(resultSet.quality || {}) };
      for (const operation of ['sum', 'average', 'min', 'max', 'p25', 'median', 'p75', 'nullCount', 'distinctCount']) {
        if (metric[operation] != null) items.push({ id: `${base}-${operation}`, title: `${field} ${operation}`, value: metric[operation], scope });
      }
      if (Array.isArray(metric.topValues)) items.push({ id: `${base}-top-values`, title: `${field} frequency`, value: metric.topValues, scope: { ...scope, resultLimited: metric.topValues.length < Number(metric.distinctCount || metric.topValues.length) } });
    }
    if (stats.columnCount != null) items.push({ id: `ev-${resultSet.id}-column-count`, title: 'column count', value: stats.columnCount, scope: resultSet.scope || null });
    for (let groupingIndex = 0; groupingIndex < (stats.groupings || []).length; groupingIndex += 1) {
      const grouping = stats.groupings[groupingIndex];
      const groupingId = String(grouping.id || 'group').replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80);
      items.push({
        id: `ev-${resultSet.id}-group-${groupingIndex}-${groupingId}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 120),
        title: `${(grouping.dimensions || []).map(field => field.name).join(' / ')} 全量聚合`,
        value: {
          dimensions: (grouping.dimensions || []).map(field => field.name),
          measures: grouping.measures || [],
          measure: grouping.measures?.[0] || null,
          rows: grouping.rows || [],
          total: grouping.measures?.[0]
            ? (grouping.rows || []).reduce((sum, row) => sum + (Number.isFinite(Number(row?.[grouping.measures[0]])) ? Number(row[grouping.measures[0]]) : 0), 0)
            : null,
        },
        scope: { ...(resultSet.scope || {}), ...(resultSet.quality || {}), resultLimited: Boolean(grouping.resultLimited), aggregated: true, totalGroups: grouping.totalGroups || 0 },
      });
    }
    for (const derived of stats.derived || []) {
      if (derived?.id) items.push({ id: String(derived.id), title: derived.title || derived.id, value: derived.value ?? null, scope: derived.scope || { ...(resultSet.scope || {}), derived: true }, formula: derived.formula || null });
    }
    items.push({ id: `ev-${resultSet.id}-row-count`, title: 'row count', value: stats.rowCount ?? null, scope: resultSet.scope || null });
    for (const sample of resultSet.samples || []) {
      items.push({ id: `ev-${resultSet.id}-sample-${sample.index}`, title: `受控样本 ${sample.index}`, value: sample.row || null, scope: { ...(resultSet.scope || {}), resultLimited: (resultSet.samples || []).length < Number(stats.rowCount || 0), sample: true } });
    }
  }
  return items.filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index);
}

function normalizeItems(items, section) {
  if (!Array.isArray(items)) throw fail(`Narrator ${section} 必须是数组`);
  const normalized = items.map(item => ({
    text: text(item?.text, 2000),
    evidenceIds: [...new Set([item?.evidenceIds, item?.evidenceId, item?.references].flat(2).filter(Boolean).map(String))],
    verificationRequired: Boolean(item?.verificationRequired),
  })).filter(item => item.text);
  if (!normalized.length) throw fail(`Narrator ${section} 不能为空`);
  return normalized;
}

function numericClaims(value) {
  const source = String(value || '');
  const matches = [...source.matchAll(/(?<!\d)[-+]?\d[\d,]*(?:\.\d+)?(?:\s*(?:%|万|亿))?/g)];
  return matches.filter(match => {
    const start = match.index || 0;
    const end = start + match[0].length;
    const tokenDigits = match[0].replace(/[,]/g, '');
    const rangeTail = source.slice(end, end + 16);
    // 年/月/日 are date syntax, not standalone numeric claims.
    // Q1/Q2 and 第一季度/第二季度 are period labels, not numeric claims.
    return !(/[年/月日Qq]/.test(source.slice(Math.max(0, start - 1), start))
      || /[年/月日]/.test(source.slice(end, end + 1))
      || /季度/.test(source.slice(end, end + 3))
      || (/^\d{4}$/.test(tokenDigits) && /^(?:至|到|-)\s*\d{4}年/.test(rangeTail)));
  }).map(match => {
    const rawToken = match[0];
    const token = rawToken.replace(/\s+/g, '');
    const suffix = token.endsWith('%') ? '%' : token.endsWith('万') ? '万' : token.endsWith('亿') ? '亿' : '';
    const n = Number(token.replace(/,/g, '').replace(/[%万亿]$/, ''));
    return { token, n, percent: suffix === '%', scale: suffix === '万' ? 10_000 : suffix === '亿' ? 100_000_000 : 1 };
  });
}
function valuesForEvidence(item) {
  const values = [];
  const collect = value => {
    if (typeof value === 'number') values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(item?.value);
  collect(item?.scope);
  // Derived-period evidence keeps the compared business amounts in its
  // formula. They remain valid evidence values even when the displayed value
  // is only the resulting percentage change. Ignore the arithmetic constant
  // 100 used by the percentage formula.
  if (typeof item?.formula === 'string' && /[+\-*/]/.test(item.formula)) {
    for (const token of item.formula.match(/[-+]?\d+(?:\.\d+)?/g) || []) {
      const value = Number(token);
      if (Number.isFinite(value) && value !== 100) values.push(value);
    }
  }
  return values;
}

function textValuesForEvidence(item) {
  const values = [];
  const collect = value => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(item?.value);
  collect(item?.scope);
  return values;
}

function ratioPercentValues(item) {
  const ratios = [];
  const collect = value => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      // Business facts commonly persist ratios as 0..1 while Narrator renders
      // them as percentages (for example concentration.share = 0.767).
      for (const [key, candidate] of Object.entries(value)) {
        if (typeof candidate === 'number' && Number.isFinite(candidate)
          && /share|ratio|rate|margin|percent|percentage|占比|比例|率/i.test(key)
          && candidate >= 0 && candidate <= 1) ratios.push(candidate * 100);
      }
      const numbers = Object.values(value).filter(candidate => typeof candidate === 'number' && Number.isFinite(candidate));
      for (let left = 0; left < numbers.length; left += 1) for (let right = 0; right < numbers.length; right += 1) {
        if (left !== right && numbers[right] !== 0) ratios.push(numbers[left] / numbers[right] * 100);
      }
      Object.values(value).filter(candidate => candidate && typeof candidate === 'object').forEach(collect);
    }
  };
  collect(item?.value);
  return ratios;
}

function percentageValuesForEvidence(item) {
  if (!item) return [];
  const title = String(item.title || '');
  const formula = String(item.formula || '');
  const values = [];
  const collect = value => {
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => {
      if (typeof child === 'number' && Number.isFinite(child)
        && /share|ratio|rate|margin|percent|percentage|占比|比例|率/i.test(key)
        && child >= 0 && child <= 1) values.push(child * 100);
      else collect(child);
    });
  };
  collect(item.value);
  if (typeof item.value === 'number' && (item.unit === '%' || /变化率|占比|比例|率|share|ratio|rate|margin/i.test(title) || formula.includes('*100'))) return values;
  if (typeof item.value === 'object' && (/变化率|占比|比例|率|share|ratio|rate|margin/i.test(title) || formula.includes('*100'))) return values;
  return [];
}

function percentageDirection(textValue) {
  const value = String(textValue || '');
  if (/下降|减少|下滑|降低|跌|降幅|负增长|收缩/.test(value)) return 'decrease';
  if (/增长|上升|回升|增加|提升|增幅/.test(value)) return 'increase';
  return 'neutral';
}

function thresholdPercentageSupported(textValue, parsed, evidenceValues) {
  if (!evidenceValues.length || !/(超过|高于|至少|不低于|不少于)/.test(String(textValue || ''))) return false;
  const direction = percentageDirection(textValue);
  const candidates = evidenceValues.map(value => direction === 'decrease' ? Math.abs(value) : value);
  const tolerance = Math.max(0.06, Math.abs(parsed.n) * 0.001);
  // "均/每年/各" is an all-values assertion; otherwise one referenced value
  // satisfying the threshold is sufficient for a local finding.
  return /均|每年|各|全部/.test(String(textValue || ''))
    ? candidates.every(value => value >= parsed.n - tolerance)
    : candidates.some(value => value >= parsed.n - tolerance);
}

function rangePercentageSupported(textValue, parsed, evidenceValues) {
  const source = String(textValue || '');
  const range = source.match(/(\d+(?:\.\d+)?)\s*%\s*-\s*(\d+(?:\.\d+)?)\s*%/);
  if (!range || !evidenceValues.length) return false;
  const lower = Number(range[1]);
  const upper = Number(range[2]);
  const direction = percentageDirection(source);
  const candidates = evidenceValues.map(value => direction === 'decrease' ? Math.abs(value) : value);
  const tolerance = value => Math.max(0.06, Math.abs(value) * 0.001);
  // A range is an envelope: at least one referenced value must support each
  // bound. This preserves strict evidence linkage while accepting rounded LLM
  // prose such as "约 46%-54%".
  if (Math.abs(parsed.n - lower) < 0.0001) return candidates.some(value => value >= lower - tolerance(lower) && value <= upper + tolerance(upper));
  if (Math.abs(Math.abs(parsed.n) - upper) < 0.0001) return candidates.some(value => value >= lower - tolerance(lower) && value <= upper + tolerance(upper));
  return false;
}

function crossEvidencePercentValues(evidences) {
  const scalars = evidences.flatMap(evidence => typeof evidence?.value === 'number' ? [evidence.value] : []);
  const ratios = [];
  for (let left = 0; left < scalars.length; left += 1) for (let right = 0; right < scalars.length; right += 1) {
    if (left !== right && scalars[right] !== 0) ratios.push(scalars[left] / scalars[right] * 100);
  }
  const contributions = evidences.filter(evidence => Array.isArray(evidence?.value?.rows) && evidence.value.measure);
  const totals = evidences.flatMap(evidence => Number.isFinite(Number(evidence?.value?.total)) ? [Number(evidence.value.total)] : []);
  for (const contribution of contributions) {
    const measure = contribution.value.measure;
    const rows = contribution.value.rows.filter(row => Number.isFinite(Number(row?.[measure])));
    const contributionTotals = totals.length ? totals : [rows.reduce((sum, row) => sum + Number(row[measure]), 0)];
    for (const total of contributionTotals) {
      let running = 0;
      for (const row of rows) {
        const amount = Number(row[measure]);
        running += amount;
        if (total !== 0) {
          ratios.push(amount / total * 100);
          ratios.push(running / total * 100);
        }
      }
    }
  }
  // A time-trend evidence item may carry the complete observed sequence but
  // no precomputed yoy field. Derive adjacent-period changes from that same
  // sequence for validation; this does not add new evidence or infer missing
  // periods, it only checks the arithmetic represented by the supplied rows.
  for (const evidence of evidences) {
    const rows = Array.isArray(evidence?.value?.rows) ? evidence.value.rows : [];
    if (rows.length < 2) continue;
    const numericFields = [...new Set(rows.flatMap(row => Object.entries(row || {}).filter(([, value]) => Number.isFinite(Number(value))).map(([key]) => key)))];
    for (const field of numericFields) {
      for (let index = 1; index < rows.length; index += 1) {
        const previous = Number(rows[index - 1]?.[field]);
        const current = Number(rows[index]?.[field]);
        if (Number.isFinite(previous) && Number.isFinite(current) && previous !== 0) ratios.push((current - previous) / Math.abs(previous) * 100);
      }
    }
  }
  return ratios;
}

function textSupportsNumber(textValue, token, narrativeText = '') {
  const raw = String(textValue || '');
  const normalizedToken = String(token).replace(/,/g, '').replace(/%$/, '');
  if (!normalizedToken) return false;
  const escaped = normalizedToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\d])${escaped}(?![\\d])`);
  if (!pattern.test(raw.replace(/,/g, ''))) return false;
  // Short tokens commonly occur in dates (for example the month in "2023年3月").
  // Accept them only when the narrative also presents the token as a date part,
  // preventing a date month from accidentally validating an unrelated count.
  if (normalizedToken.length < 2 && /年|月|日|季度|week|month|date/i.test(String(narrativeText || ''))) {
    const dateContext = new RegExp(`(?:${escaped})(?:年|月|日)|(?:年|月|日)(?:${escaped})`);
    return dateContext.test(String(narrativeText || ''));
  }
  return true;
}

function validateNarrative(narrative, catalog, critic) {
  if (!narrative || narrative.schema !== NARRATOR_SCHEMA) throw fail('Narrator schema 无效', 'NARRATOR_SCHEMA_INVALID');
  const valid = new Set(catalog.map(item => item.id));
  const byId = new Map(catalog.map(item => [item.id, item]));
  let normalized;
  try {
    normalized = {
      managementSummary: normalizeItems(narrative.managementSummary, 'managementSummary'),
      keyFindings: normalizeItems(narrative.keyFindings, 'keyFindings'),
      risks: normalizeItems(narrative.risks, 'risks'),
      actions: normalizeItems(narrative.actions, 'actions'),
    };
  } catch (error) {
    error.code = 'NARRATOR_SCHEMA_INVALID';
    throw error;
  }
  const all = Object.values(normalized).flat();
  const rejected = [];
  const claimDiagnostics = [];
  for (const item of all) {
    if (!item.evidenceIds.length || item.evidenceIds.some(id => !valid.has(id))) {
      rejected.push({ ...item, status: 'rejected', reason: 'INVALID_EVIDENCE_REFERENCE' });
      continue;
    }
    const limited = item.evidenceIds.some(id => byId.get(id)?.scope?.resultLimited);
    if (limited && /最高|最低|所有|全部|唯一|整体|总体|全局/.test(item.text) && !/当前返回|所列|样本|Top|前\s*\d|后\s*\d/i.test(item.text)) {
      rejected.push({ ...item, status: 'rejected', reason: 'LIMITED_EVIDENCE_SCOPE' });
      continue;
    }
    let itemRejected = null;
    for (const parsed of numericClaims(item.text)) {
      if (!Number.isFinite(parsed.n)) continue;
      const referencedEvidence = item.evidenceIds.map(id => byId.get(id));
      const direction = parsed.percent ? percentageDirection(item.text) : 'neutral';
      const percentageEvidenceValues = parsed.percent ? referencedEvidence.flatMap(percentageValuesForEvidence) : [];
      const supported = referencedEvidence.some(evidence => {
        const expected = parsed.n * parsed.scale;
        const numericSupported = valuesForEvidence(evidence).some(value => {
          const candidates = parsed.percent
            ? [value, value * 100, ...(direction === 'decrease' ? [Math.abs(value)] : [])]
            : [value];
          const approximate = /约|大约|左右|大致/.test(item.text);
          const tolerance = parsed.percent
            ? (parsed.token.includes('.') ? Math.max(0.06, Math.abs(expected) * 0.005) : Math.max(0.06, Math.abs(expected) * 0.01))
            : Math.max(0.011, Math.abs(expected) * (approximate ? (parsed.scale > 1 ? 0.005 : 0.0005) : 0.0001));
          return candidates.some(candidate => Math.abs(candidate - expected) < tolerance);
        });
        const textualSupported = textValuesForEvidence(evidence).some(value => textSupportsNumber(value, parsed.token, item.text));
        const ratioSupported = parsed.percent && ratioPercentValues(evidence).some(value => Math.abs(value - parsed.n) < Math.max(0.06, Math.abs(parsed.n) * 0.005));
        return numericSupported || textualSupported || ratioSupported;
      })
        || (parsed.percent && crossEvidencePercentValues(referencedEvidence).some(value => Math.abs(value - parsed.n) < (parsed.token.includes('.') ? Math.max(0.06, Math.abs(parsed.n) * 0.005) : Math.max(0.06, Math.abs(parsed.n) * 0.01))))
        || (parsed.percent && percentageEvidenceValues.some(value => Math.abs((direction === 'decrease' ? Math.abs(value) : value) - parsed.n) < (parsed.token.includes('.') ? Math.max(0.06, Math.abs(parsed.n) * 0.005) : Math.max(0.06, Math.abs(parsed.n) * 0.01))))
        || (parsed.percent && thresholdPercentageSupported(item.text, parsed, percentageEvidenceValues))
        || (parsed.percent && rangePercentageSupported(item.text, parsed, percentageEvidenceValues));
      if (!supported && !item.verificationRequired) {
        itemRejected = { token: parsed.token, reason: 'UNSUPPORTED_NUMBER' };
        claimDiagnostics.push({ text: item.text, token: parsed.token, evidenceIds: item.evidenceIds, supported: false, reason: itemRejected.reason });
        break;
      }
      claimDiagnostics.push({ text: item.text, token: parsed.token, evidenceIds: item.evidenceIds, supported, reason: supported ? null : 'VERIFICATION_REQUIRED' });
    }
    if (itemRejected) rejected.push({ ...item, status: 'rejected', ...itemRejected });
  }
  const rejectedKey = item => `${item.text}\u0000${item.evidenceIds.join('|')}`;
  const rejectedKeys = new Set(rejected.map(rejectedItem => rejectedKey(rejectedItem)));
  const accepted = Object.fromEntries(Object.entries(normalized).map(([section, items]) => [section, items.filter(item => !rejectedKeys.has(rejectedKey(item)))]));
  for (const action of accepted.actions) {
    const linkedFinding = [...accepted.managementSummary, ...accepted.keyFindings, ...accepted.risks].some(item => item.evidenceIds.some(id => action.evidenceIds.includes(id)));
    if (!linkedFinding || /(目标|阈值|提升至|降低至|控制在|至少|最多)\s*[-+]?\d/.test(action.text)) {
      rejected.push({ ...action, status: 'rejected', reason: !linkedFinding ? 'ACTION_EVIDENCE_NOT_LINKED' : 'UNVERIFIED_TARGET' });
    }
  }
  const finalSections = Object.fromEntries(Object.entries(accepted).map(([section, items]) => [section, items.filter(item => !rejected.some(candidate => candidate !== item && rejectedKey(candidate) === rejectedKey(item)))]));
  for (const section of ['managementSummary', 'keyFindings', 'risks', 'actions']) {
    if (!finalSections[section].length) finalSections[section] = [{ text: section === 'managementSummary' ? '当前证据不足以形成可核验的管理摘要。' : '当前证据不足，建议缩小结果范围后重试。', evidenceIds: [...valid].slice(0, 1), verificationRequired: true }];
  }
  return { ...finalSections, followUps: clone(narrative.followUps || []).slice(0, 5), followUpEvidenceIds: [...new Set((critic?.followUps || []).flatMap(item => item.evidenceIds || []))], validation: { rejectedClaims: rejected.map(item => ({ text: item.text, evidenceIds: item.evidenceIds, reason: item.reason, token: item.token || null })), claims: claimDiagnostics } };
}

function normalizeCritic(critic) {
  const assessments = Array.isArray(critic?.assessments) ? critic.assessments : [];
  const statuses = assessments.map(item => item?.status).filter(Boolean);
  const hasInsufficientAssessment = statuses.some(status => ['rejected', 'inconclusive'].includes(status));
  const normalizedVerdict = !hasInsufficientAssessment && statuses.every(status => status === 'supported') ? 'sufficient' : critic.verdict;
  if (normalizedVerdict === 'sufficient' && hasInsufficientAssessment) return { ...critic, verdict: 'insufficient', normalization: { from: critic.verdict, reason: 'assessment-status-conflict' } };
  if (normalizedVerdict !== critic.verdict) return { ...critic, verdict: normalizedVerdict, normalization: { from: critic.verdict, reason: 'all-assessments-supported' } };
  return critic;
}

function normalizePlanner(plan) {
  const hypotheses = Array.isArray(plan?.hypotheses) ? plan.hypotheses.map((item, index) => ({
    id: String(item?.id || `h${index + 1}`).trim(),
    methodId: item?.methodId ? String(item.methodId).trim() : null,
    question: text(item?.question, 500),
    businessValue: text(item?.businessValue, 500),
    requiredEvidenceIds: [...new Set((item?.requiredEvidenceIds || []).map(String))],
    priority: ['core', 'extended', 'optional'].includes(item?.priority) ? item.priority : 'core',
    // Core is a platform contract, not an LLM suggestion: a core hypothesis
    // must be blocking, while extensions remain explicitly non-blocking.
    blocking: ['core'].includes(item?.priority || 'core') ? true : item?.blocking === true,
    fieldDependencies: [...new Set((item?.fieldDependencies || item?.requiredFields || []).map(String).filter(Boolean))],
    evidenceDependencies: [...new Set((item?.evidenceDependencies || item?.requiredEvidenceIds || []).map(String).filter(Boolean))],
  })).filter(item => item.id) : [];
  const byPriority = priority => hypotheses.filter(item => item.priority === priority);
  return {
    ...plan,
    hypotheses,
    coreHypotheses: Array.isArray(plan?.coreHypotheses) ? plan.coreHypotheses : byPriority('core').map(item => item.id),
    extendedHypotheses: Array.isArray(plan?.extendedHypotheses) ? plan.extendedHypotheses : byPriority('extended').map(item => item.id),
    optionalHypotheses: Array.isArray(plan?.optionalHypotheses) ? plan.optionalHypotheses : byPriority('optional').map(item => item.id),
    planningMode: plan?.planningMode || (hypotheses.some(item => item.priority !== 'core') ? 'core-plus-extensions' : 'direct-core'),
  };
}

function plannerMessages({ prompt, pack, skills, skillPlan = null, catalog, catalogLimit = 500, itemTokenBudget = 1200 }) { return [
  { role: 'system', content: '你是企业业务洞察 Planner。只输出 JSON。必须从 Evidence Pack 选择可验证的业务假设，不得执行查询、猜测外部事实或输出固定统计摘要。输出 {schema:"wynai.insight-planner/v1",intent,summary,hypotheses:[{id,methodId,question,businessValue,requiredEvidenceIds,priority:"core"|"extended"|"optional",blocking:boolean,fieldDependencies:string[]}],toolRequests:[{id,kind,resultSetId,field,reason,priority:"core"|"extended"|"optional"}]}。methodId 如可确定必须使用 SkillPlan 中的方法 ID。kind 只能是 trend/contribution/concentration/quality/comparison。requiredEvidenceIds 只能使用输入证据 ID。先阅读 capabilityCoverage：只能针对 available 能力生成假设；unavailable 能力必须单独披露，不能换成未请求的替代维度。缺失单个维度或指标时，仅将依赖它的假设标记 extended/optional、blocking=false；不得阻断其他可执行核心能力。只有 capabilityCoverage.execution=blocked 或所有用户明确要求的核心能力均不可执行时才允许整体阻断。核心只覆盖用户明确要求；只有用户明确提出或 Skill 的 coreMethods/optionalMethods 声明适用时才增加扩展。简单的维度+指标+时间查询必须优先直接解读，不得默认添加季节性、集中度、归因、地区/产品下钻或行动建议。输入按 observed-records-only 解释：某实体只在部分期间有记录属于真实业务稀疏，不能自动补零、要求完整笛卡尔积或判为数据缺失；只有 evidenceCoverage 明确 omittedGroups>0 才表示平台证据受限。' },
  { role: 'user', content: JSON.stringify({ question: prompt, skills: skills || [], skillPlan, businessFacts: compactBusinessFacts(pack.businessFacts), evidenceCatalog: compactCatalog(catalog, catalogLimit, { itemTokenBudget }), evidencePack: compactPack(pack) }) },
]; }

function rowLevelEvidenceMessages({ prompt, pack, plan, skills, skillPlan, chunk }) { return [
  { role: 'system', content: '你是企业业务证据分块分析器。只输出 JSON。仅分析当前分块中真实存在的行，不得补齐、采样或推断未出现的实体和期间。输出 {schema:"wynai.insight-evidence-chunk/v1",facts:[{id,title,value,reason}]}。value 只能使用当前分块可核验的标量、数组或对象；每个 fact 必须说明 chunkIndex 和 offset 范围。' },
  { role: 'user', content: JSON.stringify({ question: prompt, skills: skills || [], skillPlan, plan, chunk: { resultSetId: chunk.resultSetId, index: chunk.index, resultSetChunkIndex: chunk.resultSetChunkIndex, chunkCount: chunk.chunkCount, offset: chunk.offset, rowCount: chunk.rows.length }, rows: compactPack(pack, { rowChunk: chunk }).resultSets.find(resultSet => resultSet.id === chunk.resultSetId)?.rows }) },
 ]; }

function normalizeRowLevelEvidence(output, chunk) {
  if (output?.schema !== 'wynai.insight-evidence-chunk/v1' || !Array.isArray(output.facts)) throw fail('分块证据输出契约无效');
  return output.facts.slice(0, 20).map((fact, index) => ({
    id: `ev-chunk-${chunk.index}-${String(fact?.id || index).replace(/[^A-Za-z0-9._:-]/g, '-')}`.slice(0, 100),
    title: text(fact?.title || `分块 ${chunk.index} 事实`, 200),
    value: clone(fact?.value ?? null),
    method: 'llm.row-level-chunk',
    scope: { resultSetId: chunk.resultSetId, chunkIndex: chunk.resultSetChunkIndex, chunkCount: chunk.chunkCount, offset: chunk.offset, sourceRowCount: chunk.rows.length, transmission: 'lossless-chunk' },
    reason: text(fact?.reason, 500),
  })).filter(fact => fact.id && fact.value !== null);
}

function criticMessages({ prompt, pack, plan, skills, skillPlan = null, catalog, catalogLimit = 500, itemTokenBudget = 1200 }) { return [
  { role: 'system', content: '你是企业业务洞察 Critic。只输出 JSON。根据 Planner 假设和 Evidence Pack 判断证据是否足够，拒绝无证据推断。输出 {schema:"wynai.insight-critic/v1",verdict:"sufficient"|"insufficient",assessments:[{hypothesisId,status,reason,evidenceIds}],followUps:[{question,reason,evidenceIds}]}。status 只能 supported/rejected/inconclusive。followUps 最多 3 个且只能请求已存在结果集/证据的有限补充。必须区分 sourceCompleteness、evidenceCoverage 和 businessSparsity：实体在部分期间无业务记录不构成证据缺失，不要求维度和期间形成完整笛卡尔积；只有平台明确省略或核心证据无法直接验证时才能判定不足。扩展项不足只能标记该项，不得拖垮已支持的核心项。' },
  { role: 'user', content: JSON.stringify({ question: prompt, skills: skills || [], skillPlan, businessFacts: compactBusinessFacts(pack.businessFacts), plan, evidenceCatalog: compactCatalog(catalog, catalogLimit, { itemTokenBudget }), evidencePack: compactPack(pack) }) },
]; }
function narratorMessages({ prompt, pack, plan, critic, skills, skillPlan = null, catalog, catalogLimit = 500, itemTokenBudget = 1200 }) { return [
  { role: 'system', content: '你是企业经营分析 Narrator。只输出 JSON，不能输出 Markdown。输出 {schema:"wynai.insight-narrator/v1",managementSummary:[...],keyFindings:[...],risks:[...],actions:[...],followUps:[...]}。每项格式 {text,evidenceIds,verificationRequired}，每项至少引用一个输入 evidence ID。不得发明数字、实体、期间或阈值；只能基于 Evidence Pack、Planner 和 Critic。行动必须引用关键发现或风险使用的同一证据。' },
  { role: 'user', content: JSON.stringify({ question: prompt, skills: skills || [], skillPlan, businessFacts: compactBusinessFacts(pack.businessFacts), plan, critic, evidenceCatalog: compactCatalog(catalog, catalogLimit, { itemTokenBudget }), evidencePack: compactPack(pack) }) },
]; }

function narratorRepairMessages(context, narrative, error) {
  const rejectedClaims = narrative?.validation?.rejectedClaims || [];
  const rejectedDetail = rejectedClaims.length
    ? `\n必须逐项删除或改写以下未通过句子（不能原样保留，也不能用未经证据支持的近似数字替换）：${JSON.stringify(rejectedClaims)}`
    : '';
  return [
    ...narratorMessages(context),
    { role: 'assistant', content: JSON.stringify(narrative) },
    { role: 'user', content: `上次 Narrator 输出未通过严格校验：${error.message}。请重新输出完整 JSON。只能保留能由所引用 evidenceIds 直接验证的数字、日期和实体；金额使用万或亿时必须是证据原值的准确单位换算。变化率必须保留证据中的正负方向；使用范围或阈值时，每个边界都必须由引用证据支持。行动必须与已保留的关键发现或风险共享至少一个 evidenceId。无法验证的数字或行动请删除，不得仅通过 verificationRequired 绕过。${rejectedDetail}` },
  ];
}

function hasUsableNarrative(report) {
  const fallbackText = new Set([
    '当前证据不足以形成可核验的管理摘要。',
    '当前证据不足，建议缩小结果范围后重试。',
  ]);
  return ['managementSummary', 'keyFindings', 'risks', 'actions']
    .flatMap(section => report?.[section] || [])
    .some(item => item && !item.verificationRequired && !fallbackText.has(String(item.text || '').trim()));
}

export async function runInsightLlmOrchestration({ llm, prompt = '', input = {}, skills = [], skillPlan = null, signal = null, onStageEvent = null, onGatewayEvent = null } = {}) {
  if (!llm?.enabled || typeof llm.completeJson !== 'function') { const error = fail('正式数据洞察必须配置支持 JSON 编排的外部 LLM', 'INSIGHT_LLM_REQUIRED'); error.status = 503; throw error; }
  const pack = clone(input);
  if (pack.budget?.withinBudget === false) throw fail('Evidence Pack 超过上下文预算', 'LLM_CONTEXT_LIMIT');
  let catalog = evidenceCatalog(pack);
  if (!catalog.length) throw fail('Evidence Pack 没有可引用证据', 'INSIGHT_EVIDENCE_EMPTY');
  const maxTokens = Number(pack.budget?.maxTokens) || 20000;
  const itemTokenBudget = Math.max(256, Math.floor(maxTokens / 12));
  let transportPlan = decideEvidenceTransport({ skillPlan, pack, modelBudget: { inputBudgetTokens: maxTokens, source: 'pack-budget' } });
  let catalogLimit = 32;
  let plannerContext = plannerMessages({ prompt, pack, skills, skillPlan, catalog, catalogLimit, itemTokenBudget });
  let estimatedPlannerTokens = estimateJsonTokens(plannerContext);
  while (estimatedPlannerTokens > maxTokens && catalogLimit > 4) {
    catalogLimit = Math.max(4, Math.floor(catalogLimit / 2));
    plannerContext = plannerMessages({ prompt, pack, skills, skillPlan, catalog, catalogLimit, itemTokenBudget });
    estimatedPlannerTokens = estimateJsonTokens(plannerContext);
  }
  if (estimatedPlannerTokens > maxTokens) throw fail(`洞察 Planner 上下文超过预算（${estimatedPlannerTokens}/${maxTokens} tokens）`, 'LLM_CONTEXT_LIMIT');
  const stageAudit = [];
  const callStage = async (stage, messages) => {
    const startedAt = Date.now();
    try {
      const output = await llm.completeJson(messages, { signal, operation: `insight-${stage}`, onEvent: onGatewayEvent });
      const durationMs = Date.now() - startedAt;
      stageAudit.push({ stage, status: 'completed', durationMs, model: llm.model || null });
      await onStageEvent?.({ stage, status: 'completed', durationMs, model: llm.model || null, messages, output });
      return output;
    } catch (error) {
      error.stage = stage;
      if (error.code === 'LLM_REQUEST_FAILED' || !error.code) error.code = 'LLM_UPSTREAM_ERROR';
      const durationMs = Date.now() - startedAt;
      stageAudit.push({ stage, status: 'failed', durationMs, model: llm.model || null, errorCode: error.code || 'LLM_REQUEST_FAILED' });
      await onStageEvent?.({ stage, status: 'failed', durationMs, model: llm.model || null, messages, error: { code: error.code || 'LLM_REQUEST_FAILED', message: error.message || String(error) } });
      throw error;
    }
  };
  let plan = await callStage('planner', plannerContext);
  if (plan?.schema !== PLANNER_SCHEMA || !Array.isArray(plan.hypotheses) || !Array.isArray(plan.toolRequests)) throw fail('Planner 输出契约无效');
  plan = normalizePlanner(plan);
  const allowed = new Set(catalog.map(item => item.id));
  for (const hypothesis of plan.hypotheses) if (!hypothesis?.id || (hypothesis.requiredEvidenceIds || []).some(id => !allowed.has(id))) throw fail('Planner 引用了不存在的证据');
  if (skillPlan?.methods?.length) {
    const methods = new Map(skillPlan.methods.map(method => [method.id, method]));
    for (const hypothesis of plan.hypotheses) {
      if (!hypothesis.methodId) continue;
      const method = methods.get(hypothesis.methodId);
      if (!method) throw fail(`Planner 引用了 SkillPlan 外的方法：${hypothesis.methodId}`);
      if (hypothesis.priority === 'core' && method.priority !== 'core') throw fail(`核心假设不能使用扩展方法：${hypothesis.methodId}`);
    }
  }
  const rowLevelMethods = new Set((skillPlan?.methods || []).filter(method => method?.rowLevel && method?.allowLosslessChunking !== false).map(method => method.id));
  const rowLevelHypotheses = plan.hypotheses.filter(hypothesis => hypothesis.methodId && rowLevelMethods.has(hypothesis.methodId));
  if (rowLevelHypotheses.length) {
    const chunks = rowChunks(pack);
    const maxChunks = Math.max(1, Math.min(32, Number(skillPlan?.maxRowLevelChunks) || 32));
    if (chunks.length > maxChunks) throw fail(`行级分块数量超过 SkillPlan 上限（${chunks.length}/${maxChunks}）`, 'LLM_CONTEXT_LIMIT');
    const chunkFacts = [];
    for (const chunk of chunks) {
      const output = await callStage(`evidence-chunk-${chunk.index}`, rowLevelEvidenceMessages({ prompt, pack, plan, skills, skillPlan, chunk }));
      chunkFacts.push(...normalizeRowLevelEvidence(output, chunk));
    }
    pack.evidence = [...(pack.evidence || []), ...chunkFacts];
    catalog = evidenceCatalog(pack);
    transportPlan = { ...transportPlan, finalMode: 'lossless-row-chunk', evidence: { ...transportPlan.evidence, chunkCount: chunks.length, representedRowCount: chunks.reduce((sum, chunk) => sum + chunk.rows.length, 0), lossless: true }, decisionTrace: [...transportPlan.decisionTrace, { step: 'chunk-coverage', chunkCount: chunks.length, contiguous: true }] };
  }
  let critic = await callStage('critic', criticMessages({ prompt, pack, plan, skills, skillPlan, catalog, catalogLimit, itemTokenBudget }));
  if (critic?.schema !== CRITIC_SCHEMA || !['sufficient', 'insufficient'].includes(critic.verdict) || !Array.isArray(critic.assessments) || !Array.isArray(critic.followUps)) throw fail('Critic 输出契约无效');
  for (const item of [...critic.assessments, ...critic.followUps]) if ((item.evidenceIds || []).some(id => !allowed.has(id))) throw fail('Critic 引用了不存在的证据');
  critic = normalizeCritic(critic);
  const planById = new Map(plan.hypotheses.map(item => [item.id, item]));
  critic = {
    ...critic,
    assessments: critic.assessments.map(item => ({
      ...item,
      priority: item?.priority || planById.get(item?.hypothesisId)?.priority || 'core',
      blocking: (item?.priority || planById.get(item?.hypothesisId)?.priority || 'core') === 'core'
        ? true
        : item?.blocking === true || planById.get(item?.hypothesisId)?.blocking === true,
    })),
  };
  const narrativeContext = { prompt, pack, plan, critic, skills, skillPlan, catalog, catalogLimit, itemTokenBudget };
  let narrative = await callStage('narrator', narratorMessages(narrativeContext));
  let report;
  try {
    report = validateNarrative(narrative, catalog, critic);
  } catch (error) {
    if (error.code !== 'INSIGHT_LLM_INVALID_OUTPUT') throw error;
    narrative = await callStage('narrator-repair', narratorRepairMessages(narrativeContext, narrative, error));
    report = validateNarrative(narrative, catalog, critic);
  }
  if (report.validation?.rejectedClaims?.length && !hasUsableNarrative(report)) {
    const error = fail(`Narrator 有 ${report.validation.rejectedClaims.length} 项未通过证据校验`, 'NARRATOR_UNSUPPORTED_CLAIM');
    narrative = await callStage('narrator-repair', narratorRepairMessages(narrativeContext, { ...narrative, validation: report.validation }, error));
    report = validateNarrative(narrative, catalog, critic);
  }
  const rejectedClaims = report.validation?.rejectedClaims || [];
  const usableNarrative = hasUsableNarrative(report);
  const needsReview = rejectedClaims.length > 0 && !usableNarrative;
  const assessments = Array.isArray(critic?.assessments) ? critic.assessments : [];
  const supportedCount = assessments.filter(item => item?.status === 'supported').length;
  const partial = supportedCount > 0 && supportedCount < assessments.length;
  const incompleteAssessments = assessments.filter(item => item?.status !== 'supported').map(item => ({ hypothesisId: item.hypothesisId, priority: item.priority || 'core', blocking: Boolean(item.blocking), status: item.status, reason: item.reason, evidenceIds: item.evidenceIds || [] }));
  const narratorPartial = rejectedClaims.length > 0 && usableNarrative;
  const blockingIncomplete = incompleteAssessments.some(item => item.blocking === true || item.priority === 'core');
  const capabilityCoverage = pack.capabilityCoverage || skillPlan?.capabilityCoverage || null;
  const unavailableCapabilities = Array.isArray(capabilityCoverage?.unavailable) ? capabilityCoverage.unavailable : [];
  const capabilityPartial = unavailableCapabilities.length > 0 && capabilityCoverage?.execution === 'partial';
  const capabilityBlocked = capabilityCoverage?.execution === 'blocked';
  const status = capabilityBlocked || blockingIncomplete || needsReview ? 'needs_review' : narratorPartial || partial || capabilityPartial ? 'completed-partial' : 'completed';
  return {
    schema: 'wynai.insight-orchestration/v1',
    planner: clone(plan),
    critic: clone(critic),
    narrative: report,
    evidence: catalog,
    skillPlan: clone(skillPlan),
    markdown: renderNarrative(report),
    model: llm.model || null,
    stageAudit,
    contextBudget: { maxTokens, estimatedPlannerTokens, catalogLimit, itemTokenBudget, plannerCatalogTransmission: 'summary-and-evidence-id-only' },
    transportPlan,
    status,
    capabilityCoverage: clone(capabilityCoverage),
    diagnostics: capabilityBlocked
      ? { reasonCode: 'REQUESTED_CAPABILITIES_UNAVAILABLE', rejectedClaims, unavailableCapabilities }
      : blockingIncomplete
      ? { reasonCode: 'CORE_EVIDENCE_INSUFFICIENT', rejectedClaims, incompleteAssessments }
      : needsReview
        ? { reasonCode: 'NARRATOR_UNSUPPORTED_CLAIM', rejectedClaims }
      : narratorPartial
        ? { reasonCode: 'PARTIAL_NARRATOR_CLAIMS', rejectedClaims, usableNarrative: true }
        : partial
          ? { reasonCode: 'PARTIAL_EVIDENCE', supportedCount, assessmentCount: assessments.length, incompleteAssessments }
          : capabilityPartial
            ? { reasonCode: 'PARTIAL_CAPABILITY_COVERAGE', unavailableCapabilities }
            : null,
  };
}

export function renderNarrative(report) {
  const sections = [['管理摘要', report.managementSummary], ['关键发现', report.keyFindings], ['风险判断', report.risks], ['行动建议', report.actions]];
  return sections.flatMap(([title, items]) => [`## ${title}`, '', ...items.map((item, index) => `${title === '行动建议' ? `${index + 1}.` : '-'} ${item.text} [${item.evidenceIds.join(', ')}]`), '']).join('\n').trim();
}

export const insightLlmSchemas = { PLANNER_SCHEMA, CRITIC_SCHEMA, NARRATOR_SCHEMA };
