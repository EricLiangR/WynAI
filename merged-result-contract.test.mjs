import assert from 'node:assert/strict';
import test from 'node:test';
import { combineCanonicalResultSets } from './lib/query/multi-dataset.mjs';

function source(id, count, offset = 0, limited = false) {
  return { id, scope: { datasetId: id }, rows: Array.from({ length: count }, (_, i) => ({ key: offset + i, value: i })),
    schema: [{ name: 'key', role: 'dimension' }, { name: 'value', role: 'measure' }], quality: { isTruncated: limited } };
}

for (const count of [19999, 20000, 20001]) {
  test(`Merged result respects the 20000-row contract at ${count} rows`, () => {
    const result = combineCanonicalResultSets({ keyFields: ['key'], resultSets: [source('generic-a', 10000), source('generic-b', count - 10000, 10000)] });
    assert.equal(result.rows.length, Math.min(count, 20000));
    assert.equal(result.statistics.totalRowCount, count);
    assert.equal(result.quality.returnedRowCount, result.rows.length);
    assert.equal(result.quality.isTruncated, count > 20000);
    if (count > 20000) assert.match(result.quality.warnings.join(' '), /20000/);
  });
}

test('A limited source does not imply a known merged total', () => {
  const result = combineCanonicalResultSets({ keyFields: ['key'], resultSets: [source('generic-a', 3, 0, true), source('generic-b', 2, 3)] });
  assert.equal(result.statistics.totalRowCount, null);
  assert.equal(result.quality.isTruncated, true);
  assert.equal(result.quality.returnedRowCount, 5);
});
