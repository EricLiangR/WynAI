import { randomUUID } from 'node:crypto';

function bounded(value, fallback = 'unknown') {
  return String(value || fallback).trim().slice(0, 160) || fallback;
}

export class SlidingWindowRateLimiter {
  constructor({ limit = 60, windowMs = 60_000, maxKeys = 5000 } = {}) {
    this.limit = Math.max(1, Number(limit) || 60);
    this.windowMs = Math.max(1000, Number(windowMs) || 60_000);
    this.maxKeys = Math.max(100, Number(maxKeys) || 5000);
    this.entries = new Map();
  }

  check(key = 'anonymous') {
    const now = Date.now();
    const normalizedKey = bounded(key, 'anonymous');
    const current = (this.entries.get(normalizedKey) || []).filter(timestamp => now - timestamp < this.windowMs);
    const allowed = current.length < this.limit;
    if (allowed) current.push(now);
    this.entries.set(normalizedKey, current);
    while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value);
    return { allowed, limit: this.limit, remaining: Math.max(0, this.limit - current.length), retryAfterMs: allowed ? 0 : Math.max(1, this.windowMs - (now - current[0])) };
  }
}

export class RequestAuditLog {
  constructor({ maxItems = 1000, persistence = null } = {}) {
    this.maxItems = Math.max(100, Number(maxItems) || 1000);
    this.persistence = persistence;
    this.items = [];
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (this.persistence) this.items = (await this.persistence.init()).slice(0, this.maxItems);
    return this;
  }

  record(input = {}) {
    const event = {
      id: `request-audit-${randomUUID()}`,
      schema: 'wynai.request-audit/v1',
      at: new Date().toISOString(),
      method: bounded(input.method, 'GET'),
      path: bounded(input.path, '/'),
      status: Number(input.status) || 200,
      durationMs: Math.max(0, Number(input.durationMs) || 0),
      actor: bounded(input.actor),
      organizationId: input.organizationId ? bounded(input.organizationId, '') : null,
      userId: input.userId ? bounded(input.userId, '') : null,
      requestId: bounded(input.requestId),
      rateLimited: Boolean(input.rateLimited),
    };
    this.items.unshift(event);
    this.items = this.items.slice(0, this.maxItems);
    if (this.persistence) {
      this.writeChain = this.writeChain.then(() => this.persistence.save(event)).catch(() => null);
    }
    return event;
  }

  list(limit = 100) {
    return this.items.slice(0, Math.max(1, Math.min(this.maxItems, Number(limit) || 100)));
  }
}

export function requestIdentity(request) {
  const userId = String(request.headers['x-wyn-user-id'] || '').trim().slice(0, 100) || null;
  const organizationId = String(request.headers['x-wyn-organization-id'] || '').trim().slice(0, 100) || null;
  return { userId, organizationId, actor: userId || 'anonymous' };
}
