import test from 'node:test';
import assert from 'node:assert/strict';
import { compileBusinessQueryIntent } from './lib/semantics/business-query-intent.mjs';

const metadata = { id: 'typed-filter-data', fields: [
  { name: 'flag', type: 'Number', role: 'measure' },
  { name: 'tags', type: 'String', role: 'dimension' },
  { name: 'opened', type: 'Date', role: 'time' },
] };
for (const [label, filter, expected] of [
  ['numeric string', { field: 'flag', operator: 'eq', value: '1' }, 1],
  ['single member', { field: 'tags', operator: 'containsAny', value: 'Alpha' }, ['Alpha']],
  ['duplicate members', { field: 'tags', operator: 'containsAll', value: ['Alpha', 'Alpha'] }, ['Alpha']],
  ['ISO date', { field: 'opened', operator: 'gte', value: '2026-09-01T00:00:00Z' }, '2026-09-01'],
]) {
  test(`Filter conservation accepts governed normalization: ${label}`, () => {
    const intent = {
      businessQuestion: 'Typed filter contract', dataset: { id: metadata.id },
      dimensions: [], metrics: [{ field: 'flag', aggregation: 'sum', alias: 'amount' }],
      filters: [filter], constraints: [], time: {},
      expectedResult: { requiredMetrics: ['amount'], maximumRows: 20000 },
    };
    const result = compileBusinessQueryIntent(metadata, intent);
    assert.equal(result.status, 'supported', JSON.stringify(result.errors));
    assert.equal(result.request.filters.length, 1);
    assert.equal(result.request.filters[0].field, filter.field);
    assert.equal(result.request.filters[0].operator, filter.operator);
    assert.deepEqual(result.request.filters[0].value, expected);
    assert.deepEqual(intent.filters, [filter]);
  });
}
