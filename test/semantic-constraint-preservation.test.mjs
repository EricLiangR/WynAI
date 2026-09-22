import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignLlmExplicitValueFilters,
  normalizeLlmRankingDimensionReferences,
  normalizeRankingPlaceholderFilters,
  normalizeSkillEntityFilterFields,
  normalizeSkillValueFilters,
  planBusinessQuestion,
  planBusinessQuestionAsync,
  restoreBaselineOutputReferences,
  restoreRankingDimensionReferences,
} from '../lib/conversation/question-planner.mjs';

const now = new Date('2026-09-15T08:00:00+08:00');
const metadata = {
  id: 'dataset-semantic-preservation', revision: 1, name: '通用业务数据',
  fields: [
    ['业务日期', 'time', 'Date'], ['销售额', 'measure', 'Number'], ['利润', 'measure', 'Number'],
    ['业务编号', 'identifier', 'String'], ['客户地区', 'geography', 'String'],
    ['客户省份', 'geography', 'String'], ['客户城市', 'geography', 'String'],
  ].map(([name, role, type]) => ({ name, role, type, rawType: type })),
};

function modelThatChanges(change) {
  let calls = 0;
  return {
    llm: {
      enabled: true,
      async planQueryIntent({ metadata: inputMetadata, question, skills }) {
        calls += 1;
        const baseline = planBusinessQuestion({ metadata: inputMetadata, question, skills, now }).intent;
        return change(structuredClone(baseline));
      },
    },
    calls: () => calls,
  };
}

test('同一问题中的多个直接指标字段按各自概念绑定', () => {
  const plan = planBusinessQuestion({ metadata, question: '按客户省份统计销售额和利润', now });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.metrics.map(item => [item.concept, item.field]), [
    ['revenue', '销售额'], ['profit', '利润'],
  ]);
});

test('排名下钻的语义概念别名归一化为唯一实际输出别名', () => {
  const intent = normalizeLlmRankingDimensionReferences({
    dimensions: [
      { field: '产品名称', alias: 'productName', concept: 'product' },
      { field: '客户名称', alias: 'customerName', concept: 'customer' },
    ],
    ranking: {
      thenDrilldown: true,
      byDimension: 'product',
      drilldownDimensions: ['customer'],
      partitionBy: [],
    },
  });
  assert.equal(intent.ranking.byDimension, 'productName');
  assert.deepEqual(intent.ranking.drilldownDimensions, ['customerName']);
});

test('模型修复丢失排名维度时从同一问题的语义基线恢复', () => {
  const baseline = {
    dimensions: [
      { field: '产品名称', alias: 'productName', concept: 'product' },
      { field: '客户名称', alias: 'customerName', concept: 'customer' },
    ],
  };
  const repaired = restoreRankingDimensionReferences({
    dimensions: [{ field: '客户名称', alias: 'customerName', concept: 'customer' }],
    ranking: {
      thenDrilldown: true,
      byDimension: 'productName',
      drilldownDimensions: ['customerName'],
      partitionBy: [],
    },
  }, baseline);
  assert.deepEqual(repaired.dimensions.map(item => item.alias), ['customerName', 'productName']);
  assert.deepEqual(repaired.expectedResult.requiredDimensions, ['customerName', 'productName']);
});

test('排名维度的自然语言占位值不会生成实际筛选条件', () => {
  const normalized = normalizeRankingPlaceholderFilters({
    dimensions: [
      { field: '产品名称', alias: 'productName', concept: 'product' },
      { field: '客户名称', alias: 'customerName', concept: 'customer' },
    ],
    ranking: { byDimension: 'productName', thenDrilldown: true, drilldownDimensions: ['customerName'] },
    filters: [
      { field: '产品名称', operator: 'eq', value: '什么' },
      { field: '客户名称', operator: 'eq', value: '客户A' },
    ],
    constraints: [
      { type: 'filter', normalized: { field: '产品名称', operator: 'eq', value: '什么' } },
      { type: 'filter', normalized: { field: '客户名称', operator: 'eq', value: '客户A' } },
    ],
  });
  assert.deepEqual(normalized.filters, [{ field: '客户名称', operator: 'eq', value: '客户A' }]);
  assert.deepEqual(normalized.constraints, [
    { type: 'filter', normalized: { field: '客户名称', operator: 'eq', value: '客户A' } },
  ]);
});

test('Skill 字典把别名绑定到源字段并移除问句占位筛选', () => {
  const normalized = normalizeSkillValueFilters({
    filters: [
      { field: 'pipelineCode', operator: 'eq', value: 'PSM的' },
      { field: 'primeOffice', operator: 'eq', value: '哪里' },
      { field: '客户名称', operator: 'eq', value: 'Consumer Products 行业 的商机有多少个' },
    ],
  }, {
    question: '有哪些商机是 PSM的，prime office 是哪里，Consumer Products 行业的商机有多少个',
    metadata: { fields: [
      { name: 'is_subcode' }, { name: 'pipelineCode' }, { name: 'primeOffice' }, { name: '客户名称' },
    ] },
    skills: [{ valueMappings: [
      { field: 'is_subcode', canonicalValue: '1', synonyms: ['PSM'], matchMode: 'exact', concept: 'psm' },
    ] }],
  });
  assert.deepEqual(normalized.filters, [{
    field: 'is_subcode', fieldRef: 'is_subcode', operator: 'eq', value: '1', concept: 'psm', source: 'PSM',
  }]);
});

test('列表查询从语义基线恢复模型遗漏的显式金额投影字段', () => {
  const restored = restoreBaselineOutputReferences({
    dimensions: [{ field: '客户名称', alias: 'customer', concept: 'customer' }],
    expectedResult: { requiredDimensions: ['customer'] },
  }, {
    dimensions: [
      { field: '客户名称', alias: 'customer', concept: 'customer' },
      { field: 'Opportunity_amount_CNY', alias: 'revenue_source', concept: 'revenue' },
    ],
  }, {
    question: '哪些交易，返回客户名称和商机金额',
    metadata: { fields: [
      { name: '客户名称', role: 'dimension' },
      { name: 'Opportunity_amount_CNY', displayName: '商机金额', role: 'measure' },
    ] },
  });
  assert.deepEqual(restored.dimensions.map(item => item.field), ['客户名称', 'Opportunity_amount_CNY']);
  assert.deepEqual(restored.expectedResult.requiredDimensions, ['customer', 'revenue_source']);
});

