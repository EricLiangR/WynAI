import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmGateway } from './llm-gateway.mjs';

const providers = [
  { id: 'primary', baseUrl: 'https://primary.test/v1', model: 'primary-model' },
  { id: 'backup', baseUrl: 'https://backup.test/v1', model: 'backup-model' },
];

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function okResponse(value = { ok: true }) {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify(value) } }] });
}

test('Gateway 主 Provider 成功并记录调用指标', async () => {
  let calls = 0;
  const gateway = createLlmGateway({ providers, fetchImpl: async (url) => {
    calls += 1;
    assert.match(url, /primary\.test/);
    return okResponse({ answer: 'primary' });
  }, cacheTtlMs: 0 });

  const result = await gateway.completeJson([{ role: 'user', content: 'hello' }]);
  assert.deepEqual(result, { answer: 'primary' });
  assert.equal(calls, 1);
  assert.equal(gateway.snapshot().metrics.successes, 1);
  assert.equal(gateway.snapshot().lastCall.provider, 'primary');
});

test('主 Provider 超时后切换备用 Provider', async () => {
  const calls = [];
  const gateway = createLlmGateway({
    providers,
    timeoutMs: 25,
    firstByteTimeoutMs: 100,
    maxAttempts: 2,
    cacheTtlMs: 0,
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (url.includes('primary')) {
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      }
      return okResponse({ answer: 'backup' });
    },
  });

  assert.deepEqual(await gateway.completeJson([{ role: 'user', content: 'fallback' }]), { answer: 'backup' });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /primary\.test/);
  assert.match(calls[1], /backup\.test/);
  assert.equal(gateway.snapshot().metrics.fallbacks, 1);
  assert.equal(gateway.snapshot().metrics.timeouts, 1);
});

test('429 和 5xx 可重试，非重试 4xx 不重复', async () => {
  let retryCalls = 0;
  const retryGateway = createLlmGateway({
    providers: [providers[0]],
    maxAttempts: 3,
    cacheTtlMs: 0,
    fetchImpl: async () => {
      retryCalls += 1;
      return retryCalls < 3 ? jsonResponse({ message: 'busy' }, retryCalls === 1 ? 429 : 503) : okResponse({ ok: true });
    },
  });
  assert.deepEqual(await retryGateway.completeJson([{ role: 'user', content: 'retry' }]), { ok: true });
  assert.equal(retryCalls, 3);
  assert.equal(retryGateway.snapshot().metrics.retries, 2);
  assert.equal(retryGateway.snapshot().metrics.fallbacks, 0);

  let badCalls = 0;
  const badGateway = createLlmGateway({
    providers: [providers[0]],
    maxAttempts: 4,
    cacheTtlMs: 0,
    fetchImpl: async () => { badCalls += 1; return jsonResponse({ message: 'bad request' }, 400); },
  });
  await assert.rejects(badGateway.completeJson([{ role: 'user', content: 'bad' }]), error => error.code === 'LLM_REQUEST_FAILED');
  assert.equal(badCalls, 1);
});

test('连续失败触发熔断并返回 LLM_CIRCUIT_OPEN', async () => {
  let calls = 0;
  const gateway = createLlmGateway({
    providers: [providers[0]],
    maxAttempts: 1,
    circuitFailureThreshold: 2,
    circuitCooldownMs: 60_000,
    cacheTtlMs: 0,
    fetchImpl: async () => { calls += 1; return jsonResponse({ message: 'upstream' }, 500); },
  });
  await assert.rejects(gateway.completeJson([{ role: 'user', content: 'one' }]), error => error.code === 'LLM_UPSTREAM_ERROR');
  await assert.rejects(gateway.completeJson([{ role: 'user', content: 'two' }]), error => error.code === 'LLM_UPSTREAM_ERROR');
  await assert.rejects(gateway.completeJson([{ role: 'user', content: 'three' }]), error => error.code === 'LLM_CIRCUIT_OPEN');
  assert.equal(calls, 2);
  assert.equal(gateway.snapshot().metrics.circuitOpen, 1);
});

test('命中进程内缓存且不持久化调用结果', async () => {
  let calls = 0;
  const gateway = createLlmGateway({ providers: [providers[0]], cacheTtlMs: 10_000, fetchImpl: async () => { calls += 1; return okResponse({ value: calls }); } });
  const messages = [{ role: 'user', content: 'same' }];
  assert.deepEqual(await gateway.completeJson(messages), { value: 1 });
  assert.deepEqual(await gateway.completeJson(messages), { value: 1 });
  assert.equal(calls, 1);
  assert.equal(gateway.snapshot().metrics.cacheHits, 1);
  assert.equal(gateway.snapshot().cacheSize, 1);
});

