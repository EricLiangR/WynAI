function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function safeFilename(value) { return String(value || 'data-insight-report').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80); }

function blockText(block) {
  if (block.type === 'warning') return block.message || block.content || '';
  if (block.type === 'kpi') return String(block.value ?? '--');
  if (block.type === 'table' || block.type === 'chart') return `Result reference: ${block.dataRef || 'unspecified'}`;
  return block.content || block.text || '';
}

export function buildInsightDocumentExport(documentValue, format = 'html', audit = {}) {
  const document = documentValue || {};
  const base = safeFilename(document.title);
  const scope = document.scope || {};
  const scopeText = `Datasets: ${Array.isArray(scope.datasets) ? scope.datasets.join(', ') : (scope.datasetId || 'unspecified')}; accuracy: ${scope.accuracy || 'unknown'}; ${scope.isTruncated ? 'result may be truncated' : 'result not marked truncated'}`;
  const markdown = [`# ${document.title || 'Data Insight Report'}`, '', `- ${scopeText}`, ''];
  for (const block of document.blocks || []) {
    if (block.title) markdown.push(`## ${block.title}`, '');
    markdown.push(block.type === 'warning' ? `> ${blockText(block)}` : blockText(block), '');
  }
  if (document.evidence?.length) {
    markdown.push('## Evidence', '');
    document.evidence.forEach(item => markdown.push(`- ${item.id || 'evidence'}: ${item.title || ''}${item.value != null ? ` (${item.value})` : ''}`));
  }
  if (document.nextQuestions?.length) {
    markdown.push('', '## Open Questions', '');
    document.nextQuestions.forEach(item => markdown.push(`- ${item}`));
  }
  if (format === 'markdown' || format === 'md') return { body: markdown.join('\n'), contentType: 'text/markdown; charset=utf-8', filename: `${base}.md` };
  if (format === 'json') return { body: `${JSON.stringify({ document, audit }, null, 2)}\n`, contentType: 'application/json; charset=utf-8', filename: `${base}.json` };
  if (format !== 'html') throw Object.assign(new Error('Insight report format supports html, markdown, or json'), { status: 400 });
  const blocks = (document.blocks || []).map(block => `<section class="block ${escapeHtml(block.type || '')}">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ''}<p>${escapeHtml(blockText(block))}</p></section>`).join('');
  const evidenceRows = (document.evidence || []).map(item => `<tr><td><code>${escapeHtml(item.id || '')}</code></td><td>${escapeHtml(item.title || '')}</td><td>${escapeHtml(item.value ?? '--')}</td></tr>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.title || 'Data Insight Report')}</title><style>body{margin:0;color:#26333a;background:#f6f8f8;font:14px/1.7 Arial,sans-serif}main{max-width:980px;margin:0 auto;padding:28px 18px}header{padding:22px 0;border-top:6px solid #1b8065;border-bottom:1px solid #d9e2e0}h1{margin:4px 0 8px;font-size:28px}h2{margin:18px 0 8px;font-size:17px}.scope{padding:12px 14px;margin:18px 0;background:#eef8f4;border-left:4px solid #1b8065}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.block{padding:14px;margin:10px 0;background:#fff;border:1px solid #dfe8e5;border-radius:6px}.block.kpi{display:inline-block;min-width:160px}.block.kpi p{font-size:22px;font-weight:700}.block.warning{border-left:4px solid #b87925;background:#fffaf0}.evidence{margin-top:24px;overflow:auto}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:8px;border:1px solid #dfe8e5;text-align:left}th{background:#edf3f1}@media(max-width:600px){main{padding:18px 12px}h1{font-size:23px}}</style></head><body><main><header><small>Wyn governed data insight</small><h1>${escapeHtml(document.title || 'Data Insight Report')}</h1></header><div class="scope">${escapeHtml(scopeText)}</div>${blocks}<section class="evidence"><h2>Evidence</h2><table><thead><tr><th>ID</th><th>Title</th><th>Value</th></tr></thead><tbody>${evidenceRows || '<tr><td colspan="3">No evidence</td></tr>'}</tbody></table></section><footer>Run: ${escapeHtml(audit.runId || '--')}; model: ${escapeHtml(audit.model || '--')}</footer></main></body></html>`;
  return { body: html, contentType: 'text/html; charset=utf-8', filename: `${base}.html` };
}
