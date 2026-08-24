function numericTokens(value) {
  const withoutCalendarValues = String(value || '')
    .replace(/\d{4}(?:-\d{1,2}){1,2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?/g, ' ')
    .replace(/\d{1,4}\s*[年月日]/g, ' ');
  return withoutCalendarValues.match(/(?<!\d)[-+]?\d[\d,]*(?:\.\d+)?%?/g) || [];
}

function normalizeNumericToken(value) {
  const token = String(value).replace(/,/g, '');
  const percent = token.endsWith('%');
  const number = Number(percent ? token.slice(0, -1) : token);
  return Number.isFinite(number) ? `${number}${percent ? '%' : ''}` : token;
}

function normalizeReportItems(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    text: String(item?.text || '').trim(),
    evidenceIds: [...new Set(
      [item?.evidenceIds, item?.evidenceId, item?.evidence_ids, item?.evidence, item?.evidences, item?.references, item?.sourceEvidence]
        .flat(2)
        .filter(Boolean)
        .flatMap(value => String(value).match(/ev-[a-z0-9-]+/gi) || []),
    )],
    verificationRequired: Boolean(item?.verificationRequired),
  })).filter(item => item.text);
}

function linkedInsightText(item, analysis) {
  return (analysis.insights || [])
    .filter(insight => (insight.evidenceIds || []).some(id => item.evidenceIds.includes(id)))
    .map(insight => `${insight.title || ''} ${insight.statement || ''}`)
    .join(' ');
}

function tokenNumber(token) {
  const value = String(token).replace(/,/g, '');
  const percent = value.endsWith('%');
  const number = Number(percent ? value.slice(0, -1) : value);
  return { number, percent };
}

function valueMatchesToken(value, token) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const parsed = tokenNumber(token);
  if (!Number.isFinite(parsed.number)) return false;
  const candidates = parsed.percent ? [value, value * 100] : [value];
  return candidates.some(candidate => Math.abs(candidate - parsed.number) < 0.011);
}