test('明确列出字段清单时不依赖哪些关键词即可建立金额源字段投影', () => {
  const catalog = {
    id: 'dataset-explicit-list-clause', revision: 1,
    fields: [
      { name: '交易编号', role: 'dimension', type: 'String' },
      { name: '客户名称', role: 'dimension', type: 'String' },
      { name: '交易金额', role: 'measure', type: 'Number' },
    ],
  };
  const skill = {
    id: 'generic-explicit-list-clause', version: '1.0.0', status: 'approved',
    metrics: [
      { id: 'transactionAmount', concept: 'revenue', name: '交易金额', field: '交易金额', aggregation: 'sum', synonyms: ['金额'] },
      { id: 'transactionCount', concept: 'transactionCount', name: '交易数量', field: '交易编号', aggregation: 'distinctCount', synonyms: [] },
    ],
    businessEntities: [
      { id: 'transaction', concept: 'transaction', name: '交易', field: '交易编号', synonyms: [] },
      { id: 'customer', concept: 'customer', name: '客户名称', field: '客户名称', synonyms: ['客户'] },
    ],
  };
  const plan = planBusinessQuestion({
    metadata: catalog,
    skills: [skill],
    question: '交易金额大于100的交易，列出客户和金额',
    now,
  });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.metrics, []);
  assert.ok(plan.intent.dimensions.some(item => item.field === '交易金额'));
});

