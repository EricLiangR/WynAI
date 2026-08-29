import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { planBusinessQuestion } from './lib/conversation/question-planner.mjs';
import { SkillRegistry, normalizedSkill } from './lib/skills/skill-registry.mjs';
import { parseBusinessTimeSemantics } from './lib/semantics/time-semantics.mjs';

const now = new Date('2026-08-24T08:00:00+08:00');
const metadata = {
  id: 'dataset-relative-time',
  revision: 1,
  fields: [
    ['订购日期', 'time', 'Date'], ['订单金额', 'measure', 'Number'],
    ['客户地区', 'geography', 'String'], ['客户省份', 'geography', 'String'],
  ].map(([name, role, type]) => ({ name, role, type, rawType: type })),
};

const [temporalSkill, salesSkill] = await Promise.all([
  readFile(new URL('./skills/system/temporal-semantics/skill.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('./skills/sales/skill.json', import.meta.url), 'utf8').then(JSON.parse),
]);
const registry = new SkillRegistry([temporalSkill, salesSkill]);
const skills = registry.resolve({ datasetId: '2b445034-38fe-4350-9cab-b7684c28b5f8', question: '各销售大区上一年收入同比' });

test('相对周期 Skill 保留受治理的 offset 与表达', () => {
  const normalized = normalizedSkill(temporalSkill);
  assert.equal(normalized.version, '1.1.0');
  assert.deepEqual(normalized.relativeTemporalSemantics.find(item => item.id === 'previous-complete-year')?.expressions, ['去年', '上一年', '上年', '上年度', '上一年度', '上个年度']);
});

test('上一年等相对周期归一为完整年度范围', () => {
  for (const question of ['上一年收入', '上年收入', '上年度收入', '上一年度收入', '去年收入']) {
    const time = parseBusinessTimeSemantics(question, { now, skills });
    assert.deepEqual(time.periods, [2025], question);
    assert.deepEqual(time.range, { start: '2025-01-01', endExclusive: '2026-01-01' }, question);
    assert.equal(time.scopeExplicit, true, question);
  }
});

test('相对年度同比保留收入、大区和隐藏基期，不进入错误指标澄清', () => {
  const plan = planBusinessQuestion({
    metadata,
    question: '各销售大区上一年收入同比',
    skills,
    skillRefs: skills.map(skill => `${skill.id}@${skill.version}`),
    now,
  });
  assert.equal(plan.status, 'supported');
  assert.equal(plan.intent.time.periods[0], 2025);
  assert.equal(plan.intent.dimensions.find(item => !item.grain)?.field, '客户地区');
  assert.equal(plan.intent.derivedMetrics.find(item => item.type === 'yoy')?.sourceAlias, 'revenue');
  assert.equal(plan.request.filters.find(item => item.operator === 'gte')?.value, '2024-01-01');
  assert.equal(plan.displayRequest.select.some(item => item.grain), false);
});
