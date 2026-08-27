const PLANNER_SCHEMA = 'wynai.insight-planner/v1';
const CRITIC_SCHEMA = 'wynai.insight-critic/v1';
const NARRATOR_SCHEMA = 'wynai.insight-narrator/v1';

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function fail(message, code = 'INSIGHT_LLM_INVALID_OUTPUT') { const error = new Error(message); error.code = code; return error; }
function text(value, max = 4000) { return String(value || '').trim().slice(0, max); }

function evidenceCatalog(pack) {
  const items = [];
  for (const item of pack.evidence || []) if (item?.id) items.push({ id: String(item.id), value: item.value ?? null, title: item.title || item.id, scope: item.scope || null });
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
        value: grouping.rows || [],
        scope: { ...(resultSet.scope || {}), ...(resultSet.quality || {}), resultLimited: Boolean(grouping.resultLimited), aggregated: true, totalGroups: grouping.totalGroups || 0 },
      });
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
  const matches = String(value || '').match(/(?<!\d)[-+]?\d[\d,]*(?:\.\d+)?(?:\s*(?:%|万|亿))?/g) || [];
  return matches.map(rawToken => {
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
  return values;
}

function ratioPercentValues(item) {
  const ratios = [];
  const collect = value => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
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

function crossEvidencePercentValues(evidences) {
  const scalars = evidences.flatMap(evidence => typeof evidence?.value === 'number' ? [evidence.value] : []);
  const ratios = [];
  for (let left = 0; left < scalars.length; left += 1) for (let right = 0; right < scalars.length; right += 1) {
    if (left !== right && scalars[right] !== 0) ratios.push(scalars[left] / scalars[right] * 100);
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
  if (!narrative || narrative.schema !== NARRATOR_SCHEMA) throw fail('Narrator schema 无效');
  const valid = new Set(catalog.map(item => item.id));
  const byId = new Map(catalog.map(item => [item.id, item]));
  const normalized = {
    managementSummary: normalizeItems(narrative.managementSummary, 'managementSummary'),
    keyFindings: normalizeItems(narrative.keyFindings, 'keyFindings'),
    risks: normalizeItems(narrative.risks, 'risks'),
    actions: normalizeItems(narrative.actions, 'actions'),
  };
  const all = Object.values(normalized).flat();
  for (const item of all) {
    if (!item.evidenceIds.length || item.evidenceIds.some(id => !valid.has(id))) throw fail(`Narrator 存在无效证据引用：${item.evidenceIds.join(',')}`);
    const limited = item.evidenceIds.some(id => byId.get(id)?.scope?.resultLimited);
    if (limited && /最高|最低|所有|全部|唯一|整体|总体|全局/.test(item.text) && !/当前返回|所列|样本|Top|前\s*\d|后\s*\d/i.test(item.text)) throw fail(`Narrator 将受限证据越界为全局结论：${item.text}`);
    for (const parsed of numericClaims(item.text)) {
      if (!Number.isFinite(parsed.n)) continue;
      const referencedEvidence = item.evidenceIds.map(id => byId.get(id));
      const supported = referencedEvidence.some(evidence => {
        const expected = parsed.n * parsed.scale;
        const numericSupported = valuesForEvidence(evidence).some(value => (parsed.percent ? [value, value * 100] : [value]).some(candidate => Math.abs(candidate - expected) < Math.max(0.011, Math.abs(expected) * 0.0001)));
        const textualSupported = textValuesForEvidence(evidence).some(value => textSupportsNumber(value, parsed.token, item.text));
        const ratioSupported = parsed.percent && ratioPercentValues(evidence).some(value => Math.abs(value - parsed.n) < 0.06);
        return numericSupported || textualSupported || ratioSupported;
      }) || (parsed.percent && crossEvidencePercentValues(referencedEvidence).some(value => Math.abs(value - parsed.n) < 0.06));
      if (!supported && !item.verificationRequired) throw fail(`Narrator 使用了证据中不存在的数字：${parsed.token}`);
    }
  }
  for (const action of normalized.actions) {
    const linkedFinding = [...normalized.keyFindings, ...normalized.risks].some(item => item.evidenceIds.some(id => action.evidenceIds.includes(id)));
    if (!linkedFinding) throw fail('Narrator 行动建议必须引用关键发现或风险证据');
    if (/(目标|阈值|提升至|降低至|控制在|至少|最多)\s*[-+]?\d/.test(action.text)) throw fail('Narrator 不得生成未经验证的定量目标或阈值');
  }
  return { ...normalized, followUps: clone(narrative.followUps || []).slice(0, 5), followUpEvidenceIds: [...new Set((critic?.followUps || []).flatMap(item => item.evidenceIds || []))] };
}

function plannerMessages({ prompt, pack, skills, catalog }) { return [
  { role: 'system', content: '你是企业业务洞察 Planner。只输出 JSON。必须从 Evidence Pack 选择可验证的业务假设，不得执行查询、猜测外部事实或输出固定统计摘要。输出 {schema:"wynai.insight-planner/v1",intent,summary,hypotheses:[{id,question,businessValue,requiredEvidenceIds}],toolRequests:[{id,kind,resultSetId,field,reason}]}。kind 只能是 trend/contribution/concentration/quality/comparison。requiredEvidenceIds 只能使用输入证据 ID。' },
  { role: 'user', content: JSON.stringify({ question: prompt, skills: skills || [], evidenceCatalog: catalog, evidencePack: pack }) },
]; }
function criticMessages({ prompt, pack, plan, skills, catalog }) { return [
  { role: 'system', content: '你是企业业务洞察 Critic。只输出 JSON。根据 Planner 假设和 Evidence Pack 判断证据是否足够，拒绝无证据推断。输出 {schema:"wynai.insight-critic/v1",verdict:"sufficient"|"insufficient",assessments:[{hypothesisId,status,reason,evidenceIds}],followUps:[{question,reason,evidenceIds}]}。status 只能 supported/rejected/inconclusive。followUps 最多 3 个且只能请求已存在结果集/证据的有限补充。' },
  { role: 'user', content: JSON.stringify({ question: prompt, skills: skills || [], plan, evidenceCatalog: catalog, evidencePack: pack }) },
]; }
function narratorMessages({ prompt, pack, plan, critic, skills, catalog }) { return [
  { role: 'system', content: '你是企业经营分析 Narrator。只输出 JSON，不能输出 Markdown。输出 {schema:"wynai.insight-narrator/v1",managementSummary:[...],keyFindings:[...],risks:[...],actions:[...],followUps:[...]}。每项格式 {text,evidenceIds,verificationRequired}，每项至少引用一个输入 evidence ID。不得发明数字、实体、期间或阈值；只能基于 Evidence Pack、Planner 和 Critic。行动必须引用关键发现或风险使用的同一证据。' },
  { role: 'user', content: JSON.stringify({ question: prompt, skills: skills || [], plan, critic, evidenceCatalog: catalog, evidencePack: pack }) },
]; }

function narratorRepairMessages(context, narrative, error) {
  return [
    ...narratorMessages(context),
    { role: 'assistant', content: JSON.stringify(narrative) },
    { role: 'user', content: `上次 Narrator 输出未通过严格校验：${error.message}。请重新输出完整 JSON。只能保留能由所引用 evidenceIds 直接验证的数字、日期和实体；金额使用万或亿时必须是证据原值的准确单位换算。无法验证的数字请删除，不得仅通过 verificationRequired 绕过。` },
  ];
}

export async function runInsightLlmOrchestration({ llm, prompt = '', input = {}, skills = [], signal = null } = {}) {
  if (!llm?.enabled || typeof llm.completeJson !== 'function') { const error = fail('正式数据洞察必须配置支持 JSON 编排的外部 LLM', 'INSIGHT_LLM_REQUIRED'); error.status = 503; throw error; }
  const pack = clone(input);
  const catalog = evidenceCatalog(pack);
  if (!catalog.length) throw fail('Evidence Pack 没有可引用证据', 'INSIGHT_EVIDENCE_EMPTY');
  const stageAudit = [];
  const callStage = async (stage, messages) => {
    const startedAt = Date.now();
    try {
      const output = await llm.completeJson(messages, { signal });
      stageAudit.push({ stage, status: 'completed', durationMs: Date.now() - startedAt, model: llm.model || null });
      return output;
    } catch (error) {
      stageAudit.push({ stage, status: 'failed', durationMs: Date.now() - startedAt, model: llm.model || null, errorCode: error.code || 'LLM_REQUEST_FAILED' });
      throw error;
    }
  };
  const plan = await callStage('planner', plannerMessages({ prompt, pack, skills, catalog }));
  if (plan?.schema !== PLANNER_SCHEMA || !Array.isArray(plan.hypotheses) || !Array.isArray(plan.toolRequests)) throw fail('Planner 输出契约无效');
  const allowed = new Set(catalog.map(item => item.id));
  for (const hypothesis of plan.hypotheses) if (!hypothesis?.id || (hypothesis.requiredEvidenceIds || []).some(id => !allowed.has(id))) throw fail('Planner 引用了不存在的证据');
  const critic = await callStage('critic', criticMessages({ prompt, pack, plan, skills, catalog }));
  if (critic?.schema !== CRITIC_SCHEMA || !['sufficient', 'insufficient'].includes(critic.verdict) || !Array.isArray(critic.assessments) || !Array.isArray(critic.followUps)) throw fail('Critic 输出契约无效');
  for (const item of [...critic.assessments, ...critic.followUps]) if ((item.evidenceIds || []).some(id => !allowed.has(id))) throw fail('Critic 引用了不存在的证据');
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
  return { schema: 'wynai.insight-orchestration/v1', planner: clone(plan), critic: clone(critic), narrative: report, evidence: catalog, markdown: renderNarrative(report), model: llm.model || null, stageAudit };
}

export function renderNarrative(report) {
  const sections = [['管理摘要', report.managementSummary], ['关键发现', report.keyFindings], ['风险判断', report.risks], ['行动建议', report.actions]];
  return sections.flatMap(([title, items]) => [`## ${title}`, '', ...items.map((item, index) => `${title === '行动建议' ? `${index + 1}.` : '-'} ${item.text} [${item.evidenceIds.join(', ')}]`), '']).join('\n').trim();
}

export const insightLlmSchemas = { PLANNER_SCHEMA, CRITIC_SCHEMA, NARRATOR_SCHEMA };
