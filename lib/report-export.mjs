const NUMBER_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function confidenceLabel(value) {
  return ({ high: '高', medium: '中', low: '低' })[String(value || 'medium').toLowerCase()] || '中';
}

function queryModeLabel(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('routed')) return '动态路由';
  if (raw.includes('wax')) return 'WAX 聚合';
  if (raw.includes('none') || raw.includes('detail')) return '数据集明细';
  if (raw.includes('sample')) return '样本分析';
  return '受控数据集查询';
}

function dataSourceLabel(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('wyn') && raw.includes('dataset')) return 'Wyn 数据集接口';
  return raw ? '受控数据接口' : 'Wyn 数据集接口';
}

function formatFilters(filters = []) {
  const operatorLabels = {
    eq: '等于',
    neq: '不等于',
    gt: '大于',
    gte: '大于等于',
    lt: '小于',
    lte: '小于等于',
    in: '属于',
    containsAny: '包含任一',
    containsAll: '同时包含全部',
    notContainsAny: '不包含任何',
    notContainsAll: '未同时包含全部',
  };
  return filters.length
    ? filters.map(item => {
      const separator = [
        'containsAny',
        'containsAll',
        'notContainsAny',
        'notContainsAll',
      ].includes(item.operator) ? '：' : ' ';
      const value = Array.isArray(item.value) ? item.value.join('、') : item.value;
      return `${item.field} ${operatorLabels[item.operator] || item.operator}${separator}${value}`;
    }).join('；')
    : '无';
}

