import { randomUUID } from 'node:crypto';

const STATES = new Set(['queued', 'planning', 'running', 'completed', 'failed']);
const TERMINAL = new Set(['completed', 'failed']);
const TRANSITIONS = {
  queued: new Set(['planning', 'running', 'failed']),
  planning: new Set(['running', 'failed']),
  running: new Set(['completed', 'failed']),
  completed: new Set(['planning']),
  failed: new Set(['planning']),
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9-]{8,100}$/.test(id)) throw new Error('无效的洞察运行 ID');
  return id;
}
function now() { return new Date().toISOString(); }

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
    for (const run of loaded || []) if (run?.id && STATES.has(run.status)) this.runs.set(run.id, run);
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
    const timestamp = now();
    const run = {
      schema: 'wynai.insight-run/v1', id: validId(this.idFactory()), mode, status: 'queued', insightId, parentRunId: parentRunId ? String(parentRunId).slice(0, 100) : null,
      datasetIds: [...new Set(datasetIds.map(String))].slice(0, 16), question: String(question || '').slice(0, 4000),
      actor: actor ? String(actor).slice(0, 200) : null, organizationId: organizationId ? String(organizationId).slice(0, 200) : null,
      skill: skill ? clone(skill) : null, plan: null, toolCalls: [], evidenceIds: [], document: null, error: null, attempt: 1,
      createdAt: timestamp, updatedAt: timestamp, metadata: clone(metadata || {}),
    };
    await this.save(run);
    return clone(run);
  }
  async transition(id, status, patch = {}) {
    if (!STATES.has(status)) throw new Error(`不支持洞察运行状态 ${status}`);
    const current = this.runs.get(validId(id));
    if (!current) throw new Error('洞察运行不存在');
    if (current.status !== status && !TRANSITIONS[current.status]?.has(status)) throw new Error(`洞察运行不能从 ${current.status} 转为 ${status}`);
    const next = { ...current, ...clone(patch), status, updatedAt: now() };
    if (status === 'completed') next.completedAt = next.updatedAt;
    if (status === 'failed') next.failedAt = next.updatedAt;
    return this.save(next);
  }
  async complete(id, patch = {}) { return this.transition(id, 'completed', patch); }
  async fail(id, error, patch = {}) {
    const detail = error instanceof Error ? error.message : String(error || '洞察运行失败');
    return this.transition(id, 'failed', { ...patch, error: { message: detail.slice(0, 1000), code: error?.code || 'INSIGHT_RUN_FAILED' } });
  }
  async retry(id) {
    const current = this.runs.get(validId(id));
    if (!current) throw new Error('洞察运行不存在');
    if (!TERMINAL.has(current.status)) throw new Error('只有已完成或失败的运行可以重试');
    return this.transition(id, 'planning', { attempt: Number(current.attempt || 1) + 1, error: null, document: null, plan: null, toolCalls: [], evidenceIds: [] });
  }
}

export const insightRunStates = [...STATES];
