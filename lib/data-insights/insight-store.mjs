import { randomUUID } from 'node:crypto';
import { normalizeInsightInput } from './insight-input.mjs';

function primaryResultSet(record) {
  return record.input.resultSets[0];
}

function resultSetSummary(resultSet) {
  const columns = resultSet.schema.map(field => field.name);
  const validCells = resultSet.rows.reduce((total, row) => total + columns.filter(column => {
    const value = row[column];
    return value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
  }).length, 0);
  const totalCells = Math.max(resultSet.rows.length * columns.length, 1);
  return {
    resultSetId: resultSet.id,
    rowCount: resultSet.rows.length,
    columnCount: columns.length,
    columns,
    completeness: Math.round(validCells / totalCells * 100),
    quality: resultSet.quality,
  };
}

function sourceKey(input) {
  return input.source?.type && input.source?.sourceId
    ? `source:${input.source.type}:${input.source.sourceId}`
    : null;
}

export class DataInsightStore {
  constructor({ maxItems = 30, idFactory = () => `ins-${randomUUID()}`, persistence = null } = {}) {
    this.maxItems = maxItems;
    this.idFactory = idFactory;
    this.persistence = persistence;
    this.writeChain = Promise.resolve();
    this.items = new Map();
    this.idempotencyIndex = new Map();
  }

  async init() {
    if (!this.persistence) return this.list();
    const loaded = await this.persistence.init();
    for (const record of loaded || []) {
      if (!record?.insightId && record?.id) record.insightId = record.id;
      if (!record?.insightId || !record.input) continue;
      record.id = record.insightId;
      this.items.set(record.insightId, record);
      if (record.idempotencyKey) this.idempotencyIndex.set(record.idempotencyKey, record.insightId);
    }
    while (this.items.size > this.maxItems) this.items.delete(this.items.keys().next().value);
    return this.list();
  }

  register(input, { idempotencyKey = null, actor = null, organizationId = null } = {}) {
    const normalized = normalizeInsightInput(input);
    const key = idempotencyKey ? `explicit:${String(idempotencyKey).slice(0, 300)}` : sourceKey(normalized);
    const existingId = key ? this.idempotencyIndex.get(key) : null;
    const existing = existingId ? this.items.get(existingId) : null;
    const now = new Date().toISOString();
    const record = existing
      ? { ...existing, input: normalized, updatedAt: now, actor: actor || existing.actor || null, organizationId: organizationId || existing.organizationId || null }
      : { id: this.idFactory(), insightId: null, input: normalized, createdAt: now, updatedAt: now, idempotencyKey: key, actor: actor || null, organizationId: organizationId || null, document: null, versions: [] };
    record.insightId ||= record.id;
    if (existing) this.items.delete(record.insightId);
    this.items.set(record.insightId, record);
    if (key) this.idempotencyIndex.set(key, record.insightId);
    if (this.persistence) this.writeChain = this.writeChain.then(() => this.persistence.save(record)).catch(error => { console.error('数据洞察持久化失败', error.message); return null; });
    while (this.items.size > this.maxItems) {
      const [oldestId, oldest] = this.items.entries().next().value;
      this.items.delete(oldestId);
      if (oldest.idempotencyKey) this.idempotencyIndex.delete(oldest.idempotencyKey);
    }
    return { record: this.detail(record), created: !existing };
  }

  list({ sourceType = null, sourceId = null, includeArchived = false } = {}) {
    return [...this.items.values()].reverse()
      .filter(record => !record.deletedAt)
      .filter(record => includeArchived || !record.archivedAt)
      .filter(record => !sourceType || record.input.source?.type === sourceType)
      .filter(record => !sourceId || record.input.source?.sourceId === sourceId)
      .map(record => this.summary(record));
  }

  get(insightId) {
    const record = this.items.get(insightId);
    return record && !record.deletedAt ? this.detail(record) : null;
  }

  getVersions(insightId) {
    const record = this.items.get(String(insightId));
    return record && !record.deletedAt ? (record.versions || []).map(version => JSON.parse(JSON.stringify(version))) : null;
  }

  async archive(insightId, { actor = null, organizationId = null } = {}) {
    const record = this.items.get(String(insightId));
    if (!record || record.deletedAt) throw new Error('数据洞察结果不存在');
    const next = { ...record, archivedAt: new Date().toISOString(), archivedBy: actor || null, archivedOrganizationId: organizationId || null, updatedAt: new Date().toISOString() };
    this.items.set(next.insightId, next);
    if (this.persistence) { this.writeChain = this.writeChain.then(() => this.persistence.save(next)).catch(error => { console.error('数据洞察持久化失败', error.message); return null; }); await this.writeChain; }
    return this.detail(next);
  }