test('显式返回 Skill 指标同义词时保留物理金额字段的源记录投影', async () => {
  const catalog = {
    id: 'dataset-skill-metric-synonym-projection', revision: 1,
    fields: [
      { name: '客户名称', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '项目名称', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '创建日期', role: 'time', type: 'Date', rawType: 'Date' },
      { name: 'amount_cny', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const skill = {
    id: 'generic-skill-metric-synonym-projection', version: '1.0.0', status: 'approved',
    metrics: [{
      id: 'revenueCny', concept: 'revenue', name: '销售额', field: 'amount_cny',
      aggregation: 'sum', synonyms: ['订单金额', '商机金额'],
    }],
    businessEntities: [],
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    metrics: [],
    dimensions: [
      { field: '客户名称', alias: 'customer', concept: 'customer' },
      { field: '项目名称', alias: 'project', concept: 'project' },
      { field: 'amount_cny', alias: 'order_amount', concept: 'revenue' },
      { field: '创建日期', alias: 'created_at', concept: 'createdAt' },
    ],
    expectedResult: {
      ...intent.expectedResult,
      shape: 'detail-table',
      requiredMetrics: [],
      requiredDimensions: ['customer', 'project', 'order_amount', 'created_at'],
    },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog,
    question: '列出客户、项目、订单金额和创建日期',
    skills: [skill],
    now,
    llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.equal(result.request.mode, 'projection');
  assert.equal(result.request.measures.length, 0);
  assert.ok(result.request.select.some(item => item.field === 'amount_cny'));
});

test('显式字段值关系优先保留数据集字段和用户原始值', () => {
  const catalog = {
    fields: [
      { name: '产品名称', role: 'dimension', type: 'String' },
      { name: '产品小类', role: 'dimension', type: 'String' },
      { name: 'recurring', role: 'dimension', type: 'String' },
    ],
  };
  const skill = {
    businessEntities: [
      { id: 'productName', concept: 'product', name: '产品名称', field: '产品名称', synonyms: ['产品', 'product'] },
      { id: 'productSubcategory', concept: 'productSubcategory', name: '产品小类', field: '产品小类', synonyms: ['小类'] },
      { id: 'recurring', concept: 'recurring', name: 'recurring 类型', field: 'recurring', synonyms: ['recurring'] },
    ],
  };
  const intent = alignLlmExplicitValueFilters({
    filters: [
      { field: '产品小类', operator: 'eq', value: 'Risk Management' },
    ],
  }, {
    question: 'recurring的商机，产品是 Safety Production and Risk Control in Manufacturing 的有哪些',
    metadata: catalog,
    skills: [skill],
  });
  assert.deepEqual(intent.filters, [{
    field: '产品名称',
    fieldRef: '产品名称',
    operator: 'eq',
    value: 'Safety Production and Risk Control in Manufacturing',
    concept: 'product',
    source: '产品是Safety Production and Risk Control in Manufacturing',
  }]);
});

test('显式字段值解析截断后续数量问句而保留真实源值', () => {
  const catalog = {
    fields: [{ name: '客户所属子行业', role: 'dimension', type: 'String' }],
  };
  const skill = {
    businessEntities: [{
      id: 'customerSubsector', concept: 'customerSubsector', name: '客户所属子行业',
      field: '客户所属子行业', synonyms: ['subsector', '子行业'],
    }],
  };
  const aligned = alignLlmExplicitValueFilters({
    filters: [{ field: '客户所属子行业', operator: 'eq', value: 'Food 的商机有多少个' }],
  }, {
    question: 'MNC 客户且 subsector是Food 的商机有多少个',
    metadata: catalog,
    skills: [skill],
  });
  assert.deepEqual(aligned.filters, [{
    field: '客户所属子行业', fieldRef: '客户所属子行业', operator: 'eq', value: 'Food',
    concept: 'customerSubsector', source: 'subsector是Food',
  }]);

  const governed = normalizeSkillValueFilters(aligned, {
    question: 'MNC 客户且 subsector是Food 的商机有多少个',
    metadata: catalog,
    skills: [{
      ...skill,
      valueMappings: [{
        field: '客户所属行业', concept: 'customerIndustry', canonicalValue: 'Food', synonyms: [], matchMode: 'exact',
      }],
    }],
  });
  assert.deepEqual(governed.filters, aligned.filters);
});

test('Skill 字典补齐模型遗漏的别名筛选并移除绑定到错误字段的值', () => {
  const normalized = normalizeSkillValueFilters({
    filters: [{ field: '客户名称', operator: 'eq', value: 'Consumer Products 行业' }],
  }, {
    question: 'MNC 客户是 Consumer Products 行业的商机有多少个',
    metadata: { fields: [
      { name: '客户名称' }, { name: '客户类型' }, { name: '客户所属行业' },
    ] },
    skills: [{ valueMappings: [
      {
        field: '客户类型', concept: 'customerType', canonicalValue: 'Multinational Corporation（MNC）',
        synonyms: ['MNC'], matchMode: 'containsAny',
      },
      {
        field: '客户所属行业', concept: 'customerIndustry', canonicalValue: 'Consumer Products',
        synonyms: [], matchMode: 'exact',
      },
    ] }],
  });
  assert.deepEqual(normalized.filters, [
    {
      field: '客户类型', fieldRef: '客户类型', operator: 'containsAny',
      value: ['Multinational Corporation（MNC）'], concept: 'customerType', source: 'MNC',
    },
    {
      field: '客户所属行业', fieldRef: '客户所属行业', operator: 'eq',
      value: 'Consumer Products', concept: 'customerIndustry', source: 'Consumer Products',
    },
  ]);
});

test('Skill 泛化实体词把相邻层级的错误筛选字段纠正为受治理字段', () => {
  const normalized = normalizeSkillEntityFilterFields({
    filters: [{ field: '产品小类', operator: 'eq', value: 'Digital Ecosystem Enterprise Alliances' }],
  }, {
    question: '请列举去年 Digital Ecosystem Enterprise Alliances 产品的客户名单',
    metadata: { fields: [
      { name: '产品名称' }, { name: '产品大类' }, { name: '产品小类' },
    ] },
    skills: [{ status: 'approved', businessEntities: [
      { id: 'productName', concept: 'product', name: '产品名称', field: '产品名称', synonyms: ['产品'] },
      { id: 'productCategory', concept: 'productCategory', name: '产品大类', field: '产品大类', synonyms: ['Level0', '大类'] },
      { id: 'productSubcategory', concept: 'productSubcategory', name: '产品小类', field: '产品小类', synonyms: ['Level1', '小类'] },
    ] }],
  });
  assert.deepEqual(normalized.filters, [{
    field: '产品名称', fieldRef: '产品名称', operator: 'eq', value: 'Digital Ecosystem Enterprise Alliances', concept: 'product',
  }]);
});

test('实体前置的英文源值覆盖模型改写并保持用户原文', () => {
  const catalog = { fields: [
    { name: '产品名称', role: 'dimension', type: 'String' },
    { name: '产品小类', role: 'dimension', type: 'String' },
  ] };
  const skill = { status: 'approved', businessEntities: [
    { id: 'productName', concept: 'product', name: '产品名称', field: '产品名称', synonyms: ['产品', 'product'] },
    { id: 'productSubcategory', concept: 'productSubcategory', name: '产品小类', field: '产品小类', synonyms: ['小类'] },
  ], valueMappings: [{
    field: '产品小类', concept: 'productSubcategory', canonicalValue: 'Ecosystem Collaboration', synonyms: [], matchMode: 'exact',
  }] };
  const normalized = alignLlmExplicitValueFilters({
    filters: [{ field: '产品小类', operator: 'eq', value: 'Ecosystem Collaboration' }],
  }, {
    question: '请列举去年 Digital Ecosystem Enterprise Alliances 产品的客户名单',
    metadata: catalog,
    skills: [skill],
  });
  assert.deepEqual(normalized.filters, [{
    field: '产品名称', fieldRef: '产品名称', operator: 'eq',
    value: 'Digital Ecosystem Enterprise Alliances', concept: 'product',
    source: 'Digital Ecosystem Enterprise Alliances 产品',
  }]);
});

test('Skill 多值字典补齐筛选时保持问句否定语义', () => {
  const mapping = {
    field: '客户类型', concept: 'customerType', canonicalValue: 'Multinational Corporation（MNC）',
    synonyms: ['MNC'], matchMode: 'containsAny',
  };
  const normalized = normalizeSkillValueFilters({
    filters: [{ field: '客户类型', operator: 'containsAny', value: ['MNC'] }],
  }, {
    question: '不是 MNC 客户的商机金额是多少',
    metadata: { fields: [{ name: '客户类型' }] },
    skills: [{ valueMappings: [mapping] }],
  });
  assert.deepEqual(normalized.filters, [{
    field: '客户类型', fieldRef: '客户类型', operator: 'notContainsAny',
    value: ['Multinational Corporation（MNC）'], concept: 'customerType', source: 'MNC',
  }]);
});

test('LLM 遗漏用户明确要求的指标时归类为覆盖失败', async () => {
  const model = modelThatChanges(intent => ({ ...intent, metrics: intent.metrics.filter(item => item.concept === 'revenue') }));
  const result = await planBusinessQuestionAsync({ metadata, question: '按客户省份统计销售额和利润', now, llm: model.llm });
  assert.equal(result.status, 'error');
  assert.equal(result.plannerDiagnostics.reason, 'INTENT_COVERAGE_INVALID');
  assert.match(result.message, /利润/);
  assert.equal(model.calls(), 3);
});

test('LLM 把已声明派生指标和普通指标误标为聚合后筛选时按结构化基线纠正', async () => {
  const model = modelThatChanges(intent => ({
    ...intent,
    filters: [...(intent.filters || []), { field: '客户省份', operator: 'in', value: ['A', 'B'] }],
    constraints: [
      ...(intent.constraints || []),
      {
        id: 'share-source-filter', type: 'filter', source: 'A和B',
        normalized: { field: '客户省份', operator: 'in', value: ['A', 'B'], negated: false }, required: true, status: 'resolved',
      },
      {
        id: 'misclassified-share', type: 'aggregate-result-filter', source: '销售额占比',
        normalized: { scope: 'aggregate-result', field: '销售额占比', operator: 'gt', value: 0 }, required: true, status: 'resolved',
      },
      {
        id: 'misclassified-amount', type: 'metric', source: '具体销售额',
        normalized: { scope: 'aggregate-result', field: '销售额', operator: 'gt', value: 0 }, required: true, status: 'resolved',
      },
    ],
  }));
  const result = await planBusinessQuestionAsync({
    metadata,
    question: '按客户省份统计销售额占比和具体销售额',
    now,
    llm: model.llm,
  });
  assert.equal(result.status, 'supported', JSON.stringify(result));
  assert.equal(result.intent.resultFilters.length, 0);
  assert.ok(result.intent.derivedMetrics.some(item => item.type === 'share-of-total'));
  assert.ok(result.request.select.some(item => item.field === '客户省份'));
  assert.equal(model.calls(), 1);
});

test('逐行返回数值字段可以由原始字段投影满足，而不能丢失该列', async () => {
  const model = modelThatChanges(intent => {
    const metric = intent.metrics.find(item => item.field === '销售额');
    const amount = { field: '销售额', alias: 'raw_revenue', concept: metric?.concept || 'revenue' };
    return {
      ...intent,
      metrics: [],
      dimensions: [...intent.dimensions.filter(item => item.field !== '销售额'), amount],
      expectedResult: {
        ...intent.expectedResult,
        shape: 'detail-table',
        requiredMetrics: [],
        requiredDimensions: [
          ...intent.expectedResult.requiredDimensions.filter(alias => !intent.dimensions.some(item => item.field === '销售额' && item.alias === alias)),
          amount.alias,
        ],
      },
    };
  });
  const result = await planBusinessQuestionAsync({
    metadata, question: '逐条列出客户省份和销售额，不聚合、不去重', now, llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.equal(result.request.mode, 'projection');
  assert.ok(result.request.select.some(item => item.field === '销售额'));
  assert.equal(result.request.measures.length, 0);

  const missing = modelThatChanges(intent => ({
    ...intent,
    metrics: [],
    dimensions: intent.dimensions.filter(item => item.field !== '销售额'),
    expectedResult: {
      ...intent.expectedResult,
      requiredMetrics: [],
      requiredDimensions: intent.expectedResult.requiredDimensions
        .filter(alias => !intent.dimensions.some(item => item.field === '销售额' && item.alias === alias)),
    },
  }));
  const recovered = await planBusinessQuestionAsync({
    metadata, question: '逐条列出客户省份和销售额，不聚合、不去重', now, llm: missing.llm,
  });
  assert.equal(recovered.status, 'supported', recovered.message);
  assert.equal(recovered.request.mode, 'projection');
  assert.ok(recovered.request.select.some(item => item.field === '销售额'));
});

test('LLM 遗漏用户明确要求的维度时归类为覆盖失败', async () => {
  const model = modelThatChanges(intent => ({ ...intent, dimensions: [] }));
  const result = await planBusinessQuestionAsync({ metadata, question: '按客户省份统计销售额', now, llm: model.llm });
  assert.equal(result.status, 'error');
  assert.equal(result.plannerDiagnostics.reason, 'INTENT_COVERAGE_INVALID');
  assert.match(result.message, /客户省份|维度/);
  assert.equal(model.calls(), 3);
});

test('LLM 遗漏用户明确要求的筛选条件时归类为覆盖失败', async () => {
  const model = modelThatChanges(intent => ({ ...intent, filters: [] }));
  const result = await planBusinessQuestionAsync({ metadata, question: '只看华东的销售额', now, llm: model.llm });
  assert.equal(result.status, 'error');
  assert.equal(result.plannerDiagnostics.reason, 'INTENT_COVERAGE_INVALID');
  assert.match(result.message, /筛选条件|客户地区/);
  assert.equal(model.calls(), 3);
});

test('仅承担筛选的维度不扩大展示粒度，明确输出或分组时仍保留', async () => {
  const catalog = {
    id: 'dataset-filter-output-role', revision: 1,
    fields: [
      { name: '客户编码', role: 'identifier', type: 'String', rawType: 'String' },
      { name: '客户名称', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '客户地区', role: 'dimension', type: 'String', rawType: 'String', synonyms: ['销售区域'] },
    ],
  };
  const skill = {
    id: 'generic-filter-output-role', version: '1.0.0', status: 'approved',
    metrics: [
      { id: 'customerCount', concept: 'customerCount', name: '客户数量', field: '客户编码', aggregation: 'distinctCount' },
    ],
    businessEntities: [
      { id: 'customer', concept: 'customer', name: '客户', field: '客户名称', synonyms: ['客户名称'] },
      { id: 'region', concept: 'region', name: '客户地区', field: '客户地区', synonyms: ['销售区域'] },
    ],
  };
  const withRegionDimension = intent => ({
    ...intent,
    constraints: (intent.constraints || []).filter(item => !(item.type === 'metric' && item.status === 'unresolved')),
    dimensions: [
      { field: '客户名称', alias: 'customer', concept: 'customer', grain: null },
      { field: '客户地区', alias: 'region', concept: 'region', grain: null },
    ],
    expectedResult: {
      ...intent.expectedResult,
      shape: 'grouped-table',
      requiredDimensions: ['customer', 'region'],
      requiredMetrics: [],
    },
  });

  const filtered = modelThatChanges(withRegionDimension);
  const filteredResult = await planBusinessQuestionAsync({
    metadata: catalog, skills: [skill], llm: filtered.llm, now,
    question: '华东和华南的客户名单',
  });
  assert.equal(filteredResult.status, 'supported', filteredResult.message);
  assert.deepEqual(filteredResult.request.select.map(item => item.field), ['客户名称']);

  const explicit = modelThatChanges(withRegionDimension);
  const explicitResult = await planBusinessQuestionAsync({
    metadata: catalog, skills: [skill], llm: explicit.llm, now,
    question: '华东和华南的客户名单，返回客户名称和客户地区',
  });
  assert.equal(explicitResult.status, 'supported', explicitResult.message);
  assert.deepEqual(explicitResult.request.select.map(item => item.field), ['客户名称', '客户地区']);

  const grouped = modelThatChanges(withRegionDimension);
  const groupedResult = await planBusinessQuestionAsync({
    metadata: catalog, skills: [skill], llm: grouped.llm, now,
    question: '按客户地区统计华东和华南的客户名单',
  });
  assert.equal(groupedResult.status, 'supported', groupedResult.message);
  assert.ok(groupedResult.request.select.some(item => item.field === '客户地区'));
});

test('数据集不支持用户要求的字段时返回能力不可用澄清', async () => {
  const model = modelThatChanges(intent => ({
    ...intent,
    dimensions: [...intent.dimensions, { field: '不存在字段', fieldRef: '不存在字段', alias: 'missing_field', concept: 'dimension' }],
  }));
  const result = await planBusinessQuestionAsync({ metadata, question: '按不存在字段统计销售额', now, llm: model.llm });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.plannerDiagnostics.failureCategory, 'capability-unavailable');
  assert.match(result.clarification, /当前数据集不包含.*不存在字段/);
  assert.equal(result.request, undefined);
  assert.equal(model.calls(), 3);
});

test('LLM 可增加数据集中真实存在的业务辅助字段', async () => {
  const model = modelThatChanges(intent => ({
    ...intent,
    dimensions: [...intent.dimensions, { field: '客户城市', fieldRef: '客户城市', alias: 'customer_city', concept: 'city' }],
  }));
  const result = await planBusinessQuestionAsync({ metadata, question: '按客户省份统计销售额', now, llm: model.llm });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.displayRequest.select.map(item => item.field), ['客户省份', '客户城市']);
  assert.equal(model.calls(), 1);
});

test('内部诊断字段不能作为用户结果字段进入查询', async () => {
  const model = modelThatChanges(intent => ({
    ...intent,
    dimensions: [...intent.dimensions, { field: 'traceId', fieldRef: 'traceId', alias: 'trace_id', concept: 'diagnostic' }],
  }));
  const result = await planBusinessQuestionAsync({ metadata, question: '按客户省份统计销售额', now, llm: model.llm });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.plannerDiagnostics.failureCategory, 'capability-unavailable');
  assert.equal(result.request, undefined);
  assert.equal(model.calls(), 3);
});

test('完整数据集字段名优先于其内部较短泛化词', () => {
  const catalog = {
    id: 'dataset-exact-field-priority',
    fields: [
      { name: '销售额', role: 'measure', type: 'Number' },
      { name: '产品名称', role: 'dimension', type: 'String' },
      { name: '产品大类', role: 'dimension', type: 'String' },
    ],
  };
  const plan = planBusinessQuestion({ metadata: catalog, question: '按产品大类统计销售额', now });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.dimensions.map(item => item.field), ['产品大类']);
});

test('财年物化移除规划器预选的其它日期字段', () => {
  const catalog = {
    id: 'dataset-fiscal-materialization',
    fields: [
      { name: '预计结束日期', role: 'time', type: 'Date' },
      { name: '实际日期', role: 'time', type: 'Date' },
      { name: '业务财年', role: 'dimension', type: 'String' },
      { name: '销售额', role: 'measure', type: 'Number' },
    ],
  };
  const fiscalSkill = {
    id: 'fiscal-policy', status: 'approved', defaultCalendar: 'fiscal',
    calendarPolicy: { fiscalYearField: '业务财年', dateField: '实际日期', fiscalYearStart: '06-01' },
  };
  const plan = planBusinessQuestion({ metadata: catalog, question: '去年销售额', skills: [fiscalSkill], now });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.filters.map(item => item.field), ['业务财年']);
});

test('实体限定指标范围时不强制分组，明确按实体统计时才输出维度', () => {
  const catalog = {
    id: 'dataset-entity-role',
    fields: [
      { name: '客户名称', role: 'dimension', type: 'String' },
      { name: '客户类型', role: 'dimension', type: 'String' },
      { name: '商机金额', role: 'measure', type: 'Number' },
    ],
  };
  const scoped = planBusinessQuestion({ metadata: catalog, question: '某类客户的商机金额是多少', now });
  assert.deepEqual(scoped.intent.dimensions, []);
  const grouped = planBusinessQuestion({ metadata: catalog, question: '按客户统计商机金额', now });
  assert.deepEqual(grouped.intent.dimensions.map(item => item.field), ['客户名称']);
});

test('Skill 中更具体的层级别名覆盖同概念族的泛化字段', () => {
  const catalog = {
    id: 'dataset-skill-hierarchy',
    fields: [
      { name: '产品名称', role: 'dimension', type: 'String' },
      { name: '产品大类', role: 'dimension', type: 'String' },
      { name: '商机金额', role: 'measure', type: 'Number' },
    ],
  };
  const skill = {
    id: 'generic-product-hierarchy', version: '1.0.0', status: 'approved',
    businessEntities: [
      { id: 'product', concept: 'product', name: '产品', field: '产品名称', synonyms: ['产品名称'] },
      { id: 'productCategory', concept: 'productCategory', name: '产品大类', field: '产品大类', synonyms: ['Level0'] },
    ],
  };
  const plan = planBusinessQuestion({ metadata: catalog, question: '按产品Level0统计商机金额', skills: [skill], now });
  assert.equal(plan.status, 'supported');
  assert.deepEqual(plan.intent.dimensions.map(item => item.field), ['产品大类']);
});

test('标量聚合将同一 Skill 概念族实体作为筛选范围且忽略继承的输出别名', async () => {
  const catalog = {
    id: 'dataset-scope-family',
    fields: [
      { name: '客户名称', role: 'dimension', type: 'String' },
      { name: '客户类型', role: 'dimension', type: 'String' },
      { name: '商机金额', role: 'measure', type: 'Number' },
    ],
  };
  const skill = {
    id: 'generic-customer-scope', version: '1.0.0', status: 'approved',
    businessEntities: [
      { id: 'customer', concept: 'customer', name: '客户', field: '客户名称', synonyms: ['客户'] },
      { id: 'customerType', concept: 'customerType', name: '客户类型', field: '客户类型', synonyms: ['A类'] },
    ],
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    semanticFrame: null,
    dimensions: [],
    filters: [{ field: '客户类型', operator: 'eq', value: 'A类' }],
    expectedResult: { ...intent.expectedResult, shape: 'scalar', requiredDimensions: ['customer'], maximumRows: 1 },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog, question: '不是A类客户的商机金额是多少', skills: [skill], now, llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.select, []);
  assert.deepEqual(result.request.filters.map(item => item.field), ['客户类型']);
});

test('分类型财年字段不能被追加日期范围比较条件', async () => {
  const catalog = {
    id: 'dataset-fiscal-field-type', revision: 1,
    fields: [
      { name: '赢单日期', role: 'time', type: 'Date', rawType: 'DateTime' },
      { name: '赢单财年', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '产品大类', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '商机金额', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const fiscalSkill = {
    id: 'fiscal-field-policy', version: '1.0.0', status: 'approved', defaultCalendar: 'fiscal',
    calendarPolicy: { default: 'fiscal', fiscalYearField: '赢单财年', dateField: '赢单日期', fiscalYearStart: '06-01' },
    businessEntities: [
      { id: 'productCategory', concept: 'productCategory', name: '产品大类', field: '产品大类', synonyms: ['Level0'] },
    ],
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    filters: [{ field: '赢单财年', operator: 'eq', value: '26' }],
    time: {
      field: '赢单财年', calendar: 'fiscal', timeZone: 'Asia/Shanghai',
      periods: ['FY26'], range: { start: '2025-06-01', endExclusive: '2026-06-01' },
      grain: null, grouping: null, explicit: true, modifier: null, groupedYears: false,
    },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog,
    question: '按产品大类统计财年26的总商机金额',
    skills: [fiscalSkill],
    now,
    llm: model.llm,
  });
  assert.equal(result.status, 'supported', JSON.stringify(result));
  assert.deepEqual(result.request.filters, [{ field: '赢单财年', operator: 'eq', value: '26', fieldType: 'dimension' }]);
  assert.equal(result.intent.time.range, null);
});

test('财年筛选与另一个日期字段范围表达同一期间时只保留财年权威条件', async () => {
  const catalog = {
    id: 'dataset-fiscal-authority', revision: 1,
    fields: [
      { name: '业务日期', role: 'time', type: 'Date', rawType: 'DateTime' },
      { name: '业务财年', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '业务分类', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '销售额', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const fiscalSkill = {
    id: 'generic-fiscal-authority', version: '1.0.0', status: 'approved', defaultCalendar: 'fiscal',
    calendarPolicy: { default: 'fiscal', fiscalYearField: '业务财年', dateField: '业务日期', fiscalYearStart: '06-01' },
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    filters: [{ field: '业务财年', operator: 'eq', value: '26' }],
    time: {
      field: '业务日期', calendar: 'fiscal', timeZone: 'Asia/Shanghai',
      periods: ['FY26'], range: { start: '2025-06-01', endExclusive: '2026-06-01' },
      grain: null, grouping: null, explicit: true, modifier: null, groupedYears: false,
    },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog,
    question: '按业务分类统计财年26的销售额',
    skills: [fiscalSkill],
    now,
    llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters, [{ field: '业务财年', operator: 'eq', value: '26', fieldType: 'dimension' }]);
  assert.equal(result.intent.time.field, '业务财年');
  assert.equal(result.intent.time.range, null);
  assert.equal(result.intent.time.authority?.source, 'skill-calendar-policy');
});

test('用户明确同时要求财年和日期区间时保留两个源端条件', async () => {
  const catalog = {
    id: 'dataset-explicit-composite-time', revision: 1,
    fields: [
      { name: '业务日期', role: 'time', type: 'Date', rawType: 'DateTime' },
      { name: '业务财年', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '销售额', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const fiscalSkill = {
    id: 'generic-explicit-composite-time', version: '1.0.0', status: 'approved', defaultCalendar: 'fiscal',
    calendarPolicy: { default: 'fiscal', fiscalYearField: '业务财年', dateField: '业务日期', fiscalYearStart: '06-01' },
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    filters: [{ field: '业务财年', operator: 'eq', value: '26' }],
    time: {
      field: '业务日期', calendar: 'fiscal', timeZone: 'Asia/Shanghai',
      periods: ['FY26'], range: { start: '2025-07-01', endExclusive: '2026-01-01' },
      grain: null, grouping: null, explicit: true, modifier: null, groupedYears: false,
    },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog,
    question: '财年26中，业务日期从2025-07-01到2025-12-31的销售额',
    skills: [fiscalSkill],
    now,
    llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['业务财年', 'eq', '26'],
    ['业务日期', 'gte', '2025-07-01'],
    ['业务日期', 'lt', '2026-01-01'],
  ]);
  assert.deepEqual(result.intent.time.range, { start: '2025-07-01', endExclusive: '2026-01-01' });
  assert.equal(result.intent.time.authority?.source, 'user-explicit-composite');
});

const fiscalMatrixCatalog = {
  id: 'dataset-fiscal-authority-matrix', revision: 1,
  fields: [
    { name: '业务日期', role: 'time', type: 'Date', rawType: 'DateTime' },
    { name: '签约日期', role: 'time', type: 'Date', rawType: 'DateTime' },
    { name: '业务财年', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '业务分类', role: 'dimension', type: 'String', rawType: 'String' },
    { name: '销售额', role: 'measure', type: 'Number', rawType: 'Double' },
  ],
};

const fiscalMatrixSkill = {
  id: 'generic-fiscal-authority-matrix', version: '1.0.0', status: 'approved', defaultCalendar: 'fiscal',
  calendarPolicy: { default: 'fiscal', fiscalYearField: '业务财年', dateField: '业务日期', fiscalYearStart: '06-01' },
};

async function planFiscalMatrixCase(question, change) {
  const model = modelThatChanges(change);
  return planBusinessQuestionAsync({
    metadata: fiscalMatrixCatalog,
    question,
    skills: [fiscalMatrixSkill],
    now,
    llm: model.llm,
  });
}

test('时间权威矩阵：只有财年条件时保持单一财年源筛选', async () => {
  const result = await planFiscalMatrixCase('按业务分类统计财年26的销售额', intent => ({
    ...intent,
    filters: [{ field: '业务财年', operator: 'eq', value: '26' }],
    time: {
      ...intent.time,
      field: '业务财年', calendar: 'fiscal', periods: ['FY26'], range: null,
      grain: null, grouping: null, explicit: true,
    },
  }));
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['业务财年', 'eq', '26'],
  ]);
  assert.equal(result.intent.time.authority?.source, 'skill-calendar-policy');
});

test('时间权威矩阵：明确自然年时保留日期范围且不建立财年权威', async () => {
  const result = await planFiscalMatrixCase('按业务分类统计自然年2025年的销售额', intent => ({
    ...intent,
    filters: [],
    time: {
      ...intent.time,
      field: '业务日期', calendar: 'gregorian', periods: ['2025'],
      range: { start: '2025-01-01', endExclusive: '2026-01-01' },
      grain: null, grouping: null, explicit: true,
    },
  }));
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['业务日期', 'gte', '2025-01-01'],
    ['业务日期', 'lt', '2026-01-01'],
  ]);
  assert.equal(result.intent.time.authority, undefined);
});

test('时间权威矩阵：明确自然年时移除模型擅加的财年条件', async () => {
  const result = await planFiscalMatrixCase('按业务分类统计自然年2025年的销售额', intent => ({
    ...intent,
    filters: [{ field: '业务财年', operator: 'eq', value: '25' }],
    time: {
      ...intent.time,
      field: '业务日期', calendar: 'gregorian', periods: ['2025'],
      range: { start: '2025-01-01', endExclusive: '2026-01-01' },
      grain: null, grouping: null, explicit: true,
    },
  }));
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['业务日期', 'gte', '2025-01-01'],
    ['业务日期', 'lt', '2026-01-01'],
  ]);
  assert.equal(result.intent.time.authority, undefined);
});

test('时间权威矩阵：单独截止目前时移除模型擅加的财年条件', async () => {
  const result = await planFiscalMatrixCase('截止目前按业务分类统计销售额', intent => ({
    ...intent,
    filters: [{ field: '业务财年', operator: 'eq', value: '27' }],
    time: {
      ...intent.time,
      field: '业务日期', calendar: 'gregorian', periods: [],
      range: { start: null, endExclusive: '2026-09-16' },
      grain: null, grouping: null, explicit: true, scopeExplicit: true,
    },
  }));
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['业务日期', 'lt', '2026-09-16'],
  ]);
  assert.equal(result.intent.time.authority, undefined);
});

