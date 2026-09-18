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

test('Narration date evidence uses the table business time zone rather than UTC day', async () => {
  let evidence;
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test',
    model: 'fixture',
    transport: async input => {
      evidence = JSON.parse(input.messages[1].content).resultSet;
      return { summary: '业务日期为 2025-02-18', keyPoints: [], limitations: [] };
    },
  });
  await llm.narrateQueryResult({
    question: 'Show created date',
    request: { id: 'date-test' },
    resultSet: {
      rows: [{ created: '2025-02-17T16:00:00.000Z' }],
      schema: [{ name: 'created', role: 'dimension', type: 'date' }],
      scope: { timeZone: 'Asia/Shanghai' },
      statistics: { minimums: { created: '2025-02-17T16:00:00.000Z' } },
      quality: { isComplete: true },
    },
  });
  assert.equal(evidence.rows[0].created, '2025-02-18');
  assert.equal(evidence.fullResultProfile.dimensions.created.minimum, '2025-02-18');
  assert.equal(evidence.statistics.minimums.created, '2025-02-18');
});

test('An intentional user ranking is complete within its requested TopN scope', async () => {
  const f = fixture(['按要求返回前6项'], { userLimitApplied: true, totalRowCount: 100 });
  await f.run();
  const evidence = JSON.parse(f.calls[0][1].content).resultSet;
  assert.equal(evidence.delivery.totalRows, 100);
  assert.equal(evidence.delivery.completeness, 'complete');
  assert.equal(evidence.delivery.isTruncated, false);
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
  assert.equal(f.calls.length, 3);
});

test('Narration delivery validation permits two bounded repairs without fallback', async () => {
  const f = fixture(['仅展示前2条记录', '仅展示前2条记录', '实际返回6行。']);
  const result = await f.run();
  assert.equal(result.summary, '实际返回6行。');
  assert.equal(f.calls.length, 3);
  const repair = JSON.parse(f.calls[2].at(-1).content);
  assert.equal(repair.forbiddenInternalPreviewRowCount, 2);
  assert.match(repair.instruction, /只使用 delivery.returnedRows/);
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

test('Narration repairs currency totals that are not supported by the complete result', async () => {
  const summaries = ['总商机金额为2,405,000,000元（约24.05亿元）。', '总商机金额为2,401,301,728.07元（约24.01亿元）。'];
  const calls = [];
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test', model: 'fixture',
    transport: async input => {
      calls.push(structuredClone(input.messages));
      return { summary: summaries[Math.min(calls.length - 1, summaries.length - 1)], keyPoints: [], limitations: [] };
    },
  });
  const result = await llm.narrateQueryResult({
    question: '不是某两类客户的商机金额是多少', request: { id: 'currency-evidence' },
    resultSet: {
      rows: [
        { revenue: 1000000000 }, { revenue: 800000000 }, { revenue: 400000000 },
        { revenue: 150000000 }, { revenue: 40000000 }, { revenue: 10000000 }, { revenue: 1301728.07 },
      ],
      schema: [{ name: 'revenue', role: 'measure', type: 'number', aggregation: 'sum' }],
      quality: { isComplete: true },
    },
  });
  assert.equal(result.summary, summaries[1]);
  assert.equal(calls.length, 2);
  assert.match(calls[1].at(-1).content, /摘要金额缺少查询结果证据/);
});

test('Projection monetary values remain valid row-level narration evidence', async () => {
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test', model: 'fixture',
    transport: async () => ({
      summary: '商机金额包括 45,117,658.112 元和 131,443.2 元。',
      keyPoints: [],
      limitations: [],
    }),
  });
  const result = await llm.narrateQueryResult({
    question: '列出商机金额',
    request: { id: 'projection-money-evidence', mode: 'projection' },
    resultSet: {
      rows: [{ opportunity_amount: 45117658.112 }, { opportunity_amount: 131443.2 }],
      schema: [{ name: 'opportunity_amount', sourceField: 'Opportunity_amount_CNY', displayName: '商机金额', role: 'measure', type: 'number', aggregation: null }],
      quality: { isComplete: true },
    },
  });
  assert.match(result.summary, /45,117,658\.112/);
});

