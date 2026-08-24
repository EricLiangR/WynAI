import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createExplorationLlm } from '../lib/llm/exploration-agent.mjs';

async function loadLocalEnv() {
  try {
    const source = await readFile('.env.local', 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await loadLocalEnv();

const startedAt = new Date();
const baseUrl = String(process.env.LLM_BASE_URL || '').replace(/\/$/, '');
const model = process.env.LLM_MODEL || '';
const artifact = {
  schemaVersion: 'uat-llm-connectivity/v1',
  startedAt: startedAt.toISOString(),
  finishedAt: null,
  status: 'failed',
  endpoint: null,
  model: model || null,
  nodeVersion: process.version,
  sendsBusinessData: false,
  checks: [],
};

try {
  assert.ok(baseUrl, 'LLM_BASE_URL 未配置');
  assert.ok(process.env.LLM_API_KEY, 'LLM_API_KEY 未配置');
  assert.ok(model, 'LLM_MODEL 未配置');
  const endpoint = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
  const parsedEndpoint = new URL(endpoint);
  artifact.endpoint = `${parsedEndpoint.origin}${parsedEndpoint.pathname}`;

  const llm = createExplorationLlm({ baseUrl, apiKey: process.env.LLM_API_KEY, model });
  const result = await llm.probe();
  assert.equal(result.ok, true, '模型未返回预期连通确认');
  artifact.status = 'passed';
  artifact.checks.push({ id: 'LLM-CONNECT-01', status: 'passed', model: result.model, latencyMs: result.latencyMs });
} catch (error) {
  artifact.checks.push({ id: 'LLM-CONNECT-01', status: 'failed', error: error.message, code: error.code || null });
  process.exitCode = 1;
} finally {
  artifact.finishedAt = new Date().toISOString();
  const directory = join('test', 'uat-artifacts', 'llm-connectivity');
  const timestamp = artifact.finishedAt.replace(/[:.]/g, '-');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `llm-connectivity-${timestamp}.json`), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  await writeFile(join(directory, 'latest.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`LLM CONNECTIVITY UAT ${artifact.status.toUpperCase()}: ${artifact.checks[0]?.status || 'failed'}`);
}
