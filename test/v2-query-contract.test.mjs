import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCanonicalFilters, normalizeCanonicalQueryRequest } from '../lib/planning/query-request-schema.mjs';
import { ControlledWaxAdapter } from '../lib/query/adapters/controlled-wax.mjs';
import { DatasetNoneAdapter } from '../lib/query/adapters/dataset-none.mjs';
import { QueryRouter } from '../lib/query/router.mjs';
import { normalizeCanonicalResultSet } from '../lib/query/result-normalizer.mjs';
import { applyQueryProgram } from '../lib/query/query-program.mjs';
import { verifyEvidenceScope } from '../lib/evidence/claim-verifier.mjs';
import { buildExplorationArtifacts } from '../lib/analytics/exploration-artifacts.mjs';
import { buildBusinessQueryIntent, compileBusinessQueryIntent } from '../lib/semantics/business-query-intent.mjs';

const metadata = {
  id: 'dataset-sales-v2',
  name: '销售数据',
  revision: 9,
  indexed: true,
  fields: [
    { name: '订购日期', type: 'Date', rawType: 'DateTime', role: 'time' },
    { name: '客户地区', type: 'String', rawType: 'String', role: 'geography' },
    { name: '类别名称', type: 'String', rawType: 'String', role: 'dimension' },
    { name: '客户类型', type: 'String', rawType: 'String', role: 'dimension', multiValue: true },
    { name: '订单金额', type: 'Number', rawType: 'Double', role: 'measure' },
  ],
};

test('CanonicalQueryRequest 拒绝 WAX、SQL 与越权字段', () => {
  const base = {
    id: 'qry-sales-by-region',
    mode: 'aggregate',
    dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '客户地区', alias: 'region' }],
    measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }],
  };
  const request = normalizeCanonicalQueryRequest(metadata, base);
  assert.equal(request.select[0].field, '客户地区');
  assert.equal(request.measures[0].alias, 'revenue');
  assert.throws(() => normalizeCanonicalQueryRequest(metadata, { ...base, wax: 'EVALUATE ROW("x",1)' }), /禁止包含/);
  assert.throws(() => normalizeCanonicalQueryRequest(metadata, { ...base, sql: 'select * from sales' }), /禁止包含/);
  assert.throws(() => normalizeCanonicalQueryRequest(metadata, { ...base, select: [{ field: '密码', alias: 'secret' }] }), /语义目录/);
  assert.throws(() => normalizeCanonicalQueryRequest(metadata, { ...base, select: [{ field: '订单金额', alias: 'amount' }] }), /属于明细字段，不能直接作为统计分组/);
});

test('Canonical 允许数值布尔标志分组但继续拒绝连续数值分组', () => {
  const operationalMetadata = {
    ...metadata,
    fields: [
      ...metadata.fields,
      { name: '是否及时通知', type: 'Number', rawType: 'SByte', role: 'measure', valueKind: 'boolean', description: '1=是 0=否' },
    ],
  };
  const request = normalizeCanonicalQueryRequest(operationalMetadata, {
    id: 'qry-notification-quality', mode: 'verify', dataset: { id: operationalMetadata.id, revision: operationalMetadata.revision },
    select: [{ field: '是否及时通知', alias: 'timely_flag' }],
    measures: [{ aggregation: 'countRows', alias: 'records' }],
  });
  assert.equal(request.select[0].field, '是否及时通知');
  assert.equal(request.select[0].role, 'measure');
  assert.throws(() => normalizeCanonicalQueryRequest(operationalMetadata, {
    ...request, id: 'qry-amount-groups', select: [{ field: '订单金额', alias: 'amount' }],
  }), /属于明细字段，不能直接作为统计分组/);
});

test('Canonical 仅允许业务标识在 verify 模式下受控定位', () => {
  const identifierMetadata = {
    ...metadata,
    fields: [...metadata.fields, { name: '订单编号', type: 'String', rawType: 'String', role: 'identifier', valueKind: 'identifier' }],
  };
  const request = normalizeCanonicalQueryRequest(identifierMetadata, {
    id: 'qry-slow-orders', mode: 'verify', dataset: { id: identifierMetadata.id, revision: identifierMetadata.revision },
    select: [{ field: '订单编号', alias: 'order_id' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'amount' }], limit: 100,
  });
  assert.equal(request.select[0].field, '订单编号');
  assert.throws(() => normalizeCanonicalQueryRequest(identifierMetadata, {
    ...request, id: 'qry-order-ranking', mode: 'aggregate',
  }), /属于明细字段，不能直接作为统计分组/);
});

