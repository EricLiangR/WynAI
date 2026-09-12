import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadSkillsFromDirectory } from '../lib/skills/skill-registry.mjs';
import { applyCanonicalFilters, normalizeCanonicalQueryRequest } from '../lib/planning/query-request-schema.mjs';

const skillsDirectory = fileURLToPath(new URL('../skills', import.meta.url));
const datasetId = '18b86197-65e3-4682-8501-6e7125afad02';
const metadata = { id: datasetId, revision: 1, fields: [
  { name: 'pipelineName', role: 'dimension', type: 'String', rawType: 'String' },
  { name: '客户名称', role: 'dimension', type: 'String', rawType: 'String' },
  { name: '客户类型', role: 'dimension', type: 'String', rawType: 'String' },
  { name: 'xssl', role: 'dimension', type: 'String', rawType: 'String' },
  { name: 'is_subcode', role: 'dimension', type: 'String', rawType: 'String' },
  { name: 'Opportunity_manager', role: 'dimension', type: 'String', rawType: 'String' },
  { name: 'Opportunity_partner', role: 'dimension', type: 'String', rawType: 'String' },
  { name: 'code_open_date', role: 'dimension', type: 'Date', rawType: 'DateTime' },
  { name: '预计关闭日期', role: 'dimension', type: 'Date', rawType: 'DateTime' },
] };

test('销售商机 Skill 1.3.0 绑定新数据集并加载 Markdown 字典', async () => {
  const registry = await loadSkillsFromDirectory(skillsDirectory);
  const skill = registry.get('sales-opportunity-a53', '1.3.0');
  assert.ok(skill);
  assert.ok(skill.datasetIds.includes(datasetId));
  assert.equal(skill.dictionaries.find(item => item.id === 'customer-type')?.items.length, 15);
  assert.equal(skill.dictionaries.find(item => item.id === 'recurring')?.items.length, 3);
  assert.ok(skill.dictionaries.some(item => item.id === 'xssl'));
  assert.ok(skill.dictionaries.some(item => item.id === 'psm'));
  for (const id of ['xssl', 'psm']) {
    const dictionary = skill.dictionaries.find(item => item.id === id);
    assert.equal(dictionary.items.length, 3);
    assert.ok(dictionary.items.every(item => item.sourceValue === '1'));
  }
});

test('销售商机简称和源值映射保留，recurring 规则可被运行时读取', async () => {
  const registry = await loadSkillsFromDirectory(skillsDirectory);
  const skill = registry.get('sales-opportunity-a53', '1.3.0');
  const mapping = (field, synonym) => skill.valueMappings.find(item => item.field === field && item.synonyms.includes(synonym));
  assert.equal(mapping('客户类型', 'MNC')?.canonicalValue, 'Multinational Corporation（MNC）');
  assert.equal(mapping('客户类型', 'POE')?.canonicalValue, 'Private Entity（POE）');
  assert.equal(mapping('recurring', '老客户、老合同续约')?.canonicalValue, 'Yes - Continuous');
  assert.equal(mapping('recurring', '老客户、新合同')?.canonicalValue, 'Yes - New Win');
  assert.equal(mapping('xssl', 'x-ssl')?.canonicalValue, '1');
  assert.equal(mapping('is_subcode', 'PSM')?.canonicalValue, '1');
});

test('销售商机请求字段绑定和多值字符串筛选可被严格校验', async () => {
  const registry = await loadSkillsFromDirectory(skillsDirectory);
  const skill = registry.get('sales-opportunity-a53', '1.3.0');
  const fields = new Map(skill.businessEntities.map(item => [item.id, item.field]));
  assert.deepEqual(['projectName', 'salesDirector', 'opportunityPartner', 'createdDate', 'expectedEndDate', 'primeOffice'].map(id => fields.get(id)), ['pipelineName', 'Opportunity_manager', 'Opportunity_partner', 'code_open_date', '预计关闭日期', 'primeOffice']);
  const request = normalizeCanonicalQueryRequest(metadata, {
    id: 'sales-uat-001', mode: 'detail',
    select: [
      { field: 'pipelineName', alias: 'project_name' }, { field: '客户名称', alias: 'customer_name' },
      { field: 'Opportunity_manager', alias: 'sales_director' }, { field: 'Opportunity_partner', alias: 'opportunity_partner' },
      { field: 'code_open_date', alias: 'created_date' }, { field: '预计关闭日期', alias: 'expected_end_date' },
    ],
    filters: [{ field: 'xssl', operator: 'eq', value: '1' }, { field: '客户类型', operator: 'containsAny', value: ['Private Entity（POE）'] }],
  });
  assert.equal(request.limit, 20000);
  assert.equal(request.expectedResult.maximumRows, 20000);
  assert.equal(request.filters[1].operator, 'containsAny');
  assert.equal(applyCanonicalFilters([{ 客户类型: '["Private Entity（POE）", "Public Entity"]' }, { 客户类型: '["Public Entity"]' }], metadata, request.filters.slice(1)).length, 1);
});
