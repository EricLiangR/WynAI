import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSemanticMapping } from '../semantic-catalog.mjs';
import { planBusinessQuestion, planBusinessQuestionAsync } from '../lib/conversation/question-planner.mjs';

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
  const model = changingModel(intent => ({ ...intent, filters: [{ field: '客户名称', operator: 'eq', value: 'MNC' }] }));
  const result = await planBusinessQuestionAsync({ metadata, question: 'MNC项目金额是多少', skills: [skill], skillRefs: ['generic-opportunity@1.0.0'], llm: model.llm, now });
  assert.equal(result.status, 'supported', JSON.stringify({ clarification: result.clarification, message: result.message, diagnostics: result.plannerDiagnostics }));
  assert.deepEqual(result.intent.filters[0], { field: '客户类型', fieldRef: '客户类型', operator: 'containsAny', value: ['Multinational Corporation（MNC）'], concept: 'customerType', source: 'MNC' });
  assert.deepEqual(result.intent.governedMappingEvidence[0], { schema: 'wynai.governed-mapping-evidence/v1', sourcePhrase: 'MNC', field: '客户类型', concept: 'customerType', operator: 'containsAny', canonicalValue: 'Multinational Corporation（MNC）', skillRef: 'generic-opportunity@1.0.0', evidenceSource: 'skill-value-mapping' });
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