test('Canonical 聚合与验证查询支持适配器允许的多维分组', () => {
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-three-dimensions', mode: 'verify', dataset: { id: metadata.id, revision: metadata.revision },
    select: [
      { field: '订购日期', alias: 'period', grain: 'month' },
      { field: '客户地区', alias: 'region' },
      { field: '类别名称', alias: 'category' },
    ],
    measures: [{ aggregation: 'countRows', alias: 'records' }],
  });
  assert.equal(request.select.length, 3);
});

test('Canonical 聚合结果筛选在服务端聚合后按指标别名执行', () => {
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-low-revenue-categories', mode: 'aggregate', dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '类别名称', alias: 'category' }],
    measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }],
    resultFilters: [{ field: 'revenue', operator: 'lt', value: 150 }],
    orderBy: [{ field: 'revenue', direction: 'asc' }], limit: 2, limitSource: "user-limit",
  });
  const adapter = new ControlledWaxAdapter();
  const executionPlan = adapter.compile(request, { metadata });
  assert.equal(executionPlan.rowLimit, 20000);
  const result = normalizeCanonicalResultSet({
    request, executionPlan, metadata,
    rawResult: { rows: [{ group1: 'A', revenue: 300 }, { group1: 'B', revenue: 100 }, { group1: 'C', revenue: 50 }], truncated: false },
  });
  assert.deepEqual(result.rows, [{ category: 'C', revenue: 50 }, { category: 'B', revenue: 100 }]);
  assert.deepEqual(result.scope.resultFilters, [{ field: 'revenue', operator: 'lt', value: 150 }]);
});

test('Canonical 字段比较只允许语义目录中的兼容字段并编译为受控列比较', () => {
  const comparisonMetadata = {
    ...metadata,
    fields: [...metadata.fields, { name: '报告日期', type: 'Date', rawType: 'DateTime', role: 'time', valueKind: 'temporal' }],
  };
  const request = normalizeCanonicalQueryRequest(comparisonMetadata, {
    id: 'qry-date-order-quality', mode: 'verify', dataset: { id: comparisonMetadata.id, revision: comparisonMetadata.revision },
    select: [{ field: '类别名称', alias: 'category' }], measures: [{ aggregation: 'countRows', alias: 'records' }],
    fieldComparisons: [{ left: '报告日期', operator: 'lt', right: '订购日期' }],
  });
  const executionPlan = new ControlledWaxAdapter().compile(request, { metadata: comparisonMetadata });
  assert.match(executionPlan.compiled.query, /\[报告日期\] < .*\[订购日期\]/);
  assert.throws(() => normalizeCanonicalQueryRequest(comparisonMetadata, {
    ...request, id: 'qry-invalid-field-comparison', fieldComparisons: [{ left: '报告日期', operator: 'lt', right: '订单金额' }],
  }), /类型不兼容/);
});

test('Canonical 时间筛选安全规范化 ISO 日期而不放宽字段校验', () => {
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-iso-date', mode: 'aggregate', dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '客户地区', alias: 'region' }],
    measures: [{ aggregation: 'countRows', alias: 'records' }],
    filters: [{ field: '订购日期', operator: 'gte', value: '2026-03-01T00:00:00.000Z' }],
  });
  assert.equal(request.filters[0].value, '2026-03-01');
});

test('Canonical in 筛选逐值校验并编译为受控 WAX 集合', () => {
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-region-set', mode: 'aggregate', dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '客户地区', alias: 'region' }],
    measures: [{ aggregation: 'countRows', alias: 'records' }],
    filters: [{ field: '客户地区', operator: 'in', value: ['华东', '华南'] }],
  });
  assert.deepEqual(request.filters[0].value, ['华东', '华南']);
  const executionPlan = new ControlledWaxAdapter().compile(request, { metadata });
  assert.match(executionPlan.compiled.query, /\[客户地区\] = "华东" \|\| .*\[客户地区\] = "华南"/);
  const singleton = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-region-singleton-set', mode: 'aggregate', dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '客户地区', alias: 'region' }], measures: [{ aggregation: 'countRows', alias: 'records' }],
    filters: [{ field: '客户地区', operator: 'in', value: '华东' }],
  });
  assert.deepEqual(singleton.filters[0].value, ['华东']);
  assert.throws(() => normalizeCanonicalQueryRequest(metadata, {
    ...request, id: 'qry-region-empty-set', filters: [{ field: '客户地区', operator: 'in', value: [] }],
  }), /1 至 50/);
});

