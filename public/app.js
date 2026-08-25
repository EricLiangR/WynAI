const elements = {
  appShell: document.querySelector('.app-shell'),
  sidebarToggle: document.querySelector('#sidebar-toggle'),
  messages: document.querySelector('#messages'),
  welcome: document.querySelector('#welcome-card'),
  input: document.querySelector('#question-input'),
  send: document.querySelector('#send-button'),
  dataset: document.querySelector('#dataset-select'),
  suggestions: [...document.querySelectorAll('[data-prompt]')],
  connectionPill: document.querySelector('#connection-pill'),
  connectionText: document.querySelector('#connection-text'),
  clear: document.querySelector('#clear-chat'),
  userTemplate: document.querySelector('#user-message-template'),
  assistantTemplate: document.querySelector('#assistant-message-template'),
  flow: [...document.querySelectorAll('.flow-item')],
  navItems: [...document.querySelectorAll('.nav-item[data-section]')],
  chatWorkspace: document.querySelector('#chat-workspace'),
  insightsWorkspace: document.querySelector('#insights-workspace'),
  agentWorkspace: document.querySelector('#agent-workspace'),
  agentWorkspaceKicker: document.querySelector('#agent-workspace-kicker'),
  agentWorkspaceTitle: document.querySelector('#agent-workspace-title'),
  agentWorkspaceDescription: document.querySelector('#agent-workspace-description'),
  reportsWorkspace: document.querySelector('#reports-workspace'),
  workspaceTitle: document.querySelector('#workspace-title'),
  resultList: document.querySelector('#analysis-result-list'),
  resultCount: document.querySelector('#result-count'),
  insightEmpty: document.querySelector('#insight-empty'),
  insightDetail: document.querySelector('#insight-detail'),
  modelStatus: document.querySelector('#model-status'),
  refreshResults: document.querySelector('#refresh-results'),
  backToChat: document.querySelector('#back-to-chat'),
  secondaryPrompt: document.querySelector('#secondary-prompt'),
  generateInsight: document.querySelector('#generate-insight'),
  secondaryOutput: document.querySelector('#secondary-output'),
  outputContent: document.querySelector('#output-content'),
  findingGrid: document.querySelector('#finding-grid'),
  agentDataset: document.querySelector('#agent-dataset-select'),
  agentGoal: document.querySelector('#agent-goal'),
  agentRunButton: document.querySelector('#agent-run-button'),
  agentEmpty: document.querySelector('#agent-empty'),
  agentRunDetail: document.querySelector('#agent-run-detail'),
  agentPlan: document.querySelector('#agent-plan'),
  agentKpis: document.querySelector('#agent-kpis'),
  agentChartGrid: document.querySelector('#agent-chart-grid'),
  agentFindings: document.querySelector('#agent-findings'),
  agentEvidenceBody: document.querySelector('#agent-evidence-body'),
  agentReportContent: document.querySelector('#agent-report-content'),
  agentPrintReport: document.querySelector('#agent-print-report'),
  agentExportFormat: document.querySelector('#agent-export-format'),
  agentExportReport: document.querySelector('#agent-export-report'),
  agentFilterField: document.querySelector('#agent-filter-field'),
  agentFilterOperator: document.querySelector('#agent-filter-operator'),
  agentFilterValue: document.querySelector('#agent-filter-value'),
  agentAddFilter: document.querySelector('#agent-add-filter'),
  agentFilterList: document.querySelector('#agent-filter-list'),
  agentRunHistory: document.querySelector('#agent-run-history'),
  agentHistoryOpen: document.querySelector('#agent-history-open'),
  agentHistoryRefresh: document.querySelector('#agent-history-refresh'),
  semanticStatus: document.querySelector('#semantic-status'),
  smartDataset: document.querySelector('#smart-dataset-select'),
  smartQuestion: document.querySelector('#smart-question'),
  smartAsk: document.querySelector('#smart-ask-button'),
  smartStatus: document.querySelector('#smart-query-status'),
  smartOutput: document.querySelector('#smart-query-output'),
  smartScope: document.querySelector('#smart-query-scope'),
  smartMessages: document.querySelector('#smart-query-messages'),
  smartNewConversation: document.querySelector('#smart-new-conversation'),
  smartTurnCount: document.querySelector('#smart-turn-count'),
  smartContextMetrics: document.querySelector('#smart-context-metrics'),
  smartContextDimensions: document.querySelector('#smart-context-dimensions'),
  smartContextFilters: document.querySelector('#smart-context-filters'),
  smartContextSkills: document.querySelector('#smart-context-skills'),
  reportTemplateFile: document.querySelector('#report-template-file'),
  reportUpload: document.querySelector('#report-upload'),
  reportTemplateSelect: document.querySelector('#report-template-select'),
  reportBlockSelect: document.querySelector('#report-block-select'),
  reportBusinessQuestion: document.querySelector('#report-business-question'),
  reportBlockType: document.querySelector('#report-block-type'),
  reportPropose: document.querySelector('#report-propose'),
  reportStatus: document.querySelector('#report-status'),
  reportTemplateTitle: document.querySelector('#report-template-title'),
  reportTemplateMeta: document.querySelector('#report-template-meta'),
  reportBlockPreview: document.querySelector('#report-block-preview'),
  reportRunStatus: document.querySelector('#report-run-status'),
  reportRunOutput: document.querySelector('#report-run-output'),
  reportContentEditor: document.querySelector('#report-content-editor'),
  reportContentStatus: document.querySelector('#report-content-status'),
  reportContentText: document.querySelector('#report-content-text'),
  reportContentMessage: document.querySelector('#report-content-message'),
  reportContentDiscuss: document.querySelector('#report-content-discuss'),
  reportContentConfirm: document.querySelector('#report-content-confirm'),
  reportDownload: document.querySelector('#report-download'),
};

const state = {
  sidebarCollapsed: false,
  sending: false,
  datasets: [],
  conversationStarted: false,
  viewProxyPort: Number(location.port || 8787) + 1,
  currentSection: 'chat',
  analysisResults: [],
  activeResult: null,
  lastViewId: '',
  llmConfigured: false,
  agentMetadata: null,
  agentRun: null,
  agentCharts: [],
  agentFilters: [],
  agentRuns: [],
  agentEngineLabel: 'Atlas 确定性分析引擎',
  smartConversationId: null,
  smartTurns: 0,
  smartAbortController: null,
  smartCharts: [],
  reportTemplates: [],
  reportTemplate: null,
  reportProposal: null,
  reportRun: null,
  reportContentBlockId: null,
};

const SIDEBAR_STORAGE_KEY = 'wynai.sidebarCollapsed';

function setSidebarCollapsed(collapsed, persist = true) {
  state.sidebarCollapsed = Boolean(collapsed);
  elements.appShell.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  elements.sidebarToggle.setAttribute('aria-expanded', String(!state.sidebarCollapsed));
  const action = state.sidebarCollapsed ? '展开左侧菜单' : '折叠左侧菜单';
  elements.sidebarToggle.setAttribute('aria-label', action);
  elements.sidebarToggle.title = action;
  if (persist) {
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(state.sidebarCollapsed)); } catch {}
  }
}

