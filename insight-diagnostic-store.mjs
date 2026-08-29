import { randomUUID } from 'node:crypto';

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function validInsightId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9-]{8,100}$/.test(id)) throw new Error('Invalid insight ID');
  return id;
}

function now() { return new Date().toISOString(); }

export class InsightDiagnosticLookupError extends Error {
  constructor(code, message, matches = []) {
    super(message);
    this.name = 'InsightDiagnosticLookupError';
    this.code = code;
    this.matches = matches;
    this.status = code === 'INSIGHT_DIAGNOSTIC_PREFIX_AMBIGUOUS' ? 409 : 404;
  }
}

export class InsightDiagnosticStore {
  constructor({ persistence = null, maxItems = 5000, idFactory = () => `evt-${randomUUID()}` } = {}) {
    this.persistence = persistence;
    this.maxItems = Math.max(1, Number(maxItems) || 5000);
    this.idFactory = idFactory;
    this.items = new Map();
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (!this.persistence) return this.list();
    const loaded = await this.persistence.init();
    for (const record of loaded || []) {
      if (record?.insightId && Array.isArray(record.events)) this.items.set(record.insightId, record);
    }
    return this.list();
  }

  list() {
    return [...this.items.values()]
      .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
      .map(clone);
  }

  resolve(idOrPrefix) {
    const value = String(idOrPrefix || '').trim();
    if (!/^[A-Za-z0-9-]{8,100}$/.test(value)) throw new InsightDiagnosticLookupError('INSIGHT_DIAGNOSTIC_NOT_FOUND', 'Invalid insight ID');
    const exact = this.items.get(value);
    if (exact) return value;
    const matches = [...this.items.keys()].filter(id => id.startsWith(value));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new InsightDiagnosticLookupError('INSIGHT_DIAGNOSTIC_PREFIX_AMBIGUOUS', 'Insight ID prefix matches multiple diagnostics', matches);
    throw new InsightDiagnosticLookupError('INSIGHT_DIAGNOSTIC_NOT_FOUND', 'Insight diagnostic record not found');
  }

  get(idOrPrefix) {
    const id = this.resolve(idOrPrefix);
    return clone(this.items.get(id));
  }

  async append(insightId, type, data = {}, context = {}) {
    const id = validInsightId(insightId);
    const timestamp = now();
    const current = this.items.get(id) || {
      schema: 'wynai.insight-diagnostic/v1', id, insightId: id, createdAt: timestamp, updatedAt: timestamp,
      actor: context.actor ? String(context.actor).slice(0, 200) : null,
      organizationId: context.organizationId ? String(context.organizationId).slice(0, 200) : null,
      source: context.source ? clone(context.source) : null, events: [],
    };
    const event = {
      id: this.idFactory(), type: String(type || 'diagnostic.event'), at: timestamp,
      actor: context.actor ? String(context.actor).slice(0, 200) : current.actor || null,
      organizationId: context.organizationId ? String(context.organizationId).slice(0, 200) : current.organizationId || null,
      runId: context.runId || null, data: clone(data),
    };
    const next = { ...current, actor: current.actor || event.actor, organizationId: current.organizationId || event.organizationId,
      source: current.source || (context.source ? clone(context.source) : null), updatedAt: timestamp,
      events: [...current.events, event].slice(-this.maxItems) };
    this.items.set(id, next);
    if (this.persistence) {
      this.writeChain = this.writeChain.then(() => this.persistence.save(next)).catch(error => { console.error('Insight diagnostic persistence failed', error.message); return null; });
      await this.writeChain;
    }
    return clone(event);
  }
}

