import assert from 'node:assert/strict';
import test from 'node:test';
import { decideVisualization } from './lib/visualization/visualization-spec.mjs';
import { buildResultPresentationPlan } from './lib/result-presentation-plan.mjs';

const request = { select: [{ field: 'Category', alias: 'category' }], measures: [{ field: 'Value', alias: 'value', aggregation: 'sum' }] };
const resultSet = { schema: [{ name: 'category', role: 'dimension', type: 'string' }, { name: 'value', role: 'measure', type: 'number' }], rows: [{ category: 'A', value: 3 }, { category: 'B', value: -2 }], quality: {} };

for (const question of ['用饼图展示', '用组合图展示']) {
  test(`An incompatible explicit chart fails without substitution: ${question}`, () => {
    assert.throws(() => buildResultPresentationPlan({ question, request, resultSet }), { code: 'VISUALIZATION_CONFIRMATION_REQUIRED', status: 422 });
  });
}
test('Empty results cannot silently replace an explicitly requested chart', () => {
  assert.throws(() => decideVisualization({ question: '用柱状图展示', request, resultSet: { ...resultSet, rows: [] } }), { code: 'VISUALIZATION_CONFIRMATION_REQUIRED' });
});
test('Automatic choice without an explicit chart remains available', () => {
  assert.equal(decideVisualization({ question: '各类数值', request, resultSet }).spec.type, 'column');
});
test('An applicable explicit pie chart is preserved', () => {
  const valid = { ...resultSet, rows: [{ category: 'A', value: 3 }, { category: 'B', value: 2 }] };
  assert.equal(decideVisualization({ question: '用饼图展示', request, resultSet: valid }).spec.type, 'pie');
});
test('An inherited explicit choice cannot be silently replaced', () => {
  assert.throws(() => decideVisualization({ question: '继续看结果', request, resultSet, previous: { type: 'pie', decision: { source: 'user' } } }), { code: 'VISUALIZATION_CONFIRMATION_REQUIRED' });
});
test('An explicit table-only choice overrides the prior chart', () => {
  assert.equal(decideVisualization({ question: '只要表格', request, resultSet, previous: { type: 'pie', decision: { source: 'user' } } }).spec, null);
});