function inlineMarkdown(value) {  return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export function markdownToSafeHtml(source = '') {
  const output = [];
  let list = null;
  const closeList = () => {
    if (!list) return;
    output.push(`</${list}>`);
    list = null;
  };
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      closeList();
      output.push(`<h2>${inlineMarkdown(heading[1])}</h2>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const nextList = ordered ? 'ol' : 'ul';
      if (list !== nextList) {
        closeList();
        list = nextList;
        output.push(`<${list}>`);
      }
      output.push(`<li>${inlineMarkdown((bullet || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  return output.join('\n');
}

function chartSvg(chart) {
  const labels = Array.isArray(chart?.labels) ? chart.labels.slice(0, 24) : [];
  const values = (Array.isArray(chart?.values) ? chart.values.slice(0, labels.length) : [])
    .map(value => Number(value));
  if (!labels.length || !values.some(Number.isFinite)) return '';
  const width = 920;
  const height = 300;
  const left = 68;
  const right = 24;
  const top = 30;
  const bottom = 58;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(...values.filter(Number.isFinite), 0) || 1;
  const safeLabels = labels.map(escapeHtml);
  let marks = '';

  if (chart.type === 'line') {
    const points = values.map((value, index) => {
      const x = left + (labels.length === 1 ? plotWidth / 2 : index / (labels.length - 1) * plotWidth);
      const y = top + plotHeight - Math.max(0, value || 0) / max * plotHeight;
      return { x, y, value };
    });
    marks += `<polyline fill="none" stroke="#17647d" stroke-width="3" points="${points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}"/>`;
    marks += points.map(point => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.5" fill="#1b9a73"/>`).join('');
    const labelStep = Math.max(1, Math.ceil(labels.length / 8));
    marks += points.map((point, index) => index % labelStep === 0 || index === labels.length - 1
      ? `<text x="${point.x.toFixed(1)}" y="${height - 24}" text-anchor="middle">${safeLabels[index]}</text>` : '').join('');
  } else {
    const gap = plotWidth / labels.length;
    const barWidth = Math.max(8, Math.min(54, gap * 0.62));
    marks += values.map((value, index) => {
      const barHeight = Math.max(0, value || 0) / max * plotHeight;
      const x = left + gap * index + (gap - barWidth) / 2;
      const y = top + plotHeight - barHeight;
      const label = safeLabels[index].length > 12 ? `${safeLabels[index].slice(0, 11)}…` : safeLabels[index];
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="${index === 0 ? '#1b9a73' : '#28758b'}"/><text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 24}" text-anchor="middle">${label}</text>`;
    }).join('');
  }
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(chart.title)}"><line x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}" stroke="#ccd2d4"/><text x="${left}" y="18" fill="#6f7679">最大值 ${escapeHtml(NUMBER_FORMAT.format(max))}</text>${marks}</svg>`;
}

function reportMarkdown(run) {
  const analysis = run.analysis || {};
  const narrative = analysis.report?.aiNarrative || analysis.report?.markdown || '';
  const filters = analysis.execution?.filters || [];
  return [
    `# ${analysis.report?.title || '智能数据分析报告'}`,
    '',
    `- 运行编号：${run.id}`,
    `- 数据集：${analysis.dataset?.name || run.dataset?.name || ''}`,
    `- 生成时间：${run.completedAt || run.createdAt || ''}`,
    `- 数据范围：${analysis.profile?.rowCount || 0} 行`,
    `- 质量样本：${analysis.profile?.sampleRowCount ?? analysis.profile?.rowCount ?? 0} 行${analysis.profile?.sourceLimitReached ? '（达到读取上限，可能仅代表当前返回范围）' : ''}`,
    `- 查询模式：${queryModeLabel(analysis.validation?.queryMode)}`,
    `- 过滤条件：${formatFilters(filters)}`,
    `- 证据覆盖：${analysis.validation?.evidenceCoverage ?? 0}%`,
    '',
    narrative,
    '',
    '## 审计说明',
    '',
    '- 数值由 Wyn 数据集查询与确定性分析程序计算，大模型仅参与证据约束下的文字组织。',
    '- 本报告不包含 Wyn 访问令牌、数据源连接信息或大模型密钥。',
  ].join('\n');
}

export function renderReportHtml(run) {
  if (!run?.analysis) throw new Error('分析运行尚未生成报告');
  const analysis = run.analysis;
  const narrative = analysis.report?.aiNarrative || analysis.report?.markdown || '';
  const generatedAt = new Date(run.completedAt || run.createdAt || Date.now()).toLocaleString('zh-CN');
  const filters = analysis.execution?.filters || [];
  const kpis = (analysis.kpis || []).map(item => `<div class="kpi"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong><small>已验证指标</small></div>`).join('');
  const charts = (analysis.charts || []).map(chart => `<section class="chart"><h2>${escapeHtml(chart.title)}</h2>${chartSvg(chart)}</section>`).join('');
  const insights = (analysis.insights || []).map(item => `<tr><td>${escapeHtml(item.category)}</td><td><strong>${escapeHtml(item.title)}</strong><br>${escapeHtml(item.statement)}</td><td>${escapeHtml(confidenceLabel(item.confidence))}</td><td>${escapeHtml((item.evidenceIds || []).join('、'))}</td></tr>`).join('');
  const evidence = (analysis.evidence || []).map(item => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.method)}</td><td>${escapeHtml(item.rowCount)}</td><td>${escapeHtml((item.fields || []).join('、'))}</td></tr>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(analysis.report?.title || '智能数据分析报告')}</title>
<style>
@page{size:A4;margin:16mm}*{box-sizing:border-box}body{margin:0;color:#273136;background:#fff;font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;font-size:12px;line-height:1.7}main{max-width:1080px;margin:0 auto}.cover{padding:34px 0 28px;border-top:7px solid #173f50;border-bottom:1px solid #dfe4e5}.cover small{color:#1b8065;font-weight:700}.cover h1{margin:12px 0 10px;font-size:30px;letter-spacing:0}.meta{display:flex;flex-wrap:wrap;gap:8px 24px;color:#6f777b}.scope{margin:20px 0;padding:14px 16px;border-left:4px solid #bf8732;background:#f7f8f8}.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin:20px 0}.kpi{min-height:92px;padding:14px;border:1px solid #dfe4e5}.kpi span,.kpi strong,.kpi small{display:block}.kpi span{color:#737b7e}.kpi strong{margin:10px 0 5px;font-size:18px}.kpi small{color:#1b8065;font-size:9px}.narrative{columns:2;column-gap:36px;margin:24px 0}.narrative h2{break-after:avoid;margin:18px 0 8px;font-size:16px}.narrative p,.narrative li{break-inside:avoid}.chart{break-inside:avoid;margin:24px 0}.chart h2{font-size:16px}.chart svg{width:100%;height:auto;border:1px solid #e0e4e5}.chart svg text{font-size:10px;fill:#666f73}.table-wrap{overflow-x:auto;margin:24px 0}table{width:100%;border-collapse:collapse}th,td{padding:9px;border:1px solid #dfe4e5;text-align:left;vertical-align:top}th{background:#f0f3f3;color:#445056}.audit{margin-top:28px;padding-top:18px;border-top:2px solid #263c46}.audit dl{display:grid;grid-template-columns:150px 1fr;margin:0}.audit dt,.audit dd{margin:0;padding:6px 0;border-bottom:1px solid #edf0f0}.audit dt{color:#727a7e}footer{margin-top:28px;padding:14px 0;border-top:1px solid #dfe4e5;color:#7c8386;font-size:10px}@media(max-width:760px){.kpis{grid-template-columns:repeat(2,1fr)}.narrative{columns:1}.audit dl{grid-template-columns:1fr}.audit dd{padding-top:0}}@media print{a{color:inherit}.chart,.table-wrap,.audit{page-break-inside:avoid}}
</style></head><body><main>
<header class="cover"><small>Wyn 受控智能分析报告</small><meta name="report-format" content="WYN GOVERNED INTELLIGENCE REPORT"><h1>${escapeHtml(analysis.report?.title || '智能数据分析报告')}</h1><div class="meta"><span>${escapeHtml(analysis.dataset?.name || '')}</span><span>${escapeHtml(generatedAt)}</span><span>运行 ${escapeHtml(run.id)}</span><span>${escapeHtml(analysis.report?.model || '确定性分析引擎')}</span></div></header>
<section class="scope"><strong>分析范围</strong>　完整数据 ${escapeHtml(analysis.profile?.rowCount || 0)} 行；质量样本 ${escapeHtml(analysis.profile?.sampleRowCount ?? analysis.profile?.rowCount ?? 0)} 行${analysis.profile?.sourceLimitReached ? '（达到读取上限，可能仅代表当前返回范围）' : ''}；证据覆盖 ${escapeHtml(analysis.validation?.evidenceCoverage ?? 0)}%；筛选：${escapeHtml(formatFilters(filters))}</section>
<section class="kpis">${kpis}</section>
<article class="narrative">${markdownToSafeHtml(narrative)}</article>
${charts}
<section class="table-wrap"><h2>关键洞察与证据引用</h2><table><thead><tr><th>类型</th><th>结论</th><th>置信度</th><th>证据</th></tr></thead><tbody>${insights}</tbody></table></section>
<section class="table-wrap"><h2>证据清单</h2><table><thead><tr><th>ID</th><th>证据</th><th>计算方法</th><th>范围</th><th>字段</th></tr></thead><tbody>${evidence}</tbody></table></section>
<section class="audit"><h2>执行与审计</h2><dl><dt>查询模式</dt><dd>${escapeHtml(queryModeLabel(analysis.validation?.queryMode))}</dd><dt>数据来源</dt><dd>${escapeHtml(dataSourceLabel(analysis.execution?.dataSource))}</dd><dt>WAX 查询</dt><dd>${escapeHtml(analysis.execution?.waxQueryCount ?? 0)} 个白名单计划</dd><dt>SQL</dt><dd>已禁用</dd><dt>大模型</dt><dd>${escapeHtml(analysis.report?.model || '')}</dd></dl></section>
<footer>数据计算由 Wyn 与确定性分析程序完成。AI 结论需结合业务情境复核。本文件不包含访问令牌或密钥。</footer>
</main></body></html>`;
}

function safeFilename(value) {
  return String(value || '智能数据分析报告').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80);
}

export function buildReportExport(run, format = 'html') {
  if (!run?.analysis) throw new Error('分析运行尚未生成报告');
  const base = safeFilename(run.analysis.report?.title);
  if (format === 'html') return { body: renderReportHtml(run), contentType: 'text/html; charset=utf-8', filename: `${base}.html` };
  if (format === 'markdown' || format === 'md') return { body: reportMarkdown(run), contentType: 'text/markdown; charset=utf-8', filename: `${base}.md` };
  if (format === 'json') return { body: `${JSON.stringify(run, null, 2)}\n`, contentType: 'application/json; charset=utf-8', filename: `${base}.json` };
  const error = new Error('报告格式仅支持 html、markdown 或 json');
  error.status = 400;
  throw error;
}
