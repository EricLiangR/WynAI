import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSemanticMapping } from './semantic-catalog.mjs';
import { planBusinessQuestionAsync } from './lib/conversation/question-planner.mjs';

test('字典校验使用配置源值而不是平台业务词表，不改写用户筛选', () => {
  const metadata = { fields: [{ name: 'status_text' }] };
  const skills = [{ id: 'custom-status', version: '1', valueMappings: [
    { field: 'status_text', canonicalValue: 'Active - Contract', synonyms: ['AC'] },
  ] }];
  const intent = { filters: [{ field: 'status_text', operator: 'containsAny', value: ['AC'] }] };
  assert.equal(validateSemanticMapping({ intent, metadata, skills }).valid, false);
  assert.deepEqual(intent.filters[0].value, ['AC']);
  assert.equal(validateSemanticMapping({ intent, metadata, skills: [] }).valid, true);
  intent.filters[0].value = ['Active - Contract'];
  assert.equal(validateSemanticMapping({ intent, metadata, skills }).valid, true);
});

test('LLM 不可用不能返回确定性业务答案', async () => {
  const result = await planBusinessQuestionAsync({
    metadata: { id: 'custom', fields: [{ name: 'amount', type: 'Number', role: 'measure' }] },
    question: '合计金额', llm: { enabled: false },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'LLM_UNAVAILABLE');
  assert.equal(result.request, undefined);
});