function includesEntityContext(text, label) {
  const parts = String(label).split(/\s*·\s*/).map(value => value.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(part => text.includes(part));
}

function validateNumericEntityContext(item, analysis) {
  if (/占比\s*100(?:\.0+)?%/.test(item.text)
    && !/(?:前三项|前\s*\d+\s*项|全部状态|所列项目|各项合计)[^。；]*占比\s*100(?:\.0+)?%/.test(item.text)) {
    throw new Error(`大模型报告将组合占比改写为单项占比：${item.text}`);
  }
  for (const token of numericTokens(item.text)) {
    const scalarSupport = item.evidenceIds.some(id => {
      const value = analysis.evidence.find(evidence => evidence.id === id)?.value;
      return valueMatchesToken(value, token);
    });
    if (scalarSupport) continue;
    const labels = new Set();
    for (const id of item.evidenceIds) {
      const value = analysis.evidence.find(evidence => evidence.id === id)?.value;
      if (!Array.isArray(value)) continue;
      for (const row of value) {
        if (!row || typeof row !== 'object' || !row.label) continue;
        if (Object.entries(row).some(([key, candidate]) => key !== 'label' && valueMatchesToken(candidate, token))) labels.add(String(row.label));
      }
    }
    if (labels.size === 1) {
      const [label] = labels;
      if (!includesEntityContext(item.text, label)) throw new Error(`大模型报告丢失数值对应的实体上下文：${token} 应关联 ${label}`);
    }
  }
}

function validateActionNumbers(item, analysis) {
  const tokens = numericTokens(item.text);
  if (!tokens.length) return;
  const supported = new Set(numericTokens(linkedInsightText(item, analysis)).map(normalizeNumericToken));
  const unsupported = tokens.filter(token => !supported.has(normalizeNumericToken(token)));
  if (unsupported.length) {
    throw new Error(`行动建议包含无证据支持的数字：${unsupported.join('、')}`);
  }
  const commitment = /(?:目标|阈值|提升至|提高至|降低至|压降至|减少至|控制在|达到|保持在|确保达到|不低于|不高于|至少|最多|至多).{0,16}[-+]?\d[\d,]*(?:\.\d+)?%?|[-+]?\d[\d,]*(?:\.\d+)?%?.{0,8}(?:目标|阈值|以内|以上|以下)/;
  if (commitment.test(item.text)) throw new Error('行动建议包含未经验证的定量目标或阈值');
}

export function parseLlmJson(content) {
  const source = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('大模型未返回结构化报告');
  return JSON.parse(source.slice(start, end + 1));
}

export function prepareStructuredReport(report, analysis) {
  const groupedEvidenceIds = new Set(
    (analysis.evidence || []).filter(item => Array.isArray(item.value)).map(item => item.id),
  );
  const managementSummary = normalizeReportItems(report?.managementSummary).map(item => {
    const hasGroupedEvidence = item.evidenceIds.some(id => groupedEvidenceIds.has(id));
    if (!hasGroupedEvidence || !numericTokens(item.text).length) return item;
    return {
      ...item,
      text: '本次分析已形成分组和交叉结果，具体数值及完整实体上下文见关键发现与风险判断。',
    };
  });
  return { ...report, managementSummary };
}

export function validateStructuredReport(report, analysis) {
  const validEvidence = new Set(analysis.evidence.map(item => item.id));
  const evidenceById = new Map(analysis.evidence.map(item => [item.id, item]));
  const normalized = {
    managementSummary: normalizeReportItems(report.managementSummary),
    keyFindings: normalizeReportItems(report.keyFindings),
    risks: normalizeReportItems(report.risks),
    actions: normalizeReportItems(report.actions),
  };
  for (const [section, items] of Object.entries(normalized)) {
    if (!items.length) throw new Error(`大模型报告缺少 ${section}`);
    for (const item of items) {
      if (!item.evidenceIds.length || item.evidenceIds.some(id => !validEvidence.has(id))) {
        const invalid = item.evidenceIds.filter(id => !validEvidence.has(id));
        throw new Error(`大模型报告存在无效证据引用${invalid.length ? `：${invalid.join('、')}` : ''}`);
      }
      if (section === 'actions') validateActionNumbers(item, analysis);
      else validateNumericEntityContext(item, analysis);
      const usesLimitedEvidence = item.evidenceIds.some(id => evidenceById.get(id)?.scope?.resultLimited);
      if (usesLimitedEvidence && /最高|最低|所有|全部|唯一|整体|总体|全局/.test(item.text) && !/返回|所列|样本|Top|前\s*\d|后\s*\d/i.test(item.text)) {
        throw new Error(`大模型报告将受限结果集越界解释为全量结论：${item.text}`);
      }
      const invalidDurationFields = item.evidenceIds.flatMap(id => evidenceById.get(id)?.scope?.invalidDurationFields || []);
      const ranksInvalidDuration = invalidDurationFields.some(field => item.text.includes(field))
        && /瓶颈|最慢|最高|最低|效率最佳|效率最差/.test(item.text);
      if (ranksInvalidDuration && !/负值|异常|排除|不可|不能|无效/.test(item.text)) {
        throw new Error('大模型报告将含负时长的证据直接解释为正常效率排名');
      }
    }
  }
  const reportItems = Object.values(normalized).flat();
  for (const evidence of analysis.evidence.filter(item => item.scope?.invalidDurationFields?.length)) {
    const disclosesBoundary = reportItems.some(item => item.evidenceIds.includes(evidence.id)
      && /负值|负时长|异常/.test(item.text)
      && /排除|不可|不能|无效|核验|验证|核查|误判/.test(item.text));
    if (!disclosesBoundary) {
      throw new Error(`大模型报告未披露负时长证据 ${evidence.id} 的排除与核验边界`);
    }
  }
  return normalized;
}

export function structuredReportMarkdown(report) {
  const sections = [
    ['管理摘要', report.managementSummary],
    ['关键发现', report.keyFindings],
    ['风险判断', report.risks],
    ['行动建议', report.actions],
  ];
  return sections.flatMap(([title, items]) => [
    `## ${title}`,
    '',
    ...items.map((item, index) => `${title === '行动建议' ? `${index + 1}.` : '-'} ${item.text} \`${item.evidenceIds.join(' / ')}\`${item.verificationRequired ? '（需要进一步验证）' : ''}`),
    '',
  ]).join('\n').trim();
}