test('时间权威矩阵：所有财年不生成隐式时间限制', async () => {
  const result = await planFiscalMatrixCase('按业务分类统计所有财年的销售额', intent => ({
    ...intent,
    filters: [],
    time: {
      ...intent.time,
      field: null, periods: [], range: null, grain: null, grouping: null, explicit: false,
    },
  }));
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters, []);
  assert.equal(result.intent.time.range, null);
  assert.equal(result.intent.time.authority, undefined);
});

test('时间权威矩阵：财年内按月分组保留日期分组但移除隐式日期范围', async () => {
  const result = await planFiscalMatrixCase('按月统计财年26的销售额', intent => ({
    ...intent,
    filters: [{ field: '业务财年', operator: 'eq', value: '26' }],
    time: {
      ...intent.time,
      field: '业务日期', calendar: 'fiscal', periods: ['FY26'],
      range: { start: '2025-06-01', endExclusive: '2026-06-01' },
      grain: 'month', grouping: 'month', groupingExplicit: true, explicit: true,
    },
  }));
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['业务财年', 'eq', '26'],
  ]);
  assert.equal(result.intent.time.field, '业务日期');
  assert.equal(result.intent.time.grain, 'month');
  assert.equal(result.intent.time.range, null);
  assert.equal(result.intent.time.authority?.source, 'skill-calendar-policy');
});