function initializeSidebar() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true'; } catch {}
  setSidebarCollapsed(collapsed, false);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function inlineMarkdown(value) {
  return value
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function markdownTableCells(line) {
  const cells = line.split('|').map(cell => cell.trim());
  if (!cells[0]) cells.shift();
  if (!cells.at(-1)) cells.pop();
  return cells;
}

function markdown(text) {
  const safe = escapeHtml(text).trim();
  if (!safe) return '<p>分析已完成，但接口未返回可展示的文本。</p>';
  const lines = safe.split(/\r?\n/);
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }

    if (line.startsWith('```')) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) code.push(lines[index++]);
      index += 1;
      output.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length <= 2 ? 3 : 4;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^[-*_]{3,}$/.test(line)) {
      output.push('<hr>');
      index += 1;
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      const headers = markdownTableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(markdownTableCells(lines[index]));
        index += 1;
      }
      output.push(`<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>${headers.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    if (/^[-*•]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*•]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*•]\s+/, ''));
        index += 1;
      }
      output.push(`<ul>${items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+[.)]\s+/, ''));
        index += 1;
      }
      output.push(`<ol>${items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ol>`);
      continue;
    }

    if (/^&gt;\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^&gt;\s?/.test(lines[index].trim())) {
        quote.push(lines[index].trim().replace(/^&gt;\s?/, ''));
        index += 1;
      }
      output.push(`<blockquote>${inlineMarkdown(quote.join('<br>'))}</blockquote>`);
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s|^```|^[-*•]\s+|^\d+[.)]\s+|^&gt;\s?|^[-*_]{3,}$/.test(lines[index].trim())) {
      if (lines[index].includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) break;
      paragraph.push(lines[index].trim());
      index += 1;
    }
    output.push(`<p>${inlineMarkdown(paragraph.join('<br>'))}</p>`);
  }
  return output.join('');
}

function switchSection(section) {
  const requestedSection = section;
  state.currentSection = requestedSection;
  const isChat = section === 'chat';
  const isInsights = section === 'insights';
  const isSmartQuery = section === 'smart-query';
  const isAnalysis = section === 'analysis';
  const isReports = section === 'reports';
  const showAgentWorkspace = isSmartQuery || isAnalysis;
  elements.chatWorkspace.hidden = !isChat;
  elements.insightsWorkspace.hidden = !isInsights;
  elements.agentWorkspace.hidden = !showAgentWorkspace;
  elements.reportsWorkspace.hidden = !isReports;
  elements.agentWorkspace.classList.toggle('smart-query-mode', isSmartQuery);
  elements.agentWorkspace.classList.toggle('analysis-mode', isAnalysis);
  elements.workspaceTitle.textContent = isChat ? 'Wyn 问数' : isInsights ? '数据洞察' : isReports ? '智能报告' : isSmartQuery ? '独立问数' : 'AI 数据分析';
  elements.clear.hidden = !(isChat || isSmartQuery);
  elements.navItems.forEach(item => item.classList.toggle('active', item.dataset.section === requestedSection));
  if (isChat) elements.input.focus();
  else if (isInsights) loadAnalysisResults();
  else if (isReports) loadReportTemplates();
  else if (isSmartQuery) {
    elements.agentWorkspaceKicker.textContent = '自建问数查询内核';
    elements.agentWorkspaceTitle.textContent = '独立智能问数';
    elements.agentWorkspaceDescription.textContent = '不调用 Wyn AI 问数接口。基于 Wyn 数据集语义直接生成受控查询，支持多轮追问和组合式结果页面。';
    document.querySelector('#agent-engine-model').textContent = '受控语义解析 + Wyn 数据查询';
    elements.agentEmpty.hidden = true;
    elements.smartQuestion.focus();
  }
  else if (isAnalysis) {
    elements.agentWorkspaceKicker.textContent = '受控数据分析智能体';
    elements.agentWorkspaceTitle.textContent = 'AI 数据分析';
    elements.agentWorkspaceDescription.textContent = '只需选择 Wyn 数据集，智能体会自主提出问题、动态选择查询方式、验证证据并生成管理报告。';
    document.querySelector('#agent-engine-model').textContent = state.agentEngineLabel;
    elements.agentEmpty.hidden = false;
    if (elements.agentDataset.value && !state.agentMetadata) loadAgentMetadata(elements.agentDataset.value);
  }
}

function formatDate(value) {
  if (!value) return '刚刚';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '刚刚' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

const displayStatusLabels = {
  completed: '已完成',
  done: '已完成',
  partial: '部分完成',
  running: '执行中',
  pending: '等待执行',
  skipped: '已跳过',
  failed: '失败',
  inconclusive: '结论不足',
  supported: '证据支持',
};

function statusLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '未知状态';
  if (/[一-鿿]/.test(raw)) return raw;
  return displayStatusLabels[raw.toLowerCase()] || '执行中';
}

function confidenceLabel(value) {
  const labels = { high: '高', medium: '中', low: '低' };
  const raw = String(value || 'medium').trim();
  return labels[raw.toLowerCase()] || (/[一-鿿]/.test(raw) ? raw : '中');
}

function plannerModeLabel(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('ai-guided-planner')) return 'AI 引导规划';
  if (raw.includes('ai-planner')) return 'AI 自主规划';
  if (raw.includes('deterministic-fallback')) return '确定性备用规划';
  if (raw.includes('deterministic')) return '确定性规划';
  return raw ? '智能规划' : '';
}

function queryModeLabel(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('routed')) return '动态路由';
  if (raw.includes('wax')) return 'WAX 聚合';
  if (raw.includes('none') || raw.includes('detail')) return '数据集明细';
  if (raw.includes('sample')) return '样本分析';
  return '受控查询';
}

function chartTypeLabel(value) {
  const raw = String(value || '').trim();
  const normalized = raw.toLowerCase().replaceAll('_', '-');
  const labels = {
    'kpicard': '指标卡',
    'kpi-card': '指标卡',
    'echarts-line': '折线图',
    'line': '折线图',
    'echarts-bar': '柱状图',
    'bar': '柱状图',
    'echarts-pie': '饼图',
    'pie': '饼图',
    'echarts-combined': '组合图',
    'combined': '组合图',
    'table': '明细表',
    'wyn-data': 'Wyn 数据结果',
    'auto': '自动图表',
  };
  return labels[normalized] || (/[一-鿿]/.test(raw) ? raw : '分析图表');
}

function localizePlanDetail(value) {
  return String(value || '')
    .replaceAll('ai-guided-planner', 'AI 引导规划')
    .replaceAll('ai-planner', 'AI 自主规划')
    .replaceAll('ai-critic', 'AI 评审')
    .replaceAll('deterministic-fallback', '确定性备用规划')
    .replace(/\bprofitability\b/gi, '盈利能力')
    .replace(/\bsupported\b/gi, '证据支持')
    .replace(/\binconclusive\b/gi, '结论不足')
    .replace(/(^|\s·\s)open(?=\s·\s|$)/gi, '$1开放探索');
}

function compactValue(value) {
  if (value == null || value === '') return '<span class="null-value">空值</span>';
  if (typeof value === 'number') return escapeHtml(new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value));
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return escapeHtml(value.slice(0, 10));
  if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
  return escapeHtml(String(value));
}

function renderResultList() {
  elements.resultCount.textContent = state.analysisResults.length;
  if (!state.analysisResults.length) {
    elements.resultList.innerHTML = '<div class="result-list-empty">尚未捕获结果集。<br>请先完成一次智能问数并等待图表加载。</div>';
    return;
  }
  elements.resultList.innerHTML = state.analysisResults.map(item => `
    <button class="result-item ${state.activeResult?.viewId === item.viewId ? 'active' : ''}" type="button" data-result-id="${escapeHtml(item.viewId)}">
      <span class="result-item-top"><span class="result-type">${escapeHtml(chartTypeLabel(item.chartType))}</span><time>${formatDate(item.capturedAt)}</time></span>
      <strong>${escapeHtml(item.topic || item.queryName || 'Wyn 分析结果')}</strong>
      <span class="result-item-meta"><span>${item.rowCount} 行</span><span>${item.columnCount} 字段</span><span>${item.completeness}% 完整</span></span>
    </button>`).join('');
}

function renderResultDetail(result) {
  state.activeResult = result;
  const resultIndex = state.analysisResults.findIndex(item => item.viewId === result.viewId);
  if (resultIndex >= 0) {
    state.analysisResults[resultIndex] = {
      ...state.analysisResults[resultIndex],
      rowCount: result.rowCount,
      columnCount: result.columnCount,
      completeness: result.completeness,
      columns: result.columns,
      source: result.source,
    };
  }
  elements.insightEmpty.hidden = true;
  elements.insightDetail.hidden = false;
  document.querySelector('#insight-view-id').textContent = result.viewId.slice(0, 12);
  document.querySelector('#insight-topic').textContent = result.topic || result.queryName || 'Wyn 分析结果';
  document.querySelector('#stat-rows').textContent = result.rowCount;
  document.querySelector('#stat-columns').textContent = result.columnCount;
  document.querySelector('#stat-completeness').textContent = `${result.completeness}%`;
  document.querySelector('#stat-model').textContent = state.llmConfigured ? '外部大模型' : '内置引擎';
  const columns = (result.columns || []).slice(0, 12);
  const rows = (result.rows || []).slice(0, 40);
  document.querySelector('#preview-range').textContent = `前 ${rows.length} 行${result.truncated ? ' · 已截断' : ''}`;
  document.querySelector('#insight-table-head').innerHTML = `<tr><th>#</th>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr>`;
  document.querySelector('#insight-table-body').innerHTML = rows.length
    ? rows.map((row, index) => `<tr><td>${index + 1}</td>${columns.map(column => `<td title="${escapeHtml(typeof row[column] === 'object' ? JSON.stringify(row[column]) : String(row[column] ?? ''))}">${compactValue(row[column])}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length + 1}"><span class="null-value">结果集没有有效数据行</span></td></tr>`;
  document.querySelector('#raw-data').textContent = JSON.stringify(result.rows || [], null, 2);
  document.querySelector('#table-quality-note').textContent = result.completeness >= 80
    ? `✓ 数据完整度 ${result.completeness}%，可进入二次分析`
    : `⚠ 数据完整度 ${result.completeness}%，洞察将优先提示质量风险`;
  elements.secondaryOutput.hidden = true;
  renderResultList();
}

async function selectAnalysisResult(viewId) {
  const response = await fetch(`/api/analysis-results/${encodeURIComponent(viewId)}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '结果集加载失败');
  renderResultDetail(result);
}

async function loadAnalysisResults(preferredViewId = '') {
  try {
    const response = await fetch('/api/analysis-results');
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '结果列表加载失败');
    state.analysisResults = data.items || [];
    state.llmConfigured = Boolean(data.llmConfigured);
    elements.modelStatus.querySelector('span').textContent = state.llmConfigured ? '外部大模型已连接' : '内置洞察引擎';
    renderResultList();
    const targetId = preferredViewId || state.activeResult?.viewId || state.analysisResults[0]?.viewId;
    if (targetId && state.analysisResults.some(item => item.viewId === targetId)) await selectAnalysisResult(targetId);
    else if (!state.analysisResults.length) {
      state.activeResult = null;
      elements.insightEmpty.hidden = false;
      elements.insightDetail.hidden = true;
    }
  } catch (error) {
    elements.resultList.innerHTML = `<div class="result-list-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function openInsightsForView(viewId) {
  switchSection('insights');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await loadAnalysisResults(viewId);
    const captured = state.analysisResults.find(item => item.viewId === viewId);
    if (captured?.rowCount > 0) return;
    await new Promise(resolve => setTimeout(resolve, 800));
  }
}

async function generateSecondaryInsight() {
  if (!state.activeResult || elements.generateInsight.disabled) return;
  elements.generateInsight.disabled = true;
  elements.generateInsight.querySelector('span').textContent = '洞察中';
  elements.secondaryOutput.hidden = false;
  elements.findingGrid.innerHTML = '';
  elements.outputContent.innerHTML = '<div class="insight-loading"><i></i><i></i><i></i><span>正在读取结构化结果并生成二次洞察</span></div>';
  elements.secondaryOutput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const response = await fetch('/api/secondary-insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewId: state.activeResult.viewId, prompt: elements.secondaryPrompt.value.trim() }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '二次洞察失败');
    document.querySelector('#output-model').textContent = data.model || 'AI 洞察引擎';
    elements.findingGrid.innerHTML = (data.findings || []).map(item => `
      <div class="finding-card ${escapeHtml(item.tone || 'violet')}"><small>${escapeHtml(item.label)}</small><strong>${escapeHtml(item.value)}</strong><span>${escapeHtml(item.detail)}</span></div>`).join('');
    elements.outputContent.innerHTML = markdown(data.content || '洞察已完成。');
  } catch (error) {
    elements.outputContent.innerHTML = `<div class="error-box"><strong>暂未完成二次洞察</strong><br>${escapeHtml(error.message)}</div>`;
  } finally {
    elements.generateInsight.disabled = false;
    elements.generateInsight.querySelector('span').textContent = '开始洞察';
  }
}

function findReadableText(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => findReadableText(item, depth + 1)).filter(Boolean).join('');
  if (typeof value !== 'object') return '';

  const preferred = ['insight', 'answer', 'content', 'message', 'text', 'description', 'summary', 'result', 'data'];
  for (const key of preferred) {
    if (value[key] != null) {
      const result = findReadableText(value[key], depth + 1);
      if (result && !/^\[object Object\]$/.test(result)) return result;
    }
  }
  return '';
}

function collectMetrics(value, found = [], depth = 0) {
  if (depth > 5 || value == null || found.length >= 6) return found;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 12)) collectMetrics(item, found, depth + 1);
    return found;
  }
  if (typeof value !== 'object') return found;

  const label = value.label ?? value.name ?? value.title ?? value.field ?? value.measure;
  const metricValue = value.value ?? value.formattedValue ?? value.displayValue;
  if (label && (typeof metricValue === 'string' || typeof metricValue === 'number')) {
    found.push({ label: String(label), value: String(metricValue) });
  }
  for (const child of Object.values(value)) collectMetrics(child, found, depth + 1);
  return found;
}

function extractViewId(value) {
  const candidates = [];
  const visit = (item, depth = 0) => {
    if (depth > 6 || item == null) return;
    if (typeof item === 'string') {
      candidates.push(item);
      try { visit(JSON.parse(item), depth + 1); } catch { /* plain stream chunk */ }
      return;
    }
    if (Array.isArray(item)) return item.forEach(child => visit(child, depth + 1));
    if (typeof item === 'object') {
      if (item.url) candidates.push(String(item.url));
      Object.values(item).forEach(child => visit(child, depth + 1));
    }
  };
  visit(value);
  for (const candidate of candidates) {
    const match = candidate.match(/[?&]viewId=([a-zA-Z0-9-]+)/);
    if (match) return match[1];
  }
  return '';
}

function renderView(view, viewId) {
  const chart = view.chart || {};
  const query = chart.query || {};
  const viewProxyOrigin = `${location.protocol}//${location.hostname}:${state.viewProxyPort}`;
  // Wyn 前端需要检测到 token 参数才会进入分析视图；代理会把此占位值替换为服务端真实 Token。
  const viewUrl = `${viewProxyOrigin}/dashboards/chatanalysis/view?viewId=${encodeURIComponent(viewId)}&token=proxy`;
  return `
    <div class="view-result">
      <div class="view-result-head">
        <span class="success-mark">✓</span>
        <div><h3>${escapeHtml(query.name || '统计图表已生成')}</h3></div>
        <button class="open-insights-link" type="button" data-action="open-insights" data-view-id="${escapeHtml(viewId)}">进入数据洞察 →</button>
      </div>
      <div class="wyn-frame-wrap">
        <div class="frame-loading"><i></i><i></i><i></i><span>Wyn 正在计算并生成统计图表</span></div>
        <iframe class="wyn-view-frame" src="${escapeHtml(viewUrl)}" title="Wyn AI 统计图表" loading="eager"></iframe>
      </div>
    </div>`;
}