test('Canonical 多值字符串操作符与 WAX FIND 编译语义一致', () => {
  const values = ['Multinational Corporation（MNC）', 'Private Entity（POE）'];
  const rows = [
    { 客户类型: '["Multinational Corporation（MNC）"]' },
    { 客户类型: '["Private Entity（POE）", "Public Entity"]' },
    { 客户类型: '["Multinational Corporation（MNC）", "Private Entity（POE）"]' },
    { 客户类型: '["Public Entity"]' },
  ];
  const expectedRows = {
    containsAny: 3,
    containsAll: 1,
    notContainsAny: 1,
    notContainsAll: 3,
  };
  for (const [operator, rowCount] of Object.entries(expectedRows)) {
    const request = normalizeCanonicalQueryRequest(metadata, {
      id: `qry-customer-type-${operator}`, mode: 'aggregate', dataset: { id: metadata.id, revision: metadata.revision },
      select: [{ field: '客户类型', alias: 'customer_type' }], measures: [{ aggregation: 'countRows', alias: 'records' }],
      filters: [{ field: '客户类型', operator, value: values }],
    });
    assert.deepEqual(request.filters[0].value, values);
    assert.equal(applyCanonicalFilters(rows, metadata, request.filters).length, rowCount);
    const executionPlan = new ControlledWaxAdapter().compile(request, { metadata });
    assert.match(executionPlan.compiled.query, /FIND\("Multinational Corporation（MNC）",'销售数据'\[客户类型\]\) (?:> 0|= 0)/);
    assert.match(executionPlan.compiled.query, /FIND\("Private Entity（POE）",'销售数据'\[客户类型\]\) (?:> 0|= 0)/);
    const expectedComparator = operator.startsWith('not') ? '= 0' : '> 0';
    assert.match(executionPlan.compiled.query, new RegExp(`FIND\\("Multinational Corporation（MNC）",'销售数据'\\[客户类型\\]\\) ${expectedComparator}`));
  }
  assert.throws(() => normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-invalid-string-membership', mode: 'aggregate', dataset: { id: metadata.id, revision: metadata.revision },
    measures: [{ aggregation: 'countRows', alias: 'records' }],
    filters: [{ field: '订单金额', operator: 'containsAny', value: ['100'] }],
  }), /仅支持字符串字段/);
});
test('Canonical 非空筛选保持本地与 WAX 语义一致并拒绝带字段的 countRows', () => {
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-non-null-region', mode: 'aggregate', dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '客户地区', alias: 'region' }], measures: [{ aggregation: 'countRows', alias: 'records' }],
    filters: [
      { field: '客户地区', operator: 'isNotNull' },
      { field: '订单金额', operator: 'isNotNull' },
      { field: '订购日期', operator: 'isNotNull' },
    ],
  });
  assert.deepEqual(request.filters[0], { field: '客户地区', operator: 'isNotNull', value: null, fieldType: 'geography' });
  const executionPlan = new ControlledWaxAdapter().compile(request, { metadata });
  assert.match(executionPlan.compiled.query, /LEN\(.*\[客户地区\]\) > 0/);
  assert.match(executionPlan.compiled.query, /\[订单金额\] > -1E\+300/);
  assert.match(executionPlan.compiled.query, /YEAR\(.*\[订购日期\]\) > 0/);
  const adapter = new DatasetNoneAdapter();
  assert.ok(adapter);
  assert.throws(() => normalizeCanonicalQueryRequest(metadata, {
    ...request, id: 'qry-ambiguous-field-count', measures: [{ field: '客户地区', aggregation: 'countRows', alias: 'region_count' }],
  }), /countRows.*不允许指定字段/);
  assert.throws(() => normalizeCanonicalQueryRequest(metadata, {
    ...request,
    id: 'qry-duplicate-revenue',
    measures: [
      { field: '订单金额', aggregation: 'sum', alias: 'top5_revenue' },
      { field: '订单金额', aggregation: 'sum', alias: 'top10_revenue' },
    ],
  }), /重复聚合口径/);
});

