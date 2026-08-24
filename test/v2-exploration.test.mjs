import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticCapabilityProfile, classifyAnalysisIntent } from '../lib/semantics/capability-profiler.mjs';
import { buildFallbackExplorationPlan, createFollowupPlan, normalizeAiGuidedPlan, normalizeExternalExplorationPlan } from '../lib/planning/exploration-planner.mjs';

const metadata = {
  id: 'sales', name: '销售宽表', revision: 1, indexed: true, fieldCount: 8,
  fields: [
    { name: '订单编号', type: 'String', role: 'identifier', description: '' },
    { name: '订购日期', type: 'Date', role: 'time', description: '' },
    { name: '订单金额', type: 'Number', role: 'measure', description: '销售收入' },
    { name: '订单利润', type: 'Number', role: 'measure', description: '订单毛利' },
    { name: '客户名称', type: 'String', role: 'dimension', description: '' },
    { name: '商品名称', type: 'String', role: 'dimension', description: '' },
    { name: '类别名称', type: 'String', role: 'dimension', description: '' },
    { name: '客户地区', type: 'String', role: 'geography', description: '' },
  ],
};

test('语义画像识别经营能力并按用户问题分类意图', () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  assert.equal(profile.capabilities.profitability, true);
  assert.equal(profile.capabilities.customer, true);
  assert.equal(profile.capabilities.product, true);
  assert.equal(classifyAnalysisIntent('利润为什么下降', profile), 'profitability');
  assert.equal(classifyAnalysisIntent('哪些客户存在风险', profile), 'customer');
  assert.equal(classifyAnalysisIntent('检查客户收入贡献和利润质量', profile), 'customer');
  assert.equal(classifyAnalysisIntent('产品结构是否健康', profile), 'product');
  assert.equal(classifyAnalysisIntent('识别高收入低利润产品', profile), 'product');
  assert.equal(classifyAnalysisIntent('最近有什么异常', profile), 'anomaly');
  assert.equal(classifyAnalysisIntent('', profile), 'open');
});

test('不同问题生成不同查询集合而不是固定月度趋势与贡献模板', () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const focuses = ['利润为什么下降', '哪些客户存在风险', '产品结构是否健康', '最近有什么异常', ''];
  const plans = focuses.map(focus => buildFallbackExplorationPlan({ metadata, profile, focus, filters: [] }));
  const sets = plans.map(plan => plan.requests.map(item => item.id).sort().join(','));
  assert.equal(new Set(sets).size, focuses.length);
  assert.ok(plans[0].requests.every(item => item.measures.some(metric => metric.field === '订单利润')));
  assert.ok(plans[1].requests.some(item => item.select.some(field => field.field === '客户名称')));
  assert.ok(plans[2].requests.some(item => item.select.some(field => ['商品名称', '类别名称'].includes(field.field))));
  assert.deepEqual(plans[3].requests.map(item => item.id), ['qry-anomaly-trend']);
  assert.ok(plans[4].requests.length >= 3);
});

test('外部 AI Planner 计划必须通过 Canonical 安全校验', () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const valid = normalizeExternalExplorationPlan({
    metadata, profile, focus: '利润分析', filters: [], model: 'fake-model',
    rawPlan: {
      intent: 'profitability', summary: '动态利润计划',
      hypotheses: [{ id: 'hyp-ai-profit', question: '利润是否恶化', businessValue: '识别质量风险', priority: 1, requiredEvidence: ['利润趋势'] }],
      requests: [{ id: 'qry-ai-profit', hypothesisId: 'hyp-ai-profit', purpose: '查询利润趋势', mode: 'compare', topic: 'profitability', select: [{ field: '订购日期', alias: 'period', grain: 'month' }], measures: [{ field: '订单利润', aggregation: 'sum', alias: 'profit' }], filters: [], orderBy: [{ field: 'period', direction: 'asc' }], limit: 100 }],
    },
  });
  assert.equal(valid.mode, 'ai-planner');
  assert.equal(valid.requests[0].measures[0].field, '订单利润');
  assert.deepEqual(valid.requests[0].filters, [{ field: '订购日期', operator: 'isNotNull', value: null, fieldType: 'time' }]);
  const prefixed = normalizeExternalExplorationPlan({
    metadata, profile, focus: '利润分析', filters: [],
    rawPlan: {
      intent: 'profitability',
      hypotheses: [{ id: 'hyp-profit-short-id', question: '利润是否恶化' }],
      requests: [{ id: 'q1', hypothesisId: 'hyp-profit-short-id', purpose: '查询利润', mode: 'aggregate', select: [], measures: [{ field: '订单利润', aggregation: 'sum', alias: 'profit' }] }],
    },
  });
  assert.equal(prefixed.requests[0].id, 'qry-q1');
  assert.throws(() => normalizeExternalExplorationPlan({
    metadata, profile, focus: '', filters: [],
    rawPlan: {
      intent: 'open', hypotheses: [{ id: 'hyp-bad', question: 'x' }],
      requests: [{ id: 'qry-bad', hypothesisId: 'hyp-bad', purpose: 'x', mode: 'aggregate', sql: 'select * from source', select: [], measures: [{ aggregation: 'countRows', alias: 'rows' }] }],
    },
  }), /禁止包含/);
});