function renderResponse(payload, fallbackText = '') {
  const text = findReadableText(payload) || fallbackText;
  const metrics = collectMetrics(payload);
  const metricHtml = metrics.length
    ? `<div class="result-card">${metrics.map(item => `<div class="metric"><small>${escapeHtml(item.label)}</small><strong>${escapeHtml(item.value)}</strong></div>`).join('')}</div>`
    : '';
  return `${metricHtml}${markdown(text || JSON.stringify(payload, null, 2))}`;
}

function addUserMessage(text) {
  const fragment = elements.userTemplate.content.cloneNode(true);
  fragment.querySelector('.user-bubble').textContent = text;
  elements.messages.append(fragment);
}

function addAssistantMessage() {
  const fragment = elements.assistantTemplate.content.cloneNode(true);
  const row = fragment.querySelector('.assistant-row');
  elements.messages.append(fragment);
  return elements.messages.querySelector('.assistant-row:last-child') || row;
}

function scrollToBottom() {
  requestAnimationFrame(() => elements.messages.scrollTo({ top: elements.messages.scrollHeight, behavior: 'smooth' }));
}

function setFlow(step) {
  elements.flow.forEach((item, index) => {
    item.classList.toggle('active', index === step);
    item.classList.toggle('done', index < step);
  });
}

function setSending(sending) {
  state.sending = sending;
  elements.send.disabled = sending || !state.datasets.length;
  elements.dataset.disabled = sending || !state.datasets.length;
  elements.suggestions.forEach(button => { button.disabled = sending || !state.datasets.length; });
  elements.send.querySelector('span').textContent = sending ? '分析中' : '发送';
}

function showConversation() {
  if (!state.conversationStarted) {
    state.conversationStarted = true;
    elements.welcome.hidden = true;
  }
}

function resetConversation() {
  state.conversationStarted = false;
  [...elements.messages.children].forEach(child => {
    if (child !== elements.welcome) child.remove();
  });
  elements.welcome.hidden = false;
  elements.input.value = '';
  resizeTextarea();
  setFlow(0);
  elements.input.focus();
}

function resizeTextarea() {
  elements.input.style.height = 'auto';
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 120)}px`;
}

function shortFieldList(values) {
  const fields = Array.isArray(values) ? values : [];
  return fields.length ? fields.join('、') : '—';
}

const filterOperatorLabels = {
  eq: '等于',
  neq: '不等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
};

function renderAgentFilters() {
  document.querySelector('#agent-filter-count').textContent = state.agentFilters.length
    ? `${state.agentFilters.length} 个条件`
    : '全部数据';
  elements.agentFilterList.innerHTML = state.agentFilters.length
    ? state.agentFilters.map((item, index) => `
      <span class="agent-filter-chip">
        <span>${escapeHtml(item.field)} ${escapeHtml(filterOperatorLabels[item.operator] || item.operator)} ${escapeHtml(item.value)}</span>
        <button type="button" data-remove-filter="${index}" title="移除筛选" aria-label="移除筛选">×</button>
      </span>`).join('')
    : '<span>未设置筛选条件</span>';
}

function updateFilterOperators() {
  const field = state.agentMetadata?.fields?.find(item => item.name === elements.agentFilterField.value);
  const comparative = field && ['measure', 'time'].includes(field.role);
  const operators = comparative
    ? ['eq', 'neq', 'gte', 'lte', 'gt', 'lt']
    : ['eq', 'neq'];
  elements.agentFilterOperator.innerHTML = operators
    .map(operator => `<option value="${operator}">${filterOperatorLabels[operator]}</option>`)
    .join('');
  elements.agentFilterValue.placeholder = field?.role === 'time' ? 'YYYY-MM-DD' : '筛选值';
}

function populateAgentFilterFields(metadata) {
  elements.agentFilterField.innerHTML = [
    '<option value="">选择字段</option>',
    ...(metadata.fields || [])
      .filter(field => ['dimension', 'geography', 'measure', 'time'].includes(field.role))
      .map(field => `<option value="${escapeHtml(field.name)}">${escapeHtml(field.name)}</option>`),
  ].join('');
  updateFilterOperators();
}

function addAgentFilter() {
  const field = elements.agentFilterField.value;
  const operator = elements.agentFilterOperator.value;
  const value = elements.agentFilterValue.value.trim();
  if (!field || !operator || !value || state.agentFilters.length >= 8) {
    elements.agentFilterValue.focus();
    return;
  }
  state.agentFilters.push({ field, operator, value });
  elements.agentFilterValue.value = '';
  renderAgentFilters();
}

function renderSemanticMetadata(metadata) {
  state.agentMetadata = metadata;
  elements.semanticStatus.classList.remove('error');
  elements.semanticStatus.innerHTML = `
    <span class="semantic-pulse"></span>
    <div><strong>语义定义已加载</strong><small>版本 ${escapeHtml(String(metadata.revision ?? '—'))} · AI 描述 ${metadata.assistant?.describedFieldCount || 0} 项</small></div>`;
  document.querySelector('#semantic-field-count').textContent = `${metadata.fieldCount || 0} 字段`;
  document.querySelector('#semantic-description').textContent = metadata.description || '未配置数据集业务描述';
  document.querySelector('#semantic-measures').textContent = shortFieldList(metadata.roles?.measure);
  document.querySelector('#semantic-dimensions').textContent = shortFieldList([...(metadata.roles?.dimension || []), ...(metadata.roles?.geography || [])]);
  document.querySelector('#semantic-times').textContent = shortFieldList(metadata.roles?.time);
  document.querySelector('#semantic-described').textContent = String(metadata.assistant?.describedFieldCount || 0);
  populateAgentFilterFields(metadata);
}

async function loadAgentMetadata(datasetId) {
  if (!datasetId) return;
  state.agentMetadata = null;
  elements.semanticStatus.classList.remove('error');
  elements.semanticStatus.innerHTML = '<span class="semantic-pulse"></span><div><strong>正在读取语义定义</strong><small>字段、类型、描述与 AI 配置</small></div>';
  try {
    const response = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/metadata`);
    const metadata = await response.json();
    if (!response.ok) throw new Error(metadata.message || '数据集语义读取失败');
    if (elements.agentDataset.value !== datasetId) return;
    renderSemanticMetadata(metadata);
  } catch (error) {
    elements.semanticStatus.classList.add('error');
    elements.semanticStatus.innerHTML = `<span class="semantic-pulse"></span><div><strong>语义定义读取失败</strong><small>${escapeHtml(error.message)}</small></div>`;
  }
}

function disposeAgentCharts() {
  for (const chart of state.agentCharts) chart.dispose();
  state.agentCharts = [];
}

