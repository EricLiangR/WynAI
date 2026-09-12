import fs from 'node:fs/promises';
import path from 'node:path';

const datasetId = '18b86197-65e3-4682-8501-6e7125afad02';
const b010 = JSON.parse(await fs.readFile('UAT-AY/optimization-evidence-L9Dkk9/B-010-evidence.json', 'utf8'));
if (b010.canonical.dataset.id !== datasetId) throw new Error('Unexpected UAT dataset');
const requests = [
  { id: 'verify-fiscal-distribution', select: [{ field: '赢单财年', alias: 'fiscal', role: 'dimension' }], filters: [] },
  ...['26', '27'].map(year => ({ id: `verify-fiscal-${year}`, select: [], filters: [{ field: '赢单财年', operator: 'eq', value: year }] })),
  { id: 'verify-b010-filtered-count', select: [], filters: b010.canonical.filters },
].map(request => ({ ...request, dataset: { id: datasetId }, mode: 'aggregate', purpose: 'Read-only UAT fiscal source verification', measures: [{ aggregation: 'countRows', alias: 'records' }], limit: 20000 }));
const response = await fetch('http://127.0.0.1:8787/api/smart-query/query', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requests }), signal: AbortSignal.timeout(120000),
});
const payload = await response.json();
if (!response.ok) throw new Error(JSON.stringify({ status: response.status, message: payload.message }));
const output = { checkedAt: new Date().toISOString(), datasetId, evidenceType: 'read-only-query-diagnostic-not-browser-UAT', requests, response: payload };
const directory = await fs.mkdtemp(path.join(process.cwd(), 'UAT-AY/fiscal-source-verification-'));
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ directory, results: payload.resultSets.map(set => ({ requestId: set.requestId, rows: set.rows, quality: set.quality })) }, null, 2));
