import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplorationLlm } from './lib/llm/exploration-agent.mjs';

test('回答生成器明确区分全量结果概要和截断预览', async () => {
  let requestBody;
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret-test-key',
    model: 'test-model',
    maxEvidenceRows: 2,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"共3行","keyPoints":[],"limitations":[]}' } }] }), { status: 200 });
    },
  });

  await llm.narrateQueryResult({
    question: '按月统计销售额',
    request: { id: 'query-1' },
    resultSet: {
      schema: [{ name: 'month', role: 'dimension', type: 'date', grain: 'month' }, { name: 'revenue', role: 'measure', type: 'number' }],
      rows: [
        { month: '2023-01-01T00:00:00Z', revenue: 1 },
        { month: '2024-01-01T00:00:00Z', revenue: 2 },
        { month: '2025-01-01T00:00:00Z', revenue: 3 },
      ],
      statistics: { rowCount: 3 },
    },
  });

  const messages = requestBody.messages;
  const prompt = messages.find(message => message.role === 'system').content;
  const evidence = JSON.parse(messages.find(message => message.role === 'user').content).resultSet;
  assert.match(prompt, /不得根据这些预览行推断全量数据的时间覆盖/);
  assert.equal(evidence.rows.length, 2);
  assert.deepEqual(evidence.preview, { returnedRows: 2, totalRows: 3, isPartial: true });
  assert.deepEqual(evidence.fullResultProfile.dimensions.month, {
    cardinality: 3,
    minimum: '2023-01-01',
    maximum: '2025-01-01',
  });
});

test('枚举全称已包含简称时拒绝摘要重复嵌套并有限修复', async () => {
  let calls = 0;
  const outputs = [
    { summary: 'POE（Private Entity（POE））客户共1个。', keyPoints: [], limitations: [] },
    { summary: 'Private Entity（POE）客户共1个。', keyPoints: [], limitations: [] },
  ];
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    fetchImpl: async () => {
      const output = outputs[Math.min(calls, outputs.length - 1)];
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 });
    },
  });
  const result = await llm.narrateQueryResult({
    question: '我的POE客户名单',
    request: { id: 'query-enum-label', filters: [{ field: '客户类型', operator: 'containsAny', value: ['Private Entity（POE）'] }] },
    resultSet: {
      schema: [{ name: 'customer', sourceField: '客户名称', displayName: '客户', role: 'dimension', type: 'string' }],
      rows: [{ customer: '客户1' }],
      statistics: { rowCount: 1 },
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.summary, 'Private Entity（POE）客户共1个。');
});
