import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SCOPE_RANK = Object.freeze({ system: 400, dataset: 300, organization: 200, user: 100 });
const FORMULA_OPERATORS = new Set(['ratio', 'difference', 'percentage']);

function parseDictionaryMetadata(block) {
  return Object.fromEntries(String(block || '').split(/\r?\n/)
    .map(line => line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value]));
}

function markdownTableCells(line) {
  const text = String(line || '').trim();
  if (!text.startsWith('|')) return [];
  const cells = text.split('|');
  if (cells.at(-1)?.trim() === '') cells.pop();
  if (cells[0]?.trim() === '') cells.shift();
  return cells.map(cell => cell.trim());
}

function isMarkdownTableSeparator(line) {
  const cells = markdownTableCells(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function booleanMetadata(value) {
  return ['true', '1', 'yes', '是'].includes(String(value || '').trim().toLowerCase());
}

function normalizedFieldSemantics(items) {
  return Array.isArray(items) ? items.slice(0, 200).map(item => ({
    field: String(item?.field || '').trim().slice(0, 200),
    type: ['string', 'number', 'boolean', 'date', 'datetime'].includes(String(item?.type || '').trim())
      ? String(item.type).trim()
      : null,
    storage: ['scalar', 'delimited-text', 'json-array'].includes(String(item?.storage || '').trim())
      ? String(item.storage).trim()
      : null,
    multiValue: Boolean(item?.multiValue),
    queryOperators: [...new Set((item?.queryOperators || [])
      .map(value => String(value).trim())
      .filter(value => ['eq', 'neq', 'containsAny', 'containsAll', 'notContainsAny', 'notContainsAll'].includes(value)))].slice(0, 12),
    description: String(item?.description || '').trim().slice(0, 500),
  })).filter(item => item.field && item.type && item.description) : [];
}

function dictionaryItemFromRow(row, columns, metadata, rowNumber) {
  const sourceColumn = metadata.sourceColumn || columns[0];
  const canonicalColumn = metadata.canonicalColumn || columns[0];
  const aliasColumn = metadata.aliasColumn || '';
  const sourceValue = String(row[sourceColumn] || '').trim();
  const canonicalName = String(row[canonicalColumn] || sourceValue).trim();
  const abbreviation = aliasColumn ? String(row[aliasColumn] || '').trim() : '';
  return {
    id: `${metadata.id}-${rowNumber}`,
    rowNumber,
    sourceValue,
    sourceCode: sourceColumn === '类型编码' ? sourceValue : null,
    canonicalName,
    abbreviation: abbreviation || null,
    aliases: [...new Set([canonicalName, abbreviation].filter(value => value && value !== sourceValue))],
    raw: row,
  };
}

export function parseMarkdownDictionaries(markdown, source = '') {
  const lines = String(markdown || '').split(/\r?\n/);
  const dictionaries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^##\s+(.+?)\s*$/);
    if (!heading) continue;
    const sectionEnd = lines.findIndex((line, offset) => offset > index && /^##\s+/.test(line));
    const end = sectionEnd >= 0 ? sectionEnd : lines.length;
    const section = lines.slice(index + 1, end).join('\n');
    const metadataMatch = section.match(/<!--\s*dictionary\s*([\s\S]*?)-->/i);
    if (!metadataMatch) continue;
    const metadata = parseDictionaryMetadata(metadataMatch[1]);
    if (!metadata.id || !metadata.field || !metadata.concept) continue;
    const sectionLines = lines.slice(index + 1, end);
    const tableStart = sectionLines.findIndex(line => markdownTableCells(line).length > 0);
    if (tableStart < 0 || !isMarkdownTableSeparator(sectionLines[tableStart + 1])) continue;
    const columns = markdownTableCells(sectionLines[tableStart]);
    const rows = [];
    for (let rowIndex = tableStart + 2; rowIndex < sectionLines.length; rowIndex += 1) {
      const cells = markdownTableCells(sectionLines[rowIndex]);
      if (!cells.length) break;
      const row = Object.fromEntries(columns.map((column, columnIndex) => [column, cells[columnIndex] || '']));
      if (Object.values(row).some(value => String(value).trim())) rows.push(row);
    }
    const items = rows.map((row, rowIndex) => dictionaryItemFromRow(row, columns, metadata, rowIndex + 1));
    dictionaries.push({
      id: metadata.id,
      version: metadata.version || '1.0.0',
      name: heading[1].trim(),
      field: metadata.field,
      concept: metadata.concept,
      matchMode: ['exact', 'containsAny', 'containsAll'].includes(metadata.matchMode) ? metadata.matchMode : 'exact',
      multiValue: booleanMetadata(metadata.multiValue),
      source,
      columns,
      items,
    });
    index = end - 1;
  }
  return dictionaries;
}

function mappingsFromDictionaries(dictionaries = []) {
  return dictionaries.flatMap(dictionary => dictionary.items.map(item => ({
    field: dictionary.field,
    concept: dictionary.concept,
    canonicalValue: item.sourceValue,
    synonyms: item.aliases,
    matchMode: dictionary.matchMode,
    notes: `${dictionary.name}；来源表格第 ${item.rowNumber} 行。${dictionary.multiValue ? '该字段按多值成员匹配。' : ''}`,
  })));
}

function normalizedMetricFormula(input, metricId) {
  if (!input) return null;
  const operator = String(input.operator || '').trim();
  if (!FORMULA_OPERATORS.has(operator)) throw new Error(`Skill 指标 ${metricId} 的公式算子不受支持：${operator}`);
  const inputs = [...new Set((input.inputs || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 8);
  if (inputs.length < 2) throw new Error(`Skill 指标 ${metricId} 的公式至少需要两个依赖指标`);
  return {
    schema: 'wynai.metric-formula/v1',
    operator,
    inputs,
    aggregationOrder: 'aggregate-then-calculate',
    zeroDivision: input.zeroDivision === 'zero' ? 'zero' : 'null',
  };
}

function normalizedSkill(input = {}) {
  const id = String(input.id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(id)) throw new Error(`Skill ID 无效：${id}`);
  const version = String(input.version || '1.0.0').trim();
  return {
    schema: 'wynai.skill/v1',
    id,
    version,
    name: String(input.name || id).trim().slice(0, 120),
    scope: ['system', 'dataset', 'organization', 'user'].includes(input.scope) ? input.scope : 'dataset',
    datasetIds: [...new Set((input.datasetIds || []).map(String).filter(Boolean))].slice(0, 50),
    organizationIds: [...new Set((input.organizationIds || []).map(String).filter(Boolean))].slice(0, 50),
    userIds: [...new Set((input.userIds || []).map(String).filter(Boolean))].slice(0, 50),
    dictionaryFiles: [...new Set((input.dictionaryFiles || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 50),
    fieldSemantics: normalizedFieldSemantics(input.fieldSemantics),
    defaultCalendar: ['fiscal', 'natural'].includes(String(input.defaultCalendar || '').trim()) ? String(input.defaultCalendar).trim() : null,
    calendarPolicy: input.calendarPolicy && typeof input.calendarPolicy === 'object' ? {
      default: ['fiscal', 'natural'].includes(String(input.calendarPolicy.default || '').trim()) ? String(input.calendarPolicy.default).trim() : null,
      userOverride: input.calendarPolicy.userOverride !== false,
      fiscalYearField: String(input.calendarPolicy.fiscalYearField || '').trim().slice(0, 200) || null,
      dateField: String(input.calendarPolicy.dateField || '').trim().slice(0, 200) || null,
      fiscalYearStart: String(input.calendarPolicy.fiscalYearStart || '').trim().slice(0, 10) || null,
      fiscalYearEndExclusive: String(input.calendarPolicy.fiscalYearEndExclusive || '').trim().slice(0, 10) || null,
      displayAssumption: String(input.calendarPolicy.displayAssumption || '').trim().slice(0, 400) || null,
    } : null,
    dictionaries: Array.isArray(input.dictionaries) ? input.dictionaries.slice(0, 50).map(dictionary => {
      const items = Array.isArray(dictionary?.items) ? dictionary.items.slice(0, 1000).map(item => ({
        id: String(item?.id || '').trim().slice(0, 120),
        rowNumber: Number.isInteger(item?.rowNumber) ? item.rowNumber : null,
        sourceValue: String(item?.sourceValue || '').trim().slice(0, 240),
        sourceCode: item?.sourceCode == null ? null : String(item.sourceCode).trim().slice(0, 240),
        canonicalName: String(item?.canonicalName || '').trim().slice(0, 240),
        abbreviation: item?.abbreviation == null ? null : String(item.abbreviation).trim().slice(0, 120),
        aliases: [...new Set((item?.aliases || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 100),
        raw: item?.raw && typeof item.raw === 'object' ? item.raw : null,
      })).filter(item => item.sourceValue) : [];
      return {
        id: String(dictionary?.id || '').trim().slice(0, 100),
        version: String(dictionary?.version || '1.0.0').trim().slice(0, 40),
        name: String(dictionary?.name || dictionary?.id || '').trim().slice(0, 160),
        field: String(dictionary?.field || '').trim().slice(0, 200),
        concept: String(dictionary?.concept || '').trim().slice(0, 100),
        matchMode: ['exact', 'containsAny', 'containsAll'].includes(dictionary?.matchMode) ? dictionary.matchMode : 'exact',
        multiValue: Boolean(dictionary?.multiValue),
        source: String(dictionary?.source || '').trim().slice(0, 300),
        columns: [...new Set((dictionary?.columns || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 20),
        items,
      };
    }).filter(dictionary => dictionary.id && dictionary.field && dictionary.items.length) : [],
    triggers: [...new Set((input.triggers || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 100),
    temporalSemantics: Array.isArray(input.temporalSemantics) ? input.temporalSemantics.slice(0, 40).map(item => ({ id: String(item?.id || '').trim().slice(0, 80), meaning: String(item?.meaning || '').trim().slice(0, 240), grain: ['day','week','month','quarter','year'].includes(item?.grain) ? item.grain : null, expressions: [...new Set((item?.expressions || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 40), ambiguity: String(item?.ambiguity || '').trim().slice(0, 240) })).filter(item => item.id && item.grain) : [],
    relativeTemporalSemantics: Array.isArray(input.relativeTemporalSemantics) ? input.relativeTemporalSemantics.slice(0, 40).map(item => ({
      id: String(item?.id || '').trim().slice(0, 80),
      meaning: String(item?.meaning || '').trim().slice(0, 240),
      unit: ['year', 'quarter', 'month', 'week', 'day'].includes(item?.unit) ? item.unit : null,
      offset: Number.isInteger(item?.offset) && item.offset >= -20 && item.offset <= 20 ? item.offset : null,
      expressions: [...new Set((item?.expressions || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 40),
      ambiguity: String(item?.ambiguity || '').trim().slice(0, 240),
    })).filter(item => item.id && item.unit && item.offset != null && item.expressions.length) : [],
    valueMappings: Array.isArray(input.valueMappings) ? input.valueMappings.slice(0, 1000).map(item => ({
      field: String(item?.field || '').trim().slice(0, 200),
      concept: String(item?.concept || '').trim().slice(0, 100),
      canonicalValue: String(item?.canonicalValue || '').trim().slice(0, 240),
      synonyms: [...new Set((item?.synonyms || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 100),
      matchMode: ['exact', 'containsAny', 'containsAll'].includes(item?.matchMode) ? item.matchMode : 'exact',
      notes: String(item?.notes || '').trim().slice(0, 400),
    })).filter(item => item.field && item.canonicalValue) : [],
    metrics: Array.isArray(input.metrics) ? input.metrics.slice(0, 100).map(metric => {
      const id = String(metric?.id || metric?.name || metric?.field || '').trim().slice(0, 80);
      const formula = normalizedMetricFormula(metric?.formula, id);
      return {
        id,
        concept: String(metric?.concept || '').trim().slice(0, 80) || null,
        name: String(metric?.name || metric?.id || metric?.field || '').trim().slice(0, 120),
        field: String(metric?.field || '').trim().slice(0, 200),
        aggregation: String(metric?.aggregation || 'sum').trim(),
        definition: String(metric?.definition || '').trim().slice(0, 500),
        synonyms: [...new Set((metric?.synonyms || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 100),
        unitFamily: String(metric?.unitFamily || '').trim().slice(0, 40) || null,
        outputAlias: String(metric?.outputAlias || '').trim().slice(0, 80) || null,
        formula,
      };
    }).filter(metric => metric.id && (metric.field || metric.formula)) : [],
    businessEntities: Array.isArray(input.businessEntities) ? input.businessEntities.slice(0, 100).map(entity => ({
      id: String(entity?.id || entity?.name || entity?.field || '').trim().slice(0, 80),
      concept: String(entity?.concept || entity?.id || '').trim().slice(0, 80),
      name: String(entity?.name || entity?.id || '').trim().slice(0, 120),
      field: String(entity?.field || '').trim().slice(0, 200),
      synonyms: [...new Set((entity?.synonyms || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 100),
    })).filter(entity => entity.id && entity.field) : [],
    workflows: Array.isArray(input.workflows) ? input.workflows.slice(0, 50) : [],
    forbidden: [...new Set((input.forbidden || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 100),
    diagnostics: Array.isArray(input.diagnostics) ? input.diagnostics.slice(0, 50).map(item => ({
      id: String(item?.id || '').trim().slice(0, 80),
      name: String(item?.name || item?.id || '').trim().slice(0, 160),
      triggers: [...new Set((item?.triggers || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 30),
      requiredEvidence: [...new Set((item?.requiredEvidence || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 30),
      riskRules: Array.isArray(item?.riskRules) ? item.riskRules.slice(0, 30).map(rule => ({ id: String(rule?.id || '').trim().slice(0, 80), when: String(rule?.when || '').trim().slice(0, 300), severity: ['info', 'warning', 'critical'].includes(rule?.severity) ? rule.severity : 'warning', action: String(rule?.action || '').trim().slice(0, 300) })).filter(rule => rule.id && rule.when) : [],
      playbook: Array.isArray(item?.playbook) ? item.playbook.slice(0, 20).map(step => String(step).trim().slice(0, 400)).filter(Boolean) : [],
    })).filter(item => item.id) : [],
    assumptions: [...new Set((input.assumptions || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 100),
    evaluationRefs: [...new Set((input.evaluationRefs || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 100),
    status: ['draft', 'approved', 'retired'].includes(input.status) ? input.status : 'draft',
  };
}

export class SkillRegistry {
  constructor(skills = []) {
    this.skills = new Map();
    skills.forEach(skill => this.register(skill));
  }

  register(skill) {
    const normalized = normalizedSkill(skill);
    this.skills.set(`${normalized.id}@${normalized.version}`, normalized);
    return normalized;
  }

  list() {
    return [...this.skills.values()];
  }

  get(id, version = null) {
    const normalizedId = String(id || '').trim();
    if (version != null) return this.skills.get(`${normalizedId}@${String(version).trim()}`) || null;
    return this.list().filter(skill => skill.id === normalizedId).sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))[0] || null;
  }

  versions(id) {
    return this.list().filter(skill => skill.id === String(id || '').trim()).sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
  }

  resolve({ datasetId, organizationId = null, userId = null, question = '' } = {}) {
    const text = String(question).toLowerCase();
    return this.list()
      .filter(skill => skill.status === 'approved')
      .filter(skill => skill.scope === 'system'
        || (skill.scope === 'dataset' && skill.datasetIds.includes(datasetId))
        || (skill.scope === 'organization' && skill.organizationIds.includes(organizationId))
        || (skill.scope === 'user' && skill.userIds.includes(userId)))
      .map(skill => ({ skill, triggerScore: skill.triggers.filter(trigger => text.includes(trigger.toLowerCase())).length }))
      .filter(item => item.triggerScore > 0 || item.skill.scope === 'system')
      .sort((a, b) => (SCOPE_RANK[b.skill.scope] - SCOPE_RANK[a.skill.scope]) || (b.triggerScore - a.triggerScore) || a.skill.id.localeCompare(b.skill.id))
      .map(item => item.skill);
  }

  detectConflicts(skills = []) {
    const conflicts = [];
    for (let index = 0; index < skills.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < skills.length; otherIndex += 1) {
        const left = skills[index];
        const right = skills[otherIndex];
        const definition = item => item.formula ? JSON.stringify(item.formula) : item.definition || item.field;
        const leftMetrics = new Map((left.metrics || []).map(item => [item.name || item.id, definition(item)]));
        for (const metric of right.metrics || []) {
          const key = metric.name || metric.id;
          if (leftMetrics.has(key) && leftMetrics.get(key) !== definition(metric)) {
            conflicts.push({ metric: key, left: left.id, right: right.id, reason: '同名指标定义冲突' });
          }
        }
      }
    }
    return conflicts;
  }

  resolveForQuestion({ datasetId, organizationId = null, userId = null, question = '' } = {}) {
    const skills = this.resolve({ datasetId, organizationId, userId, question });
    return {
      skills,
      conflicts: this.detectConflicts(skills),
      refs: skills.map(skill => `${skill.id}@${skill.version}`),
    };
  }
}

export { normalizedSkill };

export async function loadSkillsFromDirectory(directory) {
  const registry = new SkillRegistry();
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.toLowerCase() === 'skill.json') {
        const source = JSON.parse(await readFile(path, 'utf8'));
        const dictionaries = [];
        for (const file of source.dictionaryFiles || []) {
          const dictionaryPath = join(current, String(file));
          const markdown = await readFile(dictionaryPath, 'utf8');
          dictionaries.push(...parseMarkdownDictionaries(markdown, String(file)));
        }
        const generatedMappings = mappingsFromDictionaries(dictionaries);
        const explicitMappings = Array.isArray(source.valueMappings) ? source.valueMappings : [];
        const generatedByKey = new Map(generatedMappings.map(item => [`${item.field}|${item.canonicalValue}`, item]));
        const valueMappings = explicitMappings.map(item => {
          const generated = generatedByKey.get(`${item.field}|${item.canonicalValue}`);
          if (!generated) return item;
          return {
            ...generated,
            ...item,
            synonyms: [...new Set([...(generated.synonyms || []), ...(item.synonyms || [])])],
            notes: [generated.notes, item.notes].filter(Boolean).join(' '),
          };
        });
        const explicitKeys = new Set(explicitMappings.map(item => `${item.field}|${item.canonicalValue}`));
        valueMappings.push(...generatedMappings.filter(item => !explicitKeys.has(`${item.field}|${item.canonicalValue}`)));
        registry.register({ ...source, dictionaries, valueMappings });
      }
    }
  }
  await visit(directory);
  return registry;
}
