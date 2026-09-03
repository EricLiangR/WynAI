import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePlatformContextManifest, validatePlatformEvidenceTransport } from './platform-context-governance.mjs';

const input = { schema: 'wynai.insight-input/v1', title: '分析销售收入和利润', datasets: [{ id: 'dataset-1' }], resultSets: [{ id: 'rs-1', schema: [{ name: '收入', type: 'number', role: 'measure' }], rows: [{ 收入: 100 }] }] };
test('平台上下文 Manifest 保留原问题、数据集、Skill 和证据引用且核心类别无损', () => {
  const manifest = compilePlatformContextManifest({ question: input.title, input, skills: [{ id: 'retail', version: '1.3.0' }], skillPlan: { schema: 'wynai.skill-plan/v1' }, evidencePack: { schema: 'wynai.evidence-pack/v1', policy: { rawRowsToLlm: false, chunking: 'lossless-partition' }, coverage: { omittedGroups: 0 } } });
  assert.equal(manifest.schema, 'wynai.platform-context-manifest/v1');
  assert.equal(manifest.references.skillRefs[0], 'retail@1.3.0');
  assert.equal(manifest.transport.rawRowsToLlm, false);
  assert.equal(Object.values(manifest.contextClasses).every(value => value === 'required-lossless'), true);
});
test('平台上下文拒绝原始明细外发', () => { assert.throws(() => compilePlatformContextManifest({ question: input.title, input, evidencePack: { policy: { rawRowsToLlm: true } } }), /禁止向 LLM 发送原始明细/); });
test('Evidence Pack 允许显式平台限制但拒绝矛盾完整标记', () => {
  const limited = validatePlatformEvidenceTransport({ policy: { rawRowsToLlm: false }, coverage: { omittedGroups: 3, groupingsComplete: false, reason: 'explicit-platform-limit' } });
  assert.equal(limited.valid, true); assert.equal(limited.lossless, true);
  assert.throws(() => validatePlatformEvidenceTransport({ coverage: { omittedGroups: 1, groupingsComplete: true } }), /完整标记与省略分组矛盾/);
});
