import { randomUUID } from 'node:crypto';

function bounded(value, length = 1000) { return String(value ?? '').trim().slice(0, length); }

function redact(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redact(item, depth + 1));
  if (typeof value !== 'object') return typeof value === 'string' ? bounded(value, 4000) : value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|authorization|api[-_]?key|password|secret/i.test(key)) result[key] = '[REDACTED]';
    else result[key] = redact(item, depth + 1);
  }
  return result;
}

export function createTraceId() { return `trace-${randomUUID()}`; }

/** Append-only event stream used to reconstruct a smart-query turn. */
export class OperationalEventLog {
  constructor({ persistence = null, maxItems = 10_000 } = {}) {
    this.persistence = persistence;
    this.maxItems = Math.max(1000, Number(maxItems) || 10_000);
    this.items = [];
    this.sequences = new Map();
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (this.persistence) this.items = (await this.persistence.init()).slice(0, this.maxItems);
    for (const item of [...this.items].reverse()) this.sequences.set(item.traceId, Math.max(this.sequences.get(item.traceId) || 0, item.sequence || 0));
    return this;
  }

  record(input = {}) {
    const traceId = bounded(input.traceId, 100) || createTraceId();
    const sequence = (this.sequences.get(traceId) || 0) + 1;
    this.sequences.set(traceId, sequence);
    const event = {
      id: `operation-event-${randomUUID()}`, schema: 'wynai.operation-event/v1', traceId, sequence, at: new Date().toISOString(),
      event: bounded(input.event, 120) || 'unknown', phase: bounded(input.phase, 80) || 'runtime', outcome: bounded(input.outcome, 40) || null,
      durationMs: input.durationMs == null ? null : Math.max(0, Number(input.durationMs) || 0), conversationId: bounded(input.conversationId, 120) || null,
      turnId: bounded(input.turnId, 120) || null, datasetId: bounded(input.datasetId, 120) || null, actor: bounded(input.actor, 120) || 'system',
      organizationId: bounded(input.organizationId, 120) || null, userId: bounded(input.userId, 120) || null,
      versions: redact(input.versions || {}), details: redact(input.details || {}),
    };
    this.items.unshift(event);
    this.items = this.items.slice(0, this.maxItems);
    if (this.persistence) this.writeChain = this.writeChain.then(() => this.persistence.save(event)).catch(() => null);
    return event;
  }

  trace(traceId) { return this.items.filter(item => item.traceId === traceId).sort((a, b) => a.sequence - b.sequence); }
  list({ limit = 100, conversationId = null, event = null } = {}) {
    return this.items.filter(item => (!conversationId || item.conversationId === conversationId) && (!event || item.event === event)).slice(0, Math.max(1, Math.min(this.maxItems, Number(limit) || 100)));
  }
}