test('时间权威矩阵：用户明确截止日期时保留财年与日期复合条件', async () => {
  const result = await planFiscalMatrixCase('财年26截至2025-12-31的销售额', intent => ({
    ...intent,
    filters: [{ field: '业务财年', operator: 'eq', value: '26' }],
    time: {
      ...intent.time,
      field: '业务日期', calendar: 'fiscal', periods: ['FY26'],
      range: { start: null, endExclusive: '2026-01-01' },
      grain: null, grouping: null, explicit: true,
    },
  }));
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['业务财年', 'eq', '26'],
    ['业务日期', 'lt', '2026-01-01'],
  ]);
  assert.equal(result.intent.time.authority?.source, 'user-explicit-composite');
});

test('时间权威矩阵：未经用户要求的其他日期字段范围也不能叠加到财年', async () => {
  const result = await planFiscalMatrixCase('按业务分类统计财年26的销售额', intent => ({
    ...intent,
    filters: [{ field: '业务财年', operator: 'eq', value: '26' }],
    time: {
      ...intent.time,
      field: '签约日期', calendar: 'fiscal', periods: ['FY26'],
      range: { start: '2025-06-01', endExclusive: '2026-06-01' },
      grain: null, grouping: null, explicit: true,
    },
  }));
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['业务财年', 'eq', '26'],
  ]);
  assert.equal(result.intent.time.field, '业务财年');
  assert.equal(result.intent.time.range, null);
  assert.equal(result.intent.time.authority?.source, 'skill-calendar-policy');
});

