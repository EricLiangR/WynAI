import { writeFile } from 'node:fs/promises';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const durationMs = Number(process.env.UAT_HEALTH_DURATION_MS || 30 * 60 * 1000);
const intervalMs = Number(process.env.UAT_HEALTH_INTERVAL_MS || 30 * 1000);
const startedAt = new Date().toISOString();
const deadline = Date.now() + durationMs;
const samples = [];

async function probe() {
  const started = Date.now();
  let statusCode = null;
  let payload = null;
  let error = null;
  try {
    const response = await fetch(`${baseUrl}/api/llm/health`, { signal: AbortSignal.timeout(20_000) });
    statusCode = response.status;
    payload = await response.json().catch(() => null);
  } catch (cause) {
    error = { name: cause?.name || 'Error', message: cause?.message || String(cause), code: cause?.cause?.code || cause?.code || null };
  }
  samples.push({
    at: new Date().toISOString(),
    statusCode,
    ok: statusCode === 200 && payload?.ok === true && payload?.status === 'healthy',
    latencyMs: Date.now() - started,
    model: payload?.model || null,
    code: payload?.code || null,
    message: payload?.message || null,
    errorCode: payload?.error?.code || payload?.error?.cause?.code || null,
    failureClass: statusCode === 200 && payload?.ok === true && payload?.status === 'healthy'
      ? null
      : /EACCES/i.test(JSON.stringify(payload || {}) + JSON.stringify(error || {}))
        ? 'egress-permission'
        : /TIMEOUT|timed out|header/i.test(JSON.stringify(payload || {}) + JSON.stringify(error || {}))
          ? 'timeout'
          : payload?.code === 'LLM_CIRCUIT_OPEN'
            ? 'circuit-open'
            : statusCode >= 500
              ? 'upstream-or-service'
              : statusCode >= 400
                ? 'provider-http'
                : 'transport',
    metrics: payload?.gateway?.metrics || null,
    error,
  });
  await writeFile('uat-p0-health-monitor.json', JSON.stringify({ schema: 'wynai.uat-health-monitor/v1', baseUrl, startedAt, durationMs, intervalMs, completedAt: null, samples }, null, 2));
}

while (Date.now() <= deadline) {
  await probe();
  const remaining = deadline - Date.now();
  if (remaining <= 0) break;
  await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
}

const completedAt = new Date().toISOString();
const passed = samples.length > 0 && samples.every(item => item.ok);
await writeFile('uat-p0-health-monitor.json', JSON.stringify({ schema: 'wynai.uat-health-monitor/v1', baseUrl, startedAt, durationMs, intervalMs, completedAt, passed, samples }, null, 2));
console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', baseUrl, startedAt, completedAt, sampleCount: samples.length, failures: samples.filter(item => !item.ok).length }, null, 2));
if (!passed) process.exitCode = 1;
