import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowUpActions } from '../lib/conversation/followup-actions.mjs';
import { composeQuestionDocument, planBusinessQuestion } from '../lib/conversation/question-planner.mjs';
import { normalizeInsightDocument } from '../lib/protocol/interaction-contract.mjs';

const laboratoryMetadata = {
  id: 'dataset-lab-v1', revision: 1, name: '检测实验室',
  fields: [
    { name: '检测日期', role: 'time', type: 'Date' },
    { name: '检测次数', role: 'measure', type: 'Number' },
    { name: '不合格数量', role: 'measure', type: 'Number' },
    { name: '检测项目', role: 'dimension', type: 'String' },
    { name: '检验机构', role: 'dimension', type: 'String' },
  ],
};

function resultFor(plan) {
  return { id: 'rs-lab-1', rows: [{ [plan.request.measures[0].alias]: 10 }], schema: [{ name: plan.request.measures[0].alias }], quality: {} };
}

test('动态后续操作只使用当前数据集语义字段，且不包含固定销售文本', () => {
  const plan = planBusinessQuestion({ metadata: laboratoryMetadata, question: '检测次数总额是多少' });
  assert.equal(plan.status, 'supported');
  const actions = buildFollowUpActions({ metadata: laboratoryMetadata, plan, resultSet: resultFor(plan), question: '检测次数总额是多少' });
  assert.deepEqual(actions.map(item => item.label), ['改看不合格数量', '按检测项目查看', '按月查看趋势']);
  assert.ok(actions.every(item => item.schema === 'wynai.follow-up-action/v1' && item.confidence === 1));
  assert.ok(actions.every(item => !/利润|华东|销售|明细/.test(`${item.label}${item.question}`)));
});

test('动态操作对应的自然语言追问可在自定义数据集重新编译', () => {
  for (const question of ['改为查看不合格数量', '按检测项目查看检测次数', '按月查看检测次数']) {
    const plan = planBusinessQuestion({ metadata: laboratoryMetadata, question });
    assert.equal(plan.status, 'supported', question);
  }
});

test('当前查询已有时间或排名时不重复建议对应动作，质量受限结果隐藏操作', () => {
  const timePlan = planBusinessQuestion({ metadata: laboratoryMetadata, question: '按月查看检测次数' });
  const timeActions = buildFollowUpActions({ metadata: laboratoryMetadata, plan: timePlan, resultSet: resultFor(timePlan), question: '按月查看检测次数' });
  assert.equal(timeActions.some(item => item.kind === 'add-time-grain'), false);
  const rankedPlan = planBusinessQuestion({ metadata: laboratoryMetadata, question: '按检测项目查看检测次数前5名' });
  const rankedActions = buildFollowUpActions({ metadata: laboratoryMetadata, plan: rankedPlan, resultSet: resultFor(rankedPlan), question: '按检测项目查看检测次数前5名' });
  assert.equal(rankedActions.some(item => item.kind === 'rank'), false);
  assert.deepEqual(buildFollowUpActions({ metadata: laboratoryMetadata, plan: timePlan, resultSet: { ...resultFor(timePlan), quality: { isSample: true } } }), []);
});

test('文档保留结构化动作，交互契约仍拒绝原始查询字段', () => {
  const plan = planBusinessQuestion({ metadata: laboratoryMetadata, question: '检测次数总额是多少' });
  const document = composeQuestionDocument({ metadata: laboratoryMetadata, question: '检测次数总额是多少', plan, resultSet: resultFor(plan) });
  assert.equal(document.nextQuestions.length, 0);
  assert.equal(document.followUpActions.length, 3);
  assert.throws(() => normalizeInsightDocument({
    scope: { datasetId: 'dataset-lab-v1' }, blocks: [{ id: 'summary', type: 'text' }],
    followUpActions: [{ kind: 'replace-metric', label: 'x', question: 'x', basedOn: { payload: 'forbidden' } }],
  }), /禁止原始查询/);
});
test('已识别的目录维度保留其业务概念，字段名分组和排名可执行', () => {
  const metadata = {
    id: 'dataset-sales-v1', fields: [
      { name: '订购日期', role: 'time', type: 'Date' }, { name: '订单金额', role: 'measure', type: 'Number' },
      { name: '员工姓名', role: 'dimension', type: 'String' }, { name: '客户地区', role: 'geography', type: 'String' },
    ],
  };
  for (const question of ['按员工姓名查看订单金额前5名', '按客户地区查看订单金额']) {
    assert.equal(planBusinessQuestion({ metadata, question }).status, 'supported', question);
  }
});