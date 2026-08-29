import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidencePack } from '../lib/data-insights/evidence-pack.mjs';
import { runInsightLlmOrchestration } from '../lib/data-insights/llm-orchestrator.mjs';

function pack() {
  return buildEvidencePack({ title: '区域销售', evidence: [{ id: 'ev-sales-total', value: 180, title: '销售总额' }], resultSets: [{ id: 'rs-sales', schema: [{ name: '区域', type: 'string', role: 'dimension' }, { name: '销售额', type: 'number', role: 'measure' }], rows: [{ 区域: '华东', 销售额: 100 }, { 区域: '华南', 销售额: 80 }] }] });
}
function llm(outputs) { let index = 0; return { enabled: true, model: 'fake', completeJson: async () => outputs[index++] }; }

test('数据洞察通过 Planner/Critic/Narrator 编排并只允许证据引用', async () => {
  const evidenceId = 'ev-sales-total';
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', intent: 'sales', summary: '识别区域差异', hypotheses: [{ id: 'h1', question: '区域销售差异', businessValue: '定位资源重点', requiredEvidenceIds: [evidenceId] }], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [{ hypothesisId: 'h1', status: 'supported', reason: '证据足够', evidenceIds: [evidenceId] }], followUps: [] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '区域销售额已形成可核验的经营对比。', evidenceIds: [evidenceId] }], keyFindings: [{ text: '区域差异需要结合业务动作分析。', evidenceIds: [evidenceId] }], risks: [{ text: '当前证据尚未说明差异原因。', evidenceIds: [evidenceId], verificationRequired: true }], actions: [{ text: '按区域复核客户、产品和交付结构。', evidenceIds: [evidenceId] }], followUps: [] },
    ]), prompt: '请分析区域销售差异', input: pack(),
  });
  assert.equal(result.schema, 'wynai.insight-orchestration/v1');
  assert.equal(result.critic.verdict, 'sufficient');
  assert.deepEqual(result.stageAudit.map(item => item.stage), ['planner', 'critic', 'narrator']);
  assert.ok(result.stageAudit.every(item => item.status === 'completed'));
  assert.match(result.markdown, /管理摘要/);
});

test('Narrator 数字没有证据支持时隔离违规结论并保留可用洞察为 completed-partial', async () => {
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '销售额为 999。', evidenceIds: ['ev-sales-total'] }], keyFindings: [{ text: '差异需要复核。', evidenceIds: ['ev-sales-total'] }], risks: [{ text: '证据不足。', evidenceIds: ['ev-sales-total'] }], actions: [{ text: '复核数据。', evidenceIds: ['ev-sales-total'] }] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '销售额为 999。', evidenceIds: ['ev-sales-total'] }], keyFindings: [{ text: '差异需要复核。', evidenceIds: ['ev-sales-total'] }], risks: [{ text: '证据不足。', evidenceIds: ['ev-sales-total'] }], actions: [{ text: '复核数据。', evidenceIds: ['ev-sales-total'] }] },
    ]), input: pack(),
  });
  assert.equal(result.status, 'completed-partial');
  assert.equal(result.diagnostics.reasonCode, 'PARTIAL_NARRATOR_CLAIMS');
  assert.equal(result.narrative.validation.rejectedClaims[0].token, '999');
  assert.ok(result.narrative.managementSummary[0].verificationRequired);
  assert.equal(result.narrative.keyFindings[0].verificationRequired, false);
});

test('Narrator 全部内容都无法核验时仍返回 needs_review', async () => {
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '销售额为 999。', evidenceIds: ['ev-sales-total'] }], keyFindings: [{ text: '区域销售额为 999。', evidenceIds: ['ev-sales-total'] }], risks: [{ text: '风险值为 999。', evidenceIds: ['ev-sales-total'] }], actions: [{ text: '目标值为 999。', evidenceIds: ['ev-sales-total'] }] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '销售额为 999。', evidenceIds: ['ev-sales-total'] }], keyFindings: [{ text: '区域销售额为 999。', evidenceIds: ['ev-sales-total'] }], risks: [{ text: '风险值为 999。', evidenceIds: ['ev-sales-total'] }], actions: [{ text: '目标值为 999。', evidenceIds: ['ev-sales-total'] }] },
    ]), input: pack(),
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.diagnostics.reasonCode, 'NARRATOR_UNSUPPORTED_CLAIM');
});

