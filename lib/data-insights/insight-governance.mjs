import { createHash, randomUUID } from 'node:crypto';

function bounded(value, fallback = '', max = 4000) { return String(value ?? fallback).trim().slice(0, max); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function hash(value) { return createHash('sha256').update(String(value || '')).digest('hex'); }

export function redactInsightInput(input = {}, sensitiveFields = []) {
  const fields = new Set((sensitiveFields || []).map(String));
  const redacted = clone(input);
  let redactedCellCount = 0;
  for (const resultSet of redacted.resultSets || []) {
    for (const row of resultSet.rows || []) {
      for (const field of fields) if (Object.prototype.hasOwnProperty.call(row, field)) { row[field] = '[REDACTED]'; redactedCellCount += 1; }
    }
  }
  return { input: redacted, policy: { sensitiveFields: [...fields], redactedCellCount, rawRowsToLlm: false } };
}

export class InsightGovernanceService {
  constructor({ auditPersistence = null, maxGenerations = 20, windowMs = 60 * 60 * 1000, maxConcurrent = 2, timeoutMs = 180_000 } = {}) {
    this.auditPersistence = auditPersistence;
    this.maxGenerations = Math.max(1, Number(maxGenerations) || 20);
    this.windowMs = Math.max(1000, Number(windowMs) || 3600000);
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 2);
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 180000);
    this.audit = [];
    this.generationWindows = new Map();
    this.active = new Map();
  }

  async init() { if (this.auditPersistence) this.audit = (await this.auditPersistence.init()).slice(0, 5000); return this; }

  identityKey(identity = {}) { return `${identity.organizationId || 'no-org'}:${identity.actor || identity.userId || 'anonymous'}`; }

  beginGeneration(identity = {}) {
    const key = this.identityKey(identity);
    const now = Date.now();
    const active = this.active.get(key) || 0;
    if (active >= this.maxConcurrent) { const error = new Error('数据洞察并发运行数已达到上限'); error.code = 'INSIGHT_CONCURRENCY_LIMIT'; error.status = 429; throw error; }
    const entries = (this.generationWindows.get(key) || []).filter(timestamp => now - timestamp < this.windowMs);
    if (entries.length >= this.maxGenerations) { const error = new Error('数据洞察生成配额已用尽，请稍后重试'); error.code = 'INSIGHT_QUOTA_EXCEEDED'; error.status = 429; error.retryAfterMs = Math.max(1, this.windowMs - (now - entries[0])); throw error; }
    entries.push(now); this.generationWindows.set(key, entries); this.active.set(key, active + 1);
    let released = false;
    return () => { if (released) return; released = true; this.active.set(key, Math.max(0, (this.active.get(key) || 1) - 1)); };
  }

  record(event = {}) {
    const item = { id: `insight-audit-${randomUUID()}`, schema: 'wynai.insight-audit/v1', at: new Date().toISOString(), actor: bounded(event.actor, 'anonymous', 200), organizationId: event.organizationId ? bounded(event.organizationId, '', 200) : null, insightId: event.insightId ? bounded(event.insightId, '', 100) : null, runId: event.runId ? bounded(event.runId, '', 100) : null, action: bounded(event.action, 'unknown', 100), status: bounded(event.status, 'unknown', 40), model: event.model ? bounded(event.model, '', 160) : null, promptHash: event.prompt ? hash(event.prompt) : event.promptHash || null, promptLength: Number(event.promptLength ?? String(event.prompt || '').length) || 0, toolCalls: Array.isArray(event.toolCalls) ? clone(event.toolCalls).slice(0, 20) : [], stageAudit: Array.isArray(event.stageAudit) ? clone(event.stageAudit).slice(0, 8) : [], skillRefs: Array.isArray(event.skillRefs) ? event.skillRefs.map(value => bounded(value, '', 160)).slice(0, 32) : [], externalDataPolicy: clone(event.externalDataPolicy || { rawRowsToLlm: false }), gateway: event.gateway ? clone(event.gateway) : null, errorCode: event.errorCode || null };
    this.audit.unshift(item); this.audit = this.audit.slice(0, 5000);
    if (this.auditPersistence) this.auditPersistence.save(item).catch(() => null);
    return clone(item);
  }

  list({ actor = null, organizationId = null, limit = 100 } = {}) { return this.audit.filter(item => (!actor || item.actor === actor) && (!organizationId || item.organizationId === organizationId)).slice(0, Math.max(1, Math.min(500, Number(limit) || 100))).map(clone); }
}

export const insightAuditVersion = 'wynai.insight-audit/v1';