test('外部 AI Planner 兼容下划线 ID 和无意义空字段但仍保持受控契约', () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const plan = normalizeExternalExplorationPlan({
    metadata, profile, focus: '哪些客户存在风险', filters: [], model: 'fake-model',
    rawPlan: {
      intent: 'customer', summary: '客户计划',
      hypotheses: [{ id: 'hyp_customer_risk', question: '客户是否集中', businessValue: '风险', priority: 1, requiredEvidence: [] }],
      requests: [{
        id: 'qry_customer_risk', hypothesisId: 'hyp_customer_risk', purpose: '客户集中度', mode: 'aggregate', topic: 'customer',
        select: [{ field: '', alias: 'empty' }, { field: '客户名称', alias: 'customer' }],
        measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }],
        filters: [{ field: '', operator: 'eq', value: '' }], orderBy: [{ field: 'revenue', direction: 'desc' }], limit: 10,
      }],
    },
  });
  assert.equal(plan.hypotheses[0].id, 'hyp-customer-risk');
  assert.equal(plan.requests[0].id, 'qry-customer-risk');
  assert.deepEqual(plan.requests[0].select.map(item => item.field), ['客户名称']);
});

test('外部 AI Planner 将含中文的可读 ID 稳定映射为安全 Canonical ID', () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const rawPlan = {
    intent: 'customer', summary: '区域客户分析',
    hypotheses: [{ id: 'hyp-region-东北-low', question: '东北客户是否偏低', businessValue: '定位机会' }],
    requests: [{ id: 'qry-region-东北-low', hypothesisId: 'hyp-region-东北-low', purpose: '分析东北客户', mode: 'aggregate', topic: 'customer', select: [{ field: '客户名称', alias: 'customer' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }] }],
  };
  const firstPlan = normalizeExternalExplorationPlan({ metadata, profile, focus: '客户风险', filters: [], rawPlan });
  const secondPlan = normalizeExternalExplorationPlan({ metadata, profile, focus: '客户风险', filters: [], rawPlan });
  assert.match(firstPlan.hypotheses[0].id, /^[a-z][a-z0-9-]+$/i);
  assert.equal(firstPlan.requests[0].hypothesisId, firstPlan.hypotheses[0].id);
  assert.equal(firstPlan.hypotheses[0].id, secondPlan.hypotheses[0].id);
});

test('外部 AI Planner 可把常见语义别名修复为 Canonical 查询', () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const plan = normalizeExternalExplorationPlan({
    metadata, profile, focus: '最近有什么异常', filters: [],
    rawPlan: {
      intent: 'anomaly', summary: '异常计划',
      hypotheses: [{ id: 'hyp_anomaly', question: '有无异常', businessValue: '发现风险', requiredEvidence: [] }],
      requests: [{ id: 'qry_anomaly', hypothesisId: 'hyp_anomaly', purpose: '时间异常', mode: 'timeSeries', dimensions: [{ name: '订购日期', alias: 'period', grain: 'month' }], metrics: [{ name: '订单金额', operation: 'sum', alias: 'revenue' }], orderBy: [{ field: 'period', direction: 'asc' }] }],
    },
  });
  assert.equal(plan.requests[0].mode, 'compare');
  assert.equal(plan.requests[0].measures[0].aggregation, 'sum');
});

test('AI 方法级规划由受控编译器转换为查询并如实标记模式', () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const plan = normalizeAiGuidedPlan({
    metadata, profile, focus: '哪些客户存在风险', filters: [], model: 'fake-model',
    rawPlan: {
      intent: 'customer', summary: '优先检查客户集中度', methods: ['customer_concentration'],
      hypotheses: [{ id: 'ai_customer_risk', question: '客户是否集中', businessValue: '风险', requiredEvidence: [] }],
    },
  });
  assert.equal(plan.mode, 'ai-guided-planner');
  assert.deepEqual(plan.requests.map(item => item.id), ['qry-customer-concentration']);
  assert.equal(plan.aiHypotheses[0].id, 'ai-customer-risk');
});

test('无关注方向时即使 AI 偏向单一主题也保留开放探索的多主题覆盖', () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const plan = normalizeAiGuidedPlan({
    metadata, profile, focus: '', filters: [], model: 'fake-model',
    rawPlan: {
      intent: 'profitability', summary: '优先检查利润', methods: ['profit_trend'],
      hypotheses: [{ id: 'ai_profit', question: '利润如何', businessValue: '质量', requiredEvidence: [] }],
    },
  });
  assert.equal(plan.intent, 'open');
  assert.ok(new Set(plan.requests.map(item => item.topic)).size >= 3);
  assert.deepEqual(plan.aiRequestedMethods, ['profit_trend']);
});

test('完整 AI Planner 不得把开放任务窄化为利润单主题', () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  assert.throws(() => normalizeExternalExplorationPlan({
    metadata,
    profile,
    focus: '',
    filters: [],
    rawPlan: {
      intent: 'profitability',
      hypotheses: [{ id: 'hyp-profit-only', question: '利润如何' }],
      requests: [{ id: 'q1', hypothesisId: 'hyp-profit-only', purpose: '利润合计', mode: 'aggregate', topic: 'profitability', select: [], measures: [{ field: '订单利润', aggregation: 'sum', alias: 'profit' }] }],
    },
  }), /意图 profitability 与用户问题 open 不一致/);
});

