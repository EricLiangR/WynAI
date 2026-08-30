import { randomUUID } from 'node:crypto';

const STATES = new Set(['queued', 'planning', 'running', 'completed', 'failed', 'interrupted']);
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const TRANSITIONS = {
  queued: new Set(['planning', 'running', 'failed', 'interrupted']),
  planning: new Set(['running', 'failed', 'interrupted']),
  running: new Set(['completed', 'failed', 'interrupted']),
  completed: new Set(['planning']),
  failed: new Set(['planning']),
  interrupted: new Set(['planning']),
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9-]{8,100}$/.test(id)) throw new Error('无效的洞察运行 ID');
  return id;
}
function now() { return new Date().toISOString(); }

function attemptId(runId, attempt) { return `at-${String(runId).slice(0, 48)}-${attempt}-${randomUUID().slice(0, 8)}`; }

function normalizeAttempt(run, item, index = 0) {
  const attempt = Number(item?.attempt || index + 1) || index + 1;
  return {
    attempt,
    attemptId: String(item?.attemptId || attemptId(run.id, attempt)).slice(0, 100),
    status: STATES.has(item?.status) ? item.status : (index === 0 ? run.status : 'queued'),
    createdAt: item?.createdAt || run.createdAt,
    updatedAt: item?.updatedAt || run.updatedAt || run.createdAt,
    startedAt: item?.startedAt || null,
    completedAt: item?.completedAt || null,
    failedAt: item?.failedAt || null,
    interruptedAt: item?.interruptedAt || null,
    interruption: item?.interruption ? clone(item.interruption) : null,
    error: item?.error ? clone(item.error) : null,
  };
}

function normalizeRun(run) {
  const attempts = Array.isArray(run.attempts) && run.attempts.length
    ? run.attempts.map((item, index) => normalizeAttempt(run, item, index))
    : [normalizeAttempt(run, { attempt: run.attempt || 1, attemptId: run.attemptId, status: run.status }, 0)];
  const current = attempts.at(-1);
  return { ...run, attempt: Number(run.attempt || current.attempt) || current.attempt, attemptId: String(run.attemptId || current.attemptId), attempts };
}

