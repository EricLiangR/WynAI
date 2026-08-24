import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocxTemplate, readZipEntries } from '../lib/template/docx-parser.mjs';
import { TemplatePackageRepository } from '../lib/template/template-model.mjs';
import { proposeCanonicalQueries, proposeFormula } from '../lib/reporting/binding-resolver.mjs';
import { evaluateFormula } from '../lib/reporting/formula-engine.mjs';
import { ReportRunRepository } from '../lib/reporting/report-runner.mjs';

const metadata = {
  id: 'dataset-sales-v1', revision: '7', name: '销售', fields: [
    { name: '销售日期', role: 'time', type: 'Date' },
    { name: '区域', role: 'dimension', type: 'String' },
    { name: '销售额', role: 'measure', type: 'Number' },
  ],
};

test('业务描述可转换为受控 Canonical 查询并识别公式', () => {
  const proposal = proposeCanonicalQueries({ metadataItems: [metadata], intent: { businessQuestion: '按区域统计本月销售额趋势', expectedResult: { shape: 'grouped-table', maximumRows: 20 }, datasets: [{ id: metadata.id }], context: { filters: [] } } });
  assert.equal(proposal.requests.length, 1);
  assert.equal(proposal.requests[0].mode, 'aggregate');
  assert.ok(!('wax' in proposal.requests[0]));
  assert.equal(proposeFormula('计算销售额环比增长率').operator, 'change');
});

test('白名单公式拒绝任意执行并处理除零', () => {
  assert.equal(evaluateFormula({ schema: 'wynai.formula/v1', operator: 'ratio', inputs: ['a', 'b'], scale: 100, precision: 2 }, { a: 25, b: 50 }).value, 50);
  assert.equal(evaluateFormula({ schema: 'wynai.formula/v1', operator: 'ratio', inputs: ['a', 'b'] }, { a: 1, b: 0 }).value, null);
  assert.throws(() => evaluateFormula({ operator: 'evil', inputs: [] }, {}), /白名单/);
});

test('TemplatePackage 保存用户标注和确认绑定', async () => {
  const source = await readFile(new URL('../WordTemplates/能耗分析报告6月.docx', import.meta.url));
  const repository = new TemplatePackageRepository();
  const template = await repository.create(source, { filename: 'energy.docx' });
  const block = template.blocks.find(item => item.type === 'paragraph');
  await repository.annotate(template.id, { blockId: block.id, contentHash: block.contentHash, description: '显示报告期间' });
  const binding = await repository.putBinding(template.id, { blockId: block.id, type: 'parameter', placeholderKey: 'report_period', status: 'confirmed', name: '报告期间' });
  assert.equal(binding.status, 'confirmed');
  assert.equal(repository.get(template.id).bindings.length, 1);
});

test('ReportRun 执行查询、回填 Block 并保留证据', async () => {
  const source = await readFile(new URL('../WordTemplates/能耗分析报告6月.docx', import.meta.url));
  const repository = new TemplatePackageRepository();
  const template = await repository.create(source, { filename: 'energy.docx' });
  const block = template.blocks.find(item => item.type === 'paragraph');
  await repository.putBinding(template.id, { blockId: block.id, type: 'scalar', status: 'confirmed', name: '总能耗', queryRequests: [{ id: 'qry-energy', datasetId: metadata.id, mode: 'aggregate', measures: [{ field: '销售额', aggregation: 'sum', alias: 'value' }], limit: 1 }], extraction: { field: 'value' }, format: { precision: 2, unit: 'kWh' } });
  const queryService = { async execute() { return { datasets: [metadata.id], resultSets: [{ id: 'rs-1', rows: [{ value: 1234.5 }], schema: [{ name: 'value', role: 'measure' }], quality: { isSample: false }, provenance: { adapter: 'test' } }] }; } };
  const runs = new ReportRunRepository({ templates: repository, queryService });
  const run = await runs.create({ templateId: template.id, parameters: {} });
  assert.equal(run.status, 'ready');
  assert.equal(run.evidence.length, 1);
  assert.match(run.output.filename, /\.docx$/);
  assert.ok(Buffer.from(run.generatedDocxBase64, 'base64').length > 1000);
});

test('ReportRun 可生成动态交叉表和 SVG 图表关系', async () => {
  const source = await readFile(new URL('../WordTemplates/能耗分析报告6月.docx', import.meta.url));
  const repository = new TemplatePackageRepository();
  const template = await repository.create(source, { filename: 'advanced.docx' });
  const table = template.blocks.find(item => item.type === 'table');
  const paragraph = template.blocks.find(item => item.type === 'paragraph');
  const query = { id: 'qry-matrix', datasetId: metadata.id, mode: 'aggregate', select: [{ field: '区域', alias: 'region' }, { field: '销售日期', alias: 'period', grain: 'month' }], measures: [{ field: '销售额', aggregation: 'sum', alias: 'value' }], limit: 20 };
  await repository.putBinding(template.id, { blockId: table.id, type: 'matrix-table', status: 'confirmed', name: '区域月份交叉表', queryRequests: [query], extraction: { columns: ['region', 'period', 'value'] }, format: { keepHeader: false, precision: 0 } });
  await repository.putBinding(template.id, { blockId: paragraph.id, type: 'chart', status: 'confirmed', name: '区域销售额图', queryRequests: [query], extraction: { columns: ['region', 'value'], categoryField: 'region', valueField: 'value' }, format: { precision: 0 } });
  const rows = [{ region: '华东', period: '2026-01', value: 100 }, { region: '华东', period: '2026-02', value: 120 }, { region: '华北', period: '2026-01', value: 80 }];
  const queryService = { async execute() { return { datasets: [metadata.id], resultSets: [{ id: 'rs-matrix', rows, schema: [{ name: 'region', role: 'dimension' }, { name: 'period', role: 'dimension' }, { name: 'value', role: 'measure' }], quality: {}, provenance: {} }] }; } };
  const run = await new ReportRunRepository({ templates: repository, queryService }).create({ templateId: template.id });
  const entries = readZipEntries(Buffer.from(run.generatedDocxBase64, 'base64'));
  assert.ok([...entries.keys()].some(name => /^word\/media\/wynai-chart-.*\.svg$/.test(name)));
  assert.match(entries.get('word/_rels/document.xml.rels').toString('utf8'), /relationships\/image/);
  const output = parseDocxTemplate(Buffer.from(run.generatedDocxBase64, 'base64'));
  assert.ok(output.blocks.find(item => item.id === table.id)?.rows.some(row => row.includes('2026-02')));
});
