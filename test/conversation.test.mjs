import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SmartQueryConversationStore } from '../lib/conversation/session.mjs';
import { JsonRunStore } from '../lib/run-store.mjs';
import { SkillRegistry } from '../lib/skills/skill-registry.mjs';

const metadata = { id: 'dataset-sales-v1', revision: 3, name: '销售数据' };

function fakeRunAnalysis({ focus }) {
  return Promise.resolve({
    analysis: {
      dataset: metadata,
      goal: focus,
      planning: { intent: 'open' },
      kpis: [{ id: 'revenue', label: '销售额', rawValue: 100, evidenceIds: ['ev-total'] }],
      insights: [{ id: 'insight-total', title: '销售额', statement: '销售额为100', evidenceIds: ['ev-total'] }],
      charts: [{ id: 'chart-trend', title: '趋势', chartType: 'line', resultSetId: 'rs-trend', evidenceId: 'ev-total' }],
      evidence: [{ id: 'ev-total', title: '销售额', value: 100 }],
      report: { summary: ['销售额为100'] },
      execution: { filters: [] },
    },
    queries: [{ request: { id: 'qry-trend' }, executionPlan: { adapter: 'wyn-wax-controlled' }, status: 'completed' }],
    resultSets: [{ id: 'rs-trend', requestId: 'qry-trend', rows: [{ period: '2026-01', revenue: 100 }], schema: [{ name: 'period' }, { name: 'revenue' }], quality: { isSample: false, isTruncated: false, isEstimated: false, warnings: [] } }],
    audit: { warnings: [] },
  });
}

test('会话支持连续追问并返回统一 InsightDocument', async () => {
  const store = new SmartQueryConversationStore({ loadMetadata: async () => metadata, runAnalysis: fakeRunAnalysis });
  const conversation = await store.create({ datasetId: metadata.id });
  const first = await store.ask(conversation.id, { question: '看销售额趋势' });
  const second = await store.ask(conversation.id, { question: '继续按地区看' });
  assert.equal(first.response.document.schema, 'wynai.insight-document/v1');
  assert.equal(first.response.status, 'ok');
  assert.equal(second.conversation.messages.length, 4);
  assert.equal(second.response.document.blocks.some(block => block.type === 'chart'), true);
  assert.equal(first.response.resultSets.length, 1);
  assert.equal(first.response.document.blocks.find(block => block.type === 'chart').dataRef, 'rs-trend');
  assert.deepEqual(store.get(conversation.id).resultSetIds, ['rs-trend']);
  assert.deepEqual(store.get(conversation.id).activeMetrics, []);
});

