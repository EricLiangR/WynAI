import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SkillRegistry, loadSkillsFromDirectory } from '../lib/skills/skill-registry.mjs';
import { buildFallbackExplorationPlan } from '../lib/planning/exploration-planner.mjs';

test('Skill 按作用域和触发词解析，并检测指标冲突', () => {
  const registry = new SkillRegistry([
    { id: 'sales-baseline', version: '1.0.0', name: '销售基线', scope: 'dataset', datasetIds: ['dataset-sales-v1'], triggers: ['销售', '收入'], status: 'approved', metrics: [{ name: '销售额', field: '订单金额' }] },
    { id: 'sales-user', version: '1.0.0', name: '用户口径', scope: 'user', userIds: ['u1'], triggers: ['销售'], status: 'approved', metrics: [{ name: '销售额', field: '订单利润' }] },
    { id: 'system-safe', version: '1.0.0', name: '安全规则', scope: 'system', status: 'approved' },
  ]);
  const resolved = registry.resolve({ datasetId: 'dataset-sales-v1', userId: 'u1', question: '查看销售额' });
  assert.deepEqual(resolved.map(item => item.id), ['system-safe', 'sales-baseline', 'sales-user']);
  assert.equal(registry.detectConflicts(resolved).length, 1);
});

test('Skill Registry 可从本地 skill.json 加载并按数据集触发', async () => {
  const registry = await loadSkillsFromDirectory(fileURLToPath(new URL('../skills', import.meta.url)));
  const resolved = registry.resolveForQuestion({ datasetId: '2b445034-38fe-4350-9cab-b7684c28b5f8', question: '查看销售额趋势' });
  assert.ok(resolved.refs.includes('sales-baseline@1.3.0'));
  assert.equal(resolved.conflicts.length, 0);
});

test('Skill 指标口径可驱动无 LLM 确定性计划', () => {
  const metadata = {
    id: 'dataset-skill-v1', revision: 1,
    fields: [
      { name: '业务日期', role: 'time', type: 'Date', rawType: 'DateTime', valueKind: 'temporal' },
      { name: '业务金额', role: 'dimension', type: 'Number', rawType: 'Double', valueKind: 'continuous' },
      { name: '业务利润', role: 'dimension', type: 'Number', rawType: 'Double', valueKind: 'continuous' },
    ],
  };
  const profile = { roles: { time: ['业务日期'], revenue: [], profit: [], customer: [], product: [], category: [], region: [] }, capabilities: {}, fieldCatalog: [] };
  const plan = buildFallbackExplorationPlan({ metadata, profile, focus: '利润为什么下降', skills: [{ id: 'custom', version: '1.0.0', metrics: [{ name: '销售额', field: '业务金额' }, { name: '利润', field: '业务利润' }] }] });
  assert.ok(plan.requests.some(request => request.measures.some(metric => metric.field === '业务利润')));
});
