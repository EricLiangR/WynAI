import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const base = 'http://127.0.0.1:8787';
const datasetId = '18b86197-65e3-4682-8501-6e7125afad02';
const archive = JSON.parse(await fs.readFile('UAT-AY/optimization-evidence-L9Dkk9/uat-results.json', 'utf8'));
if (archive.datasetId !== datasetId) throw new Error('Unexpected dataset');
const selected = new Set(process.argv.slice(2));
const cases = archive.results.filter(item => !selected.size || selected.has(item.id));
if (!cases.length) throw new Error('No matching cases');
const directory = await fs.mkdtemp(path.join(process.cwd(), 'UAT-AY/runtime-regression-'));
const results = [];
const save = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2));
const call = async (url, body) => {
  const response = await fetch(`${base}${url}`, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180000) });
  return { status: response.status, payload: await response.json() };
};
const codeFiles = ['lib/conversation/question-planner.mjs', 'lib/conversation/session.mjs', 'lib/llm/exploration-agent.mjs', 'lib/result-presentation-plan.mjs', 'lib/query/multi-dataset.mjs', 'lib/visualization/visualization-spec.mjs'];
await save('code-hashes.json', await Promise.all(codeFiles.map(async file => ({ file,
  sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex'), note: 'Disk hash at API batch start; not a browser screenshot or process-module hash' }))));
console.log(JSON.stringify({ directory, cases: cases.map(item => item.id), evidenceType: 'API-runtime-regression-NOT-browser-UAT' }));
for (const item of cases) {
  const startedAt = new Date().toISOString();
  let record;
  try {
    const created = await call('/api/smart-query/conversations', { datasetId });
    if (created.status !== 201) throw new Error(`Conversation creation failed: ${created.status}`);
    const conversationId = created.payload.id;
    const answer = await call(`/api/smart-query/conversations/${conversationId}/messages`, { question: item.question });
    await save(`${item.id}-response.json`, { question: item.question, startedAt, completedAt: new Date().toISOString(), conversationId, ...answer });
    const response = answer.payload.response;
    const traceId = response?.trace?.traceId || answer.payload.traceId;
    const trace = traceId ? await call(`/api/smart-query/operation-events/${traceId}`) : null;
    await save(`${item.id}-trace.json`, trace);
    const request = response?.queryRequests?.[0];
    const resultSet = response?.resultSets?.[0];
    const columns = response?.presentationPlan?.table?.columns || [];
    const required = response?.businessIntent?.expectedResult?.requiredDimensions || [];
    const issues = [];
    if (answer.status !== 200 || response?.status !== 'ok') issues.push(`Request incomplete: HTTP ${answer.status}, ${response?.status || answer.payload.code || 'unknown'}`);
    if (request?.dataset?.id !== datasetId) issues.push('Dataset contract missing or wrong');
    if (request?.limit !== 20000) issues.push('Expected uniform 20000-row cap');
    if (required.some(alias => !columns.includes(alias))) issues.push('Required dimension omitted from presentation');
    if (resultSet && resultSet.rows.length !== resultSet.statistics?.rowCount) issues.push('Response row count differs from statistics');
    if (response?.planningDiagnostics?.llmAttempted !== true) issues.push('Real LLM attempt not established');
    if (response?.runtimeStatus?.mode !== 'llm-first-intent-planner') issues.push('Unexpected runtime route');
    record = { id: item.id, question: item.question, startedAt, completedAt: new Date().toISOString(), conversationId,
      traceId, httpStatus: answer.status, status: response?.status, issues,
      automatedContractChecks: issues.length ? 'failed' : 'passed', browserAcceptance: 'not-executed',
      returnedRows: resultSet?.rows?.length, quality: resultSet?.quality,
      columns, required, filters: request?.filters,
      summary: response?.document?.blocks?.find(block => block.id === 'answer-summary')?.content,
      assumptions: response?.businessIntent?.assumptions, planningDiagnostics: response?.planningDiagnostics,
    };
  } catch (error) {
    record = { id: item.id, question: item.question, startedAt, completedAt: new Date().toISOString(), automatedContractChecks: 'failed', browserAcceptance: 'not-executed', issues: [error.message] };
  }
  results.push(record);
  await save('results.json', { evidenceType: 'API-runtime-regression-NOT-browser-UAT', datasetId, results });
  console.log(JSON.stringify({ id: record.id, rows: record.returnedRows, status: record.status, issues: record.issues, traceId: record.traceId }));
}