test('Smart Query 自治分析调用固定传递 smart-query 执行策略', async () => {
  const calls = [];
  const runAnalysis = async input => {
    calls.push(input);
    return fakeRunAnalysis(input);
  };
  const store = new SmartQueryConversationStore({ loadMetadata: async () => metadata, runAnalysis });
  const conversation = await store.create({ datasetId: metadata.id });
  await store.ask(conversation.id, { question: '综合分析经营情况' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executionPolicy, 'smart-query');
  assert.equal(calls[0].strictMode, true);
});

test('Smart Query 会话交付边界拒绝 NONE 和样本分析结果', async () => {
  const noneStore = new SmartQueryConversationStore({
    loadMetadata: async () => metadata,
    runAnalysis: async input => {
      const result = await fakeRunAnalysis(input);
      result.queries[0].executionPlan.adapter = 'wyn-dataset-none-json';
      return result;
    },
  });
  const noneConversation = await noneStore.create({ datasetId: metadata.id });
  await assert.rejects(() => noneStore.ask(noneConversation.id, { question: '综合分析经营情况' }), error => (
    error?.code === 'QUERY_EXECUTION_POLICY_VIOLATION' && /不接受查询适配器/.test(error.message)
  ));

  const sampleStore = new SmartQueryConversationStore({
    loadMetadata: async () => metadata,
    runAnalysis: async input => {
      const result = await fakeRunAnalysis(input);
      result.resultSets[0].quality.isSample = true;
      return result;
    },
  });
  const sampleConversation = await sampleStore.create({ datasetId: metadata.id });
  await assert.rejects(() => sampleStore.ask(sampleConversation.id, { question: '综合分析经营情况' }), error => (
    error?.code === 'QUERY_EXECUTION_POLICY_VIOLATION' && /禁止样本结果/.test(error.message)
  ));
});

test('会话支持多个数据集并合并为一个 InsightDocument', async () => {
  const store = new SmartQueryConversationStore({ loadMetadata: async id => ({ ...metadata, id, name: id }), runAnalysis: fakeRunAnalysis });
  const conversation = await store.create({ datasetIds: ['dataset-sales-v1', 'dataset-target-v1'] });
  const result = await store.ask(conversation.id, { question: '比较两个数据集' });
  assert.deepEqual(result.response.document.scope.datasets, ['dataset-sales-v1', 'dataset-target-v1']);
  assert.equal(result.response.documents.length, 2);
  assert.ok(result.response.document.blocks.every(block => /^d[12]-/.test(block.id)));
});

test('会话状态可持久化恢复，并在 Skill 指标冲突时要求澄清', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-conversation-'));
  const metadataLoader = async () => metadata;
  const persistence = new JsonRunStore(directory, { maxItems: 10 });
  const store = new SmartQueryConversationStore({ loadMetadata: metadataLoader, runAnalysis: fakeRunAnalysis, persistence });
  await store.init();
  const conversation = await store.create({ datasetId: metadata.id });
  await store.ask(conversation.id, { question: '看销售额趋势' });
  const restored = new SmartQueryConversationStore({ loadMetadata: metadataLoader, runAnalysis: fakeRunAnalysis, persistence: new JsonRunStore(directory, { maxItems: 10 }) });
  await restored.init();
  assert.equal(restored.get(conversation.id).messages.length, 2);

  const conflictStore = new SmartQueryConversationStore({
    loadMetadata: metadataLoader,
    runAnalysis: fakeRunAnalysis,
    skillRegistry: new SkillRegistry([
      { id: 'skill-a', version: '1.0.0', scope: 'system', status: 'approved', triggers: ['销售'], metrics: [{ name: '销售额', field: 'a' }] },
      { id: 'skill-b', version: '1.0.0', scope: 'dataset', datasetIds: [metadata.id], status: 'approved', triggers: ['销售'], metrics: [{ name: '销售额', field: 'b' }] },
    ]),
  });
  const conflictConversation = await conflictStore.create({ datasetId: metadata.id });
  const clarification = await conflictStore.ask(conflictConversation.id, { question: '看销售额' });
  assert.equal(clarification.response.status, 'needs_clarification');
  assert.match(clarification.response.clarification.question, /口径/);
});

test('会话主体访问控制拒绝不同用户和组织读取或发送消息', async () => {
  const store = new SmartQueryConversationStore({ loadMetadata: async () => metadata, runAnalysis: fakeRunAnalysis });
  const conversation = await store.create({ datasetId: metadata.id, userId: 'u1', organizationId: 'org1' });
  assert.equal(store.canAccess(conversation.id, { userId: 'u1', organizationId: 'org1' }), true);
  assert.equal(store.canAccess(conversation.id, { userId: 'u2', organizationId: 'org1' }), false);
  assert.equal(store.canAccess(conversation.id, { userId: 'u1', organizationId: 'org2' }), false);
  assert.equal(store.canAccess(conversation.id, {}), false);
  const anonymous = await store.create({ datasetId: metadata.id });
  assert.equal(store.canAccess(anonymous.id, {}), true);
  assert.equal(store.canAccess(anonymous.id, { userId: 'u1' }), false);
});

test('会话问数记录 Skill 运行解析事件', async () => {
  const events = [];
  const governance = { recordResolution: async input => { events.push(input); } };
  const store = new SmartQueryConversationStore({ loadMetadata: async () => metadata, runAnalysis: fakeRunAnalysis, skillGovernance: governance, skillRegistry: new SkillRegistry([{ id: 'sales-runtime', version: '1.0.0', scope: 'system', status: 'approved', triggers: ['销售'] }]) });
  const conversation = await store.create({ datasetId: metadata.id, userId: 'u1' });
  await store.ask(conversation.id, { question: '查看销售额' });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].refs, ['sales-runtime@1.0.0']);
  assert.equal(events[0].userId, 'u1');
});

test('AI 规划降级不得作为成功的分析结果返回', async () => {
  const runAnalysis = async input => {
    const result = await fakeRunAnalysis(input);
    result.audit.warnings = ['AI Planner 降级：fetch failed'];
    return result;
  };
  const store = new SmartQueryConversationStore({ loadMetadata: async () => metadata, runAnalysis });
  const conversation = await store.create({ datasetId: metadata.id });
  await assert.rejects(() => store.ask(conversation.id, { question: '综合分析经营情况' }), { code: 'BUSINESS_FALLBACK_FORBIDDEN' });
  assert.equal(store.get(conversation.id).messages.some(message => message.role === 'assistant'), false);
});
