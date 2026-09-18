import test from 'node:test';
import assert from 'node:assert/strict';
import { planBusinessQuestionAsync } from './lib/conversation/question-planner.mjs';

const metadata = {
  id: 'custom-work-items', revision: 1,
  fields: [
    ['label', 'dimension', 'String'], ['owner_code', 'dimension', 'String'],
    ['opened_at', 'time', 'Date'], ['private_note', 'dimension', 'String'],
  ].map(([name, role, type]) => ({ name, role, type, rawType: type })),
};
const skill = {
  id: 'custom-work-items', version: '1.0.0', status: 'approved',
  businessEntities: [
    { id: 'owner', name: '经办人员', field: 'owner_code', synonyms: ['办理人'] },
    { id: 'opened', name: '登记日期', field: 'opened_at', synonyms: ['登记时间'] },
    { id: 'note', name: '内部备注', field: 'private_note', synonyms: [] },
  ],
};
const question = '请列出 label、办理人、登记时间';
const dimensions = [
  { field: 'label', alias: 'label' },
  { field: 'owner_code', alias: 'owner' },
  { field: 'opened_at', alias: 'opened' },
];

async function plan(outputs, skills = [skill], filters = []) {
  let calls = 0;
  const result = await planBusinessQuestionAsync({
    metadata, question, skills,
    llm: { enabled: true, async planQueryIntent() {
      calls += 1;
      return {
        businessQuestion: question, dimensions: structuredClone(outputs), metrics: [],
        filters: structuredClone(filters), constraints: [],
        expectedResult: { shape: 'table', requiredDimensions: outputs.map(item => item.alias) },
      };
    } },
  });
  return { result, calls };
}

test('Skill aliases absent from the provisional baseline remain valid LLM outputs', async () => {
  const { result, calls } = await plan(dimensions);
  assert.equal(result.status, 'supported', result.message);
  assert.equal(calls, 1);
  assert.deepEqual(result.displayRequest.select.map(item => item.field), dimensions.map(item => item.field));
  assert.equal(result.request.limit, 20000);
  assert.equal(result.plannerDiagnostics.llmAttempted, true);
});

test('Loaded and dataset-bound Skill fields may be returned as business context', async () => {
  const { result, calls } = await plan([...dimensions, { field: 'private_note', alias: 'note' }]);
  assert.equal(result.status, 'supported', result.message);
  assert.equal(calls, 1);
  assert.ok(result.request);
});

test('A model alias cannot authorize a field absent from the dataset', async () => {
  const { result, calls } = await plan([...dimensions, { field: 'missing_field', alias: 'missing' }], []);
  assert.equal(result.status, 'needs_clarification', result.message);
  assert.equal(calls, 3);
  assert.match(result.clarification, /当前数据集不包含/);
  assert.equal(result.plannerDiagnostics.llmAttempted, true);
  assert.equal(result.request, undefined);
});

test('A required output can also be a filter with an independent model alias', async () => {
  const outputs = dimensions.map(item => item.field === 'owner_code' ? { ...item, alias: 'assigned_person' } : item);
  const { result, calls } = await plan(outputs, [skill], [{ field: 'owner_code', operator: 'eq', value: 'A' }]);
  assert.equal(result.status, 'supported', result.message);
  assert.equal(calls, 1);
  assert.ok(result.displayRequest.select.some(item => item.field === 'owner_code'));
  assert.ok(result.request.filters.some(item => item.field === 'owner_code' && item.value === 'A'));
});