  async softDelete(insightId, { actor = null, organizationId = null } = {}) {
    const record = this.items.get(String(insightId));
    if (!record || record.deletedAt) throw new Error('数据洞察结果不存在');
    const next = { ...record, deletedAt: new Date().toISOString(), deletedBy: actor || null, deletedOrganizationId: organizationId || null, updatedAt: new Date().toISOString() };
    this.items.set(next.insightId, next);
    if (this.persistence) { this.writeChain = this.writeChain.then(() => this.persistence.save(next)).catch(error => { console.error('数据洞察持久化失败', error.message); return null; }); await this.writeChain; }
    return { insightId: next.insightId, deletedAt: next.deletedAt };
  }

  async restore(insightId, { actor = null, organizationId = null } = {}) {
    const record = this.items.get(String(insightId));
    if (!record || record.deletedAt) throw new Error('数据洞察结果不存在');
    const next = { ...record, archivedAt: null, restoredAt: new Date().toISOString(), restoredBy: actor || null, restoredOrganizationId: organizationId || null, updatedAt: new Date().toISOString() };
    this.items.set(next.insightId, next);
    if (this.persistence) {
      this.writeChain = this.writeChain.then(() => this.persistence.save(next)).catch(error => { console.error('数据洞察持久化失败', error.message); return null; });
      await this.writeChain;
    }
    return this.detail(next);
  }

  compareVersions(insightId, fromVersion, toVersion) {
    const record = this.items.get(String(insightId));
    if (!record || record.deletedAt) return null;
    const versions = record.versions || [];
    const from = versions.find(item => item.version === Number(fromVersion));
    const to = versions.find(item => item.version === Number(toVersion));
    if (!from || !to) return null;
    const fromBlocks = new Map((from.document?.blocks || []).map(item => [item.id, item]));
    const toBlocks = new Map((to.document?.blocks || []).map(item => [item.id, item]));
    const added = [...toBlocks.keys()].filter(id => !fromBlocks.has(id));
    const removed = [...fromBlocks.keys()].filter(id => !toBlocks.has(id));
    const changed = [...toBlocks.keys()].filter(id => fromBlocks.has(id) && JSON.stringify(fromBlocks.get(id)) !== JSON.stringify(toBlocks.get(id)));
    return { insightId: record.insightId, fromVersion: from.version, toVersion: to.version, addedBlockIds: added, removedBlockIds: removed, changedBlockIds: changed, scopeChanged: JSON.stringify(from.document?.scope || {}) !== JSON.stringify(to.document?.scope || {}), evidenceCount: { from: from.document?.evidence?.length || 0, to: to.document?.evidence?.length || 0 } };
  }

  summary(record) {
    return {
      insightId: record.insightId,
      title: record.input.title,
      source: record.input.source || null,
      actor: record.actor || null,
      organizationId: record.organizationId || null,
      datasets: record.input.datasets || [],
      resultSetCount: record.input.resultSets.length,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archivedAt: record.archivedAt || null,
      ...resultSetSummary(primaryResultSet(record)),
    };
  }

  detail(record) {
    return {
      ...this.summary(record),
      input: record.input,
      primaryResultSet: primaryResultSet(record),
      document: record.document || null,
      versions: Array.isArray(record.versions) ? record.versions : [],
    };
  }

  async saveDocument(insightId, document, { runId = null, actor = null, organizationId = null } = {}) {
    const record = this.items.get(String(insightId));
    if (!record) throw new Error('数据洞察结果不存在');
    const now = new Date().toISOString();
    const version = (record.versions?.at(-1)?.version || 0) + 1;
    const entry = { version, runId, actor, organizationId, generatedAt: now, document: JSON.parse(JSON.stringify(document)) };
    const next = { ...record, document: entry.document, versions: [...(record.versions || []), entry].slice(-10), updatedAt: now };
    this.items.delete(record.insightId);
    this.items.set(record.insightId, next);
    if (this.persistence) {
      this.writeChain = this.writeChain.then(() => this.persistence.save(next)).catch(error => { console.error('数据洞察持久化失败', error.message); return null; });
      await this.writeChain;
    }
    return this.detail(next);
  }
}
