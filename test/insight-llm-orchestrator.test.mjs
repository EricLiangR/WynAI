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

test('Narrator 数字没有证据支持时失败', async () => {
  await assert.rejects(() => runInsightLlmOrchestration({
    llm: llm([
      { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] },
      { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '销售额为 999。', evidenceIds: ['ev-sales-total'] }], keyFindings: [{ text: '差异需要复核。', evidenceIds: ['ev-sales-total'] }], risks: [{ text: '证据不足。', evidenceIds: ['ev-sales-total'] }], actions: [{ text: '复核数据。', evidenceIds: ['ev-sales-total'] }] },
      { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '销售额为 999。', evidenceIds: ['ev-sales-total'] }], keyFindings: [{ text: '差异需要复核。', evidenceIds: ['ev-sales-total'] }], risks: [{ text: '证据不足。', evidenceIds: ['ev-sales-total'] }], actions: [{ text: '复核数据。', evidenceIds: ['ev-sales-total'] }] },
    ]), input: pack(),
}), /不存在的数字/);
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

test('Narrator 校验失败后进行一次严格修复重试', async () => {
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
  assert.equal(result.narrative.managementSummary[0].text, '销售额为 180。');
  assert.deepEqual(result.stageAudit.map(item => item.stage), ['planner', 'critic', 'narrator', 'narrator-repair']);
});