test('相对财年说明可同时陈述当前财年锚点与目标期间', async () => {
  const result = await planFiscalMatrixCase('去年按业务分类统计销售额', intent => ({
    ...intent,
    assumptions: [
      'FY26（业务财年，当前财年FY27，去年为FY26）',
    ],
  }));
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['业务财年', 'eq', '26'],
  ]);
});

test('相对财年说明中的真实目标期间冲突仍被拒绝', async () => {
  const result = await planFiscalMatrixCase('去年按业务分类统计销售额', intent => ({
    ...intent,
    assumptions: [
      '“去年”按业务财年解释，当前日期 2026-09-15 对应财年锚点 FY27，因此去年为 FY25。',
    ],
  }));
  assert.equal(result.status, 'error');
  assert.equal(result.plannerDiagnostics.reason, 'SEMANTIC_MAPPING_INVALID');
  assert.match(result.message, /FY26/);
});

test('上一财年说明被识别为目标期间而不是当前锚点', async () => {
  const result = await planFiscalMatrixCase('去年按业务分类统计销售额', intent => ({
    ...intent,
    assumptions: [
      "未明确自然年时，'去年'按业务财年解释，当前日期 2026-09-15 的上一业务财年为 FY26（业务财年字段值 '26'）。",
    ],
  }));
  assert.equal(result.status, 'supported', result.message);
  assert.deepEqual(result.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['业务财年', 'eq', '26'],
  ]);
});