test('cacheKey 为 null 时强制执行真实探针，不复用缓存', async () => {
  let calls = 0;
  const gateway = createLlmGateway({ providers: [providers[0]], cacheTtlMs: 10_000, fetchImpl: async () => { calls += 1; return okResponse({ ok: true, call: calls }); } });
  await gateway.completeJson([{ role: 'user', content: 'probe' }], { operation: 'probe', cacheKey: null });
  await gateway.completeJson([{ role: 'user', content: 'probe' }], { operation: 'probe', cacheKey: null });
  assert.equal(calls, 2);
  assert.equal(gateway.snapshot().metrics.cacheHits, 0);
});

test('网络错误保留 AggregateError 的底层地址和系统错误码', async () => {
  const cause = new AggregateError([
    Object.assign(new Error('connect EACCES 203.0.113.10:443'), { code: 'EACCES', errno: -4092, address: '203.0.113.10', port: 443, syscall: 'connect' }),
  ]);
  const gateway = createLlmGateway({ providers: [providers[0]], maxAttempts: 1, cacheTtlMs: 0, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause }); } });
  await assert.rejects(gateway.completeJson([{ role: 'user', content: 'network' }]), error => {
    assert.equal(error.code, 'LLM_REQUEST_FAILED');
    assert.match(error.message, /EACCES/);
    const details = gateway.snapshot().providers[0].state.lastError;
    assert.match(details.message, /EACCES/);
    return true;
  });
});

test('调用方取消、超时和空响应返回明确错误码', async () => {
  const cancelled = createLlmGateway({ providers: [providers[0]], cacheTtlMs: 0, fetchImpl: async (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  const controller = new AbortController();
  const pending = cancelled.completeJson([{ role: 'user', content: 'cancel' }], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED');

  const timedOut = createLlmGateway({ providers: [providers[0]], timeoutMs: 20, firstByteTimeoutMs: 100, cacheTtlMs: 0, fetchImpl: async (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  await assert.rejects(timedOut.completeJson([{ role: 'user', content: 'timeout' }]), error => error.code === 'LLM_TIMEOUT');

  const empty = createLlmGateway({ providers: [providers[0]], maxAttempts: 1, cacheTtlMs: 0, fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '' } }] }) });
  await assert.rejects(empty.completeJson([{ role: 'user', content: 'empty' }]), error => error.code === 'LLM_EMPTY_RESPONSE');
});

test('响应头等待超时与总请求超时使用不同错误码', async () => {
  const responseHeaderTimeout = createLlmGateway({
    providers: [providers[0]],
    timeoutMs: 2_500,
    responseHeaderTimeoutMs: 1_000,
    maxAttempts: 1,
    cacheTtlMs: 0,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  });
  await assert.rejects(responseHeaderTimeout.completeJson([{ role: 'user', content: 'header-timeout' }]), error => error.code === 'LLM_RESPONSE_HEADER_TIMEOUT' && error.phase === 'responseHeader');

  const totalTimeout = createLlmGateway({
    providers: [providers[0]],
    timeoutMs: 1_000,
    responseHeaderTimeoutMs: 2_500,
    maxAttempts: 1,
    cacheTtlMs: 0,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  });
  await assert.rejects(totalTimeout.completeJson([{ role: 'user', content: 'total-timeout' }]), error => error.code === 'LLM_TIMEOUT' && error.phase === 'total');
});

test('响应头软阈值只产生慢响应事件，不提前终止同步请求', async () => {
  const events = [];
  const gateway = createLlmGateway({
    providers: [providers[0]],
    timeoutMs: 200,
    responseHeaderWarningMs: 10,
    responseHeaderTimeoutMs: 180,
    maxAttempts: 1,
    cacheTtlMs: 0,
    fetchImpl: async () => {
      await new Promise(resolve => setTimeout(resolve, 35));
      return okResponse({ answer: 'slow-but-valid' });
    },
  });
  const result = await gateway.completeJson([{ role: 'user', content: 'slow-header' }], { onEvent: event => events.push(event) });
  assert.deepEqual(result, { answer: 'slow-but-valid' });
  assert.ok(events.some(event => event.type === 'gateway.slow' && event.timeoutClass === 'soft-warning'));
  const attempt = events.find(event => event.type === 'gateway.attempt');
  assert.equal(attempt.responseHeaderWarned, true);
  assert.equal(attempt.timeoutClass, 'completed-after-soft-warning');
  assert.equal(gateway.snapshot().metrics.responseHeaderWarnings, 1);
});

test('响应头之后的响应体等待超时使用独立错误码', async () => {
  const gateway = createLlmGateway({
    providers: [providers[0]],
    timeoutMs: 2_500,
    responseHeaderWarningMs: 10,
    responseHeaderTimeoutMs: 2_000,
    responseBodyTimeoutMs: 1_000,
    maxAttempts: 1,
    cacheTtlMs: 0,
    fetchImpl: async (_url, options) => ({
      status: 200,
      ok: true,
      text: () => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('body stalled')), { once: true })),
    }),
  });
  await assert.rejects(gateway.completeJson([{ role: 'user', content: 'body-timeout' }]), error => error.code === 'LLM_RESPONSE_BODY_TIMEOUT' && error.phase === 'responseBody');
  assert.equal(gateway.snapshot().metrics.responseBodyTimeouts, 1);
});

