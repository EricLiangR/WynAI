const NUMBER_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const PERCENT_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

function arrayValue(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/,/g, '').replace(/%$/, '').trim();
  if (!normalized) return null;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

export function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function inferFieldRole(field) {
  const name = String(field.name || '');
  const description = String(field.description || '');
  const type = `${field.type || ''} ${field.rawType || ''}`;
  const numeric = /number|decimal|double|float|int|long/i.test(type);
  if (/date|datetime|timestamp/i.test(type) || (!numeric && /日期|时间|年月|月份|年度|年份|时间戳/.test(name))) return 'time';
  if (/编号|编码|代码|(^|\b)id($|\b)/i.test(name) || /^(订单|单号)$/.test(name) || /唯一.*(?:编号|单号)/.test(description)) return 'identifier';
  if ([5, 6, 8, 9].includes(Number(field.aiHint)) || /地区|区域|省份|城市|国家|经度|纬度/.test(name)) return 'geography';
  if (numeric && (/类型|状态|类别/.test(name) || (/(?:^|[\s,，;；])[012]\s*=/.test(description) && !/是否|达标|及时|准时|通过/.test(name)))) return 'dimension';
  if (numeric) return 'measure';
  return 'dimension';
}

function inferValueKind(field, role) {
  const name = String(field.name || '');
  const description = String(field.description || '');
  const type = `${field.type || ''} ${field.rawType || ''}`;
  const numeric = /number|decimal|double|float|int|long|byte/i.test(type);
  if (role === 'time') return 'temporal';
  if (role === 'identifier') return 'identifier';
  if (numeric && (/是否|达标|及时|准时|通过/.test(name) || /(?:^|[\s,，;；])[01]\s*=/.test(description))) return 'boolean';
  if (role === 'dimension' || role === 'geography') return 'categorical';
  if (numeric && /TAT|耗时|时长|用时|周期|分钟|小时|天数/.test(`${name} ${description}`)) return 'duration';
  if (numeric) return 'continuous';
  return 'categorical';
}

export function isGroupableField(field) {
  const valueKind = field?.valueKind || inferValueKind(field, field?.role);
  return ['categorical', 'boolean', 'temporal'].includes(valueKind);
}

