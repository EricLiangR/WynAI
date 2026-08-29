import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { evaluateUatCase, isApprovedSkillIdentity, normalizeUatCase, summarizeUatRun } from './uat-officer.mjs';

const baseUrl = (process.env.UAT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const adminToken = process.env.UAT_ADMIN_TOKEN || '';
const requestedPacks = (process.env.UAT_PACKS || 'sales.v1.json').split(',').map(value => value.trim()).filter(Boolean);
const evidenceRoot = process.env.WYN_AI_UAT_EVIDENCE_ROOT || join(process.cwd(), 'uat-governance-evidence');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const artifactDir = join(evidenceRoot, `governance-${runId}`);
const headers = { 'Content-Type': 'application/json' };
const adminHeaders = adminToken ? { ...headers, 'X-Wyn-Skill-Admin-Token': adminToken } : headers;

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || 'request failed'}`);
  return payload;
}

async function ask(datasetId, question) {
  const conversation = await request('/api/smart-query/conversations', { method: 'POST', headers, body: JSON.stringify({ datasetId }) });
  const payload = await request(`/api/smart-query/conversations/${conversation.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ question }) });
  return { conversation, ...payload };
}

async function loadPack(filename) {
  const content = await readFile(join(process.cwd(), 'evaluation', 'packs', basename(filename)), 'utf8');
  return JSON.parse(content);
}

await mkdir(artifactDir, { recursive: true });
const catalog = await request('/api/smart-query/skills');
const catalogCheck = { name: 'approved-skill-catalog', passed: catalog.items.every(isApprovedSkillIdentity), actual: catalog.items.map(item => ({ id: item.id, version: item.version, status: item.status })) };
const caseResults = [];
const skippedPacks = [];

for (const filename of requestedPacks) {
  const pack = await loadPack(filename);
  if (pack.status !== 'approved') {
    skippedPacks.push({ packRef: `${pack.id}@${pack.version}`, reason: 'draft_requires_business_owner_approval' });
    continue;
  }
  for (const item of pack.cases || []) {
    const uatCase = normalizeUatCase(pack, item);
    const questions = [uatCase.userQuestion, ...(item.variants || [])];
    for (const question of questions) {
      const startedAt = Date.now();
      try {
        const output = await ask(uatCase.datasetId, question);
        const traceId = output.response?.trace?.traceId;
        if (!traceId) throw new Error('response missing traceId');
        if (!adminToken) throw new Error('UAT_ADMIN_TOKEN is required to verify trace evidence');
        const trace = await request(`/api/smart-query/operation-events/${traceId}`, { headers: adminHeaders });
        const result = evaluateUatCase({ ...uatCase, userQuestion: question }, output.response, trace.items || []);
        const artifact = { ...result, question, durationMs: Date.now() - startedAt, packRef: uatCase.packRef };
        caseResults.push(artifact);
        await writeFile(join(artifactDir, `case-${uatCase.caseId}-${caseResults.length}.json`), `${JSON.stringify({ request: { datasetId: uatCase.datasetId, question }, response: output.response, trace: trace.items, result: artifact }, null, 2)}\n`);
      } catch (error) {
        caseResults.push({ caseId: uatCase.caseId, question, packRef: uatCase.packRef, passed: false, error: error.message, durationMs: Date.now() - startedAt });
      }
    }
  }
}

const summary = summarizeUatRun(caseResults);
const artifact = { schema: 'wynai.uat-governance-run/v1', runId, baseUrl, startedAt: runId, completedAt: new Date().toISOString(), status: catalogCheck.passed && summary.status === 'passed' ? 'passed' : 'failed', summary, catalogCheck, approvedPacks: requestedPacks, skippedPacks, screenshotGate: { desktop: 'required_external_browser_uat', mobile390x844: 'required_external_browser_uat', status: 'not_executed_by_api_runner' }, cases: caseResults };
await writeFile(join(artifactDir, 'uat-results.json'), `${JSON.stringify(artifact, null, 2)}\n`);
await writeFile(join(evidenceRoot, 'latest.json'), `${JSON.stringify({ artifactDir, ...artifact }, null, 2)}\n`);
console.log(`UAT GOVERNANCE ${artifact.status.toUpperCase()}: ${summary.passed}/${summary.total} cases; evidence: ${artifactDir}`);
if (artifact.status !== 'passed') process.exitCode = 1;
