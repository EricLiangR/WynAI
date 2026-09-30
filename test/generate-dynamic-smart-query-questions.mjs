import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const baseUrl = String(process.env.UAT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const datasetId = process.env.UAT_DATASET_ID || '18b86197-65e3-4682-8501-6e7125afad02';
const outputDir = process.env.UAT_DYNAMIC_OUTPUT_DIR || join(process.cwd(), 'UAT-AY', 'dynamic-semantic-uat-2026-09-29');
const skillPath = process.env.UAT_SKILL_PATH || join(process.cwd(), 'skills', 'sales-opportunity-a53', 'skill.json');

async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${pathname} HTTP ${response.status}`);
  return response.json();
}

function findField(metadata, candidates) {
  return candidates.map(candidate => (metadata?.fields || []).find(field => field.name === candidate || field.dataField === candidate)).find(Boolean) || null;
}

function entityField(skill, concept, fallback) {
  return skill.businessEntities?.find(item => item.concept === concept)?.field || fallback;
}

function entityName(skill, concept, fallback) {
  return skill.businessEntities?.find(item => item.concept === concept)?.name || fallback;
}

function mappedValue(skill, field, alias) {
  return skill.valueMappings?.find(item => item.field === field && (item.synonyms?.includes(alias) || item.canonicalValue === alias))?.canonicalValue || alias;
}

const metadata = await getJson(`/api/datasets/${datasetId}/metadata`);
const catalog = await getJson('/api/smart-query/skills');
const skill = JSON.parse(await readFile(skillPath, 'utf8'));
const activeSkill = catalog.items?.find(item => item.id === skill.id && item.version === skill.version && item.status === 'approved');
if (!activeSkill) throw new Error(`运行时未找到已批准 Skill：${skill.id}@${skill.version}`);

const fields = {
  customer: entityField(skill, 'customer', '客户名称'),
  customerType: entityField(skill, 'customerType', '客户类型'),
  industry: entityField(skill, 'customerIndustry', '客户所属行业'),
  category: entityField(skill, 'productCategory', '产品大类'),
  subcategory: entityField(skill, 'productSubcategory', '产品小类'),
  region: entityField(skill, 'salesRegion', '销售地区'),
  recurring: entityField(skill, 'recurring', 'recurring'),
  project: entityField(skill, 'projectName', 'pipelineName'),
  manager: entityField(skill, 'salesDirector', 'Opportunity_manager'),
  partner: entityField(skill, 'opportunityPartner', 'Opportunity_partner'),
  createdDate: entityField(skill, 'createdDate', 'code_open_date'),
  expectedEndDate: entityField(skill, 'expectedEndDate', '预计关闭日期'),
  fiscalYear: skill.calendarPolicy?.fiscalYearField || '赢单财年',
  fiscalQuarter: '赢单季度',
  revenue: skill.metrics?.find(item => item.concept === 'revenue' && item.field === 'Opportunity_amount_CNY')?.name || '销售额',
  opportunityCount: skill.metrics?.find(item => item.concept === 'opportunityCount')?.name || '商机数量',
};
const labels = {
  customer: entityName(skill, 'customer', '客户名称'),
  customerType: entityName(skill, 'customerType', '客户类型'),
  industry: entityName(skill, 'customerIndustry', '客户所属行业'),
  category: entityName(skill, 'productCategory', '产品大类'),
  subcategory: entityName(skill, 'productSubcategory', '产品小类'),
  region: entityName(skill, 'salesRegion', '销售地区'),
  recurring: entityName(skill, 'recurring', 'recurring 类型'),
  project: entityName(skill, 'projectName', '项目名称'),
  manager: entityName(skill, 'salesDirector', '销售总监'),
  partner: entityName(skill, 'opportunityPartner', '合作伙伴'),
  createdDate: entityName(skill, 'createdDate', '创建日期'),
  expectedEndDate: entityName(skill, 'expectedEndDate', '预计结束日期'),
};
const requiredFields = [fields.customer, fields.customerType, fields.industry, fields.category, fields.subcategory, fields.region, fields.recurring, fields.project, fields.manager, fields.partner, fields.createdDate, fields.expectedEndDate, fields.fiscalYear, fields.fiscalQuarter];
const missingFields = requiredFields.filter(name => !findField(metadata, [name]));
if (missingFields.length) throw new Error(`当前数据集缺少动态问题所需字段：${missingFields.join('、')}`);

const poe = mappedValue(skill, fields.customerType, 'POE');
const mnc = mappedValue(skill, fields.customerType, 'MNC');
const recurringNewWin = mappedValue(skill, fields.recurring, '老客户、新合同');
const riskManagement = mappedValue(skill, fields.subcategory, 'Risk Management');
const manufacturing = mappedValue(skill, fields.category, 'Manufacturing');
const food = mappedValue(skill, fields.industry, 'Food');
const questions = [
  `去年按${labels.category}统计${fields.revenue}，列出金额最高的前三个${labels.category}`,
  `去年按${labels.region}统计${fields.opportunityCount}，列出数量最多的前三个${labels.region}`,
  `${labels.recurring}为${recurringNewWin}的商机中，${labels.subcategory}为${riskManagement}的有哪些？返回${labels.project}、${labels.customer}、${labels.expectedEndDate}`,
  `x-ssl项目中${labels.customerType}为POE的项目有哪些？返回${labels.project}、${labels.customer}、${labels.partner}`,
  `去年${labels.customerType}为MNC的${fields.revenue}和${fields.opportunityCount}是多少`,
  `${labels.industry}为${food}且${labels.customerType}为POE的商机有多少个`,
  `所有财年中不是 recurring 的${labels.customer}名单`,
  `去年按${labels.subcategory}统计${fields.revenue}，筛选总金额大于500万`,
  `去年${labels.subcategory}为${riskManagement}的商机，返回${labels.project}、${labels.customer}和${labels.expectedEndDate}`,
  `去年按${fields.fiscalQuarter}统计${fields.revenue}和${fields.opportunityCount}`,
  `去年x-ssl项目返回${labels.project}、${labels.manager}、${labels.partner}、${labels.createdDate}和${labels.expectedEndDate}`,
  `${mnc}或${poe}客户中${labels.category}为${manufacturing}的${fields.revenue}是多少`,
];
const uniqueQuestions = [...new Set(questions)];
if (uniqueQuestions.length < 10) throw new Error(`动态问题数量不足：${uniqueQuestions.length}`);

await mkdir(outputDir, { recursive: true });
const manifest = {
  schema: 'wynai.dynamic-smart-query-uat/v1',
  generatedAt: new Date().toISOString(),
  baseUrl,
  dataset: { id: metadata.id, name: metadata.name, revision: metadata.revision, fieldCount: metadata.fields?.length || 0 },
  skill: { id: skill.id, version: skill.version, runtimeApproved: true },
  generation: { source: 'live-dataset-metadata-and-approved-skill', presetExpectedAnswers: false, readFixImplementation: false, minimumQuestions: 10 },
  questions: uniqueQuestions.map((question, index) => ({ id: `DYN-${String(index + 1).padStart(2, '0')}`, question })),
};
await writeFile(join(outputDir, 'dynamic-questions.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: join(outputDir, 'dynamic-questions.json'), dataset: manifest.dataset, skill: manifest.skill, count: manifest.questions.length, questions: manifest.questions }, null, 2));