test('开放式时间范围默认采用 Skill 日期字段并尊重用户显式覆盖', async () => {
  const catalog = {
    id: 'dataset-time-field-authority', revision: 1,
    fields: [
      { name: '预计日期', role: 'time', type: 'Date', rawType: 'Date' },
      { name: '业务日期', role: 'time', type: 'Date', rawType: 'Date' },
      { name: '销售额', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const skill = {
    id: 'generic-date-authority', version: '1.0.0', status: 'approved',
    calendarPolicy: { dateField: '业务日期' },
  };
  const defaultModel = modelThatChanges(intent => ({
    ...intent,
    filters: [{ field: '预计日期', operator: 'lt', value: '2026-09-16' }],
    time: { ...intent.time, field: '预计日期' },
  }));
  const defaultResult = await planBusinessQuestionAsync({
    metadata: catalog, question: '截止目前的销售额', skills: [skill], now, llm: defaultModel.llm,
  });
  assert.equal(defaultResult.status, 'supported', defaultResult.message);
  assert.deepEqual(defaultResult.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['业务日期', 'lt', '2026-09-16'],
  ]);

  const explicitModel = modelThatChanges(intent => ({
    ...intent,
    filters: [{ field: '业务日期', operator: 'lt', value: '2026-09-16' }],
    time: { ...intent.time, field: '业务日期' },
  }));
  const explicitResult = await planBusinessQuestionAsync({
    metadata: catalog, question: '预计日期截止目前的销售额', skills: [skill], now, llm: explicitModel.llm,
  });
  assert.equal(explicitResult.status, 'supported', explicitResult.message);
  assert.deepEqual(explicitResult.request.filters.map(item => [item.field, item.operator, item.value]), [
    ['预计日期', 'lt', '2026-09-16'],
  ]);
});

test('Skill 唯一实体键作为内部 Wyn 分组字段保留名单业务粒度', async () => {
  const catalog = {
    id: 'dataset-entity-grain', revision: 1,
    fields: [
      { name: '交易编号', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '客户', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '商品', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '金额', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const skill = {
    id: 'generic-transaction-grain', version: '1.0.0', status: 'approved',
    metrics: [{ id: 'transactionCount', concept: 'transactionCount', field: '交易编号', aggregation: 'distinctCount' }],
    businessEntities: [{ id: 'transaction', concept: 'transaction', name: '交易', field: '交易编号', synonyms: ['业务交易'] }],
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    dimensions: [
      { field: '客户', alias: 'customer', concept: 'customer' },
      { field: '商品', alias: 'product', concept: 'product' },
    ],
    filters: [{ field: '金额', operator: 'gt', value: 100 }],
    expectedResult: { ...intent.expectedResult, shape: 'grouped-table', requiredDimensions: ['customer', 'product'] },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog,
    question: '金额大于100的交易，列出客户、商品和金额',
    skills: [skill], now, llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.ok(result.request.select.some(item => item.field === '交易编号'));
  assert.ok(!result.displayRequest.select.some(item => item.field === '交易编号'));
});

test('Skill 实体短名嵌在完整指标短语中时不误判为返回实体字段', () => {
  const catalog = {
    id: 'dataset-metric-entity-overlap', revision: 1,
    fields: [
      { name: '交易编号', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '客户', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '交易金额', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const skill = {
    id: 'generic-metric-entity-overlap', version: '1.0.0', status: 'approved',
    metrics: [{ id: 'transactionAmount', concept: 'revenue', name: '交易金额', field: '交易金额', aggregation: 'sum' }],
    businessEntities: [{ id: 'transaction', concept: 'transaction', name: '交易', field: '交易编号', synonyms: [] }],
  };
  const result = planBusinessQuestion({ metadata: catalog, question: '列出客户和交易金额', skills: [skill], now });
  assert.equal(result.status, 'supported', result.message);
  assert.ok(!result.intent.dimensions.some(item => item.field === '交易编号'));
  assert.ok(result.intent.metrics.some(item => item.field === '交易金额'));
});

test('LLM 将确定性基线聚合指标误放入投影字段时恢复统计粒度', async () => {
  const catalog = {
    id: 'dataset-projection-role-alignment', revision: 1,
    fields: [
      { name: '项目', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '客户', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '订单金额', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    dimensions: [
      ...intent.dimensions,
      { field: '订单金额', alias: 'order_amount', concept: 'revenue' },
    ],
    metrics: [],
    expectedResult: {
      ...intent.expectedResult,
      shape: 'detail-table',
      requiredDimensions: [...intent.expectedResult.requiredDimensions, 'order_amount'],
      requiredMetrics: [],
    },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog, question: '按项目和客户统计订单金额', now, llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.equal(result.request.mode, 'aggregate');
  assert.ok(result.request.measures.some(item => item.field === '订单金额'));
  assert.ok(!result.request.select.some(item => item.field === '订单金额'));
});

test('明确列举唯一业务实体并返回金额时保持 Wyn 源端记录投影', async () => {
  const catalog = {
    id: 'dataset-entity-record-projection', revision: 1,
    fields: [
      { name: '交易编号', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '客户', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '交易金额', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const skill = {
    id: 'generic-entity-record-projection', version: '1.0.0', status: 'approved',
    metrics: [
      { id: 'transactionCount', concept: 'transactionCount', name: '交易数量', field: '交易编号', aggregation: 'distinctCount' },
      { id: 'transactionAmount', concept: 'revenue', name: '交易金额', field: '交易金额', aggregation: 'sum' },
    ],
    businessEntities: [{ id: 'transaction', concept: 'transaction', name: '交易', field: '交易编号', synonyms: [] }],
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    dimensions: [
      { field: '客户', alias: 'customer', concept: 'customer' },
      { field: '交易金额', alias: 'amount', concept: 'metric' },
    ],
    metrics: [],
    filters: [...(intent.filters || []), { field: '交易金额', operator: 'gt', value: 100 }],
    constraints: [
      ...(intent.constraints || []),
      {
        id: 'amount-source-filter', type: 'filter', source: '交易金额大于100',
        normalized: { field: '交易金额', operator: 'gt', value: '100', negated: false }, required: true, status: 'resolved',
      },
    ],
    expectedResult: { ...intent.expectedResult, shape: 'detail-table', requiredDimensions: ['customer', 'amount'], requiredMetrics: [] },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog, question: '交易金额大于100的交易有哪些，返回客户和交易金额', skills: [skill], now, llm: model.llm,
  });
  assert.equal(result.status, 'supported', JSON.stringify(result));
  assert.equal(result.request.mode, 'projection');
  assert.ok(result.request.select.some(item => item.field === '交易编号'));
  assert.ok(result.request.select.some(item => item.field === '交易金额'));
  assert.equal(result.request.measures.length, 0);
  assert.ok(!result.displayRequest.select.some(item => item.field === '交易编号'));
});

test('LLM 将显式返回的源金额误标为聚合时按语义账本恢复投影', async () => {
  const catalog = {
    id: 'dataset-explicit-source-projection', revision: 1,
    fields: [
      { name: '交易编号', role: 'identifier', type: 'String', rawType: 'String' },
      { name: '客户', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '交易金额', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const skill = {
    id: 'generic-explicit-source-projection', version: '1.0.0', status: 'approved',
    metrics: [
      { id: 'transactionAmount', concept: 'revenue', name: '交易金额', field: '交易金额', aggregation: 'sum', synonyms: [] },
      { id: 'transactionCount', concept: 'transactionCount', name: '交易数量', field: '交易编号', aggregation: 'distinctCount', synonyms: [] },
    ],
    businessEntities: [
      { id: 'transaction', concept: 'transaction', name: '交易', field: '交易编号', synonyms: [] },
      { id: 'customer', concept: 'customer', name: '客户', field: '客户', synonyms: [] },
    ],
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    metrics: [{ field: '交易金额', alias: 'amount', concept: 'revenue', aggregation: 'sum', internal: false }],
    dimensions: (intent.dimensions || []).filter(item => item.field !== '交易金额'),
    expectedResult: {
      ...intent.expectedResult,
      shape: 'grouped-table',
      requiredMetrics: ['amount'],
      requiredDimensions: (intent.expectedResult?.requiredDimensions || []).filter(alias => alias !== 'dimension_source'),
    },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog, question: '哪些交易，返回客户和交易金额', skills: [skill], now, llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.equal(result.request.mode, 'projection');
  assert.equal(result.request.measures.length, 0);
  assert.ok(result.request.select.some(item => item.field === '交易金额'));
});

test('最终协议不变量消除 detail-table 与聚合指标的非法组合', async () => {
  const catalog = {
    id: 'dataset-final-shape-invariant', revision: 1,
    fields: [
      { name: '客户', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '创建日期', role: 'time', type: 'Date', rawType: 'Date' },
      { name: '订单金额', role: 'measure', type: 'Number', rawType: 'Double' },
    ],
  };
  const model = modelThatChanges(intent => ({
    ...intent,
    dimensions: [
      ...intent.dimensions,
      { field: '创建日期', alias: 'created_at', concept: 'createdAt' },
    ],
    expectedResult: { ...intent.expectedResult, shape: 'detail-table' },
  }));
  const result = await planBusinessQuestionAsync({
    metadata: catalog, question: '按客户列出订单金额和创建日期', now, llm: model.llm,
  });
  assert.equal(result.status, 'supported', result.message);
  assert.equal(result.request.mode, 'aggregate');
  assert.ok(result.request.measures.some(item => item.field === '订单金额'));
});