test('时间粒度在结果截断前归并，月度查询不会退化为前若干日', () => {
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-monthly', mode: 'compare', dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '订购日期', alias: 'period', grain: 'month' }],
    measures: [{ aggregation: 'countRows', alias: 'records' }],
    orderBy: [{ field: 'period', direction: 'asc' }], limit: 2, limitSource: "user-limit",
  });
  const adapter = new ControlledWaxAdapter();
  const executionPlan = adapter.compile(request, { metadata });
  assert.equal(executionPlan.rowLimit, 20000);
  const rawRows = [];
  for (let month = 0; month < 4; month += 1) {
    for (let day = 1; day <= 20; day += 1) rawRows.push({ group1: new Date(Date.UTC(2026, month, day)).toISOString(), records: 1 });
  }
  const result = normalizeCanonicalResultSet({ request, executionPlan, rawResult: { rows: rawRows, truncated: false }, metadata });
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map(row => row.records), [20, 20]);
  assert.deepEqual(result.rows.map(row => row.period.slice(0, 7)), ['2026-01', '2026-02']);
});

test('查询路由按需求选择 WAX 聚合与服务端筛选投影并统一结果结构', async () => {
  const calls = [];
  const executeDatasetQuery = async (datasetId, options) => {
    calls.push({ datasetId, ...options });
    if (options.query.includes('COUNTROWS(')) return { rows: [{ total_rows: 1 }] };
    if (options.query.includes('SELECTCOLUMNS(FILTER(')) return { rows: [{ region: '华东', revenue: 300 }] };
    return { rows: [{ group1: '华东', revenue: 300 }], truncated: false };
  };
  const router = new QueryRouter([new ControlledWaxAdapter(), new DatasetNoneAdapter()]);
  const aggregate = await router.execute({
    id: 'qry-region-total',
    mode: 'aggregate',
    purpose: '区域销售额',
    dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '客户地区', alias: 'region' }],
    measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }],
    limit: 10,
  }, { metadata, executeDatasetQuery });
  const detail = await router.execute({
    id: 'qry-order-detail',
    mode: 'projection',
    purpose: '订单明细样本',
    dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '客户地区', alias: 'region' }, { field: '订单金额', alias: 'revenue' }],
    measures: [],
    filters: [{ field: '客户地区', operator: 'eq', value: '华东' }],
    limit: 100,
  }, { metadata, executeDatasetQuery });

  assert.equal(aggregate.executionPlan.adapter, 'wyn-wax-controlled');
  assert.equal(detail.executionPlan.adapter, 'wyn-wax-controlled');
  assert.equal(aggregate.resultSet.rows[0].region, '华东');
  assert.equal(aggregate.resultSet.rows[0].revenue, 300);
  assert.deepEqual(detail.resultSet.rows[0], { region: '华东', revenue: 300 });
  assert.equal(detail.resultSet.schema.find(column => column.name === 'revenue')?.role, 'measure');
  assert.ok(aggregate.resultSet.statistics);
  assert.ok(detail.resultSet.scope);
  assert.equal(detail.resultSet.quality.isSample, false);
  assert.equal(detail.resultSet.quality.isComplete, true);
  assert.equal(detail.resultSet.scope.sourceFiltering, 'wyn');
  assert.equal(calls[0].queryType, 'WAX');
  assert.ok(calls.slice(1).every(call => call.queryType === 'WAX'));
  assert.match(calls.at(-1).query, /SELECTCOLUMNS\(FILTER\(/);
  assert.equal('compiled' in aggregate.executionPlan, false);
});

test('受限升序结果只生成返回范围内的最低项结论并保留排序边界', () => {
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-lowest-regions', mode: 'aggregate', dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '客户地区', alias: 'region' }],
    measures: [{ field: '订单金额', aggregation: 'average', alias: 'average_revenue' }],
    orderBy: [{ field: 'average_revenue', direction: 'asc' }], limit: 2,
  });
  const resultSet = normalizeCanonicalResultSet({
    request,
    executionPlan: { adapter: 'wyn-wax-controlled', adapterVersion: 'test', rowLimit: 2 },
    metadata,
    rawResult: { rows: [{ group1: '华北', average_revenue: 10 }, { group1: '华南', average_revenue: 20 }], truncated: true },
  });
  const artifacts = buildExplorationArtifacts([{ request, resultSet, executionPlan: { adapter: 'wyn-wax-controlled' } }]);
  assert.match(artifacts.insights[0].statement, /当前返回范围内.*华北.*最低/);
  assert.doesNotMatch(artifacts.insights[0].statement, /最高/);
  assert.equal(artifacts.evidence[0].scope.resultLimited, true);
  assert.deepEqual(artifacts.evidence[0].scope.orderBy, [{ field: 'average_revenue', direction: 'asc' }]);
});

