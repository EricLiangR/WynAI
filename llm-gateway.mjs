import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function endpointHost(endpoint) { try { return new URL(endpoint).host; } catch { return 'configured LLM endpoint'; } }
function errorCode(error) { return String(error?.code || '').toUpperCase(); }
export function serializeError(error, depth = 0) {
  if (!error || depth > 3) return null;
  const details = {
    name: error.name || null,
    message: String(error.message || '').slice(0, 500),
    code: error.code || null,
    status: Number.isFinite(error.status) ? error.status : null,
    errno: Number.isFinite(error.errno) ? error.errno : null,
    syscall: error.syscall || null,
    address: error.address || null,
    port: Number.isFinite(error.port) ? error.port : null,
  };
  if (error.phase) details.phase = error.phase;
  if (error.cause) details.cause = serializeError(error.cause, depth + 1);
  if (Array.isArray(error.errors)) details.errors = error.errors.slice(0, 8).map(item => serializeError(item, depth + 1));
  return details;
}

function connectSocket({ host, port, secure, address, timeoutMs }) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      result.durationMs = Date.now() - startedAt;
      resolve(result);
    };
    const options = secure
      ? { host: address, port, servername: host, timeout: timeoutMs, rejectUnauthorized: true }
      : { host: address, port, timeout: timeoutMs };
    const socket = secure ? tls.connect(options) : net.connect(options);
    socket.setTimeout(timeoutMs, () => {
      const error = new Error(`连接超时 (${timeoutMs}ms)`);
      error.code = 'LLM_CONNECT_TIMEOUT';
      socket.destroy(error);
    });
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      finish({ ok: true, address, port });
      socket.destroy();
    });
    socket.once('error', error => finish({ ok: false, address, port, error: serializeError(error) }));
    socket.once('close', () => finish({ ok: false, address, port, error: { name: 'SocketClosed', message: '连接在握手完成前关闭', code: 'LLM_CONNECT_CLOSED' } }));
  });
}

async function diagnoseEndpoint(endpoint, { timeoutMs = 3_000 } = {}) {
  const parsed = new URL(endpoint);
  const host = parsed.hostname;
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  const secure = parsed.protocol === 'https:';
  const result = { endpointHost: parsed.host, protocol: parsed.protocol.replace(':', ''), dns: null, tcp: null, tls: null, durationMs: 0 };
  const startedAt = Date.now();
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
    result.dns = { ok: addresses.length > 0, addresses: addresses.map(item => ({ address: item.address, family: item.family })) };
  } catch (error) {
    result.dns = { ok: false, error: serializeError(error) };
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  const attempts = [];
  for (const item of addresses.slice(0, 8)) {
    const attempt = await connectSocket({ host, port, secure, address: item.address, timeoutMs });
    attempts.push(attempt);
    if (attempt.ok) break;
  }
  const successful = attempts.find(item => item.ok);
  result.tcp = { ok: Boolean(successful), attempts };
  if (secure) result.tls = { ok: Boolean(successful), phase: successful ? 'secureConnect' : 'not-reached' };
  result.durationMs = Date.now() - startedAt;
  return result;
}
function retryable(error) {
  const code = errorCode(error);
  if (['REQUEST_ABORTED', 'INSIGHT_LLM_INVALID_OUTPUT', 'INSIGHT_EVIDENCE_EMPTY', 'EVIDENCE_INSUFFICIENT'].includes(code)) return false;
  if (Number(error?.status) >= 400 && Number(error?.status) < 500 && Number(error?.status) !== 429) return false;
  if (['LLM_TIMEOUT', 'LLM_CONNECT_TIMEOUT', 'LLM_RESPONSE_HEADER_TIMEOUT', 'LLM_RESPONSE_BODY_TIMEOUT', 'LLM_REQUEST_FAILED', 'LLM_UPSTREAM_ERROR', 'LLM_RATE_LIMITED', 'LLM_EMPTY_RESPONSE', 'NARRATOR_SCHEMA_INVALID'].includes(code)) return true;
  return Number(error?.status) === 429 || Number(error?.status) >= 500;
}
function timeoutError(provider, code, phase, timeoutMs, cause = null) {
  const labels = { total: '总请求', responseHeader: '响应头等待', responseBody: '响应体读取', connect: '连接' };
  const error = new Error(`大模型${labels[phase] || '请求'}超时 (${provider}; ${timeoutMs}ms)`);
  error.code = code;
  error.provider = provider;
  error.phase = phase;
  error.timeoutMs = timeoutMs;
  error.timeoutClass = phase === 'total' ? 'hard-deadline' : `${phase}-hard-timeout`;
  error.cause = cause;
  return error;
}

