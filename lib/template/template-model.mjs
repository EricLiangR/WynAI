import { randomUUID } from 'node:crypto';
import { parseDocxTemplate } from './docx-parser.mjs';
import { normalizeBusinessQueryIntent } from '../protocol/interaction-contract.mjs';

const BLOCK_TYPES = new Set(['fixed-text', 'parameter', 'inline-text', 'scalar', 'repeat-table', 'grouped-table', 'matrix-table', 'chart', 'ai-narrative', 'manual-content']);
const BINDING_STATUSES = new Set(['discovered', 'proposed', 'needs-confirmation', 'confirmed', 'tested', 'published']);

function templateId() { return `tpl-${randomUUID()}`; }
function bindingId() { return `bind-${randomUUID()}`; }
function now() { return new Date().toISOString(); }

function suggestBlock(block) {
  const text = String(block.text || '');
  let type = 'fixed-text';
  let confidence = 0.35;
  let reason = '未发现明确动态语义，默认保留为固定内容';
  if (block.placeholders?.length) {
    type = block.type === 'table' ? 'repeat-table' : 'inline-text'; confidence = 0.99; reason = '包含显式模板占位符';
  } else if (block.type === 'table' && /(明细|序号|合计|占比|同比|环比|金额|能耗|数量|利润|完成率)/.test(text)) {
    type = 'grouped-table'; confidence = 0.82; reason = '表头包含统计或明细语义';
  } else if (/(管理摘要|关键发现|风险|行动建议|结论|数据洞察)/.test(text)) {
    type = 'ai-narrative'; confidence = 0.8; reason = '段落标题符合 AI 内容章节语义';
  } else if (/\d{4}\s*年|报告期间|编制日期|统计期间/.test(text)) {
    type = 'parameter'; confidence = 0.76; reason = '包含报告期间或日期参数';
  } else if (/[-+]?\d[\d,.]*\s*(?:%|元|万元|kWh|吨|件|次|小时|天)/i.test(text)) {
    type = 'inline-text'; confidence = 0.7; reason = '固定文本中包含可能需要更新的业务数值';
  }
  return { type, confidence, reason, requiresUserConfirmation: type !== 'fixed-text' };
}

function normalizeBinding(input, template) {
  const block = template.blocks.find(item => item.id === input.blockId);
  if (!block) throw Object.assign(new Error(`模板 Block 不存在：${input.blockId}`), { status: 404 });
  const type = BLOCK_TYPES.has(input.type) ? input.type : block.suggestion?.type || 'inline-text';
  const intent = input.businessIntent || input.businessQuestion ? normalizeBusinessQueryIntent({
    ...(input.businessIntent || {}),
    businessQuestion: input.businessIntent?.businessQuestion || input.businessQuestion,
    datasetIds: input.businessIntent?.datasetIds || input.datasetIds || [],
    expectedResult: input.businessIntent?.expectedResult || { shape: type.includes('table') ? 'grouped-table' : type === 'chart' ? 'chart' : type === 'ai-narrative' ? 'ai-narrative' : 'scalar' },
    presentation: input.businessIntent?.presentation || { targetBlockType: type },
  }) : null;
  return {
    schema: 'wynai.template-binding/v1',
    id: input.id || bindingId(),
    blockId: block.id,
    blockHash: block.contentHash,
    type,
    name: String(input.name || intent?.businessQuestion || block.anchorText || block.id).trim().slice(0, 200),
    placeholderKey: input.placeholderKey ? String(input.placeholderKey).trim().slice(0, 100) : null,
    businessIntent: intent,
    queryRequests: Array.isArray(input.queryRequests) ? input.queryRequests.slice(0, 12) : [],
    extraction: input.extraction || null,
    formula: input.formula || null,
    format: input.format || intent?.presentation || { format: 'general', precision: 2 },
    renderTemplate: input.renderTemplate ? String(input.renderTemplate).slice(0, 10000) : null,
    status: BINDING_STATUSES.has(input.status) ? input.status : 'needs-confirmation',
    confirmedAt: input.status === 'confirmed' ? now() : input.confirmedAt || null,
    updatedAt: now(),
  };
}

export class TemplatePackageRepository {
  constructor({ persistence = null, maxItems = 100 } = {}) {
    this.persistence = persistence;
    this.maxItems = maxItems;
    this.items = new Map();
  }

  async init() {
    if (!this.persistence) return this;
    for (const item of await this.persistence.init()) if (item?.schema === 'wynai.template-package/v1') this.items.set(item.id, item);
    return this;
  }

  async save(item) {
    item.updatedAt = now();
    this.items.set(item.id, item);
    if (this.persistence) await this.persistence.save(item);
    return item;
  }

  list() {
    return [...this.items.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(({ sourceContentBase64, ...item }) => item);
  }

  get(id, { includeSource = false } = {}) {
    const item = this.items.get(String(id));
    if (!item) return null;
    if (includeSource) return item;
    const { sourceContentBase64, ...safe } = item;
    return safe;
  }

  async create(buffer, { filename = 'template.docx', name = '' } = {}) {
    const parsed = parseDocxTemplate(buffer, { filename });
    const createdAt = now();
    const item = {
      schema: 'wynai.template-package/v1',
      id: templateId(),
      version: 1,
      name: String(name || filename.replace(/\.docx$/i, '')).trim().slice(0, 200),
      source: { ...parsed.template, uploadedAt: createdAt },
      sourceContentBase64: buffer.toString('base64'),
      parts: parsed.parts,
      blocks: parsed.blocks.map(block => ({ ...block, suggestion: suggestBlock(block), annotations: [] })),
      bindings: [],
      compatibility: parsed.compatibility,
      audit: [{ event: 'template.created', at: createdAt, details: { filename, blockCount: parsed.blocks.length } }],
      createdAt,
      updatedAt: createdAt,
    };
    return this.save(item);
  }

  async annotate(id, input = {}) {
    const item = this.items.get(String(id));
    if (!item) throw Object.assign(new Error('报告模板不存在'), { status: 404 });
    const block = item.blocks.find(value => value.id === input.blockId);
    if (!block) throw Object.assign(new Error('模板 Block 不存在'), { status: 404 });
    if (input.contentHash && input.contentHash !== block.contentHash) throw Object.assign(new Error('模板内容已变化，请重新选择目标位置'), { status: 409 });
    const annotation = { id: `ann-${randomUUID()}`, description: String(input.description || '').trim().slice(0, 4000), selectedText: String(input.selectedText || block.text || '').slice(0, 4000), createdAt: now() };
    if (!annotation.description) throw Object.assign(new Error('业务描述不能为空'), { status: 400 });
    block.annotations.push(annotation);
    item.audit.push({ event: 'block.annotated', at: annotation.createdAt, details: { blockId: block.id, annotationId: annotation.id } });
    await this.save(item);
    return annotation;
  }

  async putBinding(id, input = {}) {
    const item = this.items.get(String(id));
    if (!item) throw Object.assign(new Error('报告模板不存在'), { status: 404 });
    const normalized = normalizeBinding(input, item);
    const index = item.bindings.findIndex(value => value.id === normalized.id);
    if (index >= 0) item.bindings[index] = normalized; else item.bindings.push(normalized);
    item.version += 1;
    item.audit.push({ event: normalized.status === 'confirmed' ? 'binding.confirmed' : 'binding.saved', at: now(), details: { bindingId: normalized.id, blockId: normalized.blockId } });
    await this.save(item);
    return normalized;
  }
}

export { normalizeBinding, suggestBlock };
