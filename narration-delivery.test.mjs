import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplorationLlm } from './lib/llm/exploration-agent.mjs';

function fixture(summaries, quality = {}) {
  const calls = [];
  const llm = createExplorationLlm({ baseUrl: 'https://example.test', model: 'fixture', maxEvidenceRows: 2,
    transport: async input => {
      calls.push(structuredClone(input.messages));
      return { summary: summaries[Math.min(calls.length - 1, summaries.length - 1)], keyPoints: [], limitations: [] };
    },
  });
  return { calls, run: () => llm.narrateQueryResult({ question: '列出记录', request: { id: 'fixture' },
    resultSet: { rows: Array.from({ length: 6 }, (_, i) => ({ item: i })), schema: [], quality } }) };
}

test('Narration preview does not change the delivered count', async () => {
  const f = fixture(['共6行']);
  await f.run();
  const evidence = JSON.parse(f.calls[0][1].content).resultSet;
  assert.equal(evidence.rows.length, 2);
  assert.deepEqual(evidence.delivery, { returnedRows: 6, totalRows: 6, completeness: 'complete', isTruncated: false });
});

test('Unknown source total remains null for limited results', async () => {
  const f = fixture(['结果受限'], { isTruncated: true, totalRowCount: null });
  await f.run();
  const evidence = JSON.parse(f.calls[0][1].content).resultSet;
  assert.equal(evidence.delivery.totalRows, null);
  assert.equal(evidence.fullResultProfile.rowCount, 6);
  assert.equal(evidence.delivery.completeness, 'limited');
});

for (const wrong of ['仅展示前2条记录作为示例', '数据量较大，无法列出所有项目', '只展示部分预览行']) {
  test(`Contradictory delivery claim requires LLM repair: ${wrong}`, async () => {
    const f = fixture([wrong, '共6行']);
    assert.equal((await f.run()).summary, '共6行');
    assert.equal(f.calls.length, 2);
    assert.match(f.calls[1].at(-1).content, /repairFeedback/);
  });
}

test('Repeated invalid delivery claim fails without a replacement answer', async () => {
  const f = fixture(['仅展示前2条记录']);
  await assert.rejects(f.run, { code: 'NARRATION_DELIVERY_INVALID' });
  assert.equal(f.calls.length, 2);
});

test('Empty model summary fails rather than invoking a deterministic answer', async () => {
  const f = fixture(['']);
  await assert.rejects(f.run, { code: 'NARRATION_DELIVERY_INVALID' });
});

test('A complete large result may mention its actual count without being rejected', async () => {
  const f = fixture(['共3744条记录，结果已完整返回。']);
  const result = await f.run();
  assert.equal(result.summary, '共3744条记录，结果已完整返回。');
  assert.equal(f.calls.length, 1);
});

test('A complete result may distinguish a model preview from delivered rows', async () => {
  const f = fixture(['模型仅展示前20条预览，用户结果共2023行，已完整返回。']);
  const result = await f.run();
  assert.equal(result.summary, '模型仅展示前20条预览，用户结果共2023行，已完整返回。');
  assert.equal(f.calls.length, 1);
});