test('管理驾驶舱和跨视角运营分析识别为开放任务', () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  assert.equal(classifyAnalysisIntent('完成全国年度销售管理驾驶舱建设', profile), 'open');
  assert.equal(classifyAnalysisIntent('完成运营分析，从效率、有效性、关键指标等视角发现风险和异常', profile), 'open');
});

test('运营数据集按真实 TAT、达标和状态语义生成查询而不是伪造收入利润', () => {
  const operationalMetadata = {
    id: 'lab', name: '智慧试验室运营', revision: 1, indexed: true, fieldCount: 8,
    fields: [
      { name: '订单编号', type: 'String', role: 'identifier', description: '唯一业务单号' },
      { name: '创建时间', type: 'DateTime', role: 'time', description: '订单创建时间' },
      { name: '科室名称', type: 'String', role: 'dimension', description: '送检科室' },
      { name: '科室类型', type: 'Number', role: 'dimension', description: '1=院内 2=外部' },
      { name: '总TAT', type: 'Number', role: 'measure', description: '总TAT（分钟）' },
      { name: '是否STAT', type: 'Number', role: 'measure', valueKind: 'boolean', description: '是否急诊：1=是 0=否' },
      { name: '是否准时交付', type: 'Number', role: 'measure', description: '1=是 0=否' },
      { name: '订单状态名称', type: 'String', role: 'dimension', description: '订单流程状态' },
      { name: '通知耗时', type: 'Number', role: 'measure', description: '通知耗时分钟数' },
    ],
  };
  const profile = buildSemanticCapabilityProfile(operationalMetadata);
  assert.deepEqual(profile.roles.duration, ['总TAT', '通知耗时']);
  assert.deepEqual(profile.roles.flag, ['是否准时交付']);
  assert.ok(profile.roles.boolean.includes('是否STAT'));
  const guided = normalizeAiGuidedPlan({
    metadata: operationalMetadata,
    profile,
    focus: '完成全面运营分析，从效率、有效性和关键指标等视角发现风险',
    rawPlan: { intent: 'open', methods: ['operational_efficiency'] },
  });
  assert.ok(guided.requests.some(request => request.id === 'qry-operational-efficiency'));
  assert.ok(guided.requests.some(request => request.id === 'qry-compliance-rate'));
  assert.ok(guided.requests.some(request => request.id === 'qry-process-status'));
  assert.ok(guided.requests.some(request => request.id === 'qry-operational-trend'));
  const plan = buildFallbackExplorationPlan({ operationalMetadata, metadata: operationalMetadata, profile, focus: '完成运营分析，从效率和有效性等视角发现风险', filters: [] });
  assert.equal(plan.intent, 'open');
  assert.ok(plan.requests.length >= 3);
  const usedMeasures = plan.requests.flatMap(request => request.measures.map(item => item.field).filter(Boolean));
  assert.ok(usedMeasures.includes('总TAT'));
  assert.ok(usedMeasures.includes('是否准时交付'));
  const efficiency = plan.requests.find(request => request.id === 'qry-operational-efficiency');
  assert.ok(efficiency.measures.some(item => item.field === '总TAT'));
  assert.ok(!efficiency.measures.some(item => item.field === '是否STAT'));
  const compliance = plan.requests.find(request => request.id === 'qry-compliance-rate');
  assert.ok(compliance.measures.some(item => item.field === '是否准时交付'));
  assert.ok(!compliance.measures.some(item => item.field === '是否STAT'));
  assert.ok(!usedMeasures.includes('科室类型'));
  assert.ok(plan.requests.some(request => request.id === 'qry-process-status'));
});

test('危急值专项不会因通知耗时误触发全局 TAT 和流程状态查询', () => {
  const operationalMetadata = {
    id: 'lab', name: '智慧试验室运营', revision: 1, indexed: true, fieldCount: 8,
    fields: [
      { name: '订单编号', type: 'String', role: 'identifier', description: '唯一业务单号' },
      { name: '科室名称', type: 'String', role: 'dimension', description: '送检科室' },
      { name: '总TAT', type: 'Number', role: 'measure', valueKind: 'duration', description: '总TAT（分钟）' },
      { name: '是否准时交付', type: 'Number', role: 'measure', valueKind: 'boolean', description: '1=是 0=否' },
      { name: '订单状态名称', type: 'String', role: 'dimension', description: '订单流程状态' },
      { name: '危急值检测项目名称', type: 'String', role: 'dimension', description: '单值危急值项目' },
      { name: '通知耗时', type: 'Number', role: 'measure', valueKind: 'duration', description: '通知耗时分钟数' },
      { name: '是否及时通知', type: 'Number', role: 'measure', valueKind: 'boolean', description: '1=及时 0=不及时' },
      { name: '通知方式', type: 'String', role: 'dimension', description: '通知渠道' },
    ],
  };
  const profile = buildSemanticCapabilityProfile(operationalMetadata);
  const plan = normalizeAiGuidedPlan({
    metadata: operationalMetadata,
    profile,
    focus: '危急值通知是否及时？请按检测项目和通知方式定位通知耗时、及时率风险。',
    rawPlan: { intent: 'open', methods: ['operational_efficiency', 'compliance_rate', 'process_status', 'critical_response'] },
  });
  assert.deepEqual(plan.aiMethods, ['critical_response']);
  assert.deepEqual(plan.requests.map(request => request.id), ['qry-critical-response', 'qry-critical-by-project']);
});

