const TERMINAL = new Set(['request.completed', 'request.failed', 'request.cancelled']);
const finite = value => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const rate = (n, d) => d ? n / d : null;
const safe = value => typeof value === 'string' ? value.slice(0, 160) : null;
const codes = values => [...new Set(values.filter(Boolean).map(safe))];

export function classifyQualityError(code = '') {
  if (/TIMEOUT|NETWORK|CONNECT|CIRCUIT|HTTP|RATE_LIMIT/.test(code)) return 'llm-transport';
  if (/JSON|OUTPUT|SCHEMA|EMPTY_RESPONSE/.test(code)) return 'model-output';
  if (/INTENT_VALIDATION|COVERAGE|MAPPING|COMPILE|NARRATION_DELIVERY|SEMANTIC/.test(code)) return 'contract';
  if (/QUERY|WAX|DATASET/.test(code)) return 'query-execution';
  return code ? 'unclassified' : null;
}

/** Only safe scalar metrics and identifiers cross the quality boundary. */
export function buildQualityDetails(response = {}, error = null) {
  const sets = response.resultSets;
  const hasResult = Array.isArray(sets) && sets.length > 0;
  const rows = hasResult ? sets.reduce((n, set) => n + (set.rows?.length || 0), 0) : null;
  const p = response.planningDiagnostics || error?.details || {};
  return {
    qualityVersion: 1, status: error ? 'failed' : response.status || 'unknown',
    skillRefs: codes(response.diagnostics?.skillRefs || response.businessIntent?.skillRefs || []),
    hasResult, resultRows: rows,
    totals: hasResult ? sets.map(set => ({ returnedRows: set.rows?.length || 0,
      totalRows: finite(set.quality?.totalRowCount ?? set.statistics?.totalRowCount),
      limited: Boolean(set.quality?.isSample || set.quality?.isTruncated || set.quality?.limitReached) })) : [],
    resultLimited: hasResult ? sets.some(set => set.quality?.isSample || set.quality?.isTruncated || set.quality?.limitReached) : null,
    llmCalls: finite(p.llmCalls), llmAttempted: typeof p.llmAttempted === 'boolean' ? p.llmAttempted : null,
    repairAttempted: typeof p.repairAttempted === 'boolean' ? p.repairAttempted : null,
    code: safe(error?.code), failureCategory: safe(p.failureCategory),
    constraintViolation: response.semanticValidation?.valid === false || classifyQualityError(error?.code) === 'contract',
  };
}

