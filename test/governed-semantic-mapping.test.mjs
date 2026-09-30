import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSemanticMapping } from '../semantic-catalog.mjs';
import { alignLlmExplicitValueFilters, normalizeSkillValueFilters, planBusinessQuestion, planBusinessQuestionAsync } from '../lib/conversation/question-planner.mjs';

const now = new Date('2026-09-22T08:00:00+08:00');
const metadata = { id: 'mapping-dataset', revision: 1, fields: [
  ['pipelineName', 'dimension'], ['客户名称', 'dimension'], ['客户类型', 'dimension'], ['Opportunity_partner', 'dimension'],
  ['项目金额', 'measure'],
].map(([name, role]) => ({ name, role, type: role === 'measure' ? 'Number' : 'String', rawType: role === 'measure' ? 'Double' : 'String' })) };
const skill = { id: 'generic-opportunity', version: '1.0.0', status: 'approved', metrics: [
  { id: 'projectAmount', concept: 'revenue', name: '项目金额', field: '项目金额', aggregation: 'sum', synonyms: ['金额'], outputAlias: 'project_amount' },
],
  valueMappings: [{ field: '客户类型', concept: 'customerType', canonicalValue: 'Multinational Corporation（MNC）', synonyms: ['MNC'], matchMode: 'containsAny' }],
  businessEntities: [
    { id: 'projectName', concept: 'projectName', name: '项目名称', field: 'pipelineName', synonyms: ['项目'] },
    { id: 'opportunityPartner', concept: 'opportunityPartner', name: '合作伙伴', field: 'Opportunity_partner', synonyms: ['partner'] },
  ] };

function changingModel(change) {
  let calls = 0;
  return { calls: () => calls, llm: { enabled: true, async planQueryIntent({ metadata: catalog, question, skills }) {
    calls += 1;
    return change(structuredClone(planBusinessQuestion({ metadata: catalog, question, skills, now }).intent));
  } } };
}

test('Skill 规范值不能脱离声明字段绑定到其它字段', () => {
  const result = validateSemanticMapping({ metadata, skills: [skill], intent: { skillRefs: ['generic-opportunity@1.0.0'], filters: [
    { field: '客户名称', operator: 'containsAny', value: ['Multinational Corporation（MNC）'] },
  ] } });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('；'), /规范值字段绑定冲突.*客户类型/);
});

test('普通精确值允许与其它字段的 Skill 规范值同名', () => {
  const collisionSkill = {
    ...skill,
    valueMappings: [
      ...skill.valueMappings,
      { field: '客户类型', concept: 'customerType', canonicalValue: 'Food', synonyms: [], matchMode: 'containsAny' },
    ],
  };
  const result = validateSemanticMapping({ metadata: {
    ...metadata,
    fields: [...metadata.fields, { name: '客户所属子行业', role: 'dimension', type: 'String', rawType: 'String' }],
  }, skills: [collisionSkill], intent: { skillRefs: ['generic-opportunity@1.0.0'], filters: [
    { field: '客户所属子行业', operator: 'eq', value: 'Food' },
  ] } });
  assert.equal(result.valid, true, result.errors.join('；'));
});

test('LLM 选择的相邻字段不会被 Skill 静默改写，交由修复轮次处理', () => {
  const industrySkill = {
    ...skill,
    valueMappings: [
      ...skill.valueMappings,
      { field: '客户所属行业', concept: 'industry', canonicalValue: 'Food', synonyms: [], matchMode: 'exact' },
    ],
  };
  const metadataWithSubsector = {
    ...metadata,
    fields: [...metadata.fields, { name: '客户所属子行业', role: 'dimension', type: 'String', rawType: 'String' }],
  };
  const aligned = alignLlmExplicitValueFilters({
    filters: [{ field: '客户所属行业', operator: 'eq', value: 'Food' }],
    requestUnits: [{ id: 'subsector', kind: 'filter', sourceText: '客户所属子行业为Food', status: 'executable', field: '客户所属子行业' }],
  }, { question: '客户所属子行业为Food', metadata: metadataWithSubsector, skills: [industrySkill] });
  const result = normalizeSkillValueFilters(aligned, {
    question: '客户所属子行业为Food',
    metadata: metadataWithSubsector,
    skills: [industrySkill],
  });
  assert.equal(result.filters[0].field, '客户所属行业');
  assert.equal(result.requestUnits[0].field, '客户所属子行业');
});

