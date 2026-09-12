import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResultPresentationPlan } from './lib/result-presentation-plan.mjs';

const request = {
  select: [
    { field: 'Record', alias: 'record', role: 'dimension' },
    { field: 'OpenedAt', alias: 'opened', role: 'time' },
    { field: 'DueAt', alias: 'due', role: 'time' },
  ],
  measures: [],
  expectedResult: { requiredDimensions: ['record', 'opened', 'due'] },
};
const schema = request.select.map(item => ({ name: item.alias, type: item.role === 'time' ? 'date' : 'string', role: 'dimension' }));

for (const [label, rows] of [
  ['empty', []],
  ['single record', [{ record: 'A', opened: '2026-01-01', due: '2026-02-01' }]],
  ['repeated date', ['A', 'B'].map(record => ({ record, opened: '2026-01-01', due: '2026-02-01' }))],
  ['null dates', [{ record: 'A', opened: null, due: null }]],
]) {
  test(`Required date outputs remain visible for ${label}`, () => {
    const plan = buildResultPresentationPlan({ request, question: 'List records', resultSet: { rows, schema } });
    assert.deepEqual(new Set(plan.table.columns), new Set(['record', 'opened', 'due']));
    assert.equal(plan.table.preserveAllReturnedRows, true);
  });
}

test('Internal calculation dimensions are not exposed as user columns', () => {
  const internalRequest = { ...request, select: [...request.select, { field: 'InternalPeriod', alias: 'internal_period', role: 'time', internal: true }] };
  const plan = buildResultPresentationPlan({ request: internalRequest, resultSet: { rows: [], schema: [...schema, { name: 'internal_period', type: 'date', role: 'dimension' }] } });
  assert.equal(plan.table.columns.includes('internal_period'), false);
});
