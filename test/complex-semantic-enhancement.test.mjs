import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SkillRegistry } from '../lib/skills/skill-registry.mjs';
import { parseBusinessTimeSemantics } from '../lib/semantics/time-semantics.mjs';
import { planBusinessQuestion } from '../lib/conversation/question-planner.mjs';
import { compileWaxQuery } from '../lib/wax-query.mjs';
import { normalizeCanonicalResultSet } from '../lib/query/result-normalizer.mjs';

const rawSkills = await Promise.all([
  readFile(new URL('../skills/sales/skill.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../skills/system/temporal-semantics/skill.json', import.meta.url), 'utf8').then(JSON.parse),
]);
const registry = new SkillRegistry(rawSkills);
const skills = registry.list();
const skillRefs = skills.map(skill => `${skill.id}@${skill.version}`);
const metadata = {
  id: 'dataset-complex', revision: 1, name: '销售数据',
  fields: [
    { name: '订购日期', role: 'time', type: 'Date', rawType: 'DateTime' },
    { name: '订单金额', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '订单利润', role: 'measure', type: 'Number', rawType: 'Double' },
    { name: '订单编号', role: 'identifier', type: 'String', rawType: 'String' },
    { name: '客户地区', role: 'dimension', type: 'String' },
    { name: '客户省份', role: 'dimension', type: 'String' },
    { name: '客户城市', role: 'dimension', type: 'String' },
  ],
};
const now = new Date('2026-08-25T08:00:00+08:00');

function plan(question) {
  return planBusinessQuestion({ metadata, question, skills, skillRefs, now });
}

test('时间语义 Skill 将年月同义表达统一归一为 month', () => {
  for (const expression of ['年月', '年和月', '按照月份', '按照每个月', '按月']) {
    const parsed = parseBusinessTimeSemantics(expression, { now, skills });
    assert.equal(parsed.grain, 'month', expression);
    assert.ok(parsed.constraints.some(item => item.type === 'time-grain'), expression);
  }
});

test('复杂问题一次形成四维分组、多指标和受治理派生指标', () => {
  const planned = plan('按照年月、大区、省份、城市统计销售额、利润、毛利率');
  assert.equal(planned.status, 'supported');
  assert.deepEqual(planned.intent.dimensions.map(item => item.field).sort(), ['订购日期', '客户地区', '客户省份', '客户城市'].sort());
  assert.equal(planned.intent.dimensions.find(item => item.grain)?.grain, 'month');
  assert.deepEqual(planned.intent.metrics.filter(item => !item.internal).map(item => item.alias), ['revenue', 'profit']);
  assert.deepEqual(planned.intent.derivedMetrics.map(item => item.alias), ['gross_margin_rate']);
  assert.equal(planned.intent.derivedMetrics[0].aggregationOrder, 'aggregate-then-calculate');
});

test('平均客单价只改变客单价自身，销售额和利润仍按 sum', () => {
  const planned = plan('每年统计销售额、利润和平均客单价');
  assert.equal(planned.status, 'supported');
  assert.equal(planned.intent.metrics.find(item => item.alias === 'revenue').aggregation, 'sum');
  assert.equal(planned.intent.metrics.find(item => item.alias === 'profit').aggregation, 'sum');
  assert.deepEqual(planned.intent.derivedMetrics.map(item => item.alias), ['average_order_value']);
});

test('泛化同比在多指标问题中进入对象澄清而非静默绑定', () => {
  const planned = plan('2023至2025年销售额、利润和同比增长率');
  assert.equal(planned.status, 'needs_clarification');
  assert.match(planned.clarification, /同比增长率.*计算对象/);
  assert.ok(planned.options.some(option => /销售额同比增长率/.test(option)));
});

test('WAX 编译器对四维分组生成单次 SUMMARIZECOLUMNS 查询', () => {
  const compiled = compileWaxQuery(metadata, {
    groupBy: ['订购日期', '客户地区', '客户省份', '客户城市'],
    measures: [{ alias: 'revenue', operation: 'sum', field: '订单金额' }],
    limit: 5000, orderBy: 'group1', order: 'ASC', filters: [],
  });
  assert.equal((compiled.wax.match(/SUMMARIZECOLUMNS/g) || []).length, 1);
  assert.match(compiled.wax, /group4/);
});
test('查询协议和 WAX 编译器支持 20000 行上限并生成总数统计查询', () => {
  const compiled = compileWaxQuery(metadata, {
    groupBy: ['订购日期', '客户地区'],
    measures: [{ alias: 'revenue', operation: 'sum', field: '订单金额' }],
    limit: 20000, orderBy: 'group1', order: 'ASC', filters: [],
  });
  assert.match(compiled.wax, /TOPN\(20000/);
  assert.match(compiled.countWax, /COUNTROWS\(SUMMARIZECOLUMNS/);
});

test('结果质量保留总行数、返回行数并提示超过上限', () => {
  const request = {
    id: 'qry-large-result', mode: 'aggregate', dataset: { id: metadata.id, revision: metadata.revision },
    select: [{ field: '客户地区', alias: 'region' }],
    measures: [{ field: '订单金额', alias: 'revenue', aggregation: 'sum' }],
    filters: [], resultFilters: [], fieldComparisons: [], orderBy: [], limit: 20000,
    expectedResult: { timeZone: 'Asia/Shanghai' },
  };
  const result = normalizeCanonicalResultSet({
    request,
    executionPlan: { id: 'xp-large', adapter: 'wyn-wax-controlled', adapterVersion: 'canonical-v1', warnings: [] },
    rawResult: { rows: [{ group1: '华东', revenue: 1 }], rowLimit: 20000, limitReached: true, totalRows: 25000, truncationConfidence: 'confirmed' },
    metadata,
  });
  assert.equal(result.statistics.totalRowCount, 25000);
  assert.equal(result.statistics.returnedRowCount, 1);
  assert.equal(result.quality.totalRowCount, 25000);
  assert.equal(result.quality.returnedRowCount, 1);
  assert.match(result.quality.warnings.at(-1), /总数据 25000 行.*实际返回 1 行/);
});

test('独立问数前端不再固定截断 30 行并提供分页复制控件', async () => {
  const [source, html, css] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(source, /rows\.slice\(0, 30\)/);
  assert.match(source, /SMART_TABLE_PAGE_SIZE = 100/);
  assert.match(source, /data-smart-table-copy/);
  assert.match(source, /data-smart-table-page/);
  assert.match(source, /navigator\.clipboard\?\.writeText/);
  assert.match(source, /copyTextWithLegacyApi\(text\)/);
  assert.match(source, /document\.execCommand\('copy'\)/);
  assert.match(source, /smart-table-scroll/);
  assert.match(source, /quality\.isTruncated === true \|\| quality\.limitReached === true/);
  assert.doesNotMatch(source, /hasKnownTotal && numericTotal > returnedRows/);
  assert.doesNotMatch(source, /总数据 \$\{totalLabel\}，实际返回/);
  assert.match(css, /\.smart-table-scroll\s*\{[^}]*height:\s*320px[^}]*overflow:\s*auto/);
  assert.match(css, /\.smart-table-range\s*\{[^}]*display:\s*none/);
  assert.match(html, /data-section="smart-query"[\s\S]*智能问数/);
  assert.doesNotMatch(html, /<span>独立问数<\/span>/);
});
