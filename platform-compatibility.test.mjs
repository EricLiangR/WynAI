import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBusinessResultSnapshot, compareCompatibilitySnapshots, createCompatibilityContract, platformCompatibilityContractVersion, validateCompatibilityContract } from './platform-compatibility-contract.mjs';

function validContract() {
  return createCompatibilityContract({
    module: 'data-insight',
    adapter: 'data-insight-adapter/v1',
    versions: { input: 'wynai.insight-input/v1', gateway: 'wynai.llm-gateway/v1', evidence: 'wynai.evidence-pack/v1', skill: 'wynai.skill/v1', lifecycle: 'wynai.insight-run/v1' },
    contextClasses: { 'original-question':'required-lossless','active-conversation-context':'required-lossless','dataset-metadata':'required-lossless','skill-references':'required-lossless','permissions-and-scope':'required-lossless','derived-metric-formulas':'required-lossless','evidence-provenance':'required-lossless','redundant-history':'summarizable-with-provenance','provider-credentials':'never-forward' },
    invariants: { 'numeric-results':true, filters:true, permissions:true, 'evidence-relations':true, 'terminal-status':true, 'skill-semantics':true, 'user-visible-answer':true },
  });
}

test('平台兼容契约要求核心上下文无损和全部迁移模式', () => { const contract = validContract(); assert.equal(contract.schema, platformCompatibilityContractVersion); assert.equal(contract.module, 'data-insight'); assert.deepEqual(validateCompatibilityContract(contract), contract); });
test('平台兼容契约拒绝缺失核心无损上下文', () => { const contract = validContract(); delete contract.contextClasses['dataset-metadata']; assert.throws(() => validateCompatibilityContract(contract), /核心上下文必须无损传递/); });
test('平台兼容契约拒绝关闭阻断不变量', () => { const contract = validContract(); contract.invariants.permissions = false; assert.throws(() => validateCompatibilityContract(contract), /阻断不变量必须启用/); });
test('业务快照的数值或权限差异会阻断，内部 trace 差异不会阻断', () => { const result = compareCompatibilitySnapshots({ numericResults:{ revenue:100 }, permissions:{ rows:10 }, traceId:'old' }, { numericResults:{ revenue:101 }, permissions:{ rows:9 }, traceId:'new' }); assert.equal(result.passed, false); assert.deepEqual(result.differences.map(item => item.kind), ['numeric-results','permissions']); assert.equal(result.differences.every(item => item.blocking), true); });
test('仅有允许的内部元数据差异时通过', () => { const result = compareCompatibilitySnapshots({ numericResults:{ revenue:100 }, traceId:'old', promptLayout:'a' }, { numericResults:{ revenue:100 }, traceId:'new', promptLayout:'b' }); assert.equal(result.passed, true); assert.deepEqual(result.differences, []); });
test('业务编排快照比较 Planner/Critic/Narrator 和证据值，忽略叙述措辞', () => {
  const base = { status: 'completed', orchestration: { stageAudit: [{ stage: 'planner', status: 'completed' }, { stage: 'critic', status: 'completed' }, { stage: 'narrator', status: 'completed' }], planner: { coreHypotheses: [{ id: 'h1', methodId: 'trend', evidenceIds: ['ev-1'] }] }, critic: { assessments: [{ hypothesisId: 'h1', status: 'supported', evidenceIds: ['ev-1'] }] }, evidence: [{ id: 'ev-1', value: 100, formula: null, scope: { period: '2025' } }] }, structured: { keyFindings: [{ text: '旧文案', evidenceIds: ['ev-1'] }] } };
  const same = structuredClone(base); same.structured.keyFindings[0].text = '新文案';
  const before = { businessResult: buildBusinessResultSnapshot(base) };
  const after = { businessResult: buildBusinessResultSnapshot(same) };
  assert.equal(compareCompatibilitySnapshots(before, after).passed, true);
  const changed = structuredClone(base); changed.orchestration.evidence[0].value = 101;
  const diff = compareCompatibilitySnapshots(before, { businessResult: buildBusinessResultSnapshot(changed) });
  assert.equal(diff.passed, false);
  assert.equal(diff.differences[0].kind, 'business-result');
});
