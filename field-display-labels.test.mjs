import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFieldDisplayLabel, decorateQueryField, DISPLAY_LABEL_CONTRACT } from './field-display-labels.mjs';

test('场景化去重计数显示为项目数量并保留源字段', () => {
  assert.equal(resolveFieldDisplayLabel({ field: 'businessId', explicitLabel: '商机数量', aggregation: 'distinctCount' }), '商机数量（去重）');
  assert.deepEqual(decorateQueryField({ item: { field: 'businessId', alias: 'project_count', aggregation: 'distinctCount', displayName: '商机数量' }, metadata: { fields: [] } }), {
    field: 'businessId', alias: 'project_count', aggregation: 'distinctCount', sourceField: 'businessId', displayName: '商机数量（去重）',
  });
});

test('金额字段使用受治理的业务语义名，不根据源字段硬编码业务标签', () => {
  assert.equal(resolveFieldDisplayLabel({ field: 'amount_cny', metadataField: { displayName: '订单金额' }, aggregation: 'sum' }), '订单金额');
  assert.equal(resolveFieldDisplayLabel({ field: 'amount_cny', explicitLabel: '商机金额', aggregation: 'sum' }), '商机金额');
  assert.equal(resolveFieldDisplayLabel({ field: 'amount_cny', aggregation: 'sum' }), 'amount_cny');
});

test('普通明细字段保持数据集业务名称而不强制套用指标标签', () => {
  assert.equal(resolveFieldDisplayLabel({ field: 'pipelineCode', role: 'dimension', metadataField: { displayName: '项目编号' } }), '项目编号');
  assert.equal(DISPLAY_LABEL_CONTRACT, 'wynai.field-display-labels/v1');
});