test('Narrator 可验证日期/文本证据中的年份和月份', async () => {
  const input = buildEvidencePack({
    title: '近三年月度销售',
    resultSets: [{
      id: 'rs-monthly-sales',
      schema: [
        { name: '订购日期', type: 'string', role: 'time' },
        { name: '销售额', type: 'number', role: 'measure' },
      ],
      rows: [{ '订购日期': '2023年3月', '销售额': 120 }],
    }],
  });
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '2023年3月销售额为 120。', evidenceIds: ['ev-rs-monthly-sales-sample-0'] }], keyFindings: [{ text: '该月份需要结合后续月份比较。', evidenceIds: ['ev-rs-monthly-sales-sample-0'] }], risks: [{ text: '当前只有一个月的样本，不能外推全年趋势。', evidenceIds: ['ev-rs-monthly-sales-sample-0'] }], actions: [{ text: '补充后续月份并复核趋势。', evidenceIds: ['ev-rs-monthly-sales-sample-0'] }] },
    ]),
    input,
  });
  assert.equal(result.narrative.managementSummary[0].text, '2023年3月销售额为 120。');
});

test('Narrator 支持受控金额单位换算', async () => {
  const input = buildEvidencePack({ resultSets: [{ id: 'rs-unit', schema: [{ name: '销售额', type: 'number', role: 'measure' }], rows: [{ 销售额: 616000 }] }] });
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '销售额约为 61.6 万元。', evidenceIds: ['ev-rs-unit-field-0-sum'] }], keyFindings: [{ text: '需要结合更多维度分析。', evidenceIds: ['ev-rs-unit-field-0-sum'] }], risks: [{ text: '当前证据不足以判断风险。', evidenceIds: ['ev-rs-unit-field-0-sum'] }], actions: [{ text: '补充维度分析。', evidenceIds: ['ev-rs-unit-field-0-sum'] }] },
    ]),
    input,
  });
  assert.equal(result.narrative.managementSummary[0].text, '销售额约为 61.6 万元。');
  assert.deepEqual(result.stageAudit.map(item => item.stage), ['planner', 'critic', 'narrator']);
});

test('Narrator 对违规数字执行一次受控修订并保留严格校验', async () => {
  const input = buildEvidencePack({ evidence: [{ id: 'ev-sales-total', value: 180 }] });
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '销售额为 999。', evidenceIds: ['ev-sales-total'] }], keyFindings: [{ text: '需要分析。', evidenceIds: ['ev-sales-total'] }], risks: [{ text: '需要复核。', evidenceIds: ['ev-sales-total'] }], actions: [{ text: '复核数据。', evidenceIds: ['ev-sales-total'] }] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '销售额为 180。', evidenceIds: ['ev-sales-total'] }], keyFindings: [{ text: '需要分析。', evidenceIds: ['ev-sales-total'] }], risks: [{ text: '需要复核。', evidenceIds: ['ev-sales-total'] }], actions: [{ text: '复核数据。', evidenceIds: ['ev-sales-total'] }] },
    ]),
    input,
  });
  assert.equal(result.narrative.managementSummary[0].verificationRequired, false);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.stageAudit.map(item => item.stage), ['planner', 'critic', 'narrator', 'narrator-repair']);
});

test('Evidence Pack 超预算在编排开始前返回上下文预算错误', async () => {
  await assert.rejects(() => runInsightLlmOrchestration({ llm: llm([]), input: { budget: { withinBudget: false }, evidence: [{ id: 'ev-1', value: 1 }] } }), error => error.code === 'LLM_CONTEXT_LIMIT');
});

