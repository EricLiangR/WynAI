const PLANNER_SCHEMA = 'wynai.insight-planner/v1';
const CRITIC_SCHEMA = 'wynai.insight-critic/v1';
const NARRATOR_SCHEMA = 'wynai.insight-narrator/v1';

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function fail(message, code = 'INSIGHT_LLM_INVALID_OUTPUT') { const error = new Error(message); error.code = code; return error; }
function text(value, max = 4000) { return String(value || '').trim().slice(0, max); }

function compactValue(value, maxItems = 12) {
  if (Array.isArray(value)) return value.length <= maxItems ? value : [...value.slice(0, Math.ceil(maxItems / 2)), ...value.slice(-Math.floor(maxItems / 2))];
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [key, compactValue(item, maxItems)]));
  return value;
}

function compactScope(scope) {
  if (!scope || typeof scope !== 'object') return scope || null;
  const keys = ['datasetId', 'datasetRevision', 'timeRange', 'timeField', 'period', 'previousPeriod', 'grain', 'resultLimited', 'totalGroups', 'aggregated', 'sample', 'sourceRowCount', 'representedRowCount', 'omissionReason'];
  return Object.fromEntries(keys.filter(key => scope[key] !== undefined && scope[key] !== null).map(key => [key, scope[key]]));
}

function compactCatalog(catalog, maxItems = 4) {
  return catalog.map(item => ({
    id: item.id,
    title: item.title,
    value: Array.isArray(item.value) && item.value.length > maxItems
      ? { sample: compactValue(item.value, maxItems), rowCount: item.value.length }
      : compactValue(item.value, maxItems),
    scope: compactScope(item.scope),
    formula: item.formula || null,
    method: item.method || null,
  }));
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

function compactPack(pack) {
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
    resultSets: (pack.resultSets || []).map(resultSet => ({
      id: resultSet.id,
      scope: resultSet.scope,
      quality: resultSet.quality,
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
        derived: (resultSet.statistics?.derived || []).map(item => ({ id: item.id, title: item.title, value: item.value, formula: item.formula, scope: compactScope(item.scope) })),
        groupings: (resultSet.statistics?.groupings || []).map(grouping => ({
          id: grouping.id,
          dimensions: grouping.dimensions,
          measures: grouping.measures,
          totalGroups: grouping.totalGroups,
          resultLimited: grouping.resultLimited,
          rows: compactValue(grouping.rows, 4),
        })),
      },
      samples: (resultSet.samples || []).map(sample => ({ index: sample.index, row: compactValue(sample.row, 12) })),
    })),
  };
}