export class InsightRunStore {
  constructor({ persistence = null, maxItems = 200, idFactory = () => `ir-${randomUUID()}` } = {}) {
    this.persistence = persistence;
    this.maxItems = Math.max(1, Number(maxItems) || 200);
    this.idFactory = idFactory;
    this.runs = new Map();
  }
  async init() {
    if (!this.persistence) return this.list();
    const loaded = await this.persistence.init();
    for (const run of loaded || []) if (run?.id && STATES.has(run.status)) this.runs.set(run.id, normalizeRun(run));
    return this.list();
  }
  get(id) {
    const run = this.runs.get(validId(id));
    return run ? clone(run) : null;
  }
  list({ mode = null, status = null, insightId = null } = {}) {
    return [...this.runs.values()]
      .filter(run => !mode || run.mode === mode)
      .filter(run => !status || run.status === status)
      .filter(run => !insightId || run.insightId === insightId)
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''))
      .map(clone);
  }
  async save(run) {
    const persisted = clone(run);
    this.runs.set(persisted.id, persisted);
    if (this.persistence) await this.persistence.save(persisted);
    for (const stale of this.list().slice(this.maxItems)) this.runs.delete(stale.id);
    return clone(persisted);
  }
  async create({ mode = 'interpret', insightId = null, parentRunId = null, datasetIds = [], question = '', actor = null, organizationId = null, skill = null, metadata = {} } = {}) {
    if (!['interpret', 'explore'].includes(mode)) throw new Error('洞察运行模式必须是 interpret 或 explore');
    if (mode === 'interpret' && !insightId) throw new Error('interpret 运行必须关联 insightId');
    if (mode === 'explore' && (!Array.isArray(datasetIds) || !datasetIds.length)) throw new Error('explore 运行至少需要一个数据集');
    const id = validId(this.idFactory());
    const timestamp = now();
    const run = {
      schema: 'wynai.insight-run/v1', id, mode, status: 'queued', insightId, parentRunId: parentRunId ? String(parentRunId).slice(0, 100) : null,
      datasetIds: [...new Set(datasetIds.map(String))].slice(0, 16), question: String(question || '').slice(0, 4000),
      actor: actor ? String(actor).slice(0, 200) : null, organizationId: organizationId ? String(organizationId).slice(0, 200) : null,
      skill: skill ? clone(skill) : null, plan: null, toolCalls: [], evidenceIds: [], document: null, error: null, attempt: 1,
      attemptId: attemptId(id, 1), attempts: [], createdAt: timestamp, updatedAt: timestamp, metadata: clone(metadata || {}),
    };
    run.attempts = [normalizeAttempt(run, { attempt: 1, attemptId: run.attemptId, status: 'queued', createdAt: timestamp, updatedAt: timestamp })];
    await this.save(run);
    return clone(run);
  }
  async transition(id, status, patch = {}) {
    if (!STATES.has(status)) throw new Error(`不支持洞察运行状态 ${status}`);
    const current = this.runs.get(validId(id));
    if (!current) throw new Error('洞察运行不存在');
    if (current.status !== status && !TRANSITIONS[current.status]?.has(status)) throw new Error(`洞察运行不能从 ${current.status} 转为 ${status}`);
    const updatedAt = now();
    const next = { ...normalizeRun(current), ...clone(patch), status, updatedAt };
    const attempts = [...next.attempts];
    const currentAttempt = { ...(attempts.at(-1) || normalizeAttempt(next, {}, attempts.length)) };
    currentAttempt.status = status;
    currentAttempt.updatedAt = updatedAt;
    if (status === 'running' && !currentAttempt.startedAt) currentAttempt.startedAt = updatedAt;
    if (status === 'completed') { next.completedAt = updatedAt; currentAttempt.completedAt = updatedAt; }
    if (status === 'failed') { next.failedAt = updatedAt; currentAttempt.failedAt = updatedAt; currentAttempt.error = clone(next.error); }
    if (status === 'interrupted') { next.interruptedAt = updatedAt; currentAttempt.interruptedAt = updatedAt; currentAttempt.interruption = clone(next.interruption || { reason: 'unknown', detectedAt: updatedAt }); currentAttempt.error = clone(next.error); }
    if (status === 'planning' && current.status === 'queued' && !currentAttempt.startedAt) currentAttempt.startedAt = updatedAt;
    attempts[attempts.length - 1] = currentAttempt;
    next.attempts = attempts;
    next.attempt = currentAttempt.attempt;
    next.attemptId = currentAttempt.attemptId;
    if (status === 'completed') next.completedAt = next.updatedAt;
    if (status === 'failed') next.failedAt = next.updatedAt;
    return this.save(next);
  }
  async complete(id, patch = {}) { return this.transition(id, 'completed', patch); }
  async fail(id, error, patch = {}) {
    const detail = error instanceof Error ? error.message : String(error || '洞察运行失败');
    return this.transition(id, 'failed', { ...patch, error: { message: detail.slice(0, 1000), code: error?.code || 'INSIGHT_RUN_FAILED' } });
  }
  async interrupt(id, reason = 'unknown', patch = {}) {
    const current = this.runs.get(validId(id));
    if (!current) throw new Error('洞察运行不存在');
    if (TERMINAL.has(current.status)) return clone(current);
    const interruption = { reason: String(reason || 'unknown').slice(0, 120), detectedAt: now(), processId: process.pid };
    return this.transition(id, 'interrupted', { ...patch, interruption, error: { message: `洞察运行已中断：${interruption.reason}`, code: 'INSIGHT_RUN_INTERRUPTED' } });
  }
  async recoverUnfinished(reason = 'process-restart') {
    const recovered = [];
    for (const run of this.list()) {
      if (!TERMINAL.has(run.status)) recovered.push(await this.interrupt(run.id, reason));
    }
    return recovered;
  }
  async retry(id) {
    const current = this.runs.get(validId(id));
    if (!current) throw new Error('洞察运行不存在');
    if (!TERMINAL.has(current.status)) throw new Error('只有已完成、失败或中断的运行可以重试');
    const normalized = normalizeRun(current);
    const nextAttempt = Number(normalized.attempt || normalized.attempts.at(-1)?.attempt || 1) + 1;
    const timestamp = now();
    const freshAttempt = normalizeAttempt(normalized, { attempt: nextAttempt, attemptId: attemptId(normalized.id, nextAttempt), status: 'planning', createdAt: timestamp, updatedAt: timestamp }, normalized.attempts.length);
    const next = { ...normalized, status: 'planning', attempt: nextAttempt, attemptId: freshAttempt.attemptId, attempts: [...normalized.attempts, freshAttempt], error: null, document: null, plan: null, toolCalls: [], evidenceIds: [], updatedAt: timestamp };
    return this.save(next);
  }
}

export const insightRunStates = [...STATES];