export function qualityRecords(events = []) {
  const traces = new Map();
  const seen = new Set();
  for (const event of events) {
    if (!event?.traceId || (event.id && seen.has(event.id))) continue;
    if (event.id) seen.add(event.id);
    if (!traces.has(event.traceId)) traces.set(event.traceId, []);
    traces.get(event.traceId).push(event);
  }
  return [...traces].map(([traceId, list]) => {
    list.sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || Date.parse(a.at) - Date.parse(b.at));
    const terminal = list.filter(e => TERMINAL.has(e.event)).at(-1);
    const start = list.find(e => e.event === 'request.accepted');
    const planning = list.findLast(e => e.event === 'planning.completed')?.details?.diagnostics || {};
    const d = terminal?.details || {};
    const attempts = list.filter(e => e.event === 'gateway.attempt');
    const cacheHits = list.filter(e => e.event === 'gateway.cache-hit').length;
    const repairs = list.filter(e => e.event === 'narration.repair').length;
    const errors = codes([d.code, ...list.filter(e => /failed$/.test(e.event)).map(e => e.details?.code)]);
    const status = !terminal ? 'incomplete' : terminal.event === 'request.failed' ? 'failed' : terminal.event === 'request.cancelled' ? 'cancelled' : d.status || terminal.outcome || 'unknown';
    const hasResult = d.qualityVersion === 1 ? d.hasResult : typeof d.resultRows === 'number' ? true : null;
    const llmCalls = finite(d.llmCalls ?? planning.llmCalls);
    return {
      traceId: safe(traceId), at: terminal?.at || start?.at || list[0]?.at,
      datasetId: safe(list.find(e => e.datasetId)?.datasetId) || 'unknown',
      conversationId: safe(list.find(e => e.conversationId)?.conversationId),
      skillRefs: codes([...(d.skillRefs || []), ...list.filter(e => e.event === 'skill.resolved').flatMap(e => e.details?.skillRefs || [])]),
      models: codes(attempts.map(e => e.details?.model)), status, hasResult,
      resultRows: hasResult ? finite(d.resultRows) : null,
      resultLimited: hasResult ? d.resultLimited ?? null : null,
      totals: d.qualityVersion === 1 ? (d.totals || []).map(t => ({ returnedRows: finite(t.returnedRows), totalRows: finite(t.totalRows), limited: t.limited === true })) : [],
      durationMs: finite(terminal?.durationMs),
      llmCalls, attempts: attempts.length, failedAttempts: attempts.filter(e => e.outcome === 'failed' || e.details?.error).length,
      cacheHits,
      transportRetried: attempts.length ? attempts.some(e => Number(e.details?.attempt) > 1) : null,
      outputRepairs: attempts.filter(e => e.details?.error?.category === 'model-output').length + repairs,
      semanticRepaired: d.repairAttempted ?? planning.repairAttempted ?? null,
      constraintViolation: d.constraintViolation === true || list.some(e => e.event === 'result.validated' && e.details?.valid === false) || errors.some(code => classifyQualityError(code) === 'contract'),
      feedbackReceived: list.some(e => e.event === 'feedback.received'),
      errors, category: classifyQualityError(errors[0]), owner: errors.length ? '待调查' : null,
      traceComplete: Boolean(start && terminal),
      events: list.map(e => ({ event: safe(e.event), at: e.at, phase: safe(e.phase), outcome: safe(e.outcome),
        code: safe(e.details?.code || e.details?.error?.code), operation: safe(e.details?.operation), model: safe(e.details?.model), attempt: finite(e.details?.attempt), durationMs: finite(e.durationMs) })),
    };
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function percentile(values, p) {
  const sorted = values.filter(v => v != null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
}
function aggregate(records) {
  const closed = records.filter(r => r.status !== 'incomplete');
  const count = status => closed.filter(r => r.status === status).length;
  const results = closed.filter(r => r.status === 'ok' && r.hasResult === true);
  const retryKnown = closed.filter(r => r.transportRetried !== null);
  const repairKnown = closed.filter(r => r.semanticRepaired !== null);
  const firstKnown = closed.filter(r => r.transportRetried !== null && r.semanticRepaired !== null);
  const attempts = closed.reduce((n, r) => n + r.attempts, 0);
  const failedAttempts = closed.reduce((n, r) => n + r.failedAttempts, 0);
  const errorCodes = Object.fromEntries(codes(closed.flatMap(r => r.errors)).map(c => [c, closed.filter(r => r.errors.includes(c)).length]));
  return { requests: records.length, terminalRequests: closed.length, completed: count('ok'), failed: count('failed'),
    cancelled: count('cancelled'), clarification: count('needs_clarification'), incomplete: records.length - closed.length,
    successRate: rate(count('ok'), closed.length), failureRate: rate(count('failed'), closed.length),
    llmAttempts: attempts, llmFailedAttempts: failedAttempts, llmSuccessRate: rate(attempts - failedAttempts, attempts),
    firstSuccessRate: rate(firstKnown.filter(r => r.status === 'ok' && !r.transportRetried && !r.semanticRepaired && !r.outputRepairs).length, firstKnown.length),
    retryRate: rate(retryKnown.filter(r => r.transportRetried).length, retryKnown.length),
    semanticRepairRate: rate(repairKnown.filter(r => r.semanticRepaired).length, repairKnown.length),
    outputRepairRequests: closed.filter(r => r.outputRepairs > 0).length,
    emptyResultRate: rate(results.filter(r => r.resultRows === 0).length, results.length),
    limitedResultRate: rate(results.filter(r => r.resultLimited === true).length, results.filter(r => r.resultLimited !== null).length),
    constraintViolationRate: rate(closed.filter(r => r.constraintViolation).length, closed.length),
    feedbackRate: rate(closed.filter(r => r.feedbackReceived).length, closed.length),
    observed: { retry: retryKnown.length, semanticRepair: repairKnown.length, results: results.length, firstSuccess: firstKnown.length },
    latencyMs: { p50: percentile(closed.map(r => r.durationMs), .5), p95: percentile(closed.map(r => r.durationMs), .95), max: percentile(closed.map(r => r.durationMs), 1) }, errorCodes };
}

export function summarizeQueryQuality(events = [], options = {}) {
  const { since = null, until = null, datasetId, skillRef, model, status } = options;
  for (const value of [since, until]) if (value && !Number.isFinite(Date.parse(value))) throw Object.assign(new Error('时间范围格式无效'), { status: 400 });
  if (since && until && Date.parse(since) > Date.parse(until)) throw Object.assign(new Error('开始时间不能晚于结束时间'), { status: 400 });
  const all = qualityRecords(events);
  const records = all.filter(r => (!since || Date.parse(r.at) >= Date.parse(since)) && (!until || Date.parse(r.at) <= Date.parse(until)) &&
    (!datasetId || r.datasetId === datasetId) && (!skillRef || r.skillRefs.includes(skillRef)) && (!model || r.models.includes(model)) && (!status || r.status === status));
  const total = aggregate(records);
  const group = getter => codes(records.flatMap(getter)).map(key => ({ key, ...aggregate(records.filter(r => getter(r).includes(key))) }));
  const minSamples = Math.max(1, Math.min(100000, Number(options.minSamples) || 20));
  const maxFailureRate = options.maxFailureRate == null ? .1 : Number(options.maxFailureRate);
  if (!Number.isFinite(maxFailureRate) || maxFailureRate < 0 || maxFailureRate > 1) throw Object.assign(new Error('失败率阈值须为 0 至 1'), { status: 400 });
  const alerts = total.terminalRequests >= minSamples && total.failureRate > maxFailureRate
    ? [{ code: 'HIGH_FAILURE_RATE', level: 'warning', observed: total.failureRate, threshold: maxFailureRate, message: '查询失败率超过阈值，请查看失败记录。' }] : [];
  return { schema: 'wynai.query-quality-summary/v1', generatedAt: new Date().toISOString(), window: { since, until }, total,
    datasets: group(r => [r.datasetId]), skills: group(r => r.skillRefs), models: group(r => r.models),
    facets: { datasets: codes(all.map(r => r.datasetId)), skills: codes(all.flatMap(r => r.skillRefs)), models: codes(all.flatMap(r => r.models)) },
    alerts, thresholds: { minSamples, maxFailureRate }, traceCount: records.length,
    coverage: { retainedEvents: events.length, incompleteTraces: records.filter(r => !r.traceComplete).length, scope: 'retained-events', note: '仅统计保留的事件；非全历史。缺失指标为未知，空结果不等于错误，问题归属需调查。' },
    records };
}