test('Narration accepts a real source field label when it refers to the resolved result column', async () => {
  const calls = [];
  const summaries = ['商机数量按 pipelineCode 去重计数为 10 个。'];
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test', model: 'fixture',
    transport: async input => {
      calls.push(structuredClone(input.messages));
      return { summary: summaries[Math.min(calls.length - 1, summaries.length - 1)], keyPoints: [], limitations: [] };
    },
  });
  const result = await llm.narrateQueryResult({
    question: '商机数量是多少',
    request: { id: 'business-label-narration' },
    resultSet: {
      rows: [{ opportunity_count: 10 }],
      schema: [{ name: 'opportunity_count', sourceField: 'pipelineCode', displayName: '商机数量（去重）', role: 'measure', type: 'number', aggregation: 'distinctCount' }],
      quality: { isComplete: true },
    },
  });
  assert.equal(result.summary, summaries[0]);
  assert.equal(calls.length, 1);
});

test('Narration rejects technical trace fields even when they are mentioned by the model', async () => {
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test', model: 'fixture',
    transport: async () => ({ summary: 'traceId 为 trace-123', keyPoints: [], limitations: [] }),
  });
  await assert.rejects(llm.narrateQueryResult({
    question: '客户名单', request: { id: 'technical-field' },
    resultSet: {
      rows: [{ customer: '客户1' }],
      schema: [{ name: 'customer', sourceField: '客户名称', displayName: '客户', role: 'dimension', type: 'string' },
        { name: 'trace_id', sourceField: 'traceId', displayName: 'traceId', role: 'technical', type: 'string' }],
      quality: { isComplete: true },
    },
  }), { code: 'NARRATION_DELIVERY_INVALID' });
});

test('Narration evidence validation does not mistake an aggregate threshold for a result total', async () => {
  const calls = [];
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test', model: 'fixture',
    transport: async input => {
      calls.push(structuredClone(input.messages));
      return { summary: '筛选总金额大于1000万元后，共返回2行。', keyPoints: [], limitations: [] };
    },
  });
  const result = await llm.narrateQueryResult({
    question: '筛选总金额大于1000万', request: { id: 'threshold-evidence' },
    resultSet: {
      rows: [{ revenue: 20000000 }, { revenue: 15000000 }],
      schema: [{ name: 'revenue', role: 'measure', type: 'number', aggregation: 'sum' }],
      quality: { isComplete: true },
    },
  });
  assert.match(result.summary, /1000万/);
  assert.equal(calls.length, 1);
});

test('Empty aggregate result may state a structured monetary threshold as a condition', async () => {
  const calls = [];
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test', model: 'fixture',
    transport: async input => {
      calls.push(structuredClone(input.messages));
      return { summary: '筛选阈值为10000000元，未找到符合条件的产品大类。', keyPoints: [], limitations: [] };
    },
  });
  const result = await llm.narrateQueryResult({
    question: '筛选总金额大于1000万',
    request: { id: 'empty-threshold-evidence', resultFilters: [{ field: 'revenue', operator: 'gt', value: 10000000 }] },
    resultSet: {
      rows: [],
      schema: [{ name: 'revenue', role: 'measure', type: 'number', aggregation: 'sum' }],
      quality: { isComplete: true },
    },
  });
  assert.match(result.summary, /筛选阈值/);
  assert.equal(calls.length, 1);
});

test('Structured threshold cannot be presented as the aggregate result amount', async () => {
  const calls = [];
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test', model: 'fixture',
    transport: async input => {
      calls.push(structuredClone(input.messages));
      return { summary: '总商机金额为10000000元。', keyPoints: [], limitations: [] };
    },
  });
  await assert.rejects(llm.narrateQueryResult({
    question: '筛选总金额大于1000万',
    request: { id: 'threshold-not-result', resultFilters: [{ field: 'revenue', operator: 'gt', value: 10000000 }] },
    resultSet: {
      rows: [],
      schema: [{ name: 'revenue', role: 'measure', type: 'number', aggregation: 'sum' }],
      quality: { isComplete: true },
    },
  }), { code: 'NARRATION_DELIVERY_INVALID' });
  assert.equal(calls.length, 3);
});

test('Threshold must not excuse a claimed post-filter total', async () => {
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test', model: 'fixture',
    transport: async () => ({ summary: '筛选后总商机金额为10000000元。', keyPoints: [], limitations: [] }),
  });
  await assert.rejects(llm.narrateQueryResult({
    question: '筛选总金额大于1000万',
    request: { id: 'post-filter-total', resultFilters: [{ field: 'revenue', operator: 'gt', value: 10000000 }] },
    resultSet: { rows: [], schema: [{ name: 'revenue', role: 'measure', type: 'number', aggregation: 'sum' }], quality: { isComplete: true } },
  }), { code: 'NARRATION_DELIVERY_INVALID' });
});
