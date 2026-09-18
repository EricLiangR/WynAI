import test from 'node:test';
import assert from 'node:assert/strict';
import { compileBusinessQueryIntent } from './lib/semantics/business-query-intent.mjs';
import { materializeRankedDrilldownRequest, validateRankedDrilldownSeed } from './lib/query/query-program.mjs';
import { requestForResultPresentation } from './lib/conversation/session.mjs';

test('排名后下钻拆成两个 Wyn 查询，不在平台对明细结果做二次业务过滤', () => {
  const metadata = {
    id: 'dataset-ranked-drilldown', revision: 1, indexed: true,
    fields: [
      { name: '产品', type: 'String', rawType: 'String', role: 'dimension' },
      { name: '客户', type: 'String', rawType: 'String', role: 'dimension' },
      { name: '销售额', type: 'Number', rawType: 'Double', role: 'measure' },
    ],
  };
  const intent = {
    businessQuestion: '最热卖的产品及其客户',
    dataset: { id: metadata.id, revision: metadata.revision },
    metrics: [{ field: '销售额', aggregation: 'sum', alias: 'revenue', concept: 'revenue' }],
    dimensions: [
      { field: '产品', alias: 'product', concept: 'product' },
      { field: '客户', alias: 'customer', concept: 'customer' },
    ],
    filters: [], resultFilters: [], derivedMetrics: [],
    ranking: { source: '最热卖', orderBy: 'revenue', direction: 'desc', limit: 1, thenDrilldown: true, byDimension: 'product', drilldownDimensions: ['customer'] },
    expectedResult: {
      shape: 'grouped-table', minimumRows: 0, maximumRows: 20000,
      requiredPeriods: [], requiredMetrics: ['revenue'], requiredDimensions: ['product', 'customer'], timeZone: 'Asia/Shanghai',
    },
    constraints: [], assumptions: [], semanticFrame: null,
  };
  const compiled = compileBusinessQueryIntent(metadata, intent);
  assert.equal(compiled.status, 'supported', compiled.errors?.join(';'));
  assert.equal(compiled.queryProgram.stagedQuery.type, 'wyn-rank-then-drilldown');
  assert.deepEqual(compiled.request.select.map(item => item.alias), ['product']);
  assert.deepEqual(compiled.request.orderBy, [{ field: 'revenue', direction: 'desc' }]);
  assert.equal(compiled.request.limit, 1);
  assert.equal(compiled.request.limitSource, 'user-ranking');
  const drilldown = materializeRankedDrilldownRequest(compiled.queryProgram, {
    rows: [{ product: '产品A', revenue: 100 }],
  });
  assert.deepEqual(drilldown.filters, [{ field: '产品', operator: 'eq', value: '产品A' }]);
  assert.deepEqual(drilldown.select.map(item => item.alias), ['product', 'customer']);
  assert.equal(compiled.queryProgram.steps.some(step => step.type === 'rank-then-drilldown'), false);
});

test('排名下钻协议拒绝缺失或颠倒的维度角色', () => {
  const base = {
    businessQuestion: '找出指标最高的业务对象并列出相关明细对象',
    metrics: [{ field: '指标', aggregation: 'sum', alias: 'value', concept: 'value' }],
    dimensions: [
      { field: '业务对象', alias: 'ranked_entity', concept: 'entity' },
      { field: '明细对象', alias: 'detail_entity', concept: 'detail' },
    ],
    filters: [], resultFilters: [], derivedMetrics: [], constraints: [], assumptions: [], semanticFrame: null,
    expectedResult: { shape: 'grouped-table', minimumRows: 0, maximumRows: 20000, requiredPeriods: [], requiredMetrics: ['value'], requiredDimensions: ['ranked_entity', 'detail_entity'], timeZone: 'Asia/Shanghai' },
  };
  const metadata = { id: 'generic', revision: 1, indexed: true, fields: [
    { name: '业务对象', type: 'String', role: 'dimension' },
    { name: '明细对象', type: 'String', role: 'dimension' },
    { name: '指标', type: 'Number', role: 'measure' },
  ] };
  const missing = compileBusinessQueryIntent(metadata, {
    ...base, ranking: { orderBy: 'value', direction: 'desc', limit: 1, thenDrilldown: true, byDimension: 'ranked_entity' },
  });
  assert.equal(missing.status, 'needs_clarification');
  assert.match(missing.errors.join(';'), /drilldownDimensions/);

  const same = compileBusinessQueryIntent(metadata, {
    ...base, ranking: { orderBy: 'value', direction: 'desc', limit: 1, thenDrilldown: true, byDimension: 'ranked_entity', drilldownDimensions: ['ranked_entity'] },
  });
  assert.equal(same.status, 'needs_clarification');
  assert.match(same.errors.join(';'), /不得相同/);
});

test('第二次 Wyn 查询前拒绝超出 TopN 的排名对象集合', () => {
  const program = {
    stagedQuery: {
      type: 'wyn-rank-then-drilldown',
      rankingDimension: { field: '业务对象', alias: 'ranked_entity' },
      rankingRequest: { limit: 1 },
    },
  };
  const validation = validateRankedDrilldownSeed(program, {
    rows: [{ ranked_entity: 'A', value: 10 }, { ranked_entity: 'B', value: 10 }],
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(';'), /超过要求/);
});

test('排名下钻结果使用第二阶段请求生成表格字段和源端筛选回显', () => {
  const request = requestForResultPresentation({
    id: 'drilldown',
    select: [
      { field: '业务对象', alias: 'ranked_entity' },
      { field: '明细对象', alias: 'detail_entity' },
    ],
    measures: [{ field: '指标', alias: 'value', aggregation: 'sum' }],
    filters: [{ field: '业务对象', operator: 'eq', value: 'A' }],
    limit: 20000,
  }, {
    select: [
      { field: '业务对象', alias: 'ranked_entity', displayName: '排名对象' },
      { field: '明细对象', alias: 'detail_entity', displayName: '明细对象' },
    ],
    measures: [{ field: '指标', alias: 'value', aggregation: 'sum', displayName: '业务指标' }],
    filters: [],
  });
  assert.deepEqual(request.select.map(item => item.alias), ['ranked_entity', 'detail_entity']);
  assert.deepEqual(request.filters, [{ field: '业务对象', operator: 'eq', value: 'A' }]);
  assert.equal(request.select[1].displayName, '明细对象');
  assert.equal(request.measures[0].displayName, '业务指标');
});
