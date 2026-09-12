import fs from 'node:fs/promises';
import path from 'node:path';
const datasetId = '18b86197-65e3-4682-8501-6e7125afad02';
const request = { id: 'verify-live-result-cap', dataset: { id: datasetId }, mode: 'aggregate',
  purpose: 'Read-only actual result cap verification', select: [{ field: 'pipelineName', alias: 'project' }],
  measures: [{ aggregation: 'countRows', alias: 'records' }], filters: [], limit: 20000 };
const response = await fetch('http://127.0.0.1:8787/api/smart-query/query', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requests: [request] }), signal: AbortSignal.timeout(120000),
});
const payload = await response.json();
const result = payload.resultSets?.[0];
const issues = [];
if (response.status !== 200) issues.push(`HTTP ${response.status}`);
if (result?.rows?.length !== 20000) issues.push('Did not exercise an actual 20000-row response');
if (!(result?.statistics?.totalRowCount > 20000)) issues.push('Did not establish a source result larger than 20000');
if (result?.quality?.isTruncated !== true || result?.quality?.limitSource !== 'system-cap') issues.push('Missing system-cap completeness signal');
if (result?.statistics?.rowCount !== result?.rows?.length || result?.quality?.returnedRowCount !== result?.rows?.length) issues.push('Count contract mismatch');
const directory = await fs.mkdtemp(path.join(process.cwd(), 'UAT-AY/live-cap-verification-'));
await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ checkedAt: new Date().toISOString(), datasetId, evidenceType: 'Read-only API boundary diagnostic; NOT browser pagination UAT', request, status: response.status, issues, response: payload }, null, 2));
console.log(JSON.stringify({ directory, issues, returnedRows: result?.rows?.length, statistics: result?.statistics, quality: result?.quality }, null, 2));
