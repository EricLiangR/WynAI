import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const sales = '2b445034-38fe-4350-9cab-b7684c28b5f8';
const retail = '8875ab24-8d24-4a9e-be39-01e44a5678a9';
const cases = [];
async function json(pathname, options) { const response = await fetch(`${baseUrl}${pathname}`, options); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || ''}`); return payload; }
async function run(id, title, action) { const started = Date.now(); try { const evidence = await action(); cases.push({ id, title, status: 'passed', durationMs: Date.now() - started, evidence }); console.log(`PASS ${id} ${title}`); } catch (error) { cases.push({ id, title, status: 'failed', durationMs: Date.now() - started, error: error.message }); console.error(`FAIL ${id} ${title} - ${error.message}`); process.exitCode = 1; } }

await run('UAT-P2-01', '多数据集 Canonical 查询独立执行', async () => {
  const payload = await json('/api/smart-query/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [
    { id: 'qry-sales-region', datasetId: sales, mode: 'aggregate', select: [{ field: '客户地区', alias: 'region' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'sales' }], orderBy: [{ field: 'sales', direction: 'desc' }], limit: 10 },
    { id: 'qry-retail-region', datasetId: retail, mode: 'aggregate', select: [{ field: '客户地区', alias: 'region' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'sales' }], orderBy: [{ field: 'sales', direction: 'desc' }], limit: 10 },
  ] }) });
  assert.equal(payload.schema, 'wynai.multi-dataset-query-result/v1');
  assert.equal(payload.resultSets.length, 2);
  assert.deepEqual(new Set(payload.datasets), new Set([sales, retail]));
  assert.ok(payload.resultSets.every(item => item.scope.datasetId));
  return { datasets: payload.datasets, rows: payload.resultSets.map(item => item.statistics.rowCount), audits: payload.audits };
});

await run('UAT-P2-02', '多数据集结果按声明维度受控合并', async () => {
  const payload = await json('/api/smart-query/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ merge: { mode: 'aligned-merge', keyFields: ['region'] }, requests: [
    { id: 'qry-sales-region-merge', datasetId: sales, mode: 'aggregate', select: [{ field: '客户地区', alias: 'region' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'sales' }], limit: 10 },
    { id: 'qry-retail-region-merge', datasetId: retail, mode: 'aggregate', select: [{ field: '客户地区', alias: 'region' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'sales' }], limit: 10 },
  ] }) });
  assert.ok(payload.merged);
  assert.ok(payload.merged.scope.datasetIds.length === 2);
  assert.match(payload.merged.quality.warnings.join(' '), /明细级 Join/);
  return { mergedResultSetId: payload.merged.id, rows: payload.merged.statistics.rowCount, warnings: payload.merged.quality.warnings };
});

await run('UAT-P2-03', '查询缓存和预算边界', async () => {
  const input = { requests: [{ id: 'qry-cache-region', datasetId: sales, mode: 'aggregate', select: [{ field: '客户地区', alias: 'region' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'sales' }], limit: 10 }] };
  const first = await json('/api/smart-query/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const second = await json('/api/smart-query/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(first.audits[0].cache, 'miss');
  assert.equal(second.audits[0].cache, 'hit');
  const over = await fetch(`${baseUrl}/api/smart-query/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ budget: { maxRequests: 1 }, requests: [input.requests[0], { ...input.requests[0], id: 'qry-cache-region-2' }] }) });
  assert.equal(over.status, 400);
  return { firstCache: first.audits[0].cache, secondCache: second.audits[0].cache, overBudgetStatus: over.status };
});

await run('UAT-P2-04', '真实 Word 模板解析和回填 API', async () => {
  const source = await readFile(join('WordTemplates', '能耗分析报告6月.docx'));
  const encoded = source.toString('base64');
  const model = await json('/api/report-templates/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: '能耗分析报告6月.docx', contentBase64: encoded }) });
  assert.equal(model.schema, 'wynai.docx-template/v1');
  assert.ok(model.blocks.some(block => block.type === 'table'));
  const response = await fetch(`${baseUrl}/api/report-templates/compose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: '能耗分析报告-生成.docx', contentBase64: encoded, values: { report_period: '2026年7月' } }) });
  assert.equal(response.status, 200);
  const output = Buffer.from(await response.arrayBuffer());
  assert.ok(output.length > 1000);
  return { parts: model.parts, blockCount: model.blocks.length, outputBytes: output.length, warnings: model.compatibility.warnings };
});

const artifact = { schema: 'wynai.uat-result/v1', phase: 'phase-2-template-poc', finishedAt: new Date().toISOString(), status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed', summary: { total: cases.length, passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length }, cases, knownLimitations: ['当前多数据集只支持受控结果对齐合并，不支持任意明细级 Join。', 'Word API 首期只保证标准段落、表格、页眉页脚；复杂文本框和 SmartArt 仅提示兼容性。'] };
const dir = join('test', 'uat-artifacts', 'phase2'); await mkdir(dir, { recursive: true }); const file = `phase2-${artifact.finishedAt.replace(/[:.]/g, '-')}.json`; await writeFile(join(dir, file), `${JSON.stringify(artifact, null, 2)}\n`); await writeFile(join(dir, 'latest.json'), `${JSON.stringify(artifact, null, 2)}\n`); console.log(`PHASE 2 UAT ${artifact.status.toUpperCase()}: ${artifact.summary.passed}/${artifact.summary.total}`); if (process.exitCode) process.exit(process.exitCode);
