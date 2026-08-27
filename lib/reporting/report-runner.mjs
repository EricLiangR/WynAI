import { randomUUID } from 'node:crypto';
import { composeDocxTemplate } from '../template/docx-composer.mjs';
import { evaluateFormula } from './formula-engine.mjs';
import { createContentSession, continueContentSession, selectedContent } from './content-session.mjs';

function now() { return new Date().toISOString(); }
function runId() { return `report-${randomUUID()}`; }

function formatValue(value, format = {}) {
  if (value == null || value === '') return format.nullDisplay || '—';
  if (typeof value !== 'number') return String(value);
  const precision = Math.max(0, Math.min(8, Number.isFinite(Number(format.precision)) ? Number(format.precision) : 2));
  const numeric = format.scale ? value / Number(format.scale) : value;
  const suffix = format.unit ? ` ${format.unit}` : format.format === 'percent' ? '%' : '';
  return `${numeric.toLocaleString('zh-CN', { minimumFractionDigits: precision, maximumFractionDigits: precision })}${suffix}`;
}

function extractResult(resultSet, extraction = {}, bindingType = 'scalar') {
  extraction = extraction || {};
  const rows = resultSet?.rows || [];
  if (bindingType.includes('table') || bindingType === 'chart') return rows;
  const row = rows[Math.max(0, Number(extraction.row) || 0)] || {};
  const measureColumns = (resultSet?.schema || []).filter(item => item.role === 'measure');
  const field = extraction.field || measureColumns[0]?.name || Object.keys(row).find(key => typeof row[key] === 'number') || Object.keys(row)[0];
  return row[field];
}

function renderText(template, values) {
  return String(template || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => values[key.trim()]?.displayValue ?? values[key.trim()]?.value ?? '');
}

function tableRows(value, binding) {
  const rows = Array.isArray(value) ? value : [];
  const columns = binding.extraction?.columns || (rows[0] ? Object.keys(rows[0]) : []);
  if (binding.type === 'matrix-table') {
    const [rowField, columnField, valueField] = columns;
    const columnValues = [...new Set(rows.map(row => row[columnField]))];
    const rowValues = [...new Set(rows.map(row => row[rowField]))];
    return [[binding.format?.rowHeader || rowField, ...columnValues], ...rowValues.map(rowValue => [rowValue, ...columnValues.map(columnValue => formatValue(rows.find(row => row[rowField] === rowValue && row[columnField] === columnValue)?.[valueField], binding.format || {}))])];
  }
  return rows.map((row, index) => columns.map(column => column === '$index' ? index + 1 : formatValue(row[column], binding.format?.columns?.[column] || binding.format || {})));
}