test('LLM 已声明的 x-ssl 筛选单元由 Skill 映射物化为源字段条件', () => {
  const xsslSkill = {
    ...skill,
    valueMappings: [
      ...skill.valueMappings,
      { field: 'xssl', concept: 'xssl', canonicalValue: '1', synonyms: ['x-ssl', 'xssl'], matchMode: 'exact' },
    ],
  };
  const result = normalizeSkillValueFilters({
    filters: [],
    requestUnits: [{ id: 'xssl', kind: 'filter', sourceText: 'x-ssl 项目', status: 'executable', criticality: 'scope-defining', field: 'x-ssl' }],
  }, {
    question: 'x-ssl 项目有哪些',
    metadata: { ...metadata, fields: [...metadata.fields, { name: 'xssl', role: 'dimension', type: 'String', rawType: 'String' }] },
    skills: [xsslSkill],
  });
  assert.deepEqual(result.filters, [{
    field: 'xssl', fieldRef: 'xssl', operator: 'eq', value: '1', concept: 'xssl', source: 'x-ssl',
  }]);
  assert.equal(result.requestUnits[0].field, 'xssl');
});

for (const abbreviation of ['MCN', 'POC']) test(`未知简称 ${abbreviation} 必须澄清`, async () => {
  const model = changingModel(intent => ({ ...intent, filters: [{ field: '客户类型', fieldRef: '客户类型', operator: 'containsAny', value: ['Multinational Corporation（MNC）'], concept: 'customerType' }] }));
  const result = await planBusinessQuestionAsync({ metadata, question: `${abbreviation}的项目`, skills: [skill], skillRefs: ['generic-opportunity@1.0.0'], llm: model.llm, now });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.plannerDiagnostics.reason, 'governed-mapping-evidence-required');
  assert.match(result.clarification, new RegExp(abbreviation));
  assert.equal(model.calls(), 1);
});

test('未知简称作为受治理字典字段原值时也必须澄清', async () => {
  const model = changingModel(intent => ({ ...intent, filters: [{ field: '客户类型', fieldRef: '客户类型', operator: 'containsAny', value: ['POC'], concept: 'customerType' }] }));
  const result = await planBusinessQuestionAsync({ metadata, question: 'POC的项目', skills: [skill], skillRefs: ['generic-opportunity@1.0.0'], llm: model.llm, now });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.plannerDiagnostics.reason, 'governed-mapping-evidence-required');
  assert.match(result.clarification, /POC/);
});

test('已批准简称形成字段操作符规范值和 Skill 来源的原子证据', async () => {
  const model = changingModel(intent => ({ ...intent, filters: [{ field: '客户类型', operator: 'eq', value: 'MNC' }] }));
  const result = await planBusinessQuestionAsync({ metadata, question: 'MNC项目金额是多少', skills: [skill], skillRefs: ['generic-opportunity@1.0.0'], llm: model.llm, now });
  assert.equal(result.status, 'supported', JSON.stringify({ clarification: result.clarification, message: result.message, diagnostics: result.plannerDiagnostics }));
  assert.deepEqual(result.intent.filters[0], { field: '客户类型', fieldRef: '客户类型', operator: 'containsAny', value: ['Multinational Corporation（MNC）'], concept: 'customerType', source: 'MNC' });
  assert.deepEqual(result.intent.governedMappingEvidence[0], { schema: 'wynai.governed-mapping-evidence/v1', sourcePhrase: 'MNC', field: '客户类型', concept: 'customerType', operator: 'containsAny', canonicalValue: 'Multinational Corporation（MNC）', skillRef: 'generic-opportunity@1.0.0', evidenceSource: 'skill-value-mapping' });
});