test('Critic 缺失血缘时只能从真实父假设结果推导并删除空筛选占位', async () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const initialPlan = {
    intent: 'customer',
    hypotheses: [{ id: 'hyp-customer-base', question: '客户是否集中' }],
    requests: [],
  };
  const outcomes = [{
    request: { id: 'qry-customer-base', hypothesisId: 'hyp-customer-base', select: [{ field: '客户名称', alias: 'customer' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }] },
    resultSet: { id: 'rs-qry-customer-base', rows: [{ customer: '甲', revenue: 100 }] },
  }];
  const plan = await createFollowupPlan({
    metadata, profile, focus: '客户风险', filters: [], initialPlan, outcomes, remainingBudget: 2, executedFingerprints: new Set(),
    aiCritic: async () => ({
      summary: '继续验证客户',
      assessments: [{ hypothesisId: 'hyp-customer-base', status: 'needs_followup', reason: '需要下钻' }],
      hypotheses: [{ id: 'hyp-customer-detail', parentHypothesisId: 'hyp-customer-base', question: '客户明细结构', businessValue: '定位风险' }],
      requests: [{
        id: 'qry-customer-detail', hypothesisId: 'hyp-customer-detail', purpose: '客户收入结构', mode: 'aggregate',
        select: [{ field: '客户名称', alias: 'customer' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }],
        filters: [{ field: '客户地区', operator: 'eq', value: '' }], lineage: { parentHypothesisId: 'hyp-customer-base', reason: '需要下钻' },
      }],
    }),
  });
  assert.equal(plan.mode, 'ai-critic');
  assert.deepEqual(plan.requests[0].lineage.triggerResultSetIds, ['rs-qry-customer-base']);
  assert.deepEqual(plan.requests[0].filters, [{ field: '客户名称', operator: 'isNotNull', value: null, fieldType: 'dimension' }]);
});

test('Critic 可从唯一字段重合的真实结果补全新假设与触发血缘并记录修复', async () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const initialPlan = {
    intent: 'customer',
    hypotheses: [
      { id: 'hyp-customer-base', question: '客户是否集中' },
      { id: 'hyp-product-base', question: '产品是否集中' },
    ],
    requests: [],
  };
  const outcomes = [
    {
      request: { id: 'qry-customer-base', hypothesisId: 'hyp-customer-base', select: [{ field: '客户名称', alias: 'customer' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }] },
      resultSet: { id: 'rs-qry-customer-base', rows: [{ customer: '甲', revenue: 100 }] },
    },
    {
      request: { id: 'qry-product-base', hypothesisId: 'hyp-product-base', select: [{ field: '商品名称', alias: 'product' }], measures: [{ field: null, aggregation: 'countRows', alias: 'records' }] },
      resultSet: { id: 'rs-qry-product-base', rows: [{ product: 'A', profit: 10 }] },
    },
  ];
  const plan = await createFollowupPlan({
    metadata, profile, focus: '客户风险', filters: [], initialPlan, outcomes, remainingBudget: 2, executedFingerprints: new Set(),
    aiCritic: async () => ({
      summary: '继续检查客户利润', assessments: [], hypotheses: [],
      requests: [{
        id: 'qry-customer-profit', hypothesisId: 'hyp-customer-profit', purpose: '检查客户利润结构', mode: 'verify',
        select: [{ field: '客户名称', alias: 'customer' }], measures: [{ field: '订单利润', aggregation: 'sum', alias: 'profit' }],
        lineage: { reason: '客户贡献结果需要利润验证' },
      }],
    }),
  });
  assert.equal(plan.mode, 'ai-critic');
  assert.equal(plan.hypotheses.find(item => item.id === 'hyp-customer-profit').parentHypothesisId, 'hyp-customer-base');
  assert.deepEqual(plan.requests[0].lineage.triggerResultSetIds, ['rs-qry-customer-base']);
  assert.ok(plan.repairs.some(item => item.type === 'implicit-hypothesis'));
});

