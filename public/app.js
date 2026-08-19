const elements = {
  appShell: document.querySelector('.app-shell'),
  sidebarToggle: document.querySelector('#sidebar-toggle'),
  messages: document.querySelector('#messages'),
  welcome: document.querySelector('#welcome-card'),
  input: document.querySelector('#question-input'),
  send: document.querySelector('#send-button'),
  dataset: document.querySelector('#dataset-select'),
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
  if (section === 'reports') section = 'analysis';
  state.currentSection = requestedSection;
  const isChat = section === 'chat';
  const isInsights = section === 'insights';
  const isAnalysis = section === 'analysis';
  elements.chatWorkspace.hidden = !isChat;
  elements.insightsWorkspace.hidden = !isInsights;
  elements.agentWorkspace.hidden = !isAnalysis;
  elements.workspaceTitle.textContent = isChat ? '智能数据助手' : isInsights ? '数据洞察' : requestedSection === 'reports' ? '智能报告' : 'AI 数据分析';
  elements.clear.hidden = !isChat;
  elements.navItems.forEach(item => item.classList.toggle('active', item.dataset.section === requestedSection));
  if (isChat) elements.input.focus();
  else if (isInsights) loadAnalysisResults();
  else if (requestedSection === 'reports' && state.agentRun) {
    requestAnimationFrame(() => document.querySelector('#agent-report')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  } else if (isAnalysis && elements.agentDataset.value && !state.agentMetadata) {
    loadAgentMetadata(elements.agentDataset.value);
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
  const measures = (query.measures || []).map(item => item.alias || item.name || item.value?.name).filter(Boolean);
  const groups = (query.groupBy || []).map(item => item.alias || item.name || item.value?.name).filter(Boolean);
  const chartType = chart.visualization?.chartType || 'Auto';
  const viewProxyOrigin = `${location.protocol}//${location.hostname}:${state.viewProxyPort}`;
  // Wyn 前端需要检测到 token 参数才会进入分析视图；代理会把此占位值替换为服务端真实 Token。
  const viewUrl = `${viewProxyOrigin}/dashboards/chatanalysis/view?viewId=${encodeURIComponent(viewId)}&token=proxy`;
  return `
    <div class="view-result">
      <div class="view-result-head">
        <span class="success-mark">✓</span>
        <div><small>Wyn 统计结果已就绪</small><h3>${escapeHtml(query.name || '统计图表已生成')}</h3></div>
      </div>
      <div class="view-meta-strip">
        <span><b>分析</b>${escapeHtml(query.name || '智能分析')}</span>
        <span><b>图表</b>${escapeHtml(chartTypeLabel(chartType))}</span>
        <span><b>指标</b>${escapeHtml(measures.join('、') || '自动选择')}</span>
        <span><b>维度</b>${escapeHtml(groups.join('、') || '全局汇总')}</span>
      </div>
      <div class="wyn-frame-toolbar">
        <span class="wyn-scroll-hint"><span aria-hidden="true">↕</span> 滚轮 / 滑动浏览完整结果</span>
      </div>
      <div class="wyn-frame-wrap">
        <div class="frame-loading"><i></i><i></i><i></i><span>Wyn 正在计算并生成统计图表</span></div>
        <iframe class="wyn-view-frame" src="${escapeHtml(viewUrl)}" title="Wyn AI 统计图表" loading="eager"></iframe>
      </div>
      <div class="view-foot"><span>分析 ID</span><code>${escapeHtml(viewId)}</code><button class="open-insights-link" type="button" data-action="open-insights" data-view-id="${escapeHtml(viewId)}">进入数据洞察 →</button><span class="secure-view">Token 由服务端代理保护</span></div>
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
  elements.send.disabled = sending;
  elements.dataset.disabled = sending;
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

function shortFieldList(values, limit = 4) {
  const fields = Array.isArray(values) ? values : [];
  if (!fields.length) return '—';
  return `${fields.slice(0, limit).join('、')}${fields.length > limit ? ` 等 ${fields.length} 项` : ''}`;
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
    document.querySelector('#agent-engine-model').textContent = data.llmConfigured ? `${data.llmModel} + 确定性分析` : 'Atlas 确定性分析引擎';
  } catch {
    elements.connectionPill.classList.add('error');
    elements.connectionText.textContent = '代理服务异常';
  }
}

async function loadDatasets() {
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
    if (state.datasets[0]) await loadAgentMetadata(state.datasets[0].id);
  } catch (error) {
    elements.dataset.innerHTML = '<option value="">数据集加载失败</option>';
    elements.agentDataset.innerHTML = '<option value="">数据集加载失败</option>';
    elements.connectionPill.classList.add('error');
    elements.connectionText.textContent = '配置需要检查';
    elements.connectionPill.title = error.message;
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

elements.send.addEventListener('click', () => ask());
elements.sidebarToggle.addEventListener('click', () => setSidebarCollapsed(!state.sidebarCollapsed));
elements.input.addEventListener('input', resizeTextarea);
elements.input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ask();
  }
});
elements.clear.addEventListener('click', resetConversation);
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

window.addEventListener('resize', () => state.agentCharts.forEach(chart => chart.resize()));

initializeSidebar();
renderAgentFilters();
await Promise.all([loadHealth(), loadDatasets(), loadAgentRuns()]);
elements.input.focus();