function evidenceCatalog(pack) {
  const items = [];
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
            : Math.max(0.011, Math.abs(expected) * (approximate ? 0.0005 : 0.0001));
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

function plannerMessages({ prompt, pack, skills, catalog }) { return [
  { role: 'system', content: '你是企业业务洞察 Planner。只输出 JSON。必须从 Evidence Pack 选择可验证的业务假设，不得执行查询、猜测外部事实或输出固定统计摘要。输出 {schema:"wynai.insight-planner/v1",intent,summary,hypotheses:[{id,question,businessValue,requiredEvidenceIds}],toolRequests:[{id,kind,resultSetId,field,reason}]}。kind 只能是 trend/contribution/concentration/quality/comparison。requiredEvidenceIds 只能使用输入证据 ID。' },
  { role: 'user', content: JSON.stringify({ question: prompt, skills: skills || [], businessFacts: compactBusinessFacts(pack.businessFacts), evidenceCatalog: compactCatalog(catalog, 4), evidencePack: compactPack(pack) }) },
]; }
function criticMessages({ prompt, pack, plan, skills, catalog }) { return [
  { role: 'system', content: '你是企业业务洞察 Critic。只输出 JSON。根据 Planner 假设和 Evidence Pack 判断证据是否足够，拒绝无证据推断。输出 {schema:"wynai.insight-critic/v1",verdict:"sufficient"|"insufficient",assessments:[{hypothesisId,status,reason,evidenceIds}],followUps:[{question,reason,evidenceIds}]}。status 只能 supported/rejected/inconclusive。followUps 最多 3 个且只能请求已存在结果集/证据的有限补充。' },
  { role: 'user', content: JSON.stringify({ question: prompt, skills: skills || [], businessFacts: compactBusinessFacts(pack.businessFacts), plan, evidenceCatalog: compactCatalog(catalog, 4), evidencePack: compactPack(pack) }) },
]; }
function narratorMessages({ prompt, pack, plan, critic, skills, catalog }) { return [
  { role: 'system', content: '你是企业经营分析 Narrator。只输出 JSON，不能输出 Markdown。输出 {schema:"wynai.insight-narrator/v1",managementSummary:[...],keyFindings:[...],risks:[...],actions:[...],followUps:[...]}。每项格式 {text,evidenceIds,verificationRequired}，每项至少引用一个输入 evidence ID。不得发明数字、实体、期间或阈值；只能基于 Evidence Pack、Planner 和 Critic。行动必须引用关键发现或风险使用的同一证据。' },
  { role: 'user', content: JSON.stringify({ question: prompt, skills: skills || [], businessFacts: compactBusinessFacts(pack.businessFacts), plan, critic, evidenceCatalog: compactCatalog(catalog, 4), evidencePack: compactPack(pack) }) },
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

export async function runInsightLlmOrchestration({ llm, prompt = '', input = {}, skills = [], signal = null, onStageEvent = null, onGatewayEvent = null } = {}) {
  if (!llm?.enabled || typeof llm.completeJson !== 'function') { const error = fail('正式数据洞察必须配置支持 JSON 编排的外部 LLM', 'INSIGHT_LLM_REQUIRED'); error.status = 503; throw error; }
  const pack = clone(input);
  if (pack.budget?.withinBudget === false) throw fail('Evidence Pack 超过上下文预算', 'LLM_CONTEXT_LIMIT');
  const catalog = evidenceCatalog(pack);
  if (!catalog.length) throw fail('Evidence Pack 没有可引用证据', 'INSIGHT_EVIDENCE_EMPTY');
  const maxTokens = Number(pack.budget?.maxTokens) || 20000;
  const plannerContext = plannerMessages({ prompt, pack, skills, catalog });
  const estimatedPlannerTokens = Math.ceil(JSON.stringify(plannerContext).length / 4);
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
  const plan = await callStage('planner', plannerMessages({ prompt, pack, skills, catalog }));
  if (plan?.schema !== PLANNER_SCHEMA || !Array.isArray(plan.hypotheses) || !Array.isArray(plan.toolRequests)) throw fail('Planner 输出契约无效');
  const allowed = new Set(catalog.map(item => item.id));
  for (const hypothesis of plan.hypotheses) if (!hypothesis?.id || (hypothesis.requiredEvidenceIds || []).some(id => !allowed.has(id))) throw fail('Planner 引用了不存在的证据');
  let critic = await callStage('critic', criticMessages({ prompt, pack, plan, skills, catalog }));
  if (critic?.schema !== CRITIC_SCHEMA || !['sufficient', 'insufficient'].includes(critic.verdict) || !Array.isArray(critic.assessments) || !Array.isArray(critic.followUps)) throw fail('Critic 输出契约无效');
  for (const item of [...critic.assessments, ...critic.followUps]) if ((item.evidenceIds || []).some(id => !allowed.has(id))) throw fail('Critic 引用了不存在的证据');
  critic = normalizeCritic(critic);
  const narrativeContext = { prompt, pack, plan, critic, skills, catalog };
  let narrative = await callStage('narrator', narratorMessages(narrativeContext));
  let report;
  try {
    report = validateNarrative(narrative, catalog, critic);
  } catch (error) {
    if (error.code !== 'INSIGHT_LLM_INVALID_OUTPUT') throw error;
    narrative = await callStage('narrator-repair', narratorRepairMessages(narrativeContext, narrative, error));
    report = validateNarrative(narrative, catalog, critic);
  }
  if (report.validation?.rejectedClaims?.length) {
    const error = fail(`Narrator 有 ${report.validation.rejectedClaims.length} 项未通过证据校验`, 'NARRATOR_UNSUPPORTED_CLAIM');
    narrative = await callStage('narrator-repair', narratorRepairMessages(narrativeContext, { ...narrative, validation: report.validation }, error));
    report = validateNarrative(narrative, catalog, critic);
  }
  const needsReview = Boolean(report.validation?.rejectedClaims?.length);
  return { schema: 'wynai.insight-orchestration/v1', planner: clone(plan), critic: clone(critic), narrative: report, evidence: catalog, markdown: renderNarrative(report), model: llm.model || null, stageAudit, status: needsReview ? 'needs_review' : 'completed', diagnostics: needsReview ? { reasonCode: 'NARRATOR_UNSUPPORTED_CLAIM', rejectedClaims: report.validation.rejectedClaims } : null };
}

export function renderNarrative(report) {
  const sections = [['管理摘要', report.managementSummary], ['关键发现', report.keyFindings], ['风险判断', report.risks], ['行动建议', report.actions]];
  return sections.flatMap(([title, items]) => [`## ${title}`, '', ...items.map((item, index) => `${title === '行动建议' ? `${index + 1}.` : '-'} ${item.text} [${item.evidenceIds.join(', ')}]`), '']).join('\n').trim();
}

export const insightLlmSchemas = { PLANNER_SCHEMA, CRITIC_SCHEMA, NARRATOR_SCHEMA };
