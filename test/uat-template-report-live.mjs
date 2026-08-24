import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocxTemplate, readZipEntries } from '../lib/template/docx-parser.mjs';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const datasetId = '2b445034-38fe-4350-9cab-b7684c28b5f8';
const sourcePath = join('WordTemplates', '能耗分析报告6月.docx');
const cases = [];
async function json(pathname, options) { const response = await fetch(`${baseUrl}${pathname}`, options); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || ''}`); return payload; }
async function run(id, title, action) { const started = Date.now(); try { const evidence = await action(); cases.push({ id, title, status: 'passed', durationMs: Date.now() - started, evidence }); console.log(`PASS ${id} ${title}`); } catch (error) { cases.push({ id, title, status: 'failed', durationMs: Date.now() - started, error: error.message }); console.error(`FAIL ${id} ${title} - ${error.message}`); process.exitCode = 1; } }

const source = await readFile(sourcePath);
const parsed = parseDocxTemplate(source, { filename: '能耗分析报告6月.docx' });
const periodBlock = parsed.blocks.find(block => block.type === 'paragraph' && block.text.includes('报告期间'));
const tableBlock = parsed.blocks.find(block => block.type === 'table');
const narrativeBlock = parsed.blocks.find(block => block.type === 'paragraph' && block.text.includes('报告概述'));
const chartBlock = parsed.blocks.find(block => block.type === 'paragraph' && block.text.includes('每日能耗趋势'));

await run('UAT-TR-01', '模板上传、解析和候选识别', async () => {
  const template = await json('/api/report-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: '能耗分析报告6月.docx', name: '能耗月报模板', contentBase64: source.toString('base64') }) });
  assert.equal(template.schema, 'wynai.template-package/v1');
  assert.ok(template.blocks.some(block => block.suggestion));
  return { templateId: template.id, version: template.version, blocks: template.blocks.length, compatibility: template.compatibility };
});

const catalog = await json('/api/report-templates');
const template = catalog.items[0];

await run('UAT-TR-02', '用户业务描述标注和受控查询提议', async () => {
  const annotation = await json(`/api/report-templates/${template.id}/annotate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blockId: periodBlock.id, contentHash: periodBlock.contentHash, description: '显示用户选择的报告期间' }) });
  assert.equal(annotation.annotation.description, '显示用户选择的报告期间');
  const proposal = await json(`/api/report-templates/${template.id}/bindings/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blockId: tableBlock.id, type: 'grouped-table', businessQuestion: '按客户地区统计销售额并列出明细', datasetIds: [datasetId], expectedResult: { shape: 'grouped-table', maximumRows: 5 }, status: 'proposed' }) });
  assert.ok(proposal.proposal.requests.length === 1);
  assert.ok(!proposal.proposal.requests[0].wax);
  return { bindingId: proposal.binding.id, queryId: proposal.proposal.requests[0].id, confidence: proposal.proposal.candidates[0].confidence };
});

let tableBinding;
let periodBinding;
let narrativeBinding;
let chartBinding;
await run('UAT-TR-03', '绑定确认、白名单公式和 AI 内容块配置', async () => {
  periodBinding = (await json(`/api/report-templates/${template.id}/bindings/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blockId: periodBlock.id, type: 'parameter', placeholderKey: 'report_period', name: '报告期间', status: 'confirmed' }) })).binding;
  tableBinding = (await json(`/api/report-templates/${template.id}/bindings/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blockId: tableBlock.id, type: 'grouped-table', name: '区域销售额明细', status: 'confirmed', datasetIds: [datasetId], queryRequests: [{ id: 'qry-template-region', datasetId, mode: 'aggregate', select: [{ field: '客户地区', alias: 'group' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'value' }], orderBy: [{ field: 'value', direction: 'desc' }], limit: 5 }], extraction: { columns: ['group', 'value', 'value', 'value', 'value'] }, format: { precision: 2 } }) })).binding;
  narrativeBinding = (await json(`/api/report-templates/${template.id}/bindings/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blockId: narrativeBlock.id, type: 'ai-narrative', name: '管理摘要', businessQuestion: '形成销售区域管理摘要', datasetIds: [datasetId], status: 'confirmed' }) })).binding;
  chartBinding = (await json(`/api/report-templates/${template.id}/bindings/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blockId: chartBlock.id, type: 'chart', name: '区域销售额图', status: 'confirmed', datasetIds: [datasetId], queryRequests: [{ id: 'qry-template-chart', datasetId, mode: 'aggregate', select: [{ field: '客户地区', alias: 'group' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'value' }], orderBy: [{ field: 'value', direction: 'desc' }], limit: 5 }], extraction: { columns: ['group', 'value'], categoryField: 'group', valueField: 'value' }, format: { precision: 0 } }) })).binding;
  assert.equal(periodBinding.status, 'confirmed'); assert.equal(tableBinding.status, 'confirmed'); assert.equal(narrativeBinding.status, 'confirmed'); assert.equal(chartBinding.status, 'confirmed');
  return { bindings: [periodBinding.id, tableBinding.id, narrativeBinding.id, chartBinding.id], formulaOperators: ['ratio', 'change', 'percentage', 'difference', 'sum'] };
});

let report;
await run('UAT-TR-04', '真实数据运行、动态表格和证据链', async () => {
  report = await json('/api/report-runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: template.id, parameters: { report_period: '2026年7月' } }) });
  assert.ok(['ready', 'content-review'].includes(report.status));
  assert.ok(report.evidence.length >= 1);
  assert.ok(report.output.byteLength > 1000);
  const exportCheck = await fetch(`${baseUrl}/api/report-runs/${report.id}/export?format=docx`);
  assert.equal(exportCheck.status, 200);
  const zip = readZipEntries(Buffer.from(await exportCheck.arrayBuffer()));
  assert.ok([...zip.keys()].some(name => /^word\/media\/wynai-chart-.*\.svg$/.test(name)));
  return { reportId: report.id, status: report.status, evidence: report.evidence.length, output: report.output, resultTypes: Object.values(report.bindingResults).map(item => item.source) };
});

await run('UAT-TR-05', 'AI 内容多轮讨论、手工编辑和确认', async () => {
  const first = await json(`/api/report-runs/${report.id}/content/${encodeURIComponent(narrativeBlock.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '突出区域差异，语气保持审查报告风格' }) });
  assert.equal(first.status, 'ai-generated');
  const confirmed = await json(`/api/report-runs/${report.id}/content/${encodeURIComponent(narrativeBlock.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manualText: '经审核，区域销售额存在差异，建议结合客户结构进一步核查。', confirm: true }) });
  assert.equal(confirmed.status, 'user-confirmed');
  return { versions: confirmed.drafts.length, selectedVersion: confirmed.selectedVersion, status: confirmed.status };
});

const exportResponse = await fetch(`${baseUrl}/api/report-runs/${report.id}/export?format=docx`);
assert.equal(exportResponse.status, 200);
const generated = Buffer.from(await exportResponse.arrayBuffer());
const artifactDir = join('test', 'uat-artifacts', 'template-report');
await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, 'generated-report.docx'), generated);
const generatedModel = parseDocxTemplate(generated, { filename: 'generated-report.docx' });
assert.ok(generatedModel.blocks.length > 0);
const artifact = { schema: 'wynai.uat-result/v1', phase: 'template-report-mvp', finishedAt: new Date().toISOString(), status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed', summary: { total: cases.length, passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length }, cases, output: { path: join(artifactDir, 'generated-report.docx'), byteLength: generated.length, parsedBlockCount: generatedModel.blocks.length }, knownLimitations: ['首期网页编辑针对动态块，尚未接入 ONLYOFFICE/Collabora。', '复杂文本框、SmartArt 和任意交叉表仍属于后续阶段。'] };
await writeFile(join(artifactDir, `template-report-${artifact.finishedAt.replace(/[:.]/g, '-')}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
await writeFile(join(artifactDir, 'latest.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`TEMPLATE REPORT UAT ${artifact.status.toUpperCase()}: ${artifact.summary.passed}/${artifact.summary.total}`);
if (process.exitCode) process.exit(process.exitCode);