test('Critic 将 select 中的聚合项与指标别名筛选规范化为 measures 和 resultFilters', async () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const initialPlan = { intent: 'product', hypotheses: [{ id: 'hyp-product-base', question: '产品结构' }], requests: [] };
  const outcomes = [{
    request: { id: 'qry-product-base', hypothesisId: 'hyp-product-base', select: [{ field: '商品名称', alias: 'product' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }] },
    resultSet: { id: 'rs-qry-product-base', rows: [{ product: 'A', revenue: 100 }] },
  }];
  const plan = await createFollowupPlan({
    metadata, profile, focus: '产品结构', filters: [], initialPlan, outcomes, remainingBudget: 2, executedFingerprints: new Set(),
    aiCritic: async () => ({
      summary: '检查尾部商品', assessments: [],
      hypotheses: [{ id: 'hyp-product-tail', parentHypothesisId: 'hyp-product-base', question: '尾部商品是否低效' }],
      requests: [{
        id: 'qry-product-tail', hypothesisId: 'hyp-product-tail', purpose: '检查低收入商品', mode: 'verify',
        select: [
          { field: '商品名称', alias: 'product' },
          { field: '订单金额', alias: 'revenue', aggregation: 'sum' },
          { field: '订单利润', alias: 'profit', aggregation: 'sum' },
        ],
        measures: [], filters: [
          { field: 'revenue', operator: 'lt', value: 300000 },
          { field: '订单利润', operator: 'lt', value: '订单金额' },
        ],
        lineage: { parentHypothesisId: 'hyp-product-base', triggerResultSetIds: ['rs-qry-product-base'], reason: '检查尾部' },
      }],
    }),
  });
  assert.equal(plan.mode, 'ai-critic');
  assert.deepEqual(plan.requests[0].select.map(item => item.field), ['商品名称']);
  assert.deepEqual(plan.requests[0].measures.map(item => item.alias), ['revenue', 'profit']);
  assert.deepEqual(plan.requests[0].resultFilters, [{ field: 'revenue', operator: 'lt', value: 300000 }]);
  assert.deepEqual(plan.requests[0].fieldComparisons, [{ left: '订单利润', operator: 'lt', right: '订单金额', valueType: 'number' }]);
  assert.ok(plan.repairs.some(item => item.type === 'select-aggregation-to-measure'));
  assert.ok(plan.repairs.some(item => item.type === 'aggregate-result-filter'));
  assert.ok(plan.repairs.some(item => item.type === 'field-to-field-comparison'));
});

test('Critic 在保留业务维度时将连续 select 规范化为平均指标', async () => {
  const extendedMetadata = {
    ...metadata,
    fields: [...metadata.fields, { name: '进货价格', type: 'Number', rawType: 'Double', role: 'measure', valueKind: 'continuous', description: '商品采购单价' }],
  };
  const profile = buildSemanticCapabilityProfile(extendedMetadata);
  const initialPlan = { intent: 'product', hypotheses: [{ id: 'hyp-product-base', question: '产品利润结构' }], requests: [] };
  const outcomes = [{
    request: { id: 'qry-product-base', hypothesisId: 'hyp-product-base', select: [{ field: '商品名称', alias: 'product' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }] },
    resultSet: { id: 'rs-qry-product-base', rows: [{ product: 'A', revenue: 100 }] },
  }];
  const plan = await createFollowupPlan({
    metadata: extendedMetadata, profile, focus: '产品成本', filters: [], initialPlan, outcomes, remainingBudget: 2, executedFingerprints: new Set(),
    aiCritic: async () => ({
      summary: '比较商品成本', assessments: [],
      hypotheses: [{ id: 'hyp-product-cost', parentHypothesisId: 'hyp-product-base', question: '商品成本是否解释利润差异' }],
      requests: [{
        id: 'qry-product-cost', hypothesisId: 'hyp-product-cost', purpose: '比较商品平均进货价格', mode: 'compare',
        select: [{ field: '商品名称', alias: 'product' }, { field: '进货价格', alias: 'cost_price' }],
        measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }],
        lineage: { parentHypothesisId: 'hyp-product-base', triggerResultSetIds: ['rs-qry-product-base'], reason: '成本可能解释利润差异' },
      }],
    }),
  });
  assert.deepEqual(plan.requests[0].select.map(item => item.field), ['商品名称']);
  assert.ok(plan.requests[0].measures.some(item => item.field === '进货价格' && item.aggregation === 'average' && item.alias === 'cost_price'));
  assert.ok(plan.repairs.some(item => item.type === 'continuous-select-to-average'));
});

test('Critic 删除与显式指标重复的连续 select 并保留显式聚合口径', async () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const initialPlan = { intent: 'customer', hypotheses: [{ id: 'hyp-customer-base', question: '客户结构' }], requests: [] };
  const outcomes = [{
    request: { id: 'qry-customer-base', hypothesisId: 'hyp-customer-base', select: [{ field: '客户名称', alias: 'entity' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }] },
    resultSet: { id: 'rs-qry-customer-base', rows: [{ entity: 'A', revenue: 100 }] },
  }];
  const plan = await createFollowupPlan({
    metadata, profile, focus: '客户分级', filters: [], initialPlan, outcomes, remainingBudget: 2, executedFingerprints: new Set(),
    aiCritic: async () => ({
      summary: '验证客户分级', assessments: [],
      hypotheses: [{ id: 'hyp-customer-grade', parentHypothesisId: 'hyp-customer-base', question: '客户收入是否集中' }],
      requests: [{
        id: 'qry-customer-grade', hypothesisId: 'hyp-customer-grade', purpose: '验证客户收入结构', mode: 'aggregate',
        select: [{ field: '客户名称', alias: 'entity' }, { field: '订单金额', alias: 'revenue' }],
        measures: [
          { field: '订单金额', aggregation: 'sum', alias: 'revenue' },
          { field: '订单利润', aggregation: 'sum', alias: 'profit' },
        ],
        orderBy: [{ field: 'revenue', direction: 'desc' }],
        lineage: { parentHypothesisId: 'hyp-customer-base', triggerResultSetIds: ['rs-qry-customer-base'], reason: '补充客户分层证据' },
      }],
    }),
  });
  assert.deepEqual(plan.requests[0].select.map(item => item.field), ['客户名称']);
  assert.deepEqual(plan.requests[0].measures.filter(item => item.alias === 'revenue'), [{ field: '订单金额', aggregation: 'sum', alias: 'revenue', resultType: 'number' }]);
  assert.ok(plan.repairs.some(item => item.type === 'duplicate-measure-removed' && item.fields.includes('订单金额')));
});