function chartOption(spec) {
  const palette = ['#1d718d', '#1ca579', '#bd852e', '#6b5bc0', '#c55f69', '#527780'];
  const common = {
    animationDuration: 500,
    color: palette,
    title: { text: spec.title, left: 20, top: 16, textStyle: { color: '#26363d', fontSize: 15, fontWeight: 600 } },
    tooltip: { trigger: 'axis', textStyle: { fontSize: 12 }, valueFormatter: value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) },
    grid: { left: 72, right: 28, top: 66, bottom: 62 },
    xAxis: { type: 'category', data: spec.labels, axisLine: { lineStyle: { color: '#ccd3d6' } }, axisTick: { show: false }, axisLabel: { color: '#777f84', fontSize: 11, margin: 12, rotate: spec.labels.some(label => String(label).length > 7) ? 24 : 0 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#edf0f1' } }, axisLabel: { color: '#858c91', fontSize: 11, margin: 10 } },
  };
  const inputSeries = Array.isArray(spec.series) && spec.series.length
    ? spec.series
    : [{ name: spec.yField || spec.title, values: spec.values || [] }];
  if (inputSeries.length > 1) common.legend = { top: 42, right: 28, textStyle: { color: '#667177', fontSize: 11 } };
  if (spec.type === 'line') {
    return { ...common, series: inputSeries.map(item => ({ name: item.name, type: 'line', data: item.values, smooth: false, symbolSize: 6, lineStyle: { width: 3 }, areaStyle: { opacity: .05 } })) };
  }
  return { ...common, series: inputSeries.map(item => ({ name: item.name, type: 'bar', data: item.values, barMaxWidth: 34, itemStyle: { borderRadius: [3, 3, 0, 0] } })) };
}

function renderAgentCharts(charts) {
  disposeAgentCharts();
  elements.agentChartGrid.innerHTML = charts.length
    ? charts.map((chart, index) => `<div class="agent-chart-panel ${charts.length % 2 && index === 0 ? 'wide' : ''}" data-chart-id="${escapeHtml(chart.id)}"></div>`).join('')
    : '<div class="result-list-empty">当前数据没有形成可展示的趋势或分组图表。</div>';
  if (!globalThis.echarts) return;
  for (const spec of charts) {
    const container = elements.agentChartGrid.querySelector(`[data-chart-id="${CSS.escape(spec.id)}"]`);
    if (!container) continue;
    const chart = globalThis.echarts.init(container, null, { renderer: 'canvas' });
    chart.setOption(chartOption(spec));
    state.agentCharts.push(chart);
  }
}

function renderAgentRun(run) {
  state.agentRun = run;
  const analysis = run.analysis;
  elements.agentEmpty.hidden = true;
  elements.agentRunDetail.hidden = false;
  elements.agentPrintReport.disabled = false;
  elements.agentExportFormat.disabled = false;
  elements.agentExportReport.disabled = false;
  document.querySelector('#agent-run-status').textContent = statusLabel(run.status);
  document.querySelector('#agent-run-id').textContent = `运行 ${run.id.slice(0, 12)}`;
  document.querySelector('#agent-evidence-coverage').textContent = `${analysis.validation?.evidenceCoverage ?? 0}%`;
  const queryMode = String(analysis.validation?.queryMode || '');
  document.querySelector('#agent-query-mode').textContent = queryModeLabel(queryMode);
  const sampleRows = analysis.profile.sampleRowCount ?? analysis.profile.rowCount;
  document.querySelector('#agent-profile-summary').textContent = `${Number(analysis.profile.rowCount || 0).toLocaleString('zh-CN')} 行全量 · ${Number(sampleRows || 0).toLocaleString('zh-CN')} 行质量样本 · ${analysis.profile.completeness}% 完整`;
  const plannerMode = analysis.planning?.plannerMode || '';
  const planningMode = plannerMode ? ` · ${plannerModeLabel(plannerMode)}` : '';
  document.querySelector('#agent-engine-model').textContent = `${analysis.report.model || 'Atlas 分析引擎'}${planningMode}`;

  elements.agentPlan.innerHTML = (analysis.plan?.steps || []).map((step, index) => `
    <div class="agent-plan-step ${step.status === 'completed' ? 'done' : step.status}">
      <span>${String(index + 1).padStart(2, '0')} · ${statusLabel(step.status)}</span>
      <strong>${escapeHtml(step.title)}</strong>
      <small>${escapeHtml(localizePlanDetail(step.detail))}</small>
    </div>`).join('');
  elements.agentPlan.scrollTop = 0;

  elements.agentKpis.innerHTML = (analysis.kpis || []).map(item => `
    <article class="agent-kpi ${escapeHtml(item.tone || '')}">
      <small>${escapeHtml(item.label)}</small><strong title="${escapeHtml(String(item.value))}">${escapeHtml(String(item.value))}</strong><em>已验证指标</em>
    </article>`).join('');
  renderAgentCharts(analysis.charts || []);

  elements.agentFindings.innerHTML = (analysis.insights || []).map(item => `
    <article class="agent-finding">
      <span>${escapeHtml(item.category)}</span>
      <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.statement)}</p></div>
      <em>${escapeHtml(confidenceLabel(item.confidence))}</em>
    </article>`).join('');

  elements.agentEvidenceBody.innerHTML = (analysis.evidence || []).map(item => `
    <tr>
      <td><code>${escapeHtml(item.id)}</code><br>${escapeHtml(item.title)}</td>
      <td>${escapeHtml(item.method)}</td>
      <td>${escapeHtml(String(item.rowCount))}</td>
      <td>${escapeHtml((item.fields || []).slice(0, 4).join('、') || '—')}</td>
    </tr>`).join('');

  document.querySelector('#agent-report-title').textContent = analysis.report.title;
  const generated = new Date(run.completedAt || run.createdAt);
  document.querySelector('#agent-report-meta').textContent = `${analysis.dataset.name} · ${generated.toLocaleString('zh-CN')} · ${analysis.report.model}`;
  const reportContent = analysis.report.aiNarrative || analysis.report.markdown;
  elements.agentReportContent.innerHTML = markdown(reportContent);
  if (analysis.report.warning) {
    elements.agentReportContent.insertAdjacentHTML('afterbegin', `<blockquote>${escapeHtml(analysis.report.warning)}</blockquote>`);
  }
  requestAnimationFrame(() => state.agentCharts.forEach(chart => chart.resize()));
}

function renderAgentRunHistory(preferredId = '') {
  elements.agentRunHistory.innerHTML = state.agentRuns.length
    ? state.agentRuns.map(item => {
      const created = new Date(item.completedAt || item.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const name = item.dataset?.name || '未命名数据集';
      return `<option value="${escapeHtml(item.id)}">${escapeHtml(created)} · ${escapeHtml(name)} · ${escapeHtml(statusLabel(item.status))}</option>`;
    }).join('')
    : '<option value="">暂无运行记录</option>';
  if (preferredId && state.agentRuns.some(item => item.id === preferredId)) elements.agentRunHistory.value = preferredId;
  elements.agentHistoryOpen.disabled = !elements.agentRunHistory.value;
}

async function loadAgentRuns(preferredId = '') {
  try {
    const response = await fetch('/api/analysis-agent/v2/runs');
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '运行记录读取失败');
    state.agentRuns = data.items || [];
    renderAgentRunHistory(preferredId || state.agentRun?.id || '');
  } catch {
    state.agentRuns = [];
    renderAgentRunHistory();
  }
}

async function openAgentRun(runId = elements.agentRunHistory.value) {
  if (!runId) return;
  elements.agentHistoryOpen.disabled = true;
  try {
    const response = await fetch(`/api/analysis-agent/v2/runs/${encodeURIComponent(runId)}`);
    const run = await response.json();
    if (!response.ok) throw new Error(run.message || '分析运行读取失败');
    const datasetId = run.analysis?.dataset?.id || run.dataset?.id;
    if (datasetId && [...elements.agentDataset.options].some(option => option.value === datasetId)) {
      elements.agentDataset.value = datasetId;
      await loadAgentMetadata(datasetId);
    }
    elements.agentGoal.value = run.focus || run.goal || '';
    state.agentFilters = (run.analysis?.execution?.filters || []).map(item => ({
      field: item.field,
      operator: item.operator,
      value: String(item.value),
    }));
    renderAgentFilters();
    renderAgentRun(run);
  } catch (error) {
    elements.agentEmpty.hidden = false;
    elements.agentRunDetail.hidden = true;
    elements.agentEmpty.innerHTML = `<div class="error-box"><strong>运行记录未打开</strong><br>${escapeHtml(error.message)}</div>`;
  } finally {
    elements.agentHistoryOpen.disabled = false;
  }
}

function downloadAgentReport() {
  if (!state.agentRun?.id) return;
  const format = elements.agentExportFormat.value;
  const anchor = document.createElement('a');
  anchor.href = `/api/analysis-agent/v2/runs/${encodeURIComponent(state.agentRun.id)}/report?format=${encodeURIComponent(format)}`;
  anchor.download = '';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

async function runAgentAnalysis() {
  const datasetId = elements.agentDataset.value;
  const focus = elements.agentGoal.value.trim();
  if (!datasetId || elements.agentRunButton.disabled) return;
  elements.agentRunButton.disabled = true;
  elements.agentRunButton.querySelector('span').textContent = '正在执行分析';
  elements.agentEmpty.hidden = false;
  elements.agentRunDetail.hidden = true;
  elements.agentEmpty.innerHTML = '<div class="insight-loading"><i></i><i></i><i></i><span>正在理解语义、提出假设、动态路由查询并验证证据</span></div>';
  try {
    const response = await fetch('/api/analysis-agent/v2/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datasetId, focus, constraints: { filters: state.agentFilters, budgetProfile: 'standard' } }),
    });
    const run = await response.json();
    if (!response.ok) throw new Error(run.message || 'AI 数据分析失败');
    renderAgentRun(run);
    await loadAgentRuns(run.id);
  } catch (error) {
    elements.agentEmpty.hidden = false;
    elements.agentEmpty.innerHTML = `<div class="error-box"><strong>分析未完成</strong><br>${escapeHtml(error.message)}</div>`;
  } finally {
    elements.agentRunButton.disabled = false;
    elements.agentRunButton.querySelector('span').textContent = '开始自主分析';
  }
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    elements.connectionPill.classList.toggle('connected', Boolean(data.connected));
    elements.connectionPill.classList.toggle('error', !data.connected);
    elements.connectionText.textContent = data.connected ? 'Wyn 已连接' : 'Wyn 连接异常';
    elements.connectionPill.title = data.message || '';
    if (data.viewProxyPort) state.viewProxyPort = Number(data.viewProxyPort);
    if (data.server) document.querySelector('#server-address').textContent = data.server.replace(/^https?:\/\//, '');
    state.agentEngineLabel = data.llmConfigured ? `${data.llmModel} + 确定性分析` : 'Atlas 确定性分析引擎';
    document.querySelector('#agent-engine-model').textContent = state.agentEngineLabel;
  } catch {
    elements.connectionPill.classList.add('error');
    elements.connectionText.textContent = '代理服务异常';
  }
}

async function loadDatasets() {
  elements.dataset.disabled = true;
  elements.agentDataset.disabled = true;
  elements.agentRunButton.disabled = true;
  setSending(false);
  try {
    const response = await fetch('/api/datasets');
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '数据集加载失败');
    state.datasets = data.datasets || [];
    if (!state.datasets.length) throw new Error('没有找到已启用 AI 对话分析的数据集');
    elements.dataset.innerHTML = state.datasets
      .map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
      .join('');
    elements.agentDataset.innerHTML = state.datasets
      .map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
      .join('');
    elements.smartDataset.innerHTML = state.datasets
      .map((item, index) => `<option value="${escapeHtml(item.id)}"${index === 0 ? ' selected' : ''}>${escapeHtml(item.name)}</option>`)
      .join('');
    elements.dataset.disabled = false;
    elements.agentDataset.disabled = false;
    elements.smartDataset.disabled = false;
    elements.smartAsk.disabled = false;
    elements.agentRunButton.disabled = false;
    setSending(false);
    if (state.datasets[0]) await loadAgentMetadata(state.datasets[0].id);
  } catch (error) {
    elements.dataset.innerHTML = '<option value="">数据集加载失败</option>';
    elements.agentDataset.innerHTML = '<option value="">数据集加载失败</option>';
    elements.smartDataset.innerHTML = '<option value="">数据集加载失败</option>';
    elements.connectionPill.classList.add('error');
    elements.connectionText.textContent = '配置需要检查';
    elements.connectionPill.title = error.message;
    elements.dataset.disabled = true;
    elements.agentDataset.disabled = true;
    elements.smartDataset.disabled = true;
    elements.smartAsk.disabled = true;
    elements.agentRunButton.disabled = true;
    setSending(false);
  }
}

function parseStreamChunk(buffer, payloads) {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() || '';
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith(':') || line === '[DONE]' || line === 'data: [DONE]') continue;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    try { payloads.push(JSON.parse(line)); }
    catch { payloads.push(line); }
  }
  return remainder;
}

async function readWynResponse(response, bubble) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const raw = await response.text();
    let error;
    try { error = JSON.parse(raw); } catch { error = { message: raw }; }
    const message = error.message || error.error || `Wyn 返回 ${response.status}`;
    bubble.innerHTML = `<div class="error-box"><strong>Wyn 暂未完成本次分析</strong><br>${escapeHtml(message)}</div>`;
    throw new Error(message);
  }

  if (!response.body) {
    bubble.innerHTML = '<p>接口未返回内容。</p>';
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const payloads = [];
  let buffer = '';
  let rawText = '';
  let lastPaint = 0;
  setFlow(1);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawText += chunk;
    buffer += chunk;
    buffer = parseStreamChunk(buffer, payloads);
    const now = performance.now();
    if (now - lastPaint > 80) {
      const readable = payloads.map(findReadableText).join('') || rawText.replace(/^data:\s*/gm, '');
      if (readable.trim()) bubble.innerHTML = markdown(readable);
      lastPaint = now;
      scrollToBottom();
    }
  }

  if (buffer.trim()) {
    try { payloads.push(JSON.parse(buffer.replace(/^data:\s*/, ''))); }
    catch { payloads.push(buffer.replace(/^data:\s*/, '')); }
  }

  setFlow(2);
  const mergedPayload = payloads.length === 1 ? payloads[0] : payloads;
  const viewId = extractViewId(mergedPayload) || extractViewId(rawText);
  if (viewId) {
    state.lastViewId = viewId;
    bubble.innerHTML = '<div class="thinking"><i></i><i></i><i></i><span>正在读取 Wyn 分析视图</span></div>';
    const viewResponse = await fetch(`/api/views/${encodeURIComponent(viewId)}`);
    const view = await viewResponse.json();
    if (!viewResponse.ok) throw new Error(view.message || '分析视图读取失败');
    bubble.classList.add('has-wyn-view');
    bubble.closest('.assistant-row')?.classList.add('rich-result');
    bubble.innerHTML = renderView(view, viewId);
    const iframe = bubble.querySelector('.wyn-view-frame');
    iframe?.addEventListener('load', () => {
      bubble.querySelector('.wyn-frame-wrap')?.classList.add('loaded');
      setTimeout(() => loadAnalysisResults(viewId), 1200);
    }, { once: true });
    return;
  }
  if (/json|event-stream|ndjson/i.test(contentType) || payloads.some(item => typeof item === 'object')) {
    bubble.innerHTML = renderResponse(mergedPayload, rawText.replace(/^data:\s*/gm, ''));
  } else {
    bubble.innerHTML = markdown(rawText);
  }
}

async function ask(question = elements.input.value.trim()) {
  if (state.sending || !question) return;
  if (!elements.dataset.value) {
    elements.input.focus();
    return;
  }

  showConversation();
  addUserMessage(question);
  const assistantRow = addAssistantMessage();
  const bubble = assistantRow.querySelector('.assistant-bubble');
  elements.input.value = '';
  resizeTextarea();
  setSending(true);
  setFlow(0);
  scrollToBottom();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        datasetId: elements.dataset.value,
        includeInsight: false,
        stream: true,
      }),
    });
    await readWynResponse(response, bubble);
    elements.flow.forEach(item => { item.classList.remove('active'); item.classList.add('done'); });
  } catch (error) {
    console.error(error);
    setFlow(0);
  } finally {
    setSending(false);
    scrollToBottom();
    elements.input.focus();
  }
}