function collectSynonyms(info = {}) {
  const values = [info.Synonyms, info.synonyms, info.Aliases, info.aliases, info.Dictionary, info.dictionary]
    .flatMap(arrayValue)
    .flatMap(value => typeof value === 'string' ? value.split(/[,，;；|]/) : [])
    .map(value => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

export function normalizeDatasetMetadata(documentInfo = {}, definition = {}) {
  const assistantInfo = definition.AIAssistantInfo || {};
  const assistantByField = new Map(
    arrayValue(assistantInfo.ColumnAssistantInfos)
      .filter(Boolean)
      .map(item => [item.ColumnName, item]),
  );
  const fields = arrayValue(definition.Fields).map(rawField => {
    const assistant = assistantByField.get(rawField.Name) || {};
    const field = {
      name: rawField.Name || rawField.DataField || '',
      dataField: rawField.DataField || rawField.Name || '',
      type: rawField.TypeName || rawField.RawType || rawField.ClrType || 'Unknown',
      rawType: rawField.RawType || rawField.ClrType || '',
      format: rawField.Format || '',
      fieldType: rawField.FieldType || 'Normal',
      aggregation: rawField.Aggregation || null,
      aiHint: Number(rawField.DataVizAIHint || 0),
      description: assistant.Description || rawField.Description || rawField.MSDescription || '',
      synonyms: collectSynonyms(assistant),
    };
    const role = inferFieldRole(field);
    return { ...field, role, valueKind: inferValueKind(field, role) };
  }).filter(field => field.name);

  return {
    id: documentInfo.id || '',
    name: definition.Name || documentInfo.displayName || documentInfo.title || '未命名数据集',
    description: assistantInfo.Description || documentInfo.description || '',
    revision: documentInfo.revisionNo ?? null,
    supportChatAnalysis: Boolean(documentInfo.docTypeExtFields?.supportChatAnalysis || assistantInfo.Enabled),
    indexed: Boolean(definition.Indexed ?? documentInfo.docTypeExtFields?.indexed),
    fields,
    fieldCount: fields.length,
    roles: Object.fromEntries(['time', 'measure', 'dimension', 'geography', 'identifier'].map(role => [
      role,
      fields.filter(field => field.role === role).map(field => field.name),
    ])),
    query: {
      dataSources: arrayValue(definition.Query?.DataSources).map(item => ({ id: item.Id, name: item.Name, type: item.Type })),
      parameterCount: arrayValue(definition.Query?.QueryParameters).length,
      filterCount: arrayValue(definition.Filters).length,
      groupFieldCount: arrayValue(definition.GroupFields).length,
      waxExpressionCount: arrayValue(definition.WAXExpressions).length,
    },
    assistant: {
      enabled: Boolean(assistantInfo.Enabled),
      describedFieldCount: fields.filter(field => field.description).length,
      synonymCount: fields.reduce((total, field) => total + field.synonyms.length, 0),
    },
  };
}

function findField(fields, patterns, role) {
  const candidates = role ? fields.filter(field => field.role === role) : fields;
  for (const pattern of patterns) {
    const match = candidates.find(field => pattern.test(field.name) || pattern.test(`${field.name} ${field.description || ''}`));
    if (match) return match;
  }
  return null;
}

export function selectAnalysisFields(metadata) {
  const fields = metadata.fields || [];
  const measures = fields.filter(field => field.role === 'measure');
  const dimensions = fields.filter(field => ['dimension', 'geography'].includes(field.role));
  return {
    date: findField(fields, [/订购日期|订单日期|销售日期|日期|月份|时间/], 'time'),
    primaryMeasure: findField(measures, [/销售额|订单金额|营业收入|收入|成交金额|金额/], 'measure'),
    profitMeasure: findField(measures, [/订单利润|销售利润|毛利|利润/], 'measure'),
    quantityMeasure: findField(measures, [/购买数量|销售数量|销量|数量/], 'measure'),
    orderId: findField(fields, [/订单编号|订单号|交易编号|^订单$/]),
    category: findField(dimensions, [/类别名称|产品类别|商品类别|品类|分类/]),
    region: findField(dimensions, [/客户地区|销售区域|地区|区域|省份/]),
    customer: findField(dimensions, [/客户名称/, /^客户$/]),
    product: findField(dimensions, [/商品名称/, /产品名称/, /^商品$/, /^产品$/]),
  };
}

function sumField(rows, fieldName) {
  return rows.reduce((total, row) => total + (toNumber(row[fieldName]) || 0), 0);
}

function uniqueCount(rows, fieldName) {
  if (!fieldName) return rows.length;
  return new Set(rows.map(row => row[fieldName]).filter(value => value !== null && value !== undefined && value !== '')).size;
}

function groupSum(rows, dimension, measure, limit = 10) {
  if (!dimension || !measure) return [];
  const totals = new Map();
  for (const row of rows) {
    const keyValue = row[dimension];
    const numeric = toNumber(row[measure]);
    if (keyValue == null || keyValue === '' || numeric == null) continue;
    const key = String(keyValue);
    totals.set(key, (totals.get(key) || 0) + numeric);
  }
  return [...totals.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function monthlyTrend(rows, dateField, measureField) {
  if (!dateField || !measureField) return [];
  const totals = new Map();
  for (const row of rows) {
    const date = toDate(row[dateField]);
    const value = toNumber(row[measureField]);
    if (!date || value == null) continue;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    totals.set(key, (totals.get(key) || 0) + value);
  }
  return [...totals.entries()]
    .map(([period, value]) => ({ period, value }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

function aggregateRows(aggregates, id) {
  const result = aggregates?.[id];
  return Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
}

function aggregateQueryPlan(aggregates, id, fallback) {
  const result = aggregates?.[id];
  return result?.plan ? {
    id: result.plan.id,
    purpose: result.plan.purpose,
    queryType: result.plan.queryType,
    spec: result.plan.spec,
    durationMs: result.durationMs,
  } : fallback;
}

function normalizeBreakdown(rows, limit) {
  return rows.map(row => ({ label: String(row.group1 ?? row.label ?? ''), value: toNumber(row.value) }))
    .filter(item => item.label && item.value != null)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function completeness(rows, fields) {
  if (!rows.length || !fields.length) return 0;
  const valid = rows.reduce((total, row) => total + fields.filter(field => {
    const value = row[field.name];
    return value !== null && value !== undefined && value !== '';
  }).length, 0);
  return Math.round(valid / (rows.length * fields.length) * 1000) / 10;
}

function dateRange(rows, fieldName) {
  if (!fieldName) return { start: null, end: null };
  const values = rows.map(row => toDate(row[fieldName])).filter(Boolean).sort((a, b) => a - b);
  if (!values.length) return { start: null, end: null };
  return { start: values[0].toISOString(), end: values.at(-1).toISOString() };
}

function parseBusinessThreshold(field) {
  const match = String(field?.description || '').match(/(\d+(?:\.\d+)?)\s*万/);
  return match ? Number(match[1]) * 10_000 : null;
}

function formatCurrency(value) {
  return `¥${NUMBER_FORMAT.format(value)}`;
}

function formatPercent(value) {
  return `${PERCENT_FORMAT.format(value)}%`;
}

function evidence(id, title, fields, rowCount, value, method, queryPlan) {
  return { id, title, fields: fields.filter(Boolean), rowCount, value, method, queryPlan };
}

export function buildAnalysisPlan(metadata, goal = '') {
  const selected = selectAnalysisFields(metadata);
  const steps = [
    { id: 'semantic', title: '理解数据语义', detail: `读取 ${metadata.fieldCount || 0} 个字段及业务描述`, status: 'ready' },
    { id: 'profile', title: '检查分析数据', detail: '确认数据范围、完整度和关键字段', status: 'ready' },
    { id: 'overview', title: '计算经营概览', detail: '计算核心指标和业务规模', status: selected.primaryMeasure ? 'ready' : 'skipped' },
    { id: 'trend', title: '识别趋势变化', detail: '按时间粒度分析变化与突变', status: selected.date && selected.primaryMeasure ? 'ready' : 'skipped' },
    { id: 'drivers', title: '分析业务贡献', detail: '比较类别、区域和客户贡献', status: selected.primaryMeasure ? 'ready' : 'skipped' },
    { id: 'report', title: '生成证据化报告', detail: goal || '形成结论、风险与行动建议', status: 'ready' },
  ];
  return { goal, selectedFields: Object.fromEntries(Object.entries(selected).map(([key, field]) => [key, field?.name || null])), steps };
}

export function analyzeDataset({ metadata, rows, aggregates = null, filters = [], goal = '全面分析经营情况，识别趋势、驱动因素与风险。', rowLimit = 5000 }) {
  const safeRows = Array.isArray(rows) ? rows.slice(0, rowLimit) : [];
  const selected = selectAnalysisFields(metadata);
  const measureName = selected.primaryMeasure?.name;
  const profitName = selected.profitMeasure?.name;
  const orderIdName = selected.orderId?.name;
  const overview = aggregateRows(aggregates, 'overview')[0] || null;
  const sourceRowCount = toNumber(overview?.source_rows) ?? safeRows.length;
  const total = overview && measureName ? (toNumber(overview.total) ?? 0) : measureName ? sumField(safeRows, measureName) : 0;
  const profit = overview && profitName ? toNumber(overview.profit) : profitName ? sumField(safeRows, profitName) : null;
  const orderCount = overview ? (toNumber(overview.orders) ?? sourceRowCount) : uniqueCount(safeRows, orderIdName);
  const averageOrder = orderCount ? total / orderCount : 0;
  const profitMargin = profit != null && total ? profit / total * 100 : null;
  const quality = completeness(safeRows, metadata.fields || []);
  const range = overview && selected.date ? {
    start: toDate(overview.date_min)?.toISOString() || null,
    end: toDate(overview.date_max)?.toISOString() || null,
  } : dateRange(safeRows, selected.date?.name);
  const trendRows = aggregateRows(aggregates, 'trend');
  const trend = trendRows.length
    ? monthlyTrend(trendRows.map(row => ({ date: row.group1, value: row.value })), 'date', 'value')
    : monthlyTrend(safeRows, selected.date?.name, measureName);
  const categoryRows = aggregateRows(aggregates, 'category');
  const regionRows = aggregateRows(aggregates, 'region');
  const customerRows = aggregateRows(aggregates, 'customer');
  const category = categoryRows.length ? normalizeBreakdown(categoryRows, 8) : groupSum(safeRows, selected.category?.name, measureName, 8);
  const region = regionRows.length ? normalizeBreakdown(regionRows, 8) : groupSum(safeRows, selected.region?.name, measureName, 8);
  const customers = customerRows.length ? normalizeBreakdown(customerRows, 100) : groupSum(safeRows, selected.customer?.name, measureName, 10);
  const threshold = parseBusinessThreshold(selected.primaryMeasure);
  const keyCustomers = threshold ? customers.filter(item => item.value >= threshold) : [];

  const evidenceItems = [];
  const insights = [];
  const charts = [];
  const kpis = [];

  if (measureName) {
    kpis.push({ id: 'total', label: `${measureName}合计`, value: formatCurrency(total), rawValue: total, tone: 'violet' });
    evidenceItems.push(evidence('ev-total', `${measureName}合计`, [measureName], sourceRowCount, total, overview ? 'Wyn WAX 完整数据集求和' : '逐行求和', aggregateQueryPlan(aggregates, 'overview', { operation: 'sum', measure: measureName })));
  }
  kpis.push({ id: 'orders', label: orderIdName ? '订单数量' : '记录数量', value: NUMBER_FORMAT.format(orderCount), rawValue: orderCount, tone: 'cyan' });
  evidenceItems.push(evidence('ev-orders', orderIdName ? '订单去重计数' : '记录计数', [orderIdName], sourceRowCount, orderCount, overview ? 'Wyn WAX 完整数据集计数' : orderIdName ? '去重计数' : '记录计数', aggregateQueryPlan(aggregates, 'overview', { operation: 'distinctCount', field: orderIdName })));
  if (measureName) {
    kpis.push({ id: 'average', label: '平均订单金额', value: formatCurrency(averageOrder), rawValue: averageOrder, tone: 'amber' });
    evidenceItems.push(evidence('ev-average', '平均订单金额', [measureName, orderIdName], sourceRowCount, averageOrder, '完整数据集金额合计除以订单去重计数', aggregateQueryPlan(aggregates, 'overview', { operation: 'ratio', numerator: measureName, denominator: orderIdName || 'rowCount' })));
  }
  if (profit != null) {
    kpis.push({ id: 'profit', label: `${profitName}合计`, value: formatCurrency(profit), rawValue: profit, tone: 'green' });
    evidenceItems.push(evidence('ev-profit', `${profitName}合计`, [profitName], sourceRowCount, profit, overview ? 'Wyn WAX 完整数据集求和' : '逐行求和', aggregateQueryPlan(aggregates, 'overview', { operation: 'sum', measure: profitName })));
  }
  if (profitMargin != null) {
    kpis.push({ id: 'margin', label: '利润率', value: formatPercent(profitMargin), rawValue: profitMargin, tone: profitMargin >= 0 ? 'green' : 'rose' });
    evidenceItems.push(evidence('ev-margin', '利润率', [profitName, measureName], sourceRowCount, profitMargin, '完整数据集利润合计除以金额合计', aggregateQueryPlan(aggregates, 'overview', { operation: 'ratio', numerator: profitName, denominator: measureName })));
  }

  if (trend.length) {
    charts.push({ id: 'chart-trend', type: 'line', title: `${measureName}月度趋势`, xField: selected.date.name, yField: measureName, labels: trend.map(item => item.period), values: trend.map(item => item.value), evidenceId: 'ev-trend' });
    const latest = trend.at(-1);
    const previous = trend.at(-2);
    const changeRate = previous?.value ? (latest.value - previous.value) / previous.value * 100 : null;
    const peak = trend.reduce((best, item) => item.value > best.value ? item : best, trend[0]);
    let largestChange = null;
    for (let index = 1; index < trend.length; index += 1) {
      if (!trend[index - 1].value) continue;
      const rate = (trend[index].value - trend[index - 1].value) / trend[index - 1].value * 100;
      if (!largestChange || Math.abs(rate) > Math.abs(largestChange.rate)) largestChange = { period: trend[index].period, rate };
    }
    evidenceItems.push(evidence('ev-trend', '月度趋势序列', [selected.date.name, measureName], sourceRowCount, trend, trendRows.length ? 'Wyn WAX 按日期聚合后汇总至月份' : '按月分组求和', aggregateQueryPlan(aggregates, 'trend', { operation: 'groupSum', dimension: selected.date.name, grain: 'month', measure: measureName })));
    insights.push({
      id: 'insight-trend',
      category: '趋势',
      title: `${peak.period} 达到阶段峰值`,
      statement: changeRate == null
        ? `当前数据覆盖 ${trend.length} 个月，峰值月份为 ${peak.period}。`
        : `最近一个月 ${latest.period} 较上月${changeRate >= 0 ? '增长' : '下降'} ${formatPercent(Math.abs(changeRate))}；最大环比波动出现在 ${largestChange?.period || latest.period}。`,
      confidence: trend.length >= 6 ? 'high' : 'medium',
      evidenceIds: ['ev-trend'],
    });
  }

  const addBreakdown = (id, title, field, items, tone) => {
    if (!field || !items.length) return;
    const evidenceId = `ev-${id}`;
    const top = items[0];
    const share = total ? top.value / total * 100 : 0;
    charts.push({ id: `chart-${id}`, type: 'bar', title, xField: field.name, yField: measureName, labels: items.map(item => item.label), values: items.map(item => item.value), evidenceId });
    evidenceItems.push(evidence(evidenceId, title, [field.name, measureName], sourceRowCount, items, aggregateRows(aggregates, id).length ? 'Wyn WAX 完整数据集分组求和并排序' : '分组求和并降序排列', aggregateQueryPlan(aggregates, id, { operation: 'groupSum', dimension: field.name, measure: measureName, limit: items.length })));
    insights.push({ id: `insight-${id}`, category: '贡献', title: `${top.label} 位居首位`, statement: `${top.label} 的${measureName}为 ${formatCurrency(top.value)}，约占总体 ${formatPercent(share)}。`, confidence: 'high', evidenceIds: [evidenceId], tone });
  };
  addBreakdown('category', `${selected.category?.name || '类别'}贡献`, selected.category, category, 'violet');
  addBreakdown('region', `${selected.region?.name || '区域'}贡献`, selected.region, region, 'cyan');

  if (threshold && selected.customer && keyCustomers.length) {
    evidenceItems.push(evidence('ev-key-customers', '重点客户识别', [selected.customer.name, measureName], sourceRowCount, keyCustomers, `依据完整数据集客户聚合与字段语义阈值 ${formatCurrency(threshold)}`, aggregateQueryPlan(aggregates, 'customer', { operation: 'groupFilter', dimension: selected.customer.name, measure: measureName, operator: '>=', threshold })));
    insights.push({ id: 'insight-key-customers', category: '客户', title: `识别 ${keyCustomers.length} 个重点客户`, statement: `根据“${selected.primaryMeasure.description}”的业务定义，共有 ${keyCustomers.length} 个客户达到重点客户标准。`, confidence: 'high', evidenceIds: ['ev-key-customers'] });
  }

  evidenceItems.push(evidence('ev-quality', '质量样本完整度', (metadata.fields || []).map(field => field.name), safeRows.length, quality, '受控样本非空单元格占比', { operation: 'sampleCompleteness', sampleRows: safeRows.length, sourceRows: sourceRowCount }));
  insights.push({ id: 'insight-quality', category: '质量', title: `质量样本完整度 ${formatPercent(quality)}`, statement: quality >= 95 ? `当前 ${safeRows.length} 行质量样本未发现显著缺失问题。` : '质量样本中部分字段存在缺失，应在形成管理决策前核对数据口径和刷新状态。', confidence: safeRows.length ? 'high' : 'low', evidenceIds: ['ev-quality'] });

  const actions = [];
  const trendInsight = insights.find(item => item.id === 'insight-trend');
  if (trendInsight) actions.push('针对最大环比波动月份按区域、类别和客户继续下钻，确认变化来自业务因素还是数据刷新。');
  if (category[0]) actions.push(`围绕高贡献类别“${category[0].label}”制定增长保持与集中度风险检查方案。`);
  if (region[0]) actions.push(`复盘领先区域“${region[0].label}”的客户结构和产品组合，判断经验是否可复制。`);
  if (keyCustomers.length) actions.push('为重点客户建立持续监测清单，跟踪收入、利润和复购变化。');
  if (quality < 95) actions.push('先处理缺失字段和异常记录，再将结论用于正式经营决策。');

  const summary = [
    measureName ? `本次分析覆盖 ${sourceRowCount} 行数据，${measureName}合计 ${formatCurrency(total)}。` : `本次分析覆盖 ${sourceRowCount} 行数据。`,
    trend.length ? insights.find(item => item.id === 'insight-trend')?.statement : '当前数据未识别到可用的时间趋势字段。',
    category[0] ? `${selected.category.name}中贡献最高的是 ${category[0].label}。` : '',
    region[0] ? `${selected.region.name}中贡献最高的是 ${region[0].label}。` : '',
  ].filter(Boolean);
  const markdown = [
    '## 管理摘要',
    '',
    ...summary.map(item => `- ${item}`),
    '',
    '## 核心发现',
    '',
    ...insights.map(item => `- **${item.title}**：${item.statement}`),
    '',
    '## 建议动作',
    '',
    ...actions.map((item, index) => `${index + 1}. ${item}`),
    '',
    '## 数据与方法',
    '',
    `- 数据集：${metadata.name}`,
    `- 数据范围：${range.start ? range.start.slice(0, 10) : '未知'} 至 ${range.end ? range.end.slice(0, 10) : '未知'}`,
    `- 分析范围：${sourceRowCount} 行，${metadata.fieldCount || 0} 个字段`,
    `- 质量样本：${safeRows.length} 行，完整度 ${formatPercent(quality)}`,
    `- 过滤条件：${filters.length ? filters.map(item => `${item.field} ${item.operator} ${item.value}`).join('；') : '无'}`,
    '- 所有数值结论均由确定性程序计算，并关联到查询计划和证据记录。',
  ].join('\n');

  const plan = buildAnalysisPlan(metadata, goal);
  plan.steps = plan.steps.map(step => ({ ...step, status: step.status === 'ready' ? 'completed' : step.status }));
  const evidencedClaims = insights.filter(item => item.evidenceIds?.length).length;

  return {
    version: 'analysis-run/v1',
    goal,
    dataset: { id: metadata.id, name: metadata.name, revision: metadata.revision },
    semanticSummary: {
      description: metadata.description,
      fieldCount: metadata.fieldCount,
      describedFieldCount: metadata.assistant?.describedFieldCount || 0,
      roles: metadata.roles,
      selectedFields: plan.selectedFields,
    },
    plan,
    profile: {
      rowCount: sourceRowCount,
      sampleRowCount: safeRows.length,
      rowLimit,
      truncated: Array.isArray(rows) && rows.length > safeRows.length,
      columnCount: metadata.fieldCount || 0,
      completeness: quality,
      dateRange: range,
    },
    kpis,
    charts,
    insights,
    evidence: evidenceItems,
    report: { title: `${metadata.name}经营分析报告`, summary, actions, markdown },
    validation: {
      claimCount: insights.length,
      evidencedClaimCount: evidencedClaims,
      evidenceCoverage: insights.length ? Math.round(evidencedClaims / insights.length * 100) : 100,
      queryMode: aggregates ? 'dataset-wax-controlled' : 'dataset-none-controlled',
      sqlAllowed: false,
    },
  };
}