test('Critic 从分组维度移除字段比较操作数并保留业务维度与比较条件', async () => {
  const labMetadata = {
    ...metadata,
    fields: [
      ...metadata.fields,
      { name: '科室名称', type: 'String', role: 'dimension', valueKind: 'categorical', description: '送检科室' },
      { name: '实验完成时间', type: 'Date', role: 'time', valueKind: 'temporal', description: '实验完成时间' },
      { name: '报告发布时间', type: 'Date', role: 'time', valueKind: 'temporal', description: '报告发布时间' },
    ],
  };
  const profile = buildSemanticCapabilityProfile(labMetadata);
  const initialPlan = { intent: 'open', hypotheses: [{ id: 'hyp-tat-base', question: '科室TAT效率' }], requests: [] };
  const outcomes = [{
    request: { id: 'qry-tat-base', hypothesisId: 'hyp-tat-base', select: [{ field: '科室名称', alias: 'entity' }], measures: [{ aggregation: 'countRows', alias: 'orders' }] },
    resultSet: { id: 'rs-qry-tat-base', rows: [{ entity: 'A', orders: 10 }] },
  }];
  const plan = await createFollowupPlan({
    metadata: labMetadata, profile, focus: '验证负TAT时间戳', filters: [], initialPlan, outcomes, remainingBudget: 2, executedFingerprints: new Set(),
    aiCritic: async () => ({
      summary: '验证时间戳顺序', assessments: [],
      hypotheses: [{ id: 'hyp-timestamp-integrity', parentHypothesisId: 'hyp-tat-base', question: '报告是否早于实验完成' }],
      requests: [{
        id: 'qry-timestamp-validation', hypothesisId: 'hyp-timestamp-integrity', purpose: '按科室统计时间戳倒置记录', mode: 'verify',
        select: [
          { field: '科室名称', alias: 'entity' },
          { field: '实验完成时间', alias: 'exp_complete_time' },
          { field: '报告发布时间', alias: 'report_publish_time' },
        ],
        measures: [{ aggregation: 'countRows', alias: 'affected_orders' }],
        fieldComparisons: [{ left: '实验完成时间', operator: 'gt', right: '报告发布时间' }],
        lineage: { parentHypothesisId: 'hyp-tat-base', triggerResultSetIds: ['rs-qry-tat-base'], reason: '负TAT需要校验时间戳顺序' },
      }],
    }),
  });
  assert.deepEqual(plan.requests[0].select.map(item => item.field), ['科室名称']);
  assert.deepEqual(plan.requests[0].fieldComparisons, [{ left: '实验完成时间', operator: 'gt', right: '报告发布时间', valueType: 'time' }]);
  assert.ok(plan.repairs.some(item => item.type === 'comparison-fields-removed-from-select'
    && item.fields.includes('实验完成时间') && item.fields.includes('报告发布时间')));
});

test('Critic 将 fieldComparisons 中的结果别名还原为语义字段并记录修复', async () => {
  const labMetadata = {
    ...metadata,
    fields: [
      ...metadata.fields,
      { name: '创建时间', type: 'Date', role: 'time', description: '订单创建时间' },
      { name: '报告发布时间', type: 'Date', role: 'time', description: '报告发布时间' },
    ],
  };
  const profile = buildSemanticCapabilityProfile(labMetadata);
  const plan = await createFollowupPlan({
    metadata: labMetadata, profile, focus: '时间逻辑', filters: [],
    initialPlan: { intent: 'open', hypotheses: [{ id: 'hyp-time', question: '时间顺序' }], requests: [] },
    outcomes: [{ request: { id: 'qry-base', hypothesisId: 'hyp-time', select: [{ field: '订购日期', alias: 'period' }], measures: [{ aggregation: 'countRows', alias: 'records' }] }, resultSet: { id: 'rs-qry-base', rows: [{ period: '2026-01', records: 10 }] } }],
    remainingBudget: 2, executedFingerprints: new Set(),
    aiCritic: async () => ({
      summary: '核验时间字段', assessments: [], hypotheses: [],
      requests: [{
        id: 'qry-time-alias', hypothesisId: 'hyp-time', purpose: '验证创建时间晚于报告时间', mode: 'verify',
        select: [{ field: '创建时间', alias: 'created_at' }, { field: '报告发布时间', alias: 'reported_at' }],
        measures: [{ aggregation: 'countRows', alias: 'affected' }],
        fieldComparisons: [{ left: 'created_at', operator: 'gt', right: 'reported_at' }],
        lineage: { parentHypothesisId: 'hyp-time', triggerResultSetIds: ['rs-qry-base'], reason: '时间戳顺序' },
      }],
    }),
  });
  assert.deepEqual(plan.requests[0].fieldComparisons, [{ left: '创建时间', operator: 'gt', right: '报告发布时间', valueType: 'time' }]);
  assert.ok(plan.repairs.some(item => item.type === 'comparison-alias-to-field'));
});