function selectedSmartDatasets() {
  return [...(elements.smartDataset?.selectedOptions || [])].map(option => option.value).filter(Boolean);
}

function smartAggregationLabel(value) {
  return ({ sum: '求和', average: '平均值', min: '最小值', max: '最大值', countRows: '计数', distinctCount: '去重计数' })[value] || value || '聚合';
}

function smartFilterLabel(filter) {
  const operator = ({ eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: '包含', in: '属于' })[filter?.operator] || filter?.operator || '';
  const value = Array.isArray(filter?.value) ? filter.value.join('、') : filter?.value;
  return `${filter?.field || '字段'} ${operator} ${value ?? '—'}`.trim();
}

function renderSmartAnalysisDetails(queryRequests = [], scope = {}) {
  const requests = (Array.isArray(queryRequests) ? queryRequests : []).filter(request => request && typeof request === 'object');
  const metrics = [...new Set(requests.flatMap(request => (request.measures || []).map(measure => `${measure.field || '指标'}（${smartAggregationLabel(measure.aggregation)}）`)))];
  const dimensions = [...new Set(requests.flatMap(request => (request.select || []).map(select => `${select.field || '维度'}${select.grain ? `（按${({ year: '年', quarter: '季度', month: '月', week: '周', day: '日' })[select.grain] || select.grain}）` : ''}`)))];
  const filters = [...new Set((requests.length ? requests.flatMap(request => request.filters || []) : (scope.filters || [])).map(smartFilterLabel))];
  const ranking = requests.flatMap(request => (request.orderBy || []).map(item => { const field = [...(request.measures || []), ...(request.select || [])].find(candidate => candidate.alias === item.field)?.field || item.field || '结果'; return `${field}${item.direction === 'asc' ? '升序' : '降序'}`; }));
  const rows = [
    ['指标', metrics.join('、') || '未指定'],
    ['维度', dimensions.join('、') || '未分组'],
    ['筛选', filters.join('；') || '全部数据'],
    ['排序', [...new Set(ranking)].join('；') || '未排序'],
  ];
  return `<section class="smart-analysis-details" aria-label="详情"><div class="smart-analysis-details-head"><strong>详情</strong></div><dl>${rows.map(([label, value]) => `<div class="smart-analysis-detail-item"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></section>`;
}

const SMART_CHART_TYPE_LABELS = {
  line: '折线图', column: '柱形图', bar: '条形图', pie: '饼图', donut: '环形图', combo: '组合图', 'stacked-column': '堆叠图',
};

function disposeSmartCharts() {
  for (const entry of state.smartCharts) {
    entry.observer?.disconnect();
    entry.chart?.dispose();
  }
  state.smartCharts = [];
}

function smartChartFormatPeriod(value, schema, result) {
  if (schema?.type !== 'date' && !schema?.grain) return value ?? '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value ?? '—';
  const timeZone = result?.scope?.timeZone || 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  if (schema.grain === 'year') return `${values.year}年`;
  if (schema.grain === 'quarter') return `${values.year}年第${Math.floor((Number(values.month) - 1) / 3) + 1}季度`;
  if (schema.grain === 'month') return `${values.year}年${values.month}月`;
  if (schema.grain === 'week') return `${values.year}年${values.month}月${values.day}日所在周`;
  return `${values.year}年${values.month}月${values.day}日`;
}

function legacySmartVisualization(block, result) {
  const dimension = result?.schema?.find(column => column.role === 'dimension') || result?.schema?.[0];
  const measure = result?.schema?.find(column => column.role === 'measure') || result?.schema?.find(column => column.name !== dimension?.name);
  if (!dimension?.name || !measure?.name) return null;
  const type = block.chartType === 'line' ? 'line' : 'bar';
  return {
    schema: 'wynai.visualization-spec/v1', type, dataRef: block.dataRef, title: block.title || '分析图表',
    encoding: {
      category: { field: block.encoding?.x || dimension.name, label: dimension.displayName || dimension.sourceField || dimension.name, type: dimension.type === 'date' || dimension.grain ? 'temporal' : 'nominal' },
      seriesDimension: null,
      measures: [{ field: block.encoding?.y || measure.name, label: measure.displayName || measure.sourceField || measure.name, mark: type === 'line' ? 'line' : 'bar', axis: 'left', format: measure.format === 'percentage' ? 'percentage' : 'number', order: 0 }],
    },
    options: { stack: false, showLegend: false, showLabels: type === 'bar', categoryLimit: type === 'bar' ? 20 : 0, seriesLimit: 0, groupRemainderAsOther: false, dataZoom: false },
    decision: { source: 'automatic', reason: type === 'line' ? '时间维度适合展示变化趋势。' : '分类结果适合展示数值比较。', warnings: [], allowedTypes: ['line', 'column', 'bar'] },
  };
}

function smartChartSeriesData(spec, result, type) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const categoryField = spec.encoding.category.field;
  const categorySchema = result?.schema?.find(column => column.name === categoryField);
  const seriesField = spec.encoding.seriesDimension?.field || null;
  const measures = spec.encoding.measures || [];
  const categoryKeys = [...new Set(rows.map(row => row?.[categoryField]).filter(value => value != null))];
  const aggregate = (filteredRows, field) => {
    const values = filteredRows.map(row => Number(row?.[field])).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  if (type === 'pie' || type === 'donut') {
    const measure = measures[0];
    let data = categoryKeys.map(key => ({ name: String(smartChartFormatPeriod(key, categorySchema, result)), value: aggregate(rows.filter(row => row?.[categoryField] === key), measure.field) || 0 }));
    data.sort((a, b) => b.value - a.value);
    const limit = spec.options?.categoryLimit || 0;
    if (limit && data.length > limit) {
      const remainder = data.slice(limit).reduce((sum, item) => sum + item.value, 0);
      data = data.slice(0, limit);
      if (spec.options?.groupRemainderAsOther && remainder) data.push({ name: '其他', value: remainder });
    }
    return { categories: data.map(item => item.name), series: [{ name: measure.label, mark: 'pie', axis: 'left', format: measure.format, data }] };
  }
  const limit = spec.options?.categoryLimit || 0;
  const selectedKeys = limit ? categoryKeys.slice(0, limit) : categoryKeys;
  const categories = selectedKeys.map(key => String(smartChartFormatPeriod(key, categorySchema, result)));
  if (!seriesField) {
    return {
      categories,
      series: measures.map(measure => ({
        name: measure.label,
        mark: type === 'combo' ? measure.mark : type === 'line' ? 'line' : 'bar',
        axis: type === 'combo' ? measure.axis : 'left',
        format: measure.format,
        data: selectedKeys.map(key => aggregate(rows.filter(row => row?.[categoryField] === key), measure.field)),
      })),
    };
  }
  const seriesTotals = new Map();
  for (const row of rows) {
    const key = row?.[seriesField];
    if (key == null) continue;
    const total = measures.reduce((sum, measure) => sum + Math.abs(Number(row?.[measure.field]) || 0), 0);
    seriesTotals.set(key, (seriesTotals.get(key) || 0) + total);
  }
  let seriesKeys = [...seriesTotals.keys()].sort((a, b) => seriesTotals.get(b) - seriesTotals.get(a));
  if (spec.options?.seriesLimit) seriesKeys = seriesKeys.slice(0, spec.options.seriesLimit);
  return {
    categories,
    series: seriesKeys.flatMap(seriesKey => measures.map(measure => ({
      name: measures.length > 1 ? `${seriesKey} · ${measure.label}` : String(seriesKey),
      mark: type === 'line' ? 'line' : 'bar',
      axis: 'left',
      format: measure.format,
      data: selectedKeys.map(categoryKey => aggregate(rows.filter(row => row?.[categoryField] === categoryKey && row?.[seriesField] === seriesKey), measure.field)),
    }))),
  };
}

function smartChartOption(spec, result, selectedType = spec.type) {
  const type = selectedType;
  const data = smartChartSeriesData(spec, result, type);
  const palette = ['#5f4ac7', '#2388a2', '#1ca579', '#bd852e', '#c55c67', '#527780', '#806b4c', '#69749a'];
  const percentAxis = spec.encoding.measures.some(measure => measure.axis === 'right' && measure.format === 'percentage');
  const valueFormatter = format => value => format === 'percentage'
    ? new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 }).format(Number(value) || 0)
    : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value) || 0);
  if (type === 'pie' || type === 'donut') {
    return {
      animationDuration: 450,
      color: palette,
      tooltip: { trigger: 'item', valueFormatter: valueFormatter(spec.encoding.measures[0]?.format) },
      legend: { type: 'scroll', orient: 'vertical', right: 16, top: 'middle', textStyle: { color: '#657178', fontSize: 11 } },
      series: [{ name: data.series[0]?.name, type: 'pie', radius: type === 'donut' ? ['42%', '68%'] : '68%', center: ['40%', '52%'], avoidLabelOverlap: true, minShowLabelAngle: 4, label: { color: '#59676e', fontSize: 11, formatter: '{b}\n{d}%' }, data: data.series[0]?.data || [] }],
    };
  }
  const horizontal = type === 'bar';
  const yAxes = type === 'combo' ? [
    { type: 'value', position: 'left', splitLine: { lineStyle: { color: '#edf0f1' } }, axisLabel: { color: '#858c91', fontSize: 10 } },
    { type: 'value', position: 'right', splitLine: { show: false }, axisLabel: { color: '#858c91', fontSize: 10, formatter: value => percentAxis ? `${Math.round(value * 100)}%` : value } },
  ] : { type: horizontal ? 'category' : 'value', data: horizontal ? data.categories : undefined, inverse: horizontal, splitLine: { show: !horizontal, lineStyle: { color: '#edf0f1' } }, axisLine: { lineStyle: { color: '#ccd3d6' } }, axisTick: { show: false }, axisLabel: { color: '#777f84', fontSize: 10, width: horizontal ? 120 : undefined, overflow: 'truncate' } };
  const categoryAxis = { type: 'category', data: data.categories, axisLine: { lineStyle: { color: '#ccd3d6' } }, axisTick: { show: false }, axisLabel: { color: '#777f84', fontSize: 10, margin: 11, rotate: !horizontal && data.categories.some(label => String(label).length > 7) ? 24 : 0 } };
  return {
    animationDuration: 450,
    color: palette,
    tooltip: { trigger: 'axis', confine: true },
    legend: spec.options?.showLegend && data.series.length > 1 ? { type: 'scroll', top: 2, right: 10, textStyle: { color: '#667177', fontSize: 10 } } : undefined,
    grid: { left: horizontal ? 118 : 58, right: type === 'combo' ? 62 : horizontal && spec.options?.showLabels ? 94 : 24, top: data.series.length > 1 ? 42 : 20, bottom: spec.options?.dataZoom ? 62 : 45, containLabel: false },
    xAxis: horizontal ? { type: 'value', splitLine: { lineStyle: { color: '#edf0f1' } }, axisLabel: { color: '#858c91', fontSize: 10 } } : categoryAxis,
    yAxis: horizontal ? yAxes : type === 'combo' ? yAxes : { type: 'value', splitLine: { lineStyle: { color: '#edf0f1' } }, axisLabel: { color: '#858c91', fontSize: 10 } },
    dataZoom: spec.options?.dataZoom && !horizontal ? [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 12 }] : undefined,
    series: data.series.map(series => ({
      name: series.name,
      type: series.mark,
      data: series.data,
      yAxisIndex: type === 'combo' && series.axis === 'right' ? 1 : 0,
      stack: type === 'stacked-column' || spec.options?.stack ? 'total' : undefined,
      smooth: false,
      symbolSize: 6,
      lineStyle: series.mark === 'line' ? { width: 2.5 } : undefined,
      areaStyle: series.mark === 'line' && data.series.length === 1 ? { opacity: .04 } : undefined,
      barMaxWidth: 34,
      itemStyle: series.mark === 'bar' ? { borderRadius: horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0] } : undefined,
      label: spec.options?.showLabels && data.categories.length <= 20 ? { show: true, position: horizontal ? 'right' : 'top', color: '#50636b', fontSize: 10, formatter: params => valueFormatter(series.format)(params.value) } : undefined,
      tooltip: { valueFormatter: valueFormatter(series.format) },
    })),
  };
}

function hydrateSmartCharts(root, document, resultSets = []) {
  if (!root || !globalThis.echarts) return;
  const blockMap = new Map((document?.blocks || []).filter(block => block.type === 'chart').map(block => [block.id, block]));
  const resultMap = new Map(resultSets.map(result => [result.id, result]));
  for (const container of root.querySelectorAll('[data-smart-chart-id]')) {
    const block = blockMap.get(container.dataset.smartChartId);
    const result = resultMap.get(block?.dataRef);
    const spec = block?.visualization || legacySmartVisualization(block, result);
    if (!block || !result || !spec) continue;
    const chart = globalThis.echarts.init(container, null, { renderer: 'canvas' });
    const render = type => {
      const rowCount = result.rows?.length || 0;
      container.style.height = type === 'bar' ? `${Math.min(520, Math.max(250, rowCount * 28 + 70))}px` : '300px';
      chart.clear();
      chart.setOption(smartChartOption(spec, result, type), true);
      container.setAttribute('aria-label', `${block.title || '分析图表'}，${SMART_CHART_TYPE_LABELS[type] || type}`);
      root.querySelectorAll(`[data-smart-chart-block="${CSS.escape(block.id)}"]`).forEach(button => button.classList.toggle('active', button.dataset.smartChartType === type));
      requestAnimationFrame(() => chart.resize());
    };
    root.querySelectorAll(`[data-smart-chart-block="${CSS.escape(block.id)}"]`).forEach(button => button.addEventListener('click', () => render(button.dataset.smartChartType)));
    const observer = globalThis.ResizeObserver ? new ResizeObserver(() => chart.resize()) : null;
    observer?.observe(container);
    state.smartCharts.push({ chart, observer });
    render(spec.type);
  }
}
function renderSmartDocument(document, resultSets = [], runtimeStatus = null, queryRequests = [], feedbackContext = null) {
  if (!document) return '';
  const blocks = Array.isArray(document.blocks) ? document.blocks : [];
  const resultMap = new Map(resultSets.map(result => [result.id, result]));
  const formatCompactNumber = value => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return String(value ?? '—');
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2, notation: 'compact', compactDisplay: 'short' }).format(numeric);
  };
  const formatPeriod = (value, schema, result) => {
    if (schema?.type !== 'date' && !schema?.grain) return value ?? '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value ?? '—';
    const timeZone = result?.scope?.timeZone || 'Asia/Shanghai';
    const parts = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    if (schema.grain === 'year') return `${values.year}年`;
    if (schema.grain === 'quarter') return `${values.year}年第${Math.floor((Number(values.month) - 1) / 3) + 1}季度`;
    if (schema.grain === 'month') return `${values.year}年${values.month}月`;
    if (schema.grain === 'week') return `${values.year}年${values.month}月${values.day}日所在周`;
    return `${values.year}年${values.month}月${values.day}日`;
  };
  const renderChart = block => {
    const result = resultMap.get(block.dataRef);
    if (!result?.rows?.length) return `<p>暂无可绘制的聚合数据 · 结果集 ${escapeHtml(block.dataRef || '—')}</p>`;
    const spec = block.visualization || legacySmartVisualization(block, result);
    if (!spec) return `<p>当前结果形状不适合绘图，已保留查询明细。</p>`;
    const allowedTypes = [...new Set([spec.type, ...(spec.decision?.allowedTypes || [])])];
    const controls = allowedTypes.length > 1 ? `<div class="smart-chart-type-switch" role="group" aria-label="切换图表类型">${allowedTypes.map(type => `<button type="button" class="${type === spec.type ? 'active' : ''}" data-smart-chart-block="${escapeHtml(block.id)}" data-smart-chart-type="${escapeHtml(type)}" title="切换为${escapeHtml(SMART_CHART_TYPE_LABELS[type] || type)}">${escapeHtml(SMART_CHART_TYPE_LABELS[type] || type)}</button>`).join('')}</div>` : '';
    const decision = spec.decision?.reason ? `<p class="smart-chart-decision">${escapeHtml(spec.decision.reason)}</p>` : '';
    const warnings = spec.decision?.warnings?.length ? `<p class="smart-chart-warning">${escapeHtml(spec.decision.warnings.join('；'))}</p>` : '';
    return `${controls}<div class="smart-echart" data-smart-chart-id="${escapeHtml(block.id)}" role="img" aria-label="${escapeHtml(block.title || '分析图表')}"></div>${decision}${warnings}`;
  };
  const renderTable = block => {
    const result = resultMap.get(block.dataRef);
    const rows = result?.rows || [];
    const columns = (block.columns || result?.schema?.map(column => column.name) || Object.keys(rows[0] || {})).slice(0, 12);
    if (!rows.length || !columns.length) return `<p>暂无表格数据 · 结果集 ${escapeHtml(block.dataRef || '—')}</p>`;
    const schemaMap = new Map((result?.schema || []).map(column => [column.name, column]));
    const cellValue = (row, column) => {
      const value = row[column];
      const schema = schemaMap.get(column);
      if (schema?.type === 'date' || schema?.grain) return formatPeriod(value, schema, result);
      if (schema?.format === 'percentage' && Number.isFinite(Number(value))) return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 }).format(Number(value));
      return /measure/.test(schema?.role || '') && Number.isFinite(Number(value))
        ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value))
        : value ?? '—';
    };
    return `<div class="smart-query-table-wrap"><table class="smart-query-table"><thead><tr>${columns.map(column => `<th>${escapeHtml(schemaMap.get(column)?.displayName || schemaMap.get(column)?.sourceField || column)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, 30).map(row => `<tr>${columns.map(column => `<td>${escapeHtml(cellValue(row, column))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  };
  const datasets = document.scope?.datasets || (document.scope?.datasetId ? [document.scope.datasetId] : []);
  const accuracy = document.scope?.accuracy === 'exact' ? '精确结果' : document.scope?.accuracy === 'sample' ? '样本结果' : '范围待确认';
  elements.smartScope.innerHTML = `<i></i>${datasets.length || 0} 个数据集 · ${accuracy}`;
  const analysisDetails = renderSmartAnalysisDetails(queryRequests, document.scope || {});
  const answerBlock = blocks.find(block => block.id === 'answer-summary' || block.title === '回答');
  const renderBlock = block => {
    const title = escapeHtml(block.title || block.id || '分析块');
    if (block.type === 'kpi') return `<article class="smart-query-block"><h4>${title}</h4><strong class="value">${escapeHtml(block.value ?? '—')}</strong></article>`;
    if (block.type === 'warning') return `<article class="smart-query-block warning wide"><h4>${title}</h4><p>${escapeHtml(block.message || block.content || '')}</p></article>`;
    if (block.type === 'chart') return `<article class="smart-query-block wide"><h4>${title}</h4>${renderChart(block)}</article>`;
    if (block.type === 'table') return `<article class="smart-query-block wide"><h4>${title}</h4>${renderTable(block)}</article>`;
    return `<article class="smart-query-block wide"><h4>${title}</h4><p>${escapeHtml(block.content || block.message || '')}</p></article>`;
  };
  const answerHtml = answerBlock
    ? `<article class="smart-query-block wide smart-query-answer"><h4>${escapeHtml(answerBlock.title || '回答')}</h4><p>${escapeHtml(answerBlock.content || answerBlock.message || '')}</p>${analysisDetails}</article>`
    : `<article class="smart-query-block wide smart-query-answer"><h4>回答</h4><p>已完成本次分析。</p>${analysisDetails}</article>`;
  const blockHtml = `${answerHtml}${blocks.filter(block => block !== answerBlock).map(renderBlock).join('')}`;
  const status = runtimeStatus?.message ? `<p class="smart-runtime-note ${runtimeStatus.level === 'warning' ? 'warning' : ''}"><i></i>${escapeHtml(runtimeStatus.message)}</p>` : '';
  const suggestions = (document.followUpActions || []).map(action => `<button type="button" title="${escapeHtml(action.label)}" data-smart-followup="${escapeHtml(action.question)}">${escapeHtml(action.label)}</button>`).join('');
  const feedback = feedbackContext?.turnId
    ? `<div class="smart-answer-feedback" data-smart-feedback-turn="${escapeHtml(feedbackContext.turnId)}" data-smart-feedback-trace="${escapeHtml(feedbackContext.traceId || '')}"><div class="smart-feedback-actions"><span>这次回答是否有帮助？</span><button type="button" data-smart-feedback="correct">有帮助</button><button type="button" data-smart-feedback="wrong_understanding">理解有误</button><button type="button" data-smart-feedback="wrong_metric">口径有误</button></div><form class="smart-feedback-correction" hidden><label for="smart-feedback-correction-${escapeHtml(feedbackContext.turnId)}">请补充纠正信息</label><textarea id="smart-feedback-correction-${escapeHtml(feedbackContext.turnId)}" rows="2" maxlength="1000"></textarea><div><button type="submit" data-smart-feedback-submit>提交反馈</button><button type="button" data-smart-feedback-cancel>取消</button></div></form></div>`
    : '';
  return `<article class="smart-message smart-message-assistant"><div class="smart-assistant-avatar">问</div><div class="smart-assistant-response"><div class="smart-query-blocks">${blockHtml}</div>${suggestions ? `<div class="smart-followups">${suggestions}</div>` : ''}${status}${feedback}</div></article>`;
}


async function sendSmartFeedback(container, category, correction = '') {
  container.querySelectorAll('button, textarea').forEach(item => { item.disabled = true; });
  try {
    const response = await fetch(`/api/smart-query/conversations/${encodeURIComponent(state.smartConversationId)}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, correction, turnId: container.dataset.smartFeedbackTurn, traceId: container.dataset.smartFeedbackTrace }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || '反馈提交失败');
    container.innerHTML = '<span>感谢反馈，已进入待审核学习队列</span>';
    container.classList.add('submitted');
  } catch (error) {
    container.querySelectorAll('button, textarea').forEach(item => { item.disabled = false; });
    elements.smartStatus.textContent = error.message;
  }
}

function submitSmartFeedback(button) {
  const container = button.closest('[data-smart-feedback-turn]');
  if (!container || !state.smartConversationId || button.disabled) return;
  const category = button.dataset.smartFeedback;
  if (category === 'correct') return sendSmartFeedback(container, category);
  const form = container.querySelector('.smart-feedback-correction');
  const textarea = form?.querySelector('textarea');
  if (!form || !textarea) return;
  container.dataset.smartFeedbackCategory = category;
  form.querySelector('label').textContent = category === 'wrong_metric' ? '请说明正确的指标口径' : '请说明系统理解错在哪里';
  form.hidden = false;
  textarea.focus();
}

function smartWelcomeMarkup() {
  return '<section class="welcome-card smart-chat-welcome"><div class="orb-wrap" aria-hidden="true"><div class="orb smart-orb"><span></span></div></div><h2>让数据，直接回答问题</h2><p>选择一个业务数据集，用自然语言提问。独立问数将基于 Wyn 数据集语义执行受控查询，并支持连续追问。</p><div class="suggestion-grid"><button class="suggestion" type="button" data-smart-prompt="总销售额是多少？"><span class="suggestion-icon violet"><svg viewBox="0 0 24 24"><path d="m4 17 5-5 4 3 7-8M16 7h4v4"/></svg></span><span><strong>核心指标概览</strong><small>总销售额是多少？</small></span><svg class="arrow" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button><button class="suggestion" type="button" data-smart-prompt="2023至2025年销售额和同比增长率"><span class="suggestion-icon cyan"><svg viewBox="0 0 24 24"><path d="M4 18h16M6 15l4-5 3 3 5-7"/></svg></span><span><strong>发现趋势变化</strong><small>按年度分析销售额同比</small></span><svg class="arrow" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button><button class="suggestion" type="button" data-smart-prompt="过去三年销售额累计排名前三的销售经理是谁"><span class="suggestion-icon amber"><svg viewBox="0 0 24 24"><path d="M5 20V9h4v11M10 20V4h4v16M15 20v-7h4v7"/></svg></span><span><strong>识别业务贡献</strong><small>销售经理累计销售额排名</small></span><svg class="arrow" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button><button class="suggestion" type="button" data-smart-prompt="2023至2025年每年利润前三的城市"><span class="suggestion-icon rose"><svg viewBox="0 0 24 24"><path d="M12 3 2.8 20h18.4L12 3Zm0 6v5m0 3h.01"/></svg></span><span><strong>定位重点对象</strong><small>每年利润前三的城市</small></span><svg class="arrow" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button></div></section>';
}

function resetSmartConversation() {
  disposeSmartCharts();
  state.smartConversationId = null;
  state.smartTurns = 0;
  elements.smartTurnCount.textContent = '0 轮';
  elements.smartContextMetrics.textContent = '未指定';
  elements.smartContextDimensions.textContent = '未指定';
  elements.smartContextFilters.textContent = '全部数据';
  elements.smartContextSkills.textContent = '自动匹配';
  elements.smartScope.innerHTML = '<i></i>等待提问';
  elements.smartMessages.innerHTML = smartWelcomeMarkup();
  elements.smartStatus.textContent = selectedSmartDatasets().length ? '新对话已就绪' : '请选择会话数据集';
  elements.smartAsk.disabled = !selectedSmartDatasets().length;
  elements.smartQuestion.value = '';
}

function updateSmartContext(payload) {
  const refs = payload.response?.semanticRefs || {};
  const filters = refs.filters || payload.conversation?.activeFilters || [];
  elements.smartContextMetrics.textContent = (refs.metrics || payload.conversation?.activeMetrics || []).join('、') || '未指定';
  elements.smartContextDimensions.textContent = (refs.dimensions || payload.conversation?.activeDimensions || []).join('、') || '未指定';
  elements.smartContextFilters.textContent = filters.length ? filters.map(item => `${item.field} ${item.operator} ${item.value}`).join('；') : '全部数据';
  elements.smartContextSkills.textContent = (payload.response?.diagnostics?.skillRefs || payload.conversation?.loadedSkillRefs || []).join('、') || '未匹配';
  state.smartTurns += 1;
  elements.smartTurnCount.textContent = `${state.smartTurns} 轮`;
}

async function askSmartQuery() {
  if (state.smartAbortController) {
    state.smartAbortController.abort();
    return;
  }
  const datasetIds = selectedSmartDatasets();
  const question = elements.smartQuestion.value.trim();
  if (!datasetIds.length || !question || elements.smartAsk.disabled) return;
  elements.smartAsk.disabled = true;
  elements.smartQuestion.value = '';
  const abortController = new AbortController();
  state.smartAbortController = abortController;
  const sendButtonHtml = elements.smartAsk.innerHTML;
  elements.smartAsk.disabled = false;
  elements.smartAsk.classList.add('cancel');
  elements.smartAsk.setAttribute('aria-label', '取消本轮查询');
  elements.smartAsk.title = '取消本轮查询';
  elements.smartAsk.innerHTML = '<span aria-hidden="true">×</span>';
  const startedAt = Date.now();
  const waitingLabel = elapsed => elapsed >= 20
    ? '处理时间较长，可以取消后重试'
    : elapsed >= 8
      ? '服务仍在处理，请稍候'
      : elapsed >= 2
        ? '正在处理业务问题'
        : '正在提交问题';
  elements.smartStatus.textContent = waitingLabel(0);
  elements.smartMessages.querySelector('.smart-chat-welcome')?.remove();
  elements.smartMessages.insertAdjacentHTML('beforeend', `<article class="smart-message smart-message-user"><div>${escapeHtml(question)}</div></article><article class="smart-message smart-message-assistant smart-message-loading" id="smart-message-loading"><div class="smart-assistant-avatar">问</div><div class="smart-loading-body"><div><span></span><span></span><span></span></div><p data-smart-loading-phase>${waitingLabel(0)} · 0 秒</p></div></article>`);
  const loadingTimer = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const phase = waitingLabel(elapsed);
    const label = document.querySelector('[data-smart-loading-phase]');
    if (label) label.textContent = `${phase} · ${elapsed} 秒`;
    elements.smartStatus.textContent = phase;
  }, 1000);
  elements.smartMessages.scrollTop = elements.smartMessages.scrollHeight;
  try {
    if (!state.smartConversationId) {
      const created = await fetch('/api/smart-query/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetIds }), signal: abortController.signal });
      const payload = await created.json();
      if (!created.ok) throw new Error(payload.message || '会话创建失败');
      state.smartConversationId = payload.id;
    }
    const response = await fetch(`/api/smart-query/conversations/${encodeURIComponent(state.smartConversationId)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }), signal: abortController.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || '智能问数失败');
    document.querySelector('#smart-message-loading')?.remove();
    if (payload.response?.status === 'needs_clarification') {
      const clarification = payload.response.clarification?.question || '需要进一步确认';
      const options = (payload.response.clarification?.options || []).map(value => `<button type="button" data-smart-followup="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('');
      elements.smartMessages.insertAdjacentHTML('beforeend', `<article class="smart-message smart-message-assistant"><div class="smart-assistant-avatar">问</div><div class="smart-clarification"><strong>需要确认</strong><p>${escapeHtml(clarification)}</p>${options ? `<div class="smart-followups">${options}</div>` : ''}</div></article>`);
      elements.smartStatus.textContent = '等待你补充信息';
      updateSmartContext(payload);
    } else {
      elements.smartMessages.insertAdjacentHTML('beforeend', renderSmartDocument(payload.response?.document, payload.response?.resultSets || [], payload.response?.runtimeStatus, payload.response?.queryRequests || [], payload.response?.trace || null));
      hydrateSmartCharts(elements.smartMessages.lastElementChild, payload.response?.document, payload.response?.resultSets || []);
      elements.smartStatus.textContent = '已完成，可以继续追问';
      updateSmartContext(payload);
    }
    elements.smartMessages.scrollTop = elements.smartMessages.scrollHeight;
  } catch (error) {
    document.querySelector('#smart-message-loading')?.remove();
    const cancelled = error.name === 'AbortError';
    const message = cancelled ? '本轮已取消，问题已保留，可以修改后重试。' : error.message;
    elements.smartMessages.insertAdjacentHTML('beforeend', `<article class="smart-message smart-message-assistant"><div class="smart-assistant-avatar">问</div><div class="${cancelled ? 'smart-message-cancelled' : 'smart-message-error'}"><strong>${cancelled ? '已取消' : '本轮未完成'}</strong><p>${escapeHtml(message)}</p></div></article>`);
    elements.smartStatus.textContent = cancelled ? '本轮已取消' : error.message;
    if (!elements.smartQuestion.value) elements.smartQuestion.value = question;
  } finally {
    window.clearInterval(loadingTimer);
    if (state.smartAbortController === abortController) state.smartAbortController = null;
    elements.smartAsk.classList.remove('cancel');
    elements.smartAsk.setAttribute('aria-label', '发送问题');
    elements.smartAsk.title = '发送问题';
    elements.smartAsk.innerHTML = sendButtonHtml;
    elements.smartAsk.disabled = false;
  }
}

