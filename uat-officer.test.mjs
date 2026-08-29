import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateUatCase, isApprovedSkillIdentity, normalizeUatCase } from './uat-officer.mjs';

test('UAT 验收官以稳定身份校验 Skill，不冻结补丁版本', () => {
  assert.equal(isApprovedSkillIdentity({ id: 'sales-baseline', version: '1.3.0', status: 'approved' }), true);
  assert.equal(isApprovedSkillIdentity({ id: 'sales-baseline', version: 'invalid', status: 'approved' }), false);
  assert.equal(isApprovedSkillIdentity({ id: 'sales-baseline', version: '1.3.0', status: 'draft' }), false);
});

test('UAT 验收官同时校验语义、查询、结果、展示与 trace', () => {
  const uatCase = normalizeUatCase({ id: 'sales-core', version: '1.1.0', domain: '销售', datasetId: 'd1' }, { id: 'sales-001', question: '过去五年每年销售收入和同比', expected: { status: 'supported', metrics: ['订单金额'], dimensions: ['订购日期'], grain: 'year' }, expectedQueryInvariants: { requiredMeasures: ['订单金额'] }, expectedResultInvariants: { minimumRows: 5 }, expectedPresentation: { mode: 'chart-and-table', chartType: 'combo' }, expectedTraceEvents: ['request.accepted', 'query.executed', 'request.completed'] });
  const result = evaluateUatCase(uatCase, { status: 'ok', trace: { traceId: 'trace-1' }, businessIntent: { metrics: [{ field: '订单金额' }], dimensions: [{ field: '订购日期' }], time: { grain: 'year' } }, queryRequests: [{ measures: [{ field: '订单金额' }], select: [{ field: '订购日期' }] }], resultSets: [{ rows: [{}, {}, {}, {}, {}] }], presentationPlan: { mode: 'chart-and-table', chart: { visualization: { type: 'combo' } } } }, [{ event: 'request.accepted' }, { event: 'query.executed' }, { event: 'request.completed' }]);
  assert.equal(result.passed, true);
});
