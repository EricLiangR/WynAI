import assert from 'node:assert/strict';
import test from 'node:test';
import { SmartQueryConversationStore } from './lib/conversation/session.mjs';

function result(rows = []) {
  return {
    analysis: { dataset: { id: 'generic' }, planning: { plannerMode: 'llm' }, report: { summary: ['Verified analysis'] } },
    queries: [],
    resultSets: [{ id: 'generic-result', requestId: 'generic-query', rows, schema: [{ name: 'id', role: 'dimension', type: 'string' }], statistics: { rowCount: rows.length, totalRowCount: rows.length }, quality: { isTruncated: false } }],
    audit: { warnings: [] },
  };
}

test('Analysis routes always require strict mode, including multi-dataset queries', async () => {
  const calls = [];
  const store = new SmartQueryConversationStore({ loadMetadata: async id => ({ id }), runAnalysis: async input => { calls.push(input); return result(); } });
  const conversation = await store.create({ datasetIds: ['generic-a', 'generic-b'] });
  await store.ask(conversation.id, { question: 'Compare sources' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.strictMode === true));
});

for (const count of [201, 20000]) {
  test(`Analysis delivers all ${count} returned rows rather than a hidden preview`, async () => {
    const rows = Array.from({ length: count }, (_, id) => ({ id: String(id) }));
    const store = new SmartQueryConversationStore({ loadMetadata: async id => ({ id }), runAnalysis: async () => result(rows) });
    const conversation = await store.create({ datasetId: 'generic' });
    const response = (await store.ask(conversation.id, { question: 'List records' })).response;
    assert.equal(response.resultSets[0].rows.length, count);
    assert.equal(response.resultSets[0].rows.at(-1).id, String(count - 1));
    assert.equal(response.resultSets[0].statistics.totalRowCount, count);
  });
}

for (const signal of ['plannerMode', 'plannerDegradedReason', 'criticDegradedReason', 'legacy-warning']) {
  test(`A ${signal} fallback signal cannot become a successful answer`, async () => {
    const degraded = result();
    if (signal === 'legacy-warning') degraded.audit.warnings.push('AI Planner 降级：fetch failed');
    else degraded.analysis.planning[signal] = signal === 'plannerMode' ? 'deterministic-fallback' : 'provider failed';
    const store = new SmartQueryConversationStore({ loadMetadata: async id => ({ id }), runAnalysis: async () => degraded });
    const conversation = await store.create({ datasetId: 'generic' });
    await assert.rejects(() => store.ask(conversation.id, { question: 'Analyze' }), { code: 'BUSINESS_FALLBACK_FORBIDDEN' });
    assert.equal(store.get(conversation.id).messages.filter(message => message.role === 'assistant').length, 0);
    assert.equal(store.get(conversation.id).lastDocument, undefined);
  });
}