function reportSelectedBlock() {
  return state.reportTemplate?.blocks?.find(block => block.id === elements.reportBlockSelect.value) || null;
}

function renderReportTemplate(template) {
  state.reportTemplate = template;
  elements.reportTemplateTitle.textContent = template?.name || '未命名模板';
  elements.reportTemplateMeta.textContent = template ? `${template.blocks.length} 个 Block · v${template.version} · ${template.compatibility?.level || 'standard'}` : '—';
  elements.reportBlockSelect.innerHTML = template ? template.blocks.filter(block => block.type === 'paragraph' || block.type === 'table').map(block => `<option value="${escapeHtml(block.id)}">${escapeHtml(block.type === 'table' ? '[表格] ' : '')}${escapeHtml(block.anchorText || block.text || block.id).slice(0, 90)}</option>`).join('') : '<option value="">上传后选择段落或表格</option>';
  elements.reportBlockSelect.disabled = !template;
  elements.reportPropose.disabled = !template;
  renderReportBlockPreview();
}

function renderReportBlockPreview() {
  const block = reportSelectedBlock();
  if (!block) { elements.reportBlockPreview.textContent = '选择模板后查看候选动态块。'; return; }
  const suggestion = block.suggestion || {};
  elements.reportBlockPreview.innerHTML = `<div class="report-block-card"><strong>${escapeHtml(block.type === 'table' ? '表格' : '段落')}</strong><span>${escapeHtml(suggestion.type || 'fixed-text')} · 置信度 ${Math.round((suggestion.confidence || 0) * 100)}%</span><p>${escapeHtml(block.text || block.rows?.map(row => row.join(' | ')).join('\n') || '')}</p><small>${escapeHtml(suggestion.reason || '')}</small></div>`;
}