test('Narrator 支持集中度比例转百分比及下降率绝对值语义', async () => {
  const input = buildEvidencePack({
    evidence: [
      { id: 'concentration', title: '地区集中度', value: { share: 0.7672668, topN: 3 } },
      { id: 'ev-qoq', title: '订单金额 期间变化率', value: -53.9912312, unit: '%' },
    ],
  });
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1',
        managementSummary: [{ text: '头部地区贡献约76.7%的销售额。', evidenceIds: ['concentration'] }],
        keyFindings: [{ text: '该季度销售额下降约54%。', evidenceIds: ['ev-qoq'] }],
        risks: [{ text: '地区集中风险需要持续监控。', evidenceIds: ['concentration'] }],
        actions: [{ text: '按地区复核客户和商品结构。', evidenceIds: ['concentration'] }],
        followUps: [] },
    ]),
    input,
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.narrative.validation.rejectedClaims, []);
});

test('Narrator 支持对多个期间变化率的阈值断言', async () => {
  const input = buildEvidencePack({ evidence: [
    { id: 'q1', title: '订单金额 期间变化率', value: -46.4, unit: '%' },
    { id: 'q2', title: '订单金额 期间变化率', value: -53.2, unit: '%' },
    { id: 'q3', title: '订单金额 期间变化率', value: -49.8, unit: '%' },
  ] });
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1',
        managementSummary: [{ text: '各期间降幅均超过46%。', evidenceIds: ['q1', 'q2', 'q3'] }],
        keyFindings: [{ text: '需要结合业务节奏复核。', evidenceIds: ['q1'] }],
        risks: [{ text: '存在周期性下行风险。', evidenceIds: ['q1', 'q2', 'q3'] }],
        actions: [{ text: '提前复核第二季度计划。', evidenceIds: ['q1', 'q2', 'q3'] }],
        followUps: [] },
    ]),
    input,
  });
  assert.equal(result.status, 'completed');
});

test('Narrator 支持下降幅度范围的上下界分别校验', async () => {
  const input = buildEvidencePack({ evidence: [
    { id: 'q1', title: '订单金额 期间变化率', value: -46.4, unit: '%' },
    { id: 'q2', title: '订单金额 期间变化率', value: -53.2, unit: '%' },
    { id: 'q3', title: '订单金额 期间变化率', value: 84.8, unit: '%' },
  ] });
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1',
        managementSummary: [{ text: '降幅约46%-54%，回升约85%。', evidenceIds: ['q1', 'q2', 'q3'] }],
        keyFindings: [{ text: '周期性波动需要关注。', evidenceIds: ['q1'] }],
        risks: [{ text: '低谷期经营风险需要复核。', evidenceIds: ['q1', 'q2'] }],
        actions: [{ text: '提前制定季度计划。', evidenceIds: ['q1', 'q2'] }],
        followUps: [] },
    ]),
    input,
  });
  assert.equal(result.status, 'completed');
});

test('Narrator 不把季度标签当成数字，并支持分组累计贡献占比', async () => {
  const input = buildEvidencePack({ evidence: [
    { id: 'dimension-contribution', title: '地区贡献', value: { dimension: '地区', measure: '销售额', rows: [{ 地区: '华东', 销售额: 60 }, { 地区: '华北', 销售额: 40 }] } },
    { id: 'concentration', title: '地区集中度', value: { share: 0.8, topN: 2, total: 100, measure: '销售额' } },
  ] });
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1',
        managementSummary: [{ text: 'Q2销售额为60，头部两地区占比100%。', evidenceIds: ['dimension-contribution', 'concentration'] }],
        keyFindings: [{ text: 'Q2需要重点复核。', evidenceIds: ['dimension-contribution'] }],
        risks: [{ text: '地区集中度需要监控。', evidenceIds: ['concentration'] }],
        actions: [{ text: '按地区制定复核计划。', evidenceIds: ['concentration'] }],
        followUps: [] },
    ]),
    input,
  });
  assert.equal(result.status, 'completed');
});

