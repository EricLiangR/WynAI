const MANAGER_SCHEMA = 'wynai.platform-gateway-manager/v1';

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function managerError(message, code = 'PLATFORM_GATEWAY_INVALID') { const error = new Error(message); error.code = code; error.status = code === 'LLM_TOTAL_DEADLINE_EXCEEDED' ? 504 : 400; return error; }

/**
 * Governance facade around module-specific gateways. It preserves the gateway
 * error/status contract while enforcing a shared absolute operation deadline.
 */
export function createPlatformGatewayManager({ gateways = {}, operationBudgets = {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const entries = new Map(Object.entries(gateways).filter(([, gateway]) => gateway && typeof gateway.completeJson === 'function'));
  if (!entries.size) throw managerError('至少需要一个可用 Gateway');
  const budgets = Object.fromEntries(Object.entries(operationBudgets).map(([name, value]) => [name, Math.max(1_000, Number(value) || 60_000)]));
  const calls = new Map();

  function gatewayFor(name) {
    const gateway = entries.get(name);
    if (!gateway) throw managerError(`未注册 Gateway：${name}`);
    return gateway;
  }

  async function completeJson(name, messages, options = {}) {
    const gateway = gatewayFor(name);
    const budgetMs = Math.max(1_000, Number(options.totalBudgetMs || budgets[name] || budgets.default || 60_000));
    const externalSignal = options.signal || null;
    const controller = new AbortController();
    let deadlineReached = false;
    const startedAt = now();
    const forwardAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimer(() => { deadlineReached = true; controller.abort(); }, budgetMs);
    const onEvent = async event => options.onEvent?.({ ...event, platformGateway: name, absoluteBudgetMs: budgetMs, elapsedMs: Math.max(0, now() - startedAt) });
    try {
      return await gateway.completeJson(messages, { ...options, signal: controller.signal, onEvent });
    } catch (error) {
      if (deadlineReached && !externalSignal?.aborted && !['LLM_TIMEOUT', 'LLM_RESPONSE_HEADER_TIMEOUT', 'LLM_RESPONSE_BODY_TIMEOUT'].includes(error?.code)) {
        const wrapped = managerError(`平台 LLM 操作超过绝对总预算 (${budgetMs}ms)`, 'LLM_TOTAL_DEADLINE_EXCEEDED');
        wrapped.phase = 'platform-total'; wrapped.timeoutMs = budgetMs; wrapped.cause = error; throw wrapped;
      }
      throw error;
    } finally {
      clearTimer(timer);
      externalSignal?.removeEventListener('abort', forwardAbort);
      const item = calls.get(name) || { calls: 0, failures: 0, successes: 0 };
      item.calls += 1;
      if (deadlineReached) item.deadlineExceeded = (item.deadlineExceeded || 0) + 1;
      calls.set(name, item);
    }
  }

  function transport(name) {
    return options => completeJson(name, options?.messages || [], options);
  }

  async function probe(name = null) {
    const names = name ? [name] : [...entries.keys()];
    const results = [];
    for (const item of names) {
      const gateway = gatewayFor(item);
      if (typeof gateway.probe !== 'function') { results.push({ name: item, ok: gateway.enabled !== false, skipped: true }); continue; }
      try { results.push({ name: item, ...(await gateway.probe()) }); }
      catch (error) { results.push({ name: item, ok: false, code: error.code || 'LLM_PROBE_FAILED', message: error.message }); }
    }
    return results;
  }

  function snapshot() {
    const operations = Object.fromEntries([...entries.entries()].map(([name, gateway]) => [name, { gateway: clone(gateway.snapshot?.() || null), manager: clone(calls.get(name) || { calls: 0, failures: 0, successes: 0 }) }]));
    const enabled = [...entries.values()].some(gateway => gateway.enabled !== false);
    const open = [...entries.values()].every(gateway => gateway.snapshot?.().providers?.length && gateway.snapshot().providers.every(provider => provider.open));
    return { schema: MANAGER_SCHEMA, version: 1, enabled, status: !enabled ? 'not_configured' : open ? 'circuit_open' : 'available', operationBudgets: clone(budgets), operations };
  }

  return { schema: MANAGER_SCHEMA, version: 1, completeJson, transport, probe, snapshot, gatewayNames: () => [...entries.keys()] };
}

export const platformGatewayManagerVersion = MANAGER_SCHEMA;