async function loadReportTemplates() {
  try {
    const response = await fetch('/api/report-templates');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || '模板目录加载失败');
    state.reportTemplates = payload.items || [];
    elements.reportTemplateSelect.innerHTML = state.reportTemplates.length ? state.reportTemplates.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · v${item.version}</option>`).join('') : '<option value="">先上传模板</option>';
    if (state.reportTemplates[0]) await selectReportTemplate(state.reportTemplates[0].id);
  } catch (error) { elements.reportStatus.textContent = error.message; }
}

async function selectReportTemplate(templateId) {
  if (!templateId) return;
  const response = await fetch(`/api/report-templates/${encodeURIComponent(templateId)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || '模板加载失败');
  renderReportTemplate(payload);
  elements.reportStatus.textContent = '模板已加载，可选择 Block 并填写业务描述';
}

async function uploadReportTemplate() {
  const file = elements.reportTemplateFile.files?.[0];
  if (!file) { elements.reportStatus.textContent = '请选择 DOCX 模板'; return; }
  elements.reportUpload.disabled = true;
  try {
    const contentBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = reject; reader.readAsDataURL(file); });
    const response = await fetch('/api/report-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, name: file.name.replace(/\.docx$/i, ''), contentBase64 }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || '模板上传失败');
    await loadReportTemplates();
    elements.reportTemplateSelect.value = payload.id;
    await selectReportTemplate(payload.id);
    elements.reportStatus.textContent = `已解析 ${payload.blocks.length} 个 Block`;
  } catch (error) { elements.reportStatus.textContent = error.message; }
  finally { elements.reportUpload.disabled = false; }
}