test('Critic 稳定修复非法中文指标别名并同步去重计数口径', async () => {
  const labMetadata = {
    ...metadata,
    fields: [
      ...metadata.fields,
      { name: '采集时间', type: 'Date', role: 'time' },
      { name: '签收时间', type: 'Date', role: 'time' },
    ],
  };
  const profile = buildSemanticCapabilityProfile(labMetadata);
  const plan = await createFollowupPlan({
    metadata: labMetadata, profile, focus: '验证时间逻辑', filters: [],
    initialPlan: { intent: 'open', hypotheses: [{ id: 'hyp-time', question: '时间逻辑' }], requests: [] },
    outcomes: [{ request: { id: 'qry-base', hypothesisId: 'hyp-time', select: [{ field: '订购日期', alias: 'period' }], measures: [{ aggregation: 'countRows', alias: 'records' }] }, resultSet: { id: 'rs-qry-base', rows: [{ period: '2026-01', records: 10 }] } }],
    remainingBudget: 2, executedFingerprints: new Set(),
    aiCritic: async () => ({ summary: '验证时间', assessments: [], hypotheses: [], requests: [{
      id: 'qry-time-count', hypothesisId: 'hyp-time', purpose: '验证签收时间晚于采集时间', mode: 'verify', select: [],
      measures: [{ aggregation: 'countRows', alias: '有效签收' }, { aggregation: 'countRows', alias: '有效报告' }],
      fieldComparisons: [{ left: '签收时间', operator: 'gte', right: '采集时间' }],
      lineage: { parentHypothesisId: 'hyp-time', triggerResultSetIds: ['rs-qry-base'], reason: '验证时间顺序' },
    }] }),
  });
  assert.deepEqual(plan.requests[0].measures, [{ field: null, aggregation: 'countRows', alias: 'metric1', resultType: 'number' }]);
  assert.ok(plan.repairs.some(item => item.type === 'invalid-alias-normalized' && item.aliases.length === 2));
  assert.ok(plan.repairs.some(item => item.type === 'duplicate-countrows-removed'));
});

test('Critic 将 fieldComparisons 中的字面量右值修复为普通字段筛选', async () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const plan = await createFollowupPlan({
    metadata, profile, focus: '高收入低利润客户', filters: [],
    initialPlan: { intent: 'customer', hypotheses: [{ id: 'hyp-customer', question: '客户利润质量' }], requests: [] },
    outcomes: [{ request: { id: 'qry-base', hypothesisId: 'hyp-customer', select: [{ field: '客户名称', alias: 'entity' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }] }, resultSet: { id: 'rs-qry-base', rows: [{ entity: '甲', revenue: 400000 }] } }],
    remainingBudget: 2, executedFingerprints: new Set(),
    aiCritic: async () => ({ summary: '筛选客户', assessments: [], hypotheses: [], requests: [{
      id: 'qry-customer-threshold', hypothesisId: 'hyp-customer', purpose: '筛选高收入低利润客户', mode: 'verify',
      select: [{ field: '客户名称', alias: 'entity' }, { field: '订单金额', alias: 'revenue' }, { field: '订单利润', alias: 'profit' }],
      measures: [], filters: [{ field: '订单金额', operator: 'gte', value: 300000 }],
      fieldComparisons: [{ left: '订单利润', operator: 'lt', right: 30000 }],
      lineage: { parentHypothesisId: 'hyp-customer', triggerResultSetIds: ['rs-qry-base'], reason: '定位利润风险' },
    }] }),
  });
  assert.deepEqual(plan.requests[0].fieldComparisons, []);
  assert.ok(plan.requests[0].filters.some(item => item.field === '订单利润' && item.operator === 'lt' && item.value === 30000));
  assert.ok(plan.repairs.some(item => item.type === 'literal-comparison-to-filter'));
});