function svgEscape(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

function chartSvg(rows, binding) {
  const data = Array.isArray(rows) ? rows.slice(0, Math.max(1, Math.min(20, Number(binding.format?.maximumItems) || 10))) : [];
  const columns = binding.extraction?.columns || (data[0] ? Object.keys(data[0]) : []);
  const category = binding.extraction?.categoryField || columns[0];
  const valueField = binding.extraction?.valueField || columns.find(name => data.some(row => Number.isFinite(Number(row[name])))) || columns[1];
  const width = 720; const height = 360; const left = 72; const bottom = 50; const top = 34; const available = height - top - bottom;
  const maximum = Math.max(1, ...data.map(row => Math.abs(Number(row[valueField]) || 0)));
  const barWidth = Math.max(12, Math.min(52, (width - left - 28) / Math.max(data.length, 1) * 0.65));
  const step = (width - left - 28) / Math.max(data.length, 1);
  const bars = data.map((row, index) => { const value = Number(row[valueField]) || 0; const h = Math.abs(value) / maximum * available; const x = left + index * step + (step - barWidth) / 2; const y = top + available - h; const label = String(row[category] ?? index + 1).slice(0, 10); return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="#4968ad"/><text x="${x + barWidth / 2}" y="${height - 24}" text-anchor="middle" font-size="11" fill="#44505e">${svgEscape(label)}</text><text x="${x + barWidth / 2}" y="${Math.max(14, y - 5)}" text-anchor="middle" font-size="10" fill="#273443">${svgEscape(formatValue(value, { precision: binding.format?.precision ?? 0 }))}</text>`; }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/><text x="${left}" y="20" font-size="15" font-family="Arial, sans-serif" font-weight="700" fill="#1d2a38">${svgEscape(binding.name || '数据图表')}</text><line x1="${left}" y1="${top + available}" x2="${width - 20}" y2="${top + available}" stroke="#bfc8d2"/>${bars}</svg>`;
}

export class ReportRunRepository {
  constructor({ templates, queryService, persistence = null } = {}) {
    this.templates = templates;
    this.queryService = queryService;
    this.persistence = persistence;
    this.items = new Map();
  }

  async init() {
    if (!this.persistence) return this;
    for (const item of await this.persistence.init()) if (item?.schema === 'wynai.report-run/v1') this.items.set(item.id, item);
    return this;
  }

  async save(item) {
    item.updatedAt = now();
    this.items.set(item.id, item);
    if (this.persistence) await this.persistence.save(item);
    return item;
  }

  list() {
    return [...this.items.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(({ generatedDocxBase64, ...item }) => item);
  }

  get(id, { includeBinary = false } = {}) {
    const item = this.items.get(String(id));
    if (!item) return null;
    if (includeBinary) return item;
    const { generatedDocxBase64, ...safe } = item;
    return safe;
  }

  async create({ templateId, parameters = {}, bindingOverrides = {} } = {}) {
    const template = this.templates.get(templateId, { includeSource: true });
    if (!template) throw Object.assign(new Error('报告模板不存在'), { status: 404 });
    const bindings = template.bindings.filter(binding => ['confirmed', 'tested', 'published'].includes(binding.status));
    if (!bindings.length) throw Object.assign(new Error('模板没有已确认的动态绑定'), { status: 409 });
    const at = now();
    const run = {
      schema: 'wynai.report-run/v1', id: runId(), templateId, templateVersion: template.version,
      status: 'data-running', parameters, bindingOverrides, bindingResults: {}, evidence: [], contentSessions: {}, audit: [{ event: 'run.created', at, details: { templateId, templateVersion: template.version } }],
      createdAt: at, updatedAt: at,
    };
    await this.save(run);
    try {
      for (const binding of bindings) {
        if (binding.type === 'parameter') {
          const value = parameters[binding.placeholderKey || binding.id] ?? parameters[binding.name];
          run.bindingResults[binding.id] = { value, displayValue: formatValue(value, binding.format), source: 'parameter' };
          continue;
        }
        if (binding.queryRequests?.length) {
          const queryResult = await this.queryService.execute({ requests: binding.queryRequests, budget: { maxRequests: 12, maxRows: 20000 } });
          const resultSet = queryResult.resultSets[Math.max(0, Number(binding.extraction?.resultSetIndex) || 0)];
          const value = extractResult(resultSet, binding.extraction, binding.type);
          const evidenceId = `ev-${binding.id}`;
          run.bindingResults[binding.id] = { value, displayValue: Array.isArray(value) ? `${value.length} 行` : formatValue(value, binding.format), resultSetId: resultSet?.id, evidenceIds: [evidenceId], source: 'system-calculated' };
          run.evidence.push({ id: evidenceId, bindingId: binding.id, label: binding.name, value: Array.isArray(value) ? null : value, displayValue: Array.isArray(value) ? `${value.length} 行` : formatValue(value, binding.format), resultSetId: resultSet?.id, datasetIds: queryResult.datasets, quality: resultSet?.quality || null, provenance: resultSet?.provenance || null });
        }
      }
      for (const binding of bindings.filter(item => item.formula)) {
        const inputs = Object.fromEntries(Object.entries(binding.formula.inputBindings || {}).map(([name, dependency]) => [name, run.bindingResults[dependency]?.value]));
        const evaluated = evaluateFormula(binding.formula, inputs);
        const evidenceIds = Object.values(binding.formula.inputBindings || {}).flatMap(dependency => run.bindingResults[dependency]?.evidenceIds || []);
        run.bindingResults[binding.id] = { ...evaluated, evidenceIds, source: 'system-calculated' };
      }
      for (const binding of bindings.filter(item => item.type === 'ai-narrative')) {
        const linked = (binding.extraction?.evidenceBindings || []).flatMap(id => run.evidence.filter(item => item.bindingId === id));
        const evidence = linked.length ? linked : run.evidence;
        const session = createContentSession({ blockId: binding.blockId, title: binding.name, evidence, prompt: binding.businessIntent?.businessQuestion });
        run.contentSessions[binding.blockId] = session;
        run.bindingResults[binding.id] = { value: selectedContent(session), displayValue: selectedContent(session), evidenceIds: evidence.map(item => item.id), source: 'ai-generated' };
      }
      run.status = Object.keys(run.contentSessions).length ? 'content-review' : 'ready';
      run.audit.push({ event: 'run.data-completed', at: now(), details: { bindingCount: bindings.length, evidenceCount: run.evidence.length } });
      this.compose(run, template);
      return await this.save(run);
    } catch (error) {
      run.status = 'failed'; run.error = error.message; run.audit.push({ event: 'run.failed', at: now(), details: { message: error.message } }); await this.save(run); throw error;
    }
  }

  compose(run, template = null) {
    const sourceTemplate = template || this.templates.get(run.templateId, { includeSource: true });
    const values = {};
    const blockReplacements = [];
    const byBlock = new Map();
    for (const binding of sourceTemplate.bindings.filter(item => ['confirmed', 'tested', 'published'].includes(item.status))) {
      const result = run.bindingResults[binding.id];
      if (!result) continue;
      values[binding.placeholderKey || binding.id] = result.displayValue ?? result.value;
      if (!byBlock.has(binding.blockId)) byBlock.set(binding.blockId, []);
      byBlock.get(binding.blockId).push({ binding, result });
    }
    for (const [blockId, items] of byBlock) {
      const sourceBlock = sourceTemplate.blocks.find(item => item.id === blockId);
      const tableBinding = items.find(item => item.binding.type.includes('table'));
      const chartBinding = items.find(item => item.binding.type === 'chart');
      if (tableBinding) blockReplacements.push({ blockId, part: sourceBlock?.part, type: sourceBlock?.type, rows: tableRows(tableBinding.result.value, tableBinding.binding), keepHeader: tableBinding.binding.format?.keepHeader !== false });
      else if (chartBinding) blockReplacements.push({ blockId, part: sourceBlock?.part, type: sourceBlock?.type, svg: chartSvg(chartBinding.result.value, chartBinding.binding), name: chartBinding.binding.name });
      else {
        const primary = items[0];
        const localValues = Object.fromEntries(items.flatMap(item => [[item.binding.id, item.result], [item.binding.placeholderKey, item.result]].filter(([key]) => key)));
        blockReplacements.push({ blockId, part: sourceBlock?.part, type: sourceBlock?.type, text: primary.binding.renderTemplate ? renderText(primary.binding.renderTemplate, localValues) : primary.result.displayValue ?? primary.result.value ?? '' });
      }
    }
    const output = composeDocxTemplate(Buffer.from(sourceTemplate.sourceContentBase64, 'base64'), values, { blockReplacements });
    run.generatedDocxBase64 = output.toString('base64');
    run.output = { filename: `${sourceTemplate.name}-${run.id.slice(-8)}.docx`, byteLength: output.length, generatedAt: now() };
    return output;
  }

  async updateContent(id, blockId, input = {}) {
    const run = this.items.get(String(id));
    if (!run) throw Object.assign(new Error('报告运行不存在'), { status: 404 });
    const session = run.contentSessions[blockId];
    if (!session) throw Object.assign(new Error('AI 内容块不存在'), { status: 404 });
    const evidence = run.evidence.filter(item => session.drafts.at(-1)?.evidenceIds?.includes(item.id));
    continueContentSession(session, input, evidence);
    const template = this.templates.get(run.templateId, { includeSource: true });
    const binding = template.bindings.find(item => item.blockId === blockId && item.type === 'ai-narrative');
    if (binding) run.bindingResults[binding.id] = { value: selectedContent(session), displayValue: selectedContent(session), evidenceIds: evidence.map(item => item.id), source: session.status };
    run.status = input.confirm ? 'confirmed' : 'user-edited';
    run.audit.push({ event: input.confirm ? 'content.confirmed' : 'content.updated', at: now(), details: { blockId, selectedVersion: session.selectedVersion } });
    this.compose(run, template);
    await this.save(run);
    return session;
  }

  export(id, format = 'docx') {
    const run = this.items.get(String(id));
    if (!run) throw Object.assign(new Error('报告运行不存在'), { status: 404 });
    if (format === 'docx') return { body: Buffer.from(run.generatedDocxBase64, 'base64'), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: run.output.filename };
    if (format === 'json') {
      const { generatedDocxBase64, ...audit } = run;
      return { body: Buffer.from(`${JSON.stringify(audit, null, 2)}\n`), contentType: 'application/json; charset=utf-8', filename: `${run.id}-audit.json` };
    }
    throw Object.assign(new Error('只支持 docx 或 json 导出'), { status: 400 });
  }
}

export { extractResult, formatValue, renderText };