async function proposeReportBinding() {
  const block = reportSelectedBlock();
  const question = elements.reportBusinessQuestion.value.trim();
  if (!block || !state.reportTemplate) return;
  if (elements.reportBlockType.value !== 'parameter' && !question) { elements.reportStatus.textContent = '请先输入业务描述'; return; }
  const datasetId = elements.agentDataset.value || elements.dataset.value || state.datasets[0]?.id;
  elements.reportPropose.disabled = true;
  try {
    const body = { blockId: block.id, type: elements.reportBlockType.value, name: question || '报告参数', businessQuestion: question || undefined, datasetIds: datasetId ? [datasetId] : [], status: 'proposed' };
    const response = await fetch(`/api/report-templates/${encodeURIComponent(state.reportTemplate.id)}/bindings/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || '绑定提议失败');
    const confirmed = await fetch(`/api/report-templates/${encodeURIComponent(state.reportTemplate.id)}/bindings/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload.binding, status: 'confirmed' }) });
    const confirmedPayload = await confirmed.json();
    if (!confirmed.ok) throw new Error(confirmedPayload.message || '绑定确认失败');
    state.reportTemplate = confirmedPayload.template;
    elements.reportStatus.textContent = `已确认绑定：${payload.binding.name || block.id}`;
    await runReportTemplate();
  } catch (error) { elements.reportStatus.textContent = error.message; }
  finally { elements.reportPropose.disabled = false; }
}

function renderReportRun(run) {
  state.reportRun = run;
  elements.reportRunStatus.textContent = `${run.status} · 证据 ${run.evidence?.length || 0}`;
  const evidence = (run.evidence || []).map(item => `<li><strong>${escapeHtml(item.label || item.id)}</strong>：${escapeHtml(item.displayValue || '—')} <small>${escapeHtml(item.quality?.isTruncated ? '可能截断' : '已记录来源')}</small></li>`).join('');
  elements.reportRunOutput.innerHTML = `<div class="report-run-card"><p>运行 ${escapeHtml(run.id)} · 模板 v${run.templateVersion}</p><ul>${evidence || '<li>暂无证据</li>'}</ul></div>`;
  elements.reportDownload.disabled = !run.output;
  const contentEntry = Object.entries(run.contentSessions || {})[0];
  if (contentEntry) {
    state.reportContentBlockId = contentEntry[0];
    const session = contentEntry[1];
    elements.reportContentEditor.hidden = false;
    elements.reportContentStatus.textContent = session.status;
    elements.reportContentText.value = session.drafts.find(item => item.version === session.selectedVersion)?.text || '';
  }
}

async function runReportTemplate() {
  if (!state.reportTemplate) return;
  elements.reportStatus.textContent = '正在执行绑定查询并生成报告…';
  const response = await fetch('/api/report-runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: state.reportTemplate.id, parameters: { report_period: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' }) } }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || '报告运行失败');
  renderReportRun(payload);
  elements.reportStatus.textContent = '报告已生成，可编辑动态内容或下载 Word';
}

async function updateReportContent(confirm = false) {
  if (!state.reportRun || !state.reportContentBlockId) return;
  const response = await fetch(`/api/report-runs/${encodeURIComponent(state.reportRun.id)}/content/${encodeURIComponent(state.reportContentBlockId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manualText: elements.reportContentText.value, message: elements.reportContentMessage.value, confirm }) });
  const payload = await response.json();
  if (!response.ok) { elements.reportContentStatus.textContent = payload.message || '内容更新失败'; return; }
  elements.reportContentStatus.textContent = payload.status;
  elements.reportContentText.value = payload.drafts.find(item => item.version === payload.selectedVersion)?.text || elements.reportContentText.value;
  elements.reportContentMessage.value = '';
}

async function downloadReportDocx() {
  if (!state.reportRun) return;
  const response = await fetch(`/api/report-runs/${encodeURIComponent(state.reportRun.id)}/export?format=docx`);
  if (!response.ok) return;
  const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = state.reportRun.output?.filename || 'generated-report.docx'; link.click(); URL.revokeObjectURL(link.href);
}

elements.send.addEventListener('click', () => ask());
elements.smartAsk.addEventListener('click', askSmartQuery);
elements.smartDataset.addEventListener('change', () => {
  const datasetId = elements.smartDataset.value;
  if (datasetId && elements.agentDataset.value !== datasetId) elements.agentDataset.value = datasetId;
  resetSmartConversation();
  if (datasetId) loadAgentMetadata(datasetId);
});
elements.smartNewConversation.addEventListener('click', resetSmartConversation);
elements.smartQuestion.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); askSmartQuery(); }
});
elements.smartMessages.addEventListener('click', event => {
  const feedbackCancel = event.target.closest('[data-smart-feedback-cancel]');
  if (feedbackCancel) {
    const container = feedbackCancel.closest('[data-smart-feedback-turn]');
    const form = feedbackCancel.closest('.smart-feedback-correction');
    if (form) form.hidden = true;
    if (container) delete container.dataset.smartFeedbackCategory;
    return;
  }
  const feedback = event.target.closest('[data-smart-feedback]');
  if (feedback) {
    submitSmartFeedback(feedback);
    return;
  }
  const prompt = event.target.closest('[data-smart-prompt]');
  const followup = event.target.closest('[data-smart-followup]');
  const question = prompt?.dataset.smartPrompt || followup?.dataset.smartFollowup;
  if (!question) return;
  elements.smartQuestion.value = question;
  askSmartQuery();
});
elements.smartMessages.addEventListener('submit', event => {
  const form = event.target.closest('.smart-feedback-correction');
  if (!form) return;
  event.preventDefault();
  const container = form.closest('[data-smart-feedback-turn]');
  const category = container?.dataset.smartFeedbackCategory;
  if (!container || !category) return;
  sendSmartFeedback(container, category, form.querySelector('textarea')?.value.trim() || '');
});
elements.reportUpload.addEventListener('click', uploadReportTemplate);
elements.reportTemplateSelect.addEventListener('change', () => selectReportTemplate(elements.reportTemplateSelect.value).catch(error => { elements.reportStatus.textContent = error.message; }));
elements.reportBlockSelect.addEventListener('change', renderReportBlockPreview);
elements.reportPropose.addEventListener('click', () => proposeReportBinding().catch(error => { elements.reportStatus.textContent = error.message; }));
elements.reportContentDiscuss.addEventListener('click', () => updateReportContent(false));
elements.reportContentConfirm.addEventListener('click', () => updateReportContent(true));
elements.reportDownload.addEventListener('click', downloadReportDocx);
elements.sidebarToggle.addEventListener('click', () => setSidebarCollapsed(!state.sidebarCollapsed));
elements.input.addEventListener('input', resizeTextarea);
elements.input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ask();
  }
});
elements.clear.addEventListener('click', () => state.currentSection === 'smart-query' ? resetSmartConversation() : resetConversation());
elements.navItems.forEach(item => item.addEventListener('click', () => switchSection(item.dataset.section)));
elements.agentDataset.addEventListener('change', () => {
  state.agentFilters = [];
  renderAgentFilters();
  loadAgentMetadata(elements.agentDataset.value);
});
elements.agentRunButton.addEventListener('click', runAgentAnalysis);
elements.agentPrintReport.addEventListener('click', () => window.print());
elements.agentExportReport.addEventListener('click', downloadAgentReport);
elements.agentFilterField.addEventListener('change', updateFilterOperators);
elements.agentAddFilter.addEventListener('click', addAgentFilter);
elements.agentFilterValue.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addAgentFilter();
  }
});
elements.agentFilterList.addEventListener('click', event => {
  const button = event.target.closest('[data-remove-filter]');
  if (!button) return;
  state.agentFilters.splice(Number(button.dataset.removeFilter), 1);
  renderAgentFilters();
});
elements.agentRunHistory.addEventListener('change', () => {
  elements.agentHistoryOpen.disabled = !elements.agentRunHistory.value;
});
elements.agentHistoryOpen.addEventListener('click', () => openAgentRun());
elements.agentHistoryRefresh.addEventListener('click', () => loadAgentRuns());
document.querySelector('#agent-goal-presets').addEventListener('click', event => {
  const preset = event.target.closest('[data-agent-goal]');
  if (!preset) return;
  elements.agentGoal.value = preset.dataset.agentGoal;
  elements.agentGoal.focus();
});
elements.refreshResults.addEventListener('click', () => loadAnalysisResults());
elements.backToChat.addEventListener('click', () => switchSection('chat'));
document.querySelector('[data-action="go-chat"]').addEventListener('click', () => switchSection('chat'));
elements.resultList.addEventListener('click', event => {
  const item = event.target.closest('[data-result-id]');
  if (item) selectAnalysisResult(item.dataset.resultId).catch(error => {
    elements.resultList.innerHTML = `<div class="result-list-empty">${escapeHtml(error.message)}</div>`;
  });
});
document.querySelector('#analysis-presets').addEventListener('click', event => {
  const preset = event.target.closest('[data-preset]');
  if (!preset) return;
  elements.secondaryPrompt.value = preset.dataset.preset;
  elements.secondaryPrompt.focus();
});
document.querySelector('#toggle-raw-data').addEventListener('click', event => {
  const raw = document.querySelector('#raw-data');
  const table = document.querySelector('#data-table-wrap');
  raw.hidden = !raw.hidden;
  table.hidden = !table.hidden;
  event.currentTarget.textContent = raw.hidden ? '查看 JSON' : '查看表格';
});
elements.generateInsight.addEventListener('click', generateSecondaryInsight);
document.querySelectorAll('[data-prompt]').forEach(button => {
  button.addEventListener('click', () => ask(button.dataset.prompt));
});
elements.messages.addEventListener('click', async event => {
  const insightButton = event.target.closest('[data-action="open-insights"]');
  if (insightButton) {
    await openInsightsForView(insightButton.dataset.viewId);
    return;
  }
  const button = event.target.closest('[data-action="copy"]');
  if (!button) return;
  const text = button.closest('.assistant-content')?.querySelector('.assistant-bubble')?.innerText || '';
  await navigator.clipboard.writeText(text);
  button.textContent = '已复制';
  setTimeout(() => { button.textContent = '复制'; }, 1200);
});

window.addEventListener('message', event => {
  const expectedOrigin = `${location.protocol}//${location.hostname}:${state.viewProxyPort}`;
  const data = event.data;
  if (event.origin !== expectedOrigin || data?.source !== 'wyn-ai-demo' || !['wyn-frame-scroll', 'wyn-frame-resize'].includes(data?.type)) return;
  const isKnownFrame = [...document.querySelectorAll('.wyn-view-frame')]
    .some(frame => frame.contentWindow === event.source);
  if (!isKnownFrame) return;
  if (data.type === 'wyn-frame-resize') {
    const height = Math.max(360, Math.min(1400, Number(data.height) || 0));
    if (!height) return;
    const frame = [...document.querySelectorAll('.wyn-view-frame')]
      .find(item => item.contentWindow === event.source);
    const wrap = frame?.closest('.wyn-frame-wrap');
    if (!wrap) return;
    wrap.style.height = `${height}px`;
    return;
  }
  const deltaY = Math.max(-600, Math.min(600, Number(data.deltaY) || 0));
  elements.messages.scrollBy({ top: deltaY, left: 0, behavior: 'auto' });
});

window.addEventListener('resize', () => {
  state.agentCharts.forEach(chart => chart.resize());
  state.smartCharts.forEach(entry => entry.chart.resize());
});

initializeSidebar();
renderAgentFilters();
await Promise.all([loadHealth(), loadDatasets(), loadAgentRuns()]);
elements.input.focus();
