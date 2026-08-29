import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLocalFilters,
  buildAnalysisQueryBundle,
  compileFilteredDetailQuery,
  compileWaxQuery,
  normalizeFilters,
} from '../lib/wax-query.mjs';

const metadata = {
  id: 'dataset-sales',
  name: "销售'经营数据",
  revision: 1,
  indexed: true,
  fields: [
    { name: '订单编号', type: 'String', rawType: 'String', role: 'identifier' },
    { name: '订购日期', type: 'Date', rawType: 'DateTime', role: 'time' },
    { name: '类别名称', type: 'String', rawType: 'String', role: 'dimension' },
    { name: '客户地区', type: 'String', rawType: 'String', role: 'geography' },
    { name: '客户名称', type: 'String', rawType: 'String', role: 'dimension' },
    { name: '订单金额', type: 'Number', rawType: 'Double', role: 'measure', description: '订单金额在30万以上的就是重点客户' },
    { name: '订单利润', type: 'Number', rawType: 'Double', role: 'measure' },
  ],
};

test('结构化计划编译为带稳定别名的 WAX 分组查询', () => {
  const result = compileWaxQuery(metadata, {
    groupBy: ['类别名称'],
    measures: [{ alias: 'value', operation: 'sum', field: '订单金额' }],
    filters: [{ field: '客户地区', operator: 'eq', value: '华"东' }],
    limit: 8,
    orderBy: 'value',
    order: 'DESC',
  });
  assert.match(result.wax, /^EVALUATE TOPN\(8,SELECTCOLUMNS\(SUMMARIZECOLUMNS/);
  assert.match(result.wax, /'销售''经营数据'\[类别名称\]/);
  assert.match(result.wax, /"华""东"/);
  assert.match(result.wax, /"group1"/);
  assert.match(result.wax, /\[value\],DESC\)$/);
  assert.equal(result.spec.filters[0].fieldType, 'geography');
});

test('概览查询只允许白名单聚合并拒绝字段注入', () => {
  const result = compileWaxQuery(metadata, {
    measures: [
      { alias: 'rows', operation: 'countRows' },
      { alias: 'total', operation: 'sum', field: '订单金额' },
      { alias: 'orders', operation: 'distinctCount', field: '订单编号' },
    ],
  });
  assert.match(result.wax, /^EVALUATE ROW\(/);
  assert.match(result.countWax, /^EVALUATE ROW\("total_rows",1\)$/);
  assert.match(result.wax, /COUNTROWS\('销售''经营数据'\)/);
  assert.throws(() => compileWaxQuery(metadata, {
    measures: [{ alias: 'total', operation: 'sum', field: '订单金额]); EVALUATE ROW("x",1)' }],
  }), /字段不在数据集语义目录/);
  assert.throws(() => compileWaxQuery(metadata, {
    measures: [{ alias: 'total', operation: 'delete', field: '订单金额' }],
  }), /不支持的聚合操作/);
});

test('筛选条件执行类型校验并可在回退样本中保持同一语义', () => {
  const filters = normalizeFilters(metadata, [
    { field: '订单金额', operator: 'gte', value: '300,000' },
    { field: '订购日期', operator: 'lt', value: '2025-03-01' },
  ]);
  assert.equal(filters[0].value, 300000);
  const rows = [
    { 订单金额: 310000, 订购日期: '2025-02-01' },
    { 订单金额: 290000, 订购日期: '2025-02-01' },
    { 订单金额: 400000, 订购日期: '2025-04-01' },
  ];
  assert.deepEqual(applyLocalFilters(rows, metadata, filters), [rows[0]]);
  assert.deepEqual(applyLocalFilters([{ 客户地区: null }, { 客户地区: '华东' }], metadata, [{ field: '客户地区', operator: 'eq', value: '华东' }]), [{ 客户地区: '华东' }]);
  assert.deepEqual(applyLocalFilters([{ 订单金额: 299999 }, { 订单金额: 300000 }], metadata, [{ field: '订单金额', operator: 'lte', value: 299999 }]), [{ 订单金额: 299999 }]);
  assert.deepEqual(applyLocalFilters([{ 客户地区: null }, { 客户地区: '' }, { 客户地区: '华东' }], metadata, [{ field: '客户地区', operator: 'isNotNull' }]), [{ 客户地区: '华东' }]);
  const nonNullQuery = compileWaxQuery(metadata, {
    measures: [{ alias: 'rows', operation: 'countRows' }],
    filters: [{ field: '客户地区', operator: 'isNotNull' }],
  });
  assert.match(nonNullQuery.wax, /LEN\(.*\[客户地区\]\) > 0/);
  const dateQuery = compileWaxQuery(metadata, {
    measures: [{ alias: 'total', operation: 'sum', field: '订单金额' }],
    filters: [{ field: '订购日期', operator: 'gte', value: '2025-01-01' }],
  });
  assert.match(dateQuery.wax, /DATE\(2025,1,1\)/);
  assert.throws(() => normalizeFilters(metadata, [{ field: '订单金额', operator: 'gte', value: 'abc' }]), /需要数字/);
  assert.throws(() => normalizeFilters(metadata, [{ field: '订购日期', operator: 'eq', value: '2025年1月' }]), /YYYY-MM-DD/);
  assert.throws(() => compileWaxQuery(metadata, {
    groupBy: ['类别名称'],
    measures: [{ alias: 'value', operation: 'sum', field: '订单金额' }],
    orderBy: 'missing',
  }), /排序字段不在查询结果中/);
  assert.throws(() => compileWaxQuery(metadata, {
    measures: [{ alias: 'rows', operation: 'countRows', field: '客户地区' }],
  }), /countRows.*不允许指定字段/);
});

test('分析查询包覆盖概览、趋势、类别、区域和客户', () => {
  const bundle = buildAnalysisQueryBundle(metadata, [{ field: '客户地区', operator: 'eq', value: '华东' }]);
  assert.equal(bundle.version, 'wyn-query-bundle/v1');
  assert.deepEqual(bundle.plans.map(item => item.id), ['overview', 'trend', 'category', 'region', 'customer']);
  assert.ok(bundle.plans.every(item => item.queryType === 'WAX' && item.sqlAllowed === false));
  assert.ok(bundle.plans.every(item => item.wax.includes('FILTER(')));
  const detail = compileFilteredDetailQuery(metadata, bundle.filters);
  assert.match(detail.wax, /^EVALUATE FILTER\(/);
  assert.equal(compileFilteredDetailQuery(metadata, []), null);
});