test('底层连接超时保留 LLM_CONNECT_TIMEOUT 语义', async () => {
  const gateway = createLlmGateway({
    providers: [providers[0]],
    maxAttempts: 1,
    cacheTtlMs: 0,
    fetchImpl: async () => { const error = new Error('connect timeout'); error.code = 'UND_ERR_CONNECT_TIMEOUT'; throw error; },
  });
  await assert.rejects(gateway.completeJson([{ role: 'user', content: 'connect' }]), error => error.code === 'LLM_CONNECT_TIMEOUT');
  assert.equal(gateway.snapshot().metrics.connectTimeouts, 1);
});

test('重试使用指数退避并可被调用方取消', async () => {
  const delays = [];
  let calls = 0;
  const gateway = createLlmGateway({
    providers: [providers[0]],
    maxAttempts: 3,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 100,
    retryJitterMs: 0,
    sleepFn: async ms => { delays.push(ms); },
    cacheTtlMs: 0,
    fetchImpl: async () => { calls += 1; return jsonResponse({ message: 'busy' }, 503); },
  });
  await assert.rejects(gateway.completeJson([{ role: 'user', content: 'backoff' }]), error => error.code === 'LLM_UPSTREAM_ERROR');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(gateway.snapshot().metrics.retryDelayMs, 30);

  const controller = new AbortController();
  let abortSeen = false;
  const cancelled = createLlmGateway({
    providers: [providers[0]], maxAttempts: 2, retryBaseDelayMs: 100, retryJitterMs: 0, cacheTtlMs: 0,
    sleepFn: async (_ms, signal) => { await new Promise((resolve, reject) => { signal.addEventListener('abort', () => { abortSeen = true; reject(Object.assign(new Error('cancelled'), { code: 'REQUEST_ABORTED' })); }, { once: true }); }); },
    fetchImpl: async () => jsonResponse({ message: 'busy' }, 503),
  });
  const pending = cancelled.completeJson([{ role: 'user', content: 'abort-backoff' }], { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED');
  assert.equal(abortSeen, true);
});

test('洞察各阶段采用独立超时策略且不再使用统一 8 秒阈值', async () => {
  const gateway = createLlmGateway({ providers: [providers[0]], maxAttempts: 1, cacheTtlMs: 0, fetchImpl: async () => okResponse() });
  await gateway.completeJson([{ role: 'user', content: 'planner-policy' }], { operation: 'insight-planner' });
  assert.equal(gateway.snapshot().lastCall.policy.requestTimeoutMs, 45_000);
  assert.equal(gateway.snapshot().lastCall.policy.responseHeaderWarningMs, 15_000);
  assert.equal(gateway.snapshot().lastCall.policy.responseHeaderTimeoutMs, 45_000);
  await gateway.completeJson([{ role: 'user', content: 'critic-policy' }], { operation: 'insight-critic' });
  assert.equal(gateway.snapshot().lastCall.policy.requestTimeoutMs, 35_000);
  assert.equal(gateway.snapshot().lastCall.policy.responseHeaderWarningMs, 12_000);
  assert.equal(gateway.snapshot().lastCall.policy.responseHeaderTimeoutMs, 35_000);
  await gateway.completeJson([{ role: 'user', content: 'narrator-policy' }], { operation: 'insight-narrator' });
  assert.equal(gateway.snapshot().lastCall.policy.requestTimeoutMs, 45_000);
  assert.equal(gateway.snapshot().lastCall.policy.responseHeaderWarningMs, 15_000);
  assert.equal(gateway.snapshot().lastCall.policy.responseHeaderTimeoutMs, 45_000);
  await gateway.completeJson([{ role: 'user', content: 'repair-policy' }], { operation: 'insight-narrator-repair' });
  assert.equal(gateway.snapshot().lastCall.policy.requestTimeoutMs, 90_000);
  assert.equal(gateway.snapshot().lastCall.policy.responseHeaderWarningMs, 15_000);
  assert.equal(gateway.snapshot().lastCall.policy.responseHeaderTimeoutMs, 90_000);
});