test('Narrator 可从地区贡献明细和总额核验单项占比', async () => {
  const input = buildEvidencePack({ evidence: [
    { id: 'dimension-contribution', title: '地区贡献', value: { dimension: '地区', measure: '销售额', total: 1000, rows: [{ 地区: '华东', 销售额: 371.6 }, { 地区: '东北', 销售额: 41 }] } },
  ] });
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1',
        managementSummary: [{ text: '华东地区销售额占整体约37.2%。', evidenceIds: ['dimension-contribution'] }],
        keyFindings: [{ text: '华东是最大贡献地区。', evidenceIds: ['dimension-contribution'] }],
        risks: [{ text: '区域结构需要持续监控。', evidenceIds: ['dimension-contribution'] }],
        actions: [{ text: '按地区复核销售与利润结构。', evidenceIds: ['dimension-contribution'] }],
        followUps: [] },
    ]), input,
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.narrative.validation.rejectedClaims, []);
});

test('Narrator 可引用期间变化公式中的本期与前期金额', async () => {
  const input = buildEvidencePack({ evidence: [
    { id: 'qoq', title: '订单金额 期间变化率', value: -53.99, formula: '(444953.14-967105.08)/967105.08*100', unit: '%' },
  ] });
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1',
        managementSummary: [{ text: '本期销售额444,953.14，前期为967,105.08。', evidenceIds: ['qoq'] }],
        keyFindings: [{ text: '销售额下降约54%。', evidenceIds: ['qoq'] }],
        risks: [{ text: '季度下行风险需要监控。', evidenceIds: ['qoq'] }],
        actions: [{ text: '复核低谷季度的业务驱动因素。', evidenceIds: ['qoq'] }],
        followUps: [] },
    ]),
    input,
  });
  assert.equal(result.status, 'completed');
});

test('Narrator 可引用证据范围中的期间年份', async () => {
  const input = buildEvidencePack({ evidence: [
    { id: 'q1', title: '订单金额 期间变化率', value: -46.4, formula: '(539497.44-1007149.96)/1007149.96*100', scope: { period: '2021-04-01', previousPeriod: '2021-01-01' } },
  ] });
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1',
        managementSummary: [{ text: '2021年第二季度销售额下降约46%。', evidenceIds: ['q1'] }],
        keyFindings: [{ text: '需关注季度波动。', evidenceIds: ['q1'] }],
        risks: [{ text: '淡季风险需要监控。', evidenceIds: ['q1'] }],
        actions: [{ text: '复核2021年第二季度的下降原因。', evidenceIds: ['q1'] }],
        followUps: [] },
    ]),
    input,
  });
  assert.equal(result.status, 'completed');
});

test('Critic 局部证据不足时返回 completed-partial 而不是整体失败', async () => {
  const input = buildEvidencePack({
    evidence: [
      { id: 'time-trend', title: '月度趋势', value: [{ 月份: '2024-01', 销售额: 100, 利润: 40 }] },
      { id: 'revenue-total', title: '销售额合计', value: 100 },
      { id: 'profit-total', title: '利润合计', value: 40 },
    ],
  });
  const result = await runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [{ id: 'core', requiredEvidenceIds: ['time-trend'] }, { id: 'optional', requiredEvidenceIds: ['time-trend'] }], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'insufficient', assessments: [
        { hypothesisId: 'core', status: 'supported', reason: '月度核心结果可验证', evidenceIds: ['time-trend'] },
        { hypothesisId: 'optional', status: 'inconclusive', reason: '缺少扩展维度', evidenceIds: ['time-trend'] },
      ], followUps: [] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '月度销售额和利润可由当前结果验证。', evidenceIds: ['time-trend'] }], keyFindings: [{ text: '扩展分析暂无法确认。', evidenceIds: ['time-trend'], verificationRequired: true }], risks: [{ text: '请补充扩展维度。', evidenceIds: ['time-trend'], verificationRequired: true }], actions: [{ text: '继续复核当前结果。', evidenceIds: ['time-trend'] }], followUps: [] },
    ]),
    prompt: '过去半年每月销售额和利润',
    input,
  });
  assert.equal(result.status, 'completed-partial');
  assert.equal(result.diagnostics.reasonCode, 'PARTIAL_EVIDENCE');
});