test('证据范围校验拒绝用全局类别排名解释单月增长', () => {
  const required = {
    metrics: ['订单金额'],
    dimensions: ['订购日期', '类别名称'],
    periods: ['2026-01', '2026-02'],
    filters: [],
  };
  const globalRanking = {
    metrics: ['订单金额'],
    dimensions: ['类别名称'],
    periods: [],
    filters: [],
  };
  const result = verifyEvidenceScope(required, globalRanking);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(reason => reason.includes('订购日期')));
  assert.ok(result.reasons.some(reason => reason.includes('2026-01')));
});


test('用户主动排名范围不被误报为系统截断，并保留底层范围证据', () => {
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-top-five-scope', mode: 'aggregate', dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '类别名称', alias: 'category' }],
    measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }],
    orderBy: [{ field: 'revenue', direction: 'desc' }], limit: 5, limitSource: 'user-ranking',
  });
  const result = normalizeCanonicalResultSet({
    request, executionPlan: { id: 'exec-top-five', adapter: 'wyn-wax-controlled', rowLimit: 5 }, metadata,
    rawResult: {
      rows: [
        { group1: 'A', revenue: 500 }, { group1: 'B', revenue: 400 }, { group1: 'C', revenue: 300 },
        { group1: 'D', revenue: 200 }, { group1: 'E', revenue: 100 },
      ], totalRows: 76, limitReached: true,
    },
  });
  assert.equal(result.quality.userLimitApplied, true);
  assert.equal(result.quality.limitSource, 'user-ranking');
  assert.equal(result.quality.sourceLimitReached, true);
  assert.equal(result.quality.isTruncated, false);
  assert.equal(result.quality.limitReached, false);
  assert.equal(result.quality.warnings.some(message => /达到结果上限|实际返回|截断/.test(message)), false);
  assert.equal(result.statistics.totalRowCount, 76);
});

test('Bottom N 与前百分比均属于用户主动范围，百分比排名在查询程序中按组数计算', () => {
  const bottom = buildBusinessQueryIntent({ metadata, question: '去年销售额排名后两的商品类别' });
  assert.equal(bottom.ranking.direction, 'asc');
  assert.equal(bottom.ranking.limit, 2);
  assert.equal(compileBusinessQueryIntent(metadata, bottom).request.limitSource, 'user-ranking');
  const percentage = buildBusinessQueryIntent({ metadata, question: '去年销售额排名前20%的商品类别' });
  assert.equal(percentage.ranking.percentage, 20);
  const compiled = compileBusinessQueryIntent(metadata, percentage);
  assert.equal(compiled.displayRequest.limitSource, 'user-ranking');
  assert.equal(compiled.request.limitSource, 'internal-calculation');
  const output = applyQueryProgram({
    rows: [
      { category: 'A', revenue: 500 }, { category: 'B', revenue: 400 }, { category: 'C', revenue: 300 },
      { category: 'D', revenue: 200 }, { category: 'E', revenue: 100 },
    ], schema: [{ name: 'category' }, { name: 'revenue', role: 'measure', type: 'number' }],
    quality: { userLimitApplied: true, limitSource: 'user-ranking', isTruncated: false, limitReached: false },
    statistics: { totalRowCount: 5 },
  }, compiled.queryProgram);
  assert.equal(output.rows.length, 1);
  assert.equal(output.rows[0].category, 'A');
});
test('系统上限在 20001 行边界保留完整性标记，且不混同用户 TopN', () => {
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'qry-system-row-cap', mode: 'aggregate', dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '类别名称', alias: 'category' }],
    measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }],
    limit: 20000, limitSource: 'default',
  });
  const rawRows = Array.from({ length: 20001 }, (_, index) => ({ group1: `C-${index}`, revenue: index + 1 }));
  const result = normalizeCanonicalResultSet({
    request,
    executionPlan: { id: 'exec-system-row-cap', adapter: 'wyn-wax-controlled', adapterVersion: 'test', rowLimit: 20000 },
    rawResult: { rows: rawRows, totalRows: 20001, limitReached: true, truncationConfidence: 'confirmed' },
    metadata,
  });
  assert.equal(result.rows.length, 20000);
  assert.equal(result.statistics.totalRowCount, 20001);
  assert.equal(result.quality.isTruncated, true);
  assert.equal(result.quality.limitSource, 'system-cap');
  assert.match(result.quality.warnings.join('；'), /达到结果上限/);
});