test('完整业务描述解析为 Skill 规范值时不要求用户原文命中规范值', async () => {
  const productMetadata = {
    ...metadata,
    fields: [
      ...metadata.fields,
      { name: '产品名称', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '产品大类', role: 'dimension', type: 'String', rawType: 'String' },
      { name: '产品小类', role: 'dimension', type: 'String', rawType: 'String' },
    ],
  };
  const productSkill = {
    ...skill,
    valueMappings: [
      ...skill.valueMappings,
      {
        field: '产品名称', concept: 'product',
        canonicalValue: 'Safety Production and Risk Control in Manufacturing',
        synonyms: ['Safety Production and Risk Control in Manufacturing'], matchMode: 'exact',
      },
      {
        field: '产品大类', concept: 'productCategory',
        canonicalValue: 'Manufacturing', synonyms: ['Manufacturing'], matchMode: 'exact',
      },
      { field: '产品小类', concept: 'productSubcategory', canonicalValue: 'Risk Management', synonyms: ['风险管理'], matchMode: 'exact' },
    ],
    businessEntities: [
      ...(skill.businessEntities || []),
      { id: 'productName', concept: 'product', name: '产品名称', field: '产品名称', synonyms: ['产品', 'product'] },
      { id: 'productCategory', concept: 'productCategory', name: '产品大类', field: '产品大类', synonyms: ['大类'] },
      { id: 'productSubcategory', concept: 'productSubcategory', name: '产品小类', field: '产品小类', synonyms: ['小类'] },
    ],
  };
  let calls = 0;
  const model = { enabled: true, async planQueryIntent({ repairFeedback = '' } = {}) {
    calls += 1;
    const corrected = Boolean(repairFeedback);
    return {
      schema: 'wynai.business-query-intent/v2',
      businessQuestion: '列出产品为 Safety Production and Risk Control in Manufacturing 的商机',
      metrics: [],
      derivedMetrics: [],
      dimensions: [{ field: 'pipelineName', fieldRef: 'pipelineName', alias: 'project_name', concept: 'projectName', grain: null }],
      filters: [corrected
        ? { field: '产品名称', fieldRef: '产品名称', operator: 'eq', value: 'Safety Production and Risk Control in Manufacturing' }
        : { field: '产品小类', fieldRef: '产品小类', operator: 'eq', value: 'Risk Management' }],
      resultFilters: [],
      time: { field: null, calendar: null, periods: [], range: null, grain: null },
      expectedResult: { shape: 'detail-table', minimumRows: 0, maximumRows: 20000, requiredPeriods: [], requiredMetrics: [], requiredDimensions: ['project_name'], timeZone: 'Asia/Shanghai' },
      constraints: [], assumptions: [], confidence: 1,
      skillRefs: ['generic-opportunity@1.0.0'], mappingEvidence: [], ambiguities: [],
    };
  } };
  const result = await planBusinessQuestionAsync({
    metadata: productMetadata,
    question: 'Safety Production and Risk Control in Manufacturing 的商机有哪些',
    skills: [productSkill],
    skillRefs: ['generic-opportunity@1.0.0'],
    llm: model,
    now,
  });
  assert.notEqual(result.plannerDiagnostics?.reason, 'governed-mapping-evidence-required');
  assert.notEqual(result.status, 'needs_clarification');
  assert.ok(result.intent, JSON.stringify(result));
  assert.equal(calls, 2);
  assert.deepEqual(result.intent.filters, [{
    field: '产品名称', fieldRef: '产品名称', operator: 'eq',
    value: 'Safety Production and Risk Control in Manufacturing', concept: 'product',
    source: 'Safety Production and Risk Control in Manufacturing',
  }]);
});

test('其它字段字典中的同名规范值不能误拦截普通筛选', async () => {
  const collisionSkill = {
    ...skill,
    valueMappings: [
      ...skill.valueMappings,
      { field: '客户类型', concept: 'customerType', canonicalValue: '26', synonyms: ['TYPE26'], matchMode: 'containsAny' },
    ],
  };
  const model = changingModel(intent => ({
    ...intent,
    filters: [{ field: 'pipelineName', fieldRef: 'pipelineName', operator: 'eq', value: '26' }],
  }));
  const result = await planBusinessQuestionAsync({
    metadata,
    question: '订单名称26的项目金额是多少',
    skills: [collisionSkill],
    skillRefs: ['generic-opportunity@1.0.0'],
    llm: model.llm,
    now,
  });
  assert.notEqual(result.plannerDiagnostics?.reason, 'governed-mapping-evidence-required');
});

test('必需字段按 Skill 同义词解析到实际输出 alias', async () => {
  const model = { enabled: true, async planQueryIntent() { return {
    schema: 'wynai.business-query-intent/v2', businessQuestion: '按项目名称、partner统计项目金额',
    metrics: [{ field: '项目金额', fieldRef: '项目金额', aggregation: 'sum', alias: 'project_amount', concept: 'revenue', internal: false }],
    derivedMetrics: [],
    dimensions: [
      { field: 'pipelineName', fieldRef: 'pipelineName', alias: 'project_name', concept: 'projectName', grain: null },
      { field: 'Opportunity_partner', fieldRef: 'Opportunity_partner', alias: 'opportunity_partner', concept: 'opportunityPartner', grain: null },
    ],
    filters: [], resultFilters: [],
    time: { field: null, calendar: null, timeZone: 'Asia/Shanghai', periods: [], range: null, grain: null },
    expectedResult: { shape: 'grouped-table', minimumRows: 0, maximumRows: 20000, requiredPeriods: [], requiredMetrics: ['project_amount'], requiredDimensions: ['project_name', 'partner'], timeZone: 'Asia/Shanghai' },
    constraints: [], assumptions: [], confidence: 1, skillRefs: ['generic-opportunity@1.0.0'], mappingEvidence: [], ambiguities: [],
  }; } };
  const result = await planBusinessQuestionAsync({ metadata, question: '按项目名称、partner统计项目金额', skills: [skill], skillRefs: ['generic-opportunity@1.0.0'], llm: model, now });
  assert.equal(result.status, 'supported', JSON.stringify({ clarification: result.clarification, message: result.message, diagnostics: result.plannerDiagnostics }));
  assert.deepEqual(result.intent.expectedResult.requiredDimensions, ['project_name', 'opportunity_partner']);
  assert.ok(result.request.select.some(item => item.field === 'Opportunity_partner'));
});
