import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const target = 'https://dashscope.aliyuncs.com/compatible-mode/v1/models';
const localHealth = 'http://127.0.0.1:8787/api/llm/health';

function causeChain(error) {
  const chain = [];
  let current = error;
  while (current) {
    chain.push({
      name: current.name || null,
      message: current.message || String(current),
      code: current.code || null,
      errno: current.errno || null,
      syscall: current.syscall || null,
      address: current.address || null,
      port: current.port || null,
      errors: Array.isArray(current.errors)
        ? current.errors.map(item => ({ code: item.code || null, address: item.address || null, port: item.port || null, message: item.message || null }))
        : null,
    });
    current = current.cause;
  }
  return chain;
}

async function nodeFetch() {
  const startedAt = Date.now();
  try {
    const response = await fetch(target, { headers: { Authorization: 'Bearer prototype-invalid-key' }, signal: AbortSignal.timeout(10_000) });
    return { mode: 'node-fetch-direct', reachedRemote: true, httpStatus: response.status, durationMs: Date.now() - startedAt };
  } catch (error) {
    return { mode: 'node-fetch-direct', reachedRemote: false, durationMs: Date.now() - startedAt, error: causeChain(error) };
  }
}

async function commandProbe(mode, executable, args) {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, { timeout: 15_000, windowsHide: true });
    return { mode, reachedRemote: true, durationMs: Date.now() - startedAt, output: `${stdout}${stderr}`.trim().slice(0, 1000) };
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`.trim();
    const statusMatch = output.match(/(?:HTTP\/\S+\s+|StatusCode\s*:\s*)([1-5]\d{2})/i);
    return {
      mode,
      reachedRemote: Boolean(statusMatch),
      httpStatus: statusMatch ? Number(statusMatch[1]) : null,
      durationMs: Date.now() - startedAt,
      exitCode: error.code || null,
      output: output.slice(0, 1500),
      error: causeChain(error),
    };
  }
}

async function projectHealth() {
  const startedAt = Date.now();
  try {
    const response = await fetch(localHealth, { signal: AbortSignal.timeout(15_000) });
    const payload = await response.json().catch(() => ({}));
    return {
      mode: 'project-8787-health',
      reachedLocal: true,
      providerHealthy: response.ok && payload.ok === true,
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      code: payload.code || null,
      message: payload.message || null,
      providerError: payload.error || null,
    };
  } catch (error) {
    return { mode: 'project-8787-health', reachedLocal: false, durationMs: Date.now() - startedAt, error: causeChain(error) };
  }
}

const powershellScript = [
  "$ProgressPreference='SilentlyContinue'",
  `try { $r=Invoke-WebRequest -UseBasicParsing -Uri '${target}' -Headers @{Authorization='Bearer prototype-invalid-key'} -TimeoutSec 10; Write-Output ('StatusCode: ' + [int]$r.StatusCode) } catch { if ($_.Exception.Response) { Write-Output ('StatusCode: ' + [int]$_.Exception.Response.StatusCode); exit 3 }; Write-Output $_.Exception.ToString(); exit 2 }`,
].join('; ');

const results = await Promise.all([
  nodeFetch(),
  commandProbe('curl-direct', 'curl.exe', ['-sS', '-o', 'NUL', '-w', 'HTTP/%{http_version} %{http_code}', '--connect-timeout', '5', '--max-time', '10', '-H', 'Authorization: Bearer prototype-invalid-key', target]),
  commandProbe('powershell-invoke-webrequest', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellScript]),
  projectHealth(),
]);

const external = results.filter(item => item.mode !== 'project-8787-health');
const reachedCount = external.filter(item => item.reachedRemote).length;
const conclusion = reachedCount === external.length
  ? 'all-direct-modes-reached-remote'
  : reachedCount === 0
    ? 'environment-egress-blocks-all-tested-modes'
    : 'runtime-specific-egress-policy-difference';

console.log(JSON.stringify({
  schema: 'wynai.llm-egress-prototype/v1',
  generatedAt: new Date().toISOString(),
  targetHost: 'dashscope.aliyuncs.com',
  targetPort: 443,
  conclusion,
  results,
}, null, 2));