test('Critic 将聚合别名与数值字面量比较修复为结果筛选', async () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const plan = await createFollowupPlan({
    metadata, profile, focus: '识别低利润产品', filters: [],
    initialPlan: { intent: 'product', hypotheses: [{ id: 'hyp-product', question: '产品利润质量' }], requests: [] },
    outcomes: [{ request: { id: 'qry-base', hypothesisId: 'hyp-product', select: [{ field: '商品名称', alias: 'entity' }], measures: [{ field: '订单利润', aggregation: 'sum', alias: 'profit' }] }, resultSet: { id: 'rs-qry-base', rows: [{ entity: '产品A', profit: 100 }] } }],
    remainingBudget: 2, executedFingerprints: new Set(),
    aiCritic: async () => ({ summary: '筛选低利润产品', assessments: [], hypotheses: [], requests: [{
      id: 'qry-product-threshold', hypothesisId: 'hyp-product', purpose: '筛选低利润产品', mode: 'verify',
      select: [{ field: '商品名称', alias: 'entity' }],
      measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }, { field: '订单利润', aggregation: 'sum', alias: 'profit' }],
      fieldComparisons: [{ left: 'profit', operator: 'lt', right: 0.45 }],
      orderBy: [{ field: 'profit', direction: 'asc' }],
      lineage: { parentHypothesisId: 'hyp-product', triggerResultSetIds: ['rs-qry-base'], reason: '验证低利润产品' },
    }] }),
  });
  assert.deepEqual(plan.requests[0].fieldComparisons, []);
  assert.deepEqual(plan.requests[0].resultFilters, [{ field: 'profit', operator: 'lt', value: 0.45 }]);
  assert.ok(plan.repairs.some(item => item.type === 'literal-comparison-to-filter'));
});

test('Critic 显式记录并去除 countRows 的字段与重复别名而不伪造多个计数口径', async () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const initialPlan = { intent: 'customer', hypotheses: [{ id: 'hyp-customer-base', question: '客户结构' }], requests: [] };
  const outcomes = [{
    request: { id: 'qry-customer-base', hypothesisId: 'hyp-customer-base', select: [{ field: '客户名称', alias: 'entity' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }] },
    resultSet: { id: 'rs-qry-customer-base', rows: [{ entity: 'A', revenue: 100 }] },
  }];
  const plan = await createFollowupPlan({
    metadata, profile, focus: '亏损客户', filters: [], initialPlan, outcomes, remainingBudget: 2, executedFingerprints: new Set(),
    aiCritic: async () => ({
      summary: '统计亏损记录', assessments: [], hypotheses: [],
      requests: [{
        id: 'qry-loss-records', hypothesisId: 'hyp-customer-base', purpose: '统计亏损记录数', mode: 'verify',
        select: [{ field: '客户名称', alias: 'entity' }],
        measures: [
          { field: '订单利润', aggregation: 'countRows', alias: 'loss_records' },
          { field: '订单利润', aggregation: 'countRows', alias: 'duplicate_loss_records' },
        ],
        filters: [{ field: '订单利润', operator: 'lt', value: 0 }],
        lineage: { parentHypothesisId: 'hyp-customer-base', triggerResultSetIds: ['rs-qry-customer-base'], reason: '检查亏损客户' },
      }],
    }),
  });
  assert.deepEqual(plan.requests[0].measures, [{ field: null, aggregation: 'countRows', alias: 'loss_records', resultType: 'number' }]);
  assert.ok(plan.repairs.some(item => item.type === 'countrows-field-removed'));
  assert.ok(plan.repairs.some(item => item.type === 'duplicate-countrows-removed' && item.removedAliases.includes('duplicate_loss_records')));
});

test('Critic 为多个缺失 ID 的 follow-up 生成唯一且可审计的查询 ID', async () => {
  const profile = buildSemanticCapabilityProfile(metadata);
  const initialPlan = { intent: 'customer', hypotheses: [{ id: 'hyp-customer-base', question: '客户结构' }], requests: [] };
  const outcomes = [{
    request: { id: 'qry-customer-base', hypothesisId: 'hyp-customer-base', select: [{ field: '客户名称', alias: 'customer' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }] },
    resultSet: { id: 'rs-qry-customer-base', rows: [{ customer: 'A', revenue: 100 }] },
  }];
  const plan = await createFollowupPlan({
    metadata, profile, focus: '客户结构', filters: [], initialPlan, outcomes, remainingBudget: 3, executedFingerprints: new Set(),
    aiCritic: async () => ({
      summary: '补充客户验证', assessments: [],
      hypotheses: [
        { id: 'hyp-customer-revenue', parentHypothesisId: 'hyp-customer-base', question: '客户收入' },
        { id: 'hyp-customer-profit', parentHypothesisId: 'hyp-customer-base', question: '客户利润' },
      ],
      requests: [
        { hypothesisId: 'hyp-customer-revenue', purpose: '客户收入验证', mode: 'verify', select: [{ field: '客户名称', alias: 'customer' }], measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }], lineage: { parentHypothesisId: 'hyp-customer-base', triggerResultSetIds: ['rs-qry-customer-base'] } },
        { hypothesisId: 'hyp-customer-profit', purpose: '客户利润验证', mode: 'verify', select: [{ field: '客户名称', alias: 'customer' }], measures: [{ field: '订单利润', aggregation: 'sum', alias: 'profit' }], lineage: { parentHypothesisId: 'hyp-customer-base', triggerResultSetIds: ['rs-qry-customer-base'] } },
      ],
    }),
  });
  assert.equal(plan.requests.length, 2);
  assert.equal(new Set(plan.requests.map(item => item.id)).size, 2);
  assert.ok(plan.requests.every(item => /^qry-followup-/.test(item.id)));
  assert.equal(plan.repairs.filter(item => item.type === 'missing-request-id').length, 2);
});