const DEFAULT_OPERATION_POLICIES = {
  // The warning is intentionally shorter than the hard deadline. A slow
  // provider should be observable without being aborted merely because it
  // has not produced headers yet.
  'insight-planner': { requestTimeoutMs: 45_000, responseHeaderWarningMs: 15_000, responseHeaderTimeoutMs: 45_000 },
  'insight-critic': { requestTimeoutMs: 35_000, responseHeaderWarningMs: 12_000, responseHeaderTimeoutMs: 35_000 },
  'insight-narrator': { requestTimeoutMs: 45_000, responseHeaderWarningMs: 15_000, responseHeaderTimeoutMs: 45_000 },
  'insight-narrator-repair': { requestTimeoutMs: 90_000, responseHeaderWarningMs: 15_000, responseHeaderTimeoutMs: 90_000 },
  'agent-report': { requestTimeoutMs: 45_000, responseHeaderWarningMs: 15_000, responseHeaderTimeoutMs: 45_000 },
  exploration: { requestTimeoutMs: 45_000, responseHeaderWarningMs: 15_000, responseHeaderTimeoutMs: 45_000 },
  intent: { requestTimeoutMs: 15_000, responseHeaderWarningMs: 8_000, responseHeaderTimeoutMs: 15_000 },
  probe: { requestTimeoutMs: 10_000, responseHeaderWarningMs: 5_000, responseHeaderTimeoutMs: 10_000 },
};

