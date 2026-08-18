import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildReportExport, markdownToSafeHtml, renderReportHtml } from '../lib/report-export.mjs';

const run = {
  id: 'run-12345678',
  status: 'completed',
  createdAt: '2026-08-01T01:00:00.000Z',
  completedAt: '2026-08-01T01:01:00.000Z',
  analysis: {
    dataset: { id: 'sales', name: '销售数据' },
    profile: { rowCount: 10000, sampleRowCount: 5000 },
    validation: { queryMode: 'dataset-wax-controlled', evidenceCoverage: 100 },
    execution: { dataSource: 'wyn-dataset-api', waxQueryCount: 5, filters: [{ field: '地区', operator: 'eq', value: '华东' }] },
    kpis: [{ label: '销售额合计', value: '¥1,000', rawValue: 1000 }],
    charts: [
      { type: 'bar', title: '类别贡献', labels: ['饮料', '点心'], values: [600, 400] },
      { type: 'line', title: '月度趋势', labels: ['2026-01', '2026-02', '2026-03'], values: [300, 500, 400] },
      { type: 'bar', title: '空结果', labels: [], values: [] },
    ],
    insights: [{ category: '贡献', title: '饮料领先', statement: '贡献 60%。', confidence: 'high', evidenceIds: ['ev-category'] }],
    evidence: [{ id: 'ev-category', title: '类别贡献', method: 'WAX 聚合', rowCount: 10000, fields: ['类别', '销售额'] }],
    report: {
      title: '销售经营分析报告',
      model: 'test-model',
      aiNarrative: '## 管理摘要\n\n- **销售稳定** <script>alert(1)</script>',
    },
  },
};

test('Markdown 转换保留结构但转义不可信 HTML', () => {
  const html = markdownToSafeHtml('## 标题\n\n这是一段说明。\n\n- **结论** <img src=x onerror=alert(1)>');
  assert.match(html, /<h2>标题<\/h2>/);
  assert.match(html, /<p>这是一段说明。<\/p>/);
  assert.match(html, /<strong>结论<\/strong>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('独立 HTML 报告包含图表、证据与执行审计且不执行注入内容', () => {
  const html = renderReportHtml(run);
  assert.match(html, /Wyn 受控智能分析报告/);
  assert.match(html, /<svg/);
  assert.match(html, /<polyline/);
  assert.match(html, /ev-category/);
  assert.match(html, /WAX 聚合/);
  assert.match(html, /SQL<\/dt><dd>已禁用/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
});

test('报告可导出 HTML、Markdown 和 JSON 并拒绝未知格式', () => {
  const html = buildReportExport(run, 'html');
  const markdown = buildReportExport(run, 'markdown');
  const json = buildReportExport(run, 'json');
  assert.equal(html.contentType, 'text/html; charset=utf-8');
  assert.match(markdown.body, /运行编号：run-12345678/);
  assert.equal(JSON.parse(json.body).id, run.id);
  assert.throws(() => buildReportExport(run, 'pdf'), /仅支持/);
});

test('系统界面关键标签默认使用中文', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
  ]);
  for (const englishLabel of ['AI WORKSPACE', 'LIVE', 'AWAITING DATASET', 'READY FOR ANALYSIS', 'ANALYSIS HARNESS', 'EVIDENCE BASED']) {
    assert.doesNotMatch(html, new RegExp(englishLabel));
  }
  assert.match(html, /受控数据分析智能体/);
  assert.match(html, /证据支撑洞察/);
  assert.match(app, /Wyn 统计结果已就绪/);
  assert.doesNotMatch(html, /id="insight-toggle"/);
  assert.match(app, /includeInsight: false/);
  assert.match(app, /已验证指标/);
  assert.match(app, /statusLabel\(step\.status\)/);
  assert.match(app, /queryModeLabel\(queryMode\)/);
  assert.match(html, /id="agent-plan" tabindex="0"/);
  assert.match(css, /max-height: min\(440px,52vh\)/);
  assert.match(app, /elements\.agentPlan\.scrollTop = 0/);
});