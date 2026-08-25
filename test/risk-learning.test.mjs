import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessPlanningRisk } from '../lib/planning/risk-router.mjs';
import { OperationalEventLog } from '../lib/observability/operational-event-log.mjs';
import { FeedbackLearningService } from '../lib/learning/feedback-learning.mjs';
import { normalizeEvaluationPack, runEvaluationPack } from '../lib/evaluation/evaluation-suite.mjs';
import { JsonRunStore } from '../lib/run-store.mjs';
import { SkillRegistry } from '../lib/skills/skill-registry.mjs';

function plan({ status = 'supported', metrics = [{ field: '订单金额' }], dimensions = [], derivedMetrics = [], confidence = 1, constraints = [] } = {}) {
  return { status, intent: { metrics, dimensions, derivedMetrics, confidence, constraints, time: { grain: null } } };
}

test('风险路由区分低中高风险并给出可审计原因', () => {
  const low = assessPlanningRisk({ question: '销售额是多少', plan: plan(), skillRefs: ['sales-baseline@1.1.0'] });
  assert.equal(low.level, 'low');
  assert.equal(low.policy.llm, 'skip');
  const medium = assessPlanningRisk({ question: '每年销售额同比增长率', plan: plan({ derivedMetrics: [{ source: '订单金额' }] }), skillRefs: ['sales-baseline@1.1.0'] });
  assert.equal(medium.level, 'medium');
  assert.ok(medium.reasons.some(item => item.code === 'DERIVED_METRIC'));
  const high = assessPlanningRisk({ question: '这份财务报表是否合规，为什么', plan: plan({ status: 'needs_clarification', confidence: 0.5 }) });
  assert.equal(high.level, 'high');
  assert.equal(high.policy.execution, 'blocked-until-validated');
});

test('运行事件日志按 trace 顺序回放并脱敏密钥', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wynai-operation-log-'));
  const persistence = new JsonRunStore(join(dir, 'events'), { maxItems: 20 });
  const log = new OperationalEventLog({ persistence, maxItems: 1000 });
  await log.init();
  log.record({ traceId: 'trace-test', event: 'turn.received', details: { question: '销售额', token: 'secret-value' } });
  log.record({ traceId: 'trace-test', event: 'turn.completed', outcome: 'success' });
  await log.writeChain;
  const events = log.trace('trace-test');
  assert.deepEqual(events.map(item => item.sequence), [1, 2]);
  assert.equal(events[0].details.token, '[REDACTED]');
  const restored = new OperationalEventLog({ persistence: new JsonRunStore(join(dir, 'events'), { maxItems: 20 }), maxItems: 1000 });
  await restored.init();
  assert.equal(restored.trace('trace-test').length, 2);
});

test('用户反馈只生成待审核候选，不直接修改生产 Skill', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wynai-feedback-'));
  const service = new FeedbackLearningService({
    feedbackPersistence: new JsonRunStore(join(dir, 'feedback'), { maxItems: 20 }),
    candidatePersistence: new JsonRunStore(join(dir, 'candidates'), { maxItems: 20 }),
  });
  await service.init();
  const result = await service.submit({ category: 'wrong_metric', correction: '收入应使用不含税金额' }, { conversationId: 'conv-1', turnId: 'turn-1', traceId: 'trace-1', datasetId: 'dataset-1', question: '收入是多少', answer: '100', semanticSnapshot: { skillRefs: ['finance@1.0.0'] } });
  assert.equal(result.candidate.kind, 'skill-rule');
  assert.equal(result.candidate.status, 'pending_review');
  const reviewed = await service.review(result.candidate.id, 'approved_for_authoring', { actor: 'data-owner', reason: '口径已核对' });
  assert.equal(reviewed.status, 'approved_for_authoring');
  assert.equal(service.candidates.length, 1);
});

test('只有 approved Skill 可以参与生产问题解析', () => {
  const registry = new SkillRegistry([
    { id: 'approved-skill', version: '1.0.0', scope: 'dataset', datasetIds: ['d1'], triggers: ['销售'], status: 'approved' },
    { id: 'draft-skill', version: '1.0.0', scope: 'dataset', datasetIds: ['d1'], triggers: ['销售'], status: 'draft' },
  ]);
  assert.deepEqual(registry.resolveForQuestion({ datasetId: 'd1', question: '看销售' }).refs, ['approved-skill@1.0.0']);
});

test('领域评测包运行主问题与口语变体并输出逐槽位差异', async () => {
  const pack = normalizeEvaluationPack({ id: 'retail-core', domain: '零售', datasetId: 'retail-1', status: 'approved', cases: [{ id: 'r1', question: '按品类看销售额', variants: ['各类别收入'], expected: { status: 'supported', metrics: ['订单金额'], dimensions: ['类别名称'] } }] });
  const run = await runEvaluationPack(pack, async () => plan({ metrics: [{ field: '订单金额' }], dimensions: [{ field: '类别名称' }] }));
  assert.equal(run.total, 2);
  assert.equal(run.passed, 2);
  assert.equal(run.failed, 0);
});


test('风险、日志、反馈和评测协议均有持久化 JSON Schema', async () => {
  const names = [
    ['wynai.planning-risk-assessment.v1.schema.json', 'wynai.planning-risk-assessment/v1'],
    ['wynai.operation-event.v1.schema.json', 'wynai.operation-event/v1'],
    ['wynai.user-feedback.v1.schema.json', 'wynai.user-feedback/v1'],
    ['wynai.learning-candidate.v1.schema.json', 'wynai.learning-candidate/v1'],
    ['wynai.evaluation-pack.v1.schema.json', 'wynai.evaluation-pack/v1'],
  ];
  for (const [name, schemaId] of names) {
    const schema = JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.properties.schema.const, schemaId);
  }
});

test('销售、实验室和零售评测包均符合 v1 规范', async () => {
  for (const name of ['sales.v1.json', 'laboratory.v1.json', 'retail.v1.json']) {
    const pack = JSON.parse(await readFile(new URL(`../evaluation/packs/${name}`, import.meta.url), 'utf8'));
    assert.equal(normalizeEvaluationPack(pack).schema, 'wynai.evaluation-pack/v1');
  }
});

test('负向反馈使用页面内纠错编辑器且不依赖浏览器 prompt', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /window\.prompt\s*\(/);
  assert.match(source, /class="smart-feedback-correction"/);
  assert.match(source, /data-smart-feedback-submit/);
  assert.match(source, /data-smart-feedback-cancel/);
});


test('规划器未就绪与业务风险分值分离', () => {
  const assessment = assessPlanningRisk({
    question: '查看销售额',
    plan: plan({ status: 'needs_clarification', confidence: 1, constraints: [] }),
    skillRefs: ['sales-baseline@1.1.0'],
  });
  assert.equal(assessment.score, 0);
  assert.equal(assessment.level, 'low');
  assert.equal(assessment.plannerReadiness, 'incomplete');
  assert.ok(assessment.reasons.some(item => item.code === 'PLANNER_INCOMPLETE' && item.score === 0));
});