export function createLlmGateway({ providers = [], fetchImpl = globalThis.fetch, timeoutMs = 45_000, connectTimeoutMs = 3_000, firstByteTimeoutMs = null, responseHeaderTimeoutMs = null, responseHeaderWarningMs = null, responseBodyTimeoutMs = null, maxAttempts = 2, circuitFailureThreshold = 3, circuitCooldownMs = 30_000, cacheTtlMs = 30_000, enableThinking = null, operationPolicies = {}, retryBaseDelayMs = 250, retryMaxDelayMs = 4_000, retryJitterMs = 150, sleepFn = null, randomFn = Math.random } = {}) {
  const normalizedProviders = providers.map((provider, index) => ({
    id: String(provider.id || `provider-${index + 1}`),
    baseUrl: String(provider.baseUrl || '').replace(/\/$/, ''),
    apiKey: String(provider.apiKey || ''),
    model: String(provider.model || ''),
  })).filter(provider => provider.baseUrl && provider.model && fetchImpl);
  const state = new Map(normalizedProviders.map(provider => [provider.id, { failures: 0, openUntil: 0, lastError: null }]));
  const cache = new Map();
  const metrics = { calls: 0, successes: 0, failures: 0, timeouts: 0, connectTimeouts: 0, responseHeaderTimeouts: 0, responseBodyTimeouts: 0, responseHeaderWarnings: 0, retries: 0, retryDelayMs: 0, fallbacks: 0, cacheHits: 0, circuitOpen: 0 };
  let lastCall = null;

  const basePolicy = {
    requestTimeoutMs: Math.max(1_000, Number(timeoutMs) || 45_000),
    connectTimeoutMs: Math.max(250, Number(connectTimeoutMs) || 3_000),
    responseHeaderTimeoutMs: Math.max(1_000, Number(responseHeaderTimeoutMs) || Number(timeoutMs) || 45_000),
    responseHeaderWarningMs: Math.max(0, Number(responseHeaderWarningMs ?? firstByteTimeoutMs) || 15_000),
    responseBodyTimeoutMs: Math.max(1_000, Number(responseBodyTimeoutMs) || Number(timeoutMs) || 45_000),
    maxAttempts: Math.max(1, Math.min(4, Number(maxAttempts) || 2)),
    retryBaseDelayMs: Math.max(0, Number(retryBaseDelayMs) || 0),
    retryMaxDelayMs: Math.max(0, Number(retryMaxDelayMs) || 4_000),
    retryJitterMs: Math.max(0, Number(retryJitterMs) || 0),
  };
  function policyFor(operation, overrides = {}) {
    const named = DEFAULT_OPERATION_POLICIES[operation] || {};
    const configured = operationPolicies?.[operation] || {};
    const policy = { ...basePolicy, ...named, ...configured, ...overrides };
    // `timeoutMs` and `firstByteTimeoutMs` remain accepted as request-level aliases.
    if (overrides.timeoutMs != null && overrides.requestTimeoutMs == null) policy.requestTimeoutMs = overrides.timeoutMs;
    if (overrides.firstByteTimeoutMs != null && overrides.responseHeaderWarningMs == null) policy.responseHeaderWarningMs = overrides.firstByteTimeoutMs;
    policy.requestTimeoutMs = Math.max(1_000, Number(policy.requestTimeoutMs) || basePolicy.requestTimeoutMs);
    policy.connectTimeoutMs = Math.max(250, Number(policy.connectTimeoutMs) || basePolicy.connectTimeoutMs);
    policy.responseHeaderTimeoutMs = Math.max(1_000, Math.min(policy.requestTimeoutMs, Number(policy.responseHeaderTimeoutMs) || policy.requestTimeoutMs));
    policy.responseHeaderWarningMs = Math.max(0, Math.min(policy.responseHeaderTimeoutMs, Number(policy.responseHeaderWarningMs) || 0));
    policy.responseBodyTimeoutMs = Math.max(1_000, Math.min(policy.requestTimeoutMs, Number(policy.responseBodyTimeoutMs) || policy.requestTimeoutMs));
    policy.maxAttempts = Math.max(1, Math.min(4, Number(policy.maxAttempts) || basePolicy.maxAttempts));
    policy.retryBaseDelayMs = Math.max(0, Number(policy.retryBaseDelayMs) || 0);
    policy.retryMaxDelayMs = Math.max(policy.retryBaseDelayMs, Number(policy.retryMaxDelayMs) || basePolicy.retryMaxDelayMs);
    policy.retryJitterMs = Math.max(0, Number(policy.retryJitterMs) || 0);
    return policy;
  }
  const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error('请求已取消'), { code: 'REQUEST_ABORTED' })); return; }
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('请求已取消'), { code: 'REQUEST_ABORTED' })); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  async function waitBeforeRetry(attempt, policy, signal) {
    const exponential = Math.min(policy.retryMaxDelayMs, policy.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)));
    const jitter = policy.retryJitterMs > 0 ? Math.floor(Math.max(0, Number(randomFn()) || 0) * policy.retryJitterMs) : 0;
    const delayMs = Math.max(0, exponential + jitter);
    if (!delayMs) return 0;
    await (sleepFn || defaultSleep)(delayMs, signal);
    metrics.retryDelayMs += delayMs;
    return delayMs;
  }

  function providerEndpoint(provider) { return /\/chat\/completions$/i.test(provider.baseUrl) ? provider.baseUrl : `${provider.baseUrl}/chat/completions`; }
  function available(provider) { return (state.get(provider.id)?.openUntil || 0) <= Date.now(); }
  function openCircuit(provider, error) {
    const item = state.get(provider.id);
    if (!item) return;
    item.failures += 1;
    item.lastError = { code: errorCode(error) || 'LLM_REQUEST_FAILED', message: String(error?.message || '').slice(0, 300), details: serializeError(error) };
    if (item.failures >= circuitFailureThreshold) item.openUntil = Date.now() + circuitCooldownMs;
  }
  function closeCircuit(provider) {
    const item = state.get(provider.id);
    if (item) { item.failures = 0; item.openUntil = 0; item.lastError = null; }
  }
  function cacheGet(key) {
    if (!key || cacheTtlMs <= 0) return null;
    const item = cache.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) { cache.delete(key); return null; }
    metrics.cacheHits += 1;
    return clone(item.value);
  }
  function cacheSet(key, value) { if (key && cacheTtlMs > 0) cache.set(key, { value: clone(value), expiresAt: Date.now() + cacheTtlMs }); }

  async function request(provider, messages, { signal = null, policy, maxOutputTokens = 4096, enableThinking: requestThinking = null, operation = 'json', attempt = 1, onEvent = null } = {}) {
    const requestTimeout = policy.requestTimeoutMs;
    const responseHeaderTimeout = Math.min(requestTimeout, policy.responseHeaderTimeoutMs);
    const responseHeaderWarning = Math.min(responseHeaderTimeout, policy.responseHeaderWarningMs);
    const responseBodyTimeout = Math.min(requestTimeout, policy.responseBodyTimeoutMs);
    const endpoint = providerEndpoint(provider);
    const startedAt = Date.now();
    const requestPayload = { model: provider.model, temperature: 0.1, max_tokens: Math.max(256, Number(maxOutputTokens) || 4096), ...(typeof (requestThinking ?? enableThinking) === 'boolean' ? { enable_thinking: requestThinking ?? enableThinking } : {}), response_format: { type: 'json_object' }, messages: clone(messages) };
    let responsePayload = null;
    let responseRaw = null;
    let responseStatus = null;
    let outcomeError = null;
    let timedOut = false;
    let responseHeaderTimedOut = false;
    let responseBodyTimedOut = false;
    let responseHeaderWarned = false;
    const controller = new AbortController();
    let cancelled = false;
    const abortFromCaller = () => { cancelled = true; controller.abort(signal?.reason); };
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeout);
    // `fetch()` resolves when response headers are available. The warning timer
    // is deliberately non-destructive; the hard timer remains the resource
    // protection boundary for a synchronous request.
    const emitNonBlocking = event => {
      try {
        const pending = onEvent?.(event);
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch { /* diagnostics must not change the request outcome */ }
    };
    const responseHeaderWarningTimer = responseHeaderWarning > 0 && responseHeaderWarning < responseHeaderTimeout
      ? setTimeout(() => {
        responseHeaderWarned = true;
        metrics.responseHeaderWarnings += 1;
        emitNonBlocking({
          type: 'gateway.slow',
          operation,
          phase: 'responseHeader',
          provider: provider.id,
          model: provider.model,
          elapsedMs: Date.now() - startedAt,
          responseHeaderWarningMs: responseHeaderWarning,
          responseHeaderTimeoutMs: responseHeaderTimeout,
          timeoutClass: 'soft-warning',
        });
      }, responseHeaderWarning)
      : null;
    // Native fetch reports TCP/TLS failures separately (for example
    // UND_ERR_CONNECT_TIMEOUT). This hard timer only protects the header phase.
    const responseHeaderTimer = setTimeout(() => { responseHeaderTimedOut = true; controller.abort(); }, responseHeaderTimeout);
    let responseBodyTimer = null;
    try {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
        });
      } catch (error) {
        if (cancelled) { const wrapped = new Error('请求已取消'); wrapped.code = 'REQUEST_ABORTED'; wrapped.cause = error; throw wrapped; }
        if (timedOut || responseHeaderTimedOut) {
          const wrapped = timedOut
            ? timeoutError(provider.id, 'LLM_TIMEOUT', 'total', requestTimeout, error)
            : timeoutError(provider.id, 'LLM_RESPONSE_HEADER_TIMEOUT', 'responseHeader', responseHeaderTimeout, error);
          throw wrapped;
        }
        const details = serializeError(error);
        const nested = details?.cause?.errors?.[0] || details?.cause || details;
        const diagnostic = nested?.code || nested?.message || '未知网络错误';
        const wrapped = new Error(`大模型请求失败 (${endpointHost(endpoint)}; ${diagnostic}): ${error?.message || '未知网络错误'}`);
        wrapped.code = error?.code === 'UND_ERR_CONNECT_TIMEOUT' ? 'LLM_CONNECT_TIMEOUT' : 'LLM_REQUEST_FAILED';
        wrapped.status = error?.status;
        wrapped.cause = error;
        throw wrapped;
      }
      clearTimeout(responseHeaderTimer);
      if (responseBodyTimeout > 0 && responseBodyTimeout < requestTimeout) responseBodyTimer = setTimeout(() => { responseBodyTimedOut = true; controller.abort(); }, responseBodyTimeout);
      responseStatus = response.status;
      let payload = {};
      if (typeof response.text === 'function') {
        try {
          responseRaw = await response.text();
        } catch (error) {
          if (cancelled) { const wrapped = new Error('请求已取消'); wrapped.code = 'REQUEST_ABORTED'; wrapped.cause = error; throw wrapped; }
          if (timedOut) throw timeoutError(provider.id, 'LLM_TIMEOUT', 'total', requestTimeout, error);
          if (responseBodyTimedOut) throw timeoutError(provider.id, 'LLM_RESPONSE_BODY_TIMEOUT', 'responseBody', responseBodyTimeout, error);
          throw error;
        }
        try { payload = responseRaw ? JSON.parse(responseRaw) : {}; } catch { payload = {}; }
      } else {
        try {
          payload = await response.json();
        } catch (error) {
          if (cancelled) { const wrapped = new Error('请求已取消'); wrapped.code = 'REQUEST_ABORTED'; wrapped.cause = error; throw wrapped; }
          if (timedOut) throw timeoutError(provider.id, 'LLM_TIMEOUT', 'total', requestTimeout, error);
          if (responseBodyTimedOut) throw timeoutError(provider.id, 'LLM_RESPONSE_BODY_TIMEOUT', 'responseBody', responseBodyTimeout, error);
          throw error;
        }
        try { responseRaw = JSON.stringify(payload); } catch { responseRaw = null; }
      }
      responsePayload = clone(payload);
      if (!response.ok) {
        const error = new Error(payload.error?.message || payload.message || `模型返回 ${response.status}`);
        error.status = response.status;
        error.code = response.status === 429 ? 'LLM_RATE_LIMITED' : response.status >= 500 ? 'LLM_UPSTREAM_ERROR' : 'LLM_REQUEST_FAILED';
        throw error;
      }
      const content = payload.choices?.[0]?.message?.content || payload.output_text || '';
      if (!String(content).trim()) { const error = new Error('模型返回为空'); error.code = 'LLM_EMPTY_RESPONSE'; throw error; }
      const text = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      try { return JSON.parse(text); }
      catch (error) { const wrapped = new Error('模型未返回合法 JSON'); wrapped.code = 'NARRATOR_SCHEMA_INVALID'; wrapped.cause = error; throw wrapped; }
    } catch (error) {
      outcomeError = error;
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(responseHeaderTimer);
      clearTimeout(responseHeaderWarningTimer);
      clearTimeout(responseBodyTimer);
      signal?.removeEventListener('abort', abortFromCaller);
      if (typeof onEvent === 'function') {
        try {
          await onEvent({
            type: 'gateway.attempt', operation, attempt, provider: provider.id, model: provider.model,
            endpointHost: endpointHost(endpoint), durationMs: Date.now() - startedAt,
            request: requestPayload, responseStatus, response: responsePayload, responseRaw,
            timeoutMs: requestTimeout, requestTimeoutMs: requestTimeout, connectTimeoutMs: policy.connectTimeoutMs,
            responseHeaderWarningMs: responseHeaderWarning, responseHeaderTimeoutMs: responseHeaderTimeout,
            responseBodyTimeoutMs: responseBodyTimeout, timedOut, responseHeaderTimedOut, responseBodyTimedOut,
            responseHeaderWarned, timeoutClass: timedOut ? 'hard-deadline' : responseBodyTimedOut ? 'response-body-hard-timeout' : responseHeaderTimedOut ? 'response-header-hard-timeout' : responseHeaderWarned ? 'completed-after-soft-warning' : 'completed',
            // Kept as a read-only diagnostic alias for older log readers.
            firstByteTimedOut: responseHeaderTimedOut, cancelled,
            error: outcomeError ? { code: errorCode(outcomeError) || 'LLM_REQUEST_FAILED', message: String(outcomeError.message || ''), details: serializeError(outcomeError) } : null,
          });
        } catch { /* diagnostics must not change the request outcome */ }
      }
    }
  }

  async function completeJson(messages, { signal = null, cacheKey = undefined, timeoutMs: timeoutOverrideMs = null, requestTimeoutMs = null, responseHeaderTimeoutMs: responseHeaderOverrideMs = null, responseHeaderWarningMs: responseHeaderWarningOverrideMs = null, responseBodyTimeoutMs: responseBodyOverrideMs = null, firstByteTimeoutMs: firstByteOverrideMs = null, operation = 'json', maxOutputTokens = 4096, enableThinking: requestThinking = null, onEvent = null } = {}) {
    const key = cacheKey === null ? null : cacheKey || hash({ operation, messages, providers: normalizedProviders.map(provider => `${provider.id}:${provider.model}`) });
    const cached = cacheGet(key);
    if (cached) {
      lastCall = { status: 'cache-hit', operation, provider: 'cache', attempts: 0, durationMs: 0 };
      try { await onEvent?.({ type: 'gateway.cache-hit', operation, durationMs: 0 }); } catch { /* ignore diagnostics failure */ }
      return cached;
    }
    if (!normalizedProviders.length) { const error = new Error('未配置可用的 LLM Provider'); error.code = 'INSIGHT_LLM_REQUIRED'; error.status = 503; throw error; }
    metrics.calls += 1;
    const startedAt = Date.now();
    const attempts = [];
    let lastError = null;
    let attemptCount = 0;
    let previousProviderId = null;
    const policy = policyFor(operation, {
      ...(requestTimeoutMs != null ? { requestTimeoutMs } : {}),
      ...(timeoutOverrideMs != null ? { timeoutMs: timeoutOverrideMs } : {}),
      ...(responseHeaderOverrideMs != null ? { responseHeaderTimeoutMs: responseHeaderOverrideMs } : {}),
      ...(responseHeaderWarningOverrideMs != null ? { responseHeaderWarningMs: responseHeaderWarningOverrideMs } : {}),
      ...(responseBodyOverrideMs != null ? { responseBodyTimeoutMs: responseBodyOverrideMs } : {}),
      ...(firstByteOverrideMs != null ? { firstByteTimeoutMs: firstByteOverrideMs } : {}),
    });
    const max = policy.maxAttempts;
    const candidates = normalizedProviders.filter(available);
    if (!candidates.length) {
      metrics.circuitOpen += 1;
      const error = new Error('所有 LLM Provider 当前处于熔断状态');
      error.code = 'LLM_CIRCUIT_OPEN';
      error.retryable = true;
      throw error;
    }
    for (let round = 0; round < max && attemptCount < max; round += 1) {
      const provider = candidates[round % candidates.length];
      if (!available(provider)) { metrics.circuitOpen += 1; continue; }
      attemptCount += 1;
      try {
        const value = await request(provider, messages, { signal, policy, maxOutputTokens, enableThinking: requestThinking, operation, attempt: attemptCount, onEvent });
        closeCircuit(provider);
        metrics.successes += 1;
        if (previousProviderId && previousProviderId !== provider.id) metrics.fallbacks += 1;
        lastCall = { status: 'completed', operation, provider: provider.id, model: provider.model, attempts: attemptCount, durationMs: Date.now() - startedAt, retries: Math.max(0, attemptCount - 1), policy: clone(policy) };
        cacheSet(key, value);
        return value;
      } catch (error) {
        lastError = error;
        previousProviderId = provider.id;
        if (['LLM_TIMEOUT', 'LLM_CONNECT_TIMEOUT', 'LLM_RESPONSE_HEADER_TIMEOUT'].includes(error.code)) metrics.timeouts += 1;
        if (error.code === 'LLM_CONNECT_TIMEOUT') metrics.connectTimeouts += 1;
        if (error.code === 'LLM_RESPONSE_HEADER_TIMEOUT') metrics.responseHeaderTimeouts += 1;
        if (error.code === 'LLM_RESPONSE_BODY_TIMEOUT') { metrics.responseBodyTimeouts += 1; metrics.timeouts += 1; }
        openCircuit(provider, error);
        attempts.push({ provider: provider.id, model: provider.model, code: errorCode(error), durationMs: Date.now() - startedAt, phase: error.phase || null });
        if (!retryable(error) || attemptCount >= max) break;
        metrics.retries += 1;
        await waitBeforeRetry(attemptCount, policy, signal);
      }
    }
    metrics.failures += 1;
    const finalError = lastError || new Error('LLM 调用失败');
    finalError.gateway = { attempts, providerCount: normalizedProviders.length, maxAttempts: max, operation, policy: clone(policy) };
    lastCall = { status: 'failed', operation, provider: attempts.at(-1)?.provider || null, attempts: attemptCount, durationMs: Date.now() - startedAt, retries: Math.max(0, attemptCount - 1), errorCode: errorCode(finalError), policy: clone(policy) };
    throw finalError;
  }

  async function transport({ messages, signal = null, maxOutputTokens = 4096, enableThinking: requestThinking = null, operation = 'exploration', onEvent = null } = {}) { return completeJson(messages, { signal, operation, maxOutputTokens, enableThinking: requestThinking, onEvent }); }
  async function probe() { const startedAt = Date.now(); const result = await completeJson([{ role: 'system', content: 'Return only a JSON object: {"ok":true}.' }, { role: 'user', content: 'Confirm JSON connectivity.' }], { operation: 'probe', cacheKey: null }); return { ok: result?.ok === true, model: lastCall?.model || null, latencyMs: Date.now() - startedAt, gateway: clone(lastCall) }; }
  async function diagnose() {
    return Promise.all(normalizedProviders.map(async provider => ({ id: provider.id, model: provider.model, endpoint: providerEndpoint(provider), network: await diagnoseEndpoint(providerEndpoint(provider), { timeoutMs: basePolicy.connectTimeoutMs }) })));
  }
  function snapshot() { return { metrics: clone(metrics), providers: normalizedProviders.map(provider => ({ id: provider.id, model: provider.model, open: !available(provider), state: clone(state.get(provider.id)) })), cacheSize: cache.size, lastCall: clone(lastCall) }; }

  return { enabled: normalizedProviders.length > 0, model: normalizedProviders[0]?.model || null, completeJson, transport, probe, diagnose, snapshot };
}

export const llmGatewayVersion = 'wynai.llm-gateway/v1';
