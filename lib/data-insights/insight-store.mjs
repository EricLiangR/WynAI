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
  constructor({ maxItems = 30, idFactory = () => `ins-${randomUUID()}` } = {}) {
    this.maxItems = maxItems;
    this.idFactory = idFactory;
    this.items = new Map();
    this.idempotencyIndex = new Map();
  }

  register(input, { idempotencyKey = null } = {}) {
    const normalized = normalizeInsightInput(input);
    const key = idempotencyKey ? `explicit:${String(idempotencyKey).slice(0, 300)}` : sourceKey(normalized);
    const existingId = key ? this.idempotencyIndex.get(key) : null;
    const existing = existingId ? this.items.get(existingId) : null;
    const now = new Date().toISOString();
    const record = existing
      ? { ...existing, input: normalized, updatedAt: now }
      : { insightId: this.idFactory(), input: normalized, createdAt: now, updatedAt: now, idempotencyKey: key };
    if (existing) this.items.delete(record.insightId);
    this.items.set(record.insightId, record);
    if (key) this.idempotencyIndex.set(key, record.insightId);
    while (this.items.size > this.maxItems) {
      const [oldestId, oldest] = this.items.entries().next().value;
      this.items.delete(oldestId);
      if (oldest.idempotencyKey) this.idempotencyIndex.delete(oldest.idempotencyKey);
    }
    return { record: this.detail(record), created: !existing };
  }

  list({ sourceType = null, sourceId = null } = {}) {
    return [...this.items.values()].reverse()
      .filter(record => !sourceType || record.input.source?.type === sourceType)
      .filter(record => !sourceId || record.input.source?.sourceId === sourceId)
      .map(record => this.summary(record));
  }

  get(insightId) {
    const record = this.items.get(insightId);
    return record ? this.detail(record) : null;
  }

  summary(record) {
    return {
      insightId: record.insightId,
      title: record.input.title,
      source: record.input.source || null,
      datasets: record.input.datasets || [],
      resultSetCount: record.input.resultSets.length,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...resultSetSummary(primaryResultSet(record)),
    };
  }

  detail(record) {
    return {
      ...this.summary(record),
      input: record.input,
      primaryResultSet: primaryResultSet(record),
    };
  }
}
