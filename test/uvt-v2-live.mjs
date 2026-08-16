import assert from 'node:assert/strict';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

async function jsonRequest(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} 返回 ${response.status}: ${payload.message || '未知错误'}`);
  return { response, payload };
}

async function runCase(id, title, action) {
  const startedAt = Date.now();
  try {
    const detail = await action();
    console.log(`PASS ${id} ${title} (${Date.now() - startedAt}ms)${detail ? ` - ${detail}` : ''}`);
  } catch (error) {
    console.error(`FAIL ${id} ${title} - ${error.message}`);
    process.exitCode = 1;
  }
}

async function createRun(datasetId, focus) {
  const { payload } = await jsonRequest('/api/analysis-agent/v2/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetId, focus, strictMode: true }),
  });
  assert.equal(payload.version, 'analysis-run/v2.1');
  assert.equal(payload.status, 'completed');
  assert.equal(payload.analysis.validation.queryMode, 'routed-canonical-v2.1-exploration');
  assert.equal(payload.analysis.validation.sqlAllowed, false);
  assert.equal(payload.analysis.validation.evidenceCoverage, 100);
  assert.equal(payload.analysis.validation.strictMode, true);
  assert.notEqual(payload.analysis.planning.plannerMode, 'deterministic-fallback');
  assert.equal(payload.analysis.planning.plannerDegradedReason, null);
  assert.notEqual(payload.analysis.planning.criticMode, 'deterministic-critic');
  assert.equal(payload.analysis.planning.criticDegradedReason, null);
  assert.deepEqual(payload.audit.warnings, []);
  assert.ok(payload.analysis.report.aiNarrative, '严格 UAT 不允许 AI 报告降级为空');
  assert.notEqual(payload.analysis.report.model, 'Atlas V2.1 确定性降级引擎');
  assert.ok(!payload.analysis.report.warning, `严格 UAT 报告存在警告：${payload.analysis.report.warning || ''}`);
  assert.ok(payload.queries.every(item => /^qry-/i.test(item.request.id)), '查询 ID 必须使用 qry- 前缀');
  assert.equal(new Set(payload.queries.map(item => item.request.id)).size, payload.queries.length, '查询 ID 必须唯一');
  assert.ok(payload.queries.every(item => !item.request.sql && !item.request.wax && !item.request.query && !item.request.payload));
  assert.ok(payload.analysis.charts.every(chart => payload.analysis.evidence.some(evidence => evidence.id === chart.evidenceId)));
  return payload;
}

function explorationQueries(run) {
  return run.queries.filter(item => !item.request.id.startsWith('qry-system-'));
}

function assertInvalidDurationsAreQualified(run) {
  const durationEvidence = run.analysis.evidence.filter(item => item.scope?.invalidDurationFields?.length);
  assert.ok(durationEvidence.length > 0, '真实负时长未被识别为数据质量证据');
  for (const evidence of durationEvidence) {
    const relatedInsights = run.analysis.insights.filter(item => item.evidenceIds?.includes(evidence.id));
    assert.ok(relatedInsights.length > 0, `${evidence.id} 缺少负时长解读`);
    assert.ok(relatedInsights.every(item => /负值|异常/.test(item.statement) && /排除|不可|不能|无效/.test(item.statement)), `${evidence.id} 仍把负时长用于正常经营排名`);
    const relatedCharts = run.analysis.charts.filter(chart => chart.evidenceId === evidence.id);
    for (const chart of relatedCharts) {
      for (const field of evidence.scope.invalidDurationFields) {
        const series = chart.series?.find(item => item.name === field);
        if (series) assert.ok(series.values.every(value => value == null || value >= 0), `${field} 负值仍进入图表序列`);
      }
    }
    const reportItems = Object.values(run.analysis.report.aiStructured || {}).flat();
    assert.ok(reportItems.some(item => item.evidenceIds?.includes(evidence.id) && /负值|异常/.test(item.text) && /排除|不可|不能|无效|核验|验证|核查|误判/.test(item.text)), `${evidence.id} 的 AI 报告未披露负时长边界`);
    for (const item of reportItems.filter(item => item.evidenceIds?.includes(evidence.id) && evidence.scope.invalidDurationFields.some(field => item.text.includes(field)) && /瓶颈|最慢|最高|最低|效率最佳|效率最差/.test(item.text))) {
      assert.match(item.text, /负值|异常|排除|不可|不能|无效/, `${evidence.id} 将无效时长字段用于正常效率排名`);
    }
  }
}

let dataset;
let metadata;
let availableDatasets = [];
let llmConfigured = false;
const runs = new Map();

await runCase('UAT-V21-01', 'Wyn 连接与 LLM 配置状态', async () => {
  const { payload } = await jsonRequest('/api/health');
  assert.equal(payload.connected, true);
  llmConfigured = Boolean(payload.llmConfigured);
  return `Wyn ${payload.status}, LLM ${payload.llmConfigured ? `${payload.llmModel} 已配置（真实连通由 Planner/报告用例验证）` : '未配置'}`;
});

await runCase('UAT-V21-02', '读取销售数据集语义能力', async () => {
  const { payload } = await jsonRequest('/api/datasets');
  assert.ok(payload.total > 0);
  availableDatasets = payload.datasets;
  dataset = payload.datasets.find(item => /销售/.test(item.name)) || payload.datasets[0];
  metadata = (await jsonRequest(`/api/datasets/${dataset.id}/metadata`)).payload;
  assert.ok(metadata.roles.measure.length > 0);
  assert.ok(metadata.roles.time.length > 0);
  return `${dataset.name}, ${metadata.fieldCount} fields`;
});

await runCase('UAT-V21-03', '利润问题生成利润诊断路径', async () => {
  const run = await createRun(dataset.id, '利润为什么下降？请检查收入增长是否真正带来利润改善，并定位高收入低利润的业务实体。');
  runs.set('profitability', run);
  assert.equal(run.analysis.planning.intent, 'profitability');
  assert.ok(explorationQueries(run).some(item => item.request.measures.some(metric => /利润|毛利/.test(metric.field || ''))));
  assert.ok(run.analysis.insights.some(item => item.topic === 'profitability'));
  return `${run.analysis.planning.plannerMode}, ${explorationQueries(run).map(item => item.request.id).join(',')}`;
});

await runCase('UAT-V21-04', '客户问题生成客户经营路径', async () => {
  const run = await createRun(dataset.id, '哪些客户存在经营风险？重点检查客户集中度、客户收入贡献和利润质量。');
  runs.set('customer', run);
  assert.equal(run.analysis.planning.intent, 'customer');
  assert.ok(explorationQueries(run).some(item => item.request.select.some(field => /客户名称|客户编号/.test(field.field))));
  assert.ok(run.analysis.insights.some(item => item.topic === 'customer'));
  return `${run.analysis.planning.plannerMode}, ${explorationQueries(run).map(item => item.request.id).join(',')}`;
});

await runCase('UAT-V21-05', '产品问题生成产品组合路径', async () => {
  const run = await createRun(dataset.id, '产品结构是否健康？请识别高收入低利润产品以及需要优化的品类。');
  runs.set('product', run);
  assert.equal(run.analysis.planning.intent, 'product');
  assert.ok(explorationQueries(run).some(item => item.request.select.some(field => /商品|产品|类别|品类/.test(field.field))));
  assert.ok(run.analysis.insights.some(item => item.topic === 'product'));
  return `${run.analysis.planning.plannerMode}, ${explorationQueries(run).map(item => item.request.id).join(',')}`;
});

await runCase('UAT-V21-06', '异常问题由时间结果触发下钻', async () => {
  const run = await createRun(dataset.id, '最近有哪些异常波动？先识别显著时间变化，再根据结果决定是否下钻。');
  runs.set('anomaly', run);
  assert.equal(run.analysis.planning.intent, 'anomaly');
  assert.ok(explorationQueries(run).some(item => item.request.select.some(field => field.grain)));
  const followups = explorationQueries(run).filter(item => item.round > 1);
  assert.ok(followups.length > 0);
  assert.ok(followups.every(item => item.request.lineage?.triggerResultSetIds?.length));
  return `${run.analysis.planning.criticMode}, follow-up ${followups.map(item => item.request.id).join(',')}`;
});

await runCase('UAT-V21-07', '无关注方向执行开放探索', async () => {
  const run = await createRun(dataset.id, '');
  runs.set('open', run);
  assert.equal(run.analysis.planning.intent, 'open');
  assert.ok(run.hypotheses.filter(item => !item.id.startsWith('hyp-system-')).length >= 3);
  assert.ok(new Set(explorationQueries(run).map(item => item.request.topic)).size >= 2);
  return `${run.analysis.planning.plannerMode}, ${run.hypotheses.length} hypotheses`;
});

await runCase('UAT-V21-08', '五类问题的查询树和图表结构存在真实差异', async () => {
  assert.equal(runs.size, 5);
  const querySignatures = [...runs.values()].map(run => explorationQueries(run).map(item => `${item.request.topic}:${item.request.select.map(field => field.field).join('+')}:${item.request.measures.map(metric => metric.field || metric.aggregation).join('+')}`).sort().join('|'));
  assert.equal(new Set(querySignatures).size, querySignatures.length);
  const chartSignatures = [...runs.values()].map(run => run.analysis.charts.map(chart => `${chart.topic}:${chart.xField}:${chart.yField}`).sort().join('|'));
  assert.ok(new Set(chartSignatures).size >= 4);
  if (llmConfigured) assert.ok([...runs.values()].filter(run => /^ai-(planner|guided-planner)$/.test(run.analysis.planning.plannerMode)).length >= 4);
  return `${new Set(querySignatures).size} query trees, ${new Set(chartSignatures).size} chart structures`;
});

await runCase('UAT-V21-11', '年度销售驾驶舱必须执行多主题开放分析并保持订单口径正确', async () => {
  const target = availableDatasets.find(item => item.name === '零售数据');
  assert.ok(target, '缺少零售数据集');
  const run = await createRun(target.id, '完成全国年度销售管理驾驶舱建设');
  runs.set('dashboard', run);
  assert.equal(run.analysis.planning.intent, 'open');
  const queries = explorationQueries(run);
  assert.ok(queries.length >= 3);
  assert.ok(new Set(queries.flatMap(item => item.request.select.map(field => field.field))).size >= 3);
  const orderKpi = run.analysis.kpis.find(item => item.id === 'orders');
  assert.ok(orderKpi?.rawValue > 8, `订单数口径异常：${orderKpi?.rawValue}`);
  assert.ok(run.analysis.charts.length >= 3);
  const timeSets = run.resultSets.filter(item => queries.some(query => query.request.id === item.requestId && query.request.select.some(field => field.grain)));
  assert.ok(timeSets.every(item => item.statistics.rowCount < 200), '时间粒度仍为日级结果');
  return `${run.analysis.planning.plannerMode}, ${queries.length} queries, ${run.analysis.charts.length} charts, orders=${orderKpi.rawValue}`;
});

await runCase('UAT-V21-12', '智慧试验室必须执行 TAT、达标或流程状态分析且禁止伪造财务指标', async () => {
  const target = availableDatasets.find(item => /智慧试验室运营中心数据/.test(item.name));
  assert.ok(target, '缺少智慧试验室运营数据集');
  const run = await createRun(target.id, '完成智慧试验室运营分析，从项目、效率、有效性、关键指标等视角进行分析，发现运营风险、异常，并形成有数据支撑的改进计划');
  runs.set('laboratory', run);
  assert.equal(run.analysis.planning.intent, 'open');
  const queries = explorationQueries(run);
  const measureFields = queries.flatMap(item => item.request.measures.map(metric => metric.field).filter(Boolean));
  assert.ok(measureFields.some(field => /TAT|耗时|达标|准时|及时/.test(field)), `未执行运营指标：${measureFields.join(',')}`);
  assert.ok(!measureFields.includes('科室类型'));
  const efficiency = queries.find(item => item.request.id === 'qry-operational-efficiency');
  assert.ok(efficiency, '缺少运营效率查询');
  assert.ok(efficiency.request.measures.some(metric => /TAT|耗时|时长/.test(metric.field || '')), '运营效率查询未使用时长指标');
  assert.ok(!efficiency.request.measures.some(metric => /^是否/.test(metric.field || '')), '运营效率查询误用布尔标志作为时长');
  const compliance = queries.find(item => item.request.id === 'qry-compliance-rate');
  assert.ok(compliance, '缺少达标率查询');
  assert.ok(compliance.request.measures.filter(metric => metric.field).every(metric => /达标|及时|准时|通过/.test(metric.field)), '达标率查询混入非合规布尔标志');
  assert.ok(queries.some(item => item.request.select.some(field => /状态|科室|专业组|检测项目/.test(field.field))));
  assert.ok(!run.analysis.kpis.some(item => /利润率|科室类型合计|平均订单金额/.test(item.label)));
  assert.ok(run.analysis.charts.length >= 3);
  assertInvalidDurationsAreQualified(run);
  return `${run.analysis.planning.plannerMode}, ${queries.map(item => item.request.id).join(',')}`;
});

await runCase('UAT-V21-13', '分环节 TAT 问题必须比较真实处理阶段且禁止把状态标志当时长', async () => {
  const target = availableDatasets.find(item => /智慧试验室运营中心数据/.test(item.name));
  assert.ok(target, '缺少智慧试验室运营数据集');
  const run = await createRun(target.id, '前处理、分析、后处理哪个环节是TAT瓶颈？请比较各科室的总TAT和分环节平均时长，定位效率风险。');
  runs.set('laboratory-tat', run);
  assert.equal(run.analysis.planning.intent, 'open');
  const queries = explorationQueries(run);
  const stageQuery = queries.find(item => new Set(item.request.measures.map(metric => metric.field).filter(field => /前处理TAT|分析TAT|后处理TAT/.test(field))).size >= 3);
  assert.ok(stageQuery, '未形成覆盖前处理、分析和后处理的 TAT 瓶颈查询');
  assert.ok(stageQuery.request.select.some(field => /科室|专业组/.test(field.field)), 'TAT 瓶颈查询缺少组织定位维度');
  assert.ok(!stageQuery.request.measures.some(metric => /^是否/.test(metric.field || '')), 'TAT 瓶颈查询混入布尔标志');
  assertInvalidDurationsAreQualified(run);
  return `${run.analysis.planning.plannerMode}, ${stageQuery.request.id}`;
});

await runCase('UAT-V21-14', '危急值通知问题必须使用通知耗时与及时率并形成项目或通知方式定位', async () => {
  const target = availableDatasets.find(item => /智慧试验室运营中心数据/.test(item.name));
  assert.ok(target, '缺少智慧试验室运营数据集');
  const run = await createRun(target.id, '危急值通知是否及时？请按危急值检测项目和通知方式定位通知耗时、及时率风险，不要分析销售或利润。');
  runs.set('laboratory-critical', run);
  assert.equal(run.analysis.planning.intent, 'open');
  const queries = explorationQueries(run);
  assert.ok(!queries.some(item => ['qry-operational-efficiency', 'qry-compliance-rate', 'qry-process-status'].includes(item.request.id)), '危急值专项混入了无关的全局 TAT、达标或流程状态查询');
  const notificationQueries = queries.filter(item => item.request.measures.some(metric => /通知耗时|是否及时通知/.test(metric.field || '')));
  assert.ok(notificationQueries.length > 0, '未执行危急值通知指标查询');
  const modeQueries = notificationQueries.filter(item => item.request.select.some(field => /通知方式/.test(field.field)));
  const projectQueries = notificationQueries.filter(item => item.request.select.some(field => /检测项目/.test(field.field)));
  assert.ok(modeQueries.length > 0, '未按通知方式定位风险');
  assert.ok(projectQueries.length > 0, '未按检测项目定位风险');
  const singleValueProjectQuery = projectQueries.find(item => {
    const selection = item.request.select.find(field => /检测项目/.test(field.field));
    const resultSet = run.resultSets.find(result => result.requestId === item.request.id);
    return selection && resultSet?.rows?.length && resultSet.rows.every(row => row[selection.alias] != null && !/[,，、;；]/.test(String(row[selection.alias])));
  });
  assert.ok(singleValueProjectQuery, '检测项目查询仍按多值组合字符串聚合，不能作为单项目结论');
  const notificationTimeQueries = notificationQueries.filter(item => item.request.select.some(field => field.grain));
  for (const query of notificationTimeQueries) {
    const timeSelection = query.request.select.find(field => field.grain);
    const resultSet = run.resultSets.find(result => result.requestId === query.request.id);
    assert.ok(resultSet?.rows?.every(row => row[timeSelection.alias] != null), `${query.request.id} 混入空时间分组`);
    assert.ok(timeSelection.grain !== 'day' || query.request.limit >= 500, `${query.request.id} 日粒度仅截取局部期间却可能被解释为完整趋势`);
  }
  const notificationFields = new Set(notificationQueries.flatMap(item => item.request.measures.map(metric => metric.field).filter(Boolean)));
  assert.ok(notificationFields.has('通知耗时'));
  assert.ok(notificationFields.has('是否及时通知'));
  assert.ok(!run.analysis.kpis.some(item => /收入|利润|订单金额/.test(item.label)), '危急值场景生成了无关财务 KPI');
  assert.doesNotMatch(JSON.stringify(run.analysis.report.aiStructured), /(?:产生|通知|报告|创建|采集|签收)时间[^。；]*为\s*0(?:\D|$)/, '时间聚合被错误解释为数值 0');
  return `${run.analysis.planning.plannerMode}, ${notificationQueries.map(item => item.request.id).join(',')}`;
});

await runCase('UAT-V21-09', '安全校验、证据链和敏感信息保护', async () => {
  const rawQuery = await fetch(`${baseUrl}/api/analysis-agent/v2/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetId: dataset.id, sql: 'select * from source' }),
  });
  assert.equal(rawQuery.status, 400);
  for (const run of runs.values()) {
    assert.ok(run.resultSets.every(item => item.schema && item.statistics && item.scope && item.provenance && item.quality));
    const detail = run.resultSets.find(item => item.requestId === 'qry-system-quality');
    assert.equal(detail.rowStorage, 'not-persisted-sensitive-detail');
    assert.equal(detail.rows.length, 0);
    assert.doesNotMatch(JSON.stringify(run), /WYN_TOKEN|LLM_API_KEY|[A-F0-9]{64}/i);
  }
  return `raw SQL ${rawQuery.status}, ${runs.size} evidence chains verified`;
});

await runCase('UAT-V21-10', '持久化与动态报告导出', async () => {
  const list = await jsonRequest('/api/analysis-agent/v2/runs');
  for (const run of runs.values()) assert.ok(list.payload.items.some(item => item.id === run.id));
  const signatures = [];
  for (const [intent, run] of runs) {
    const response = await fetch(`${baseUrl}/api/analysis-agent/v2/runs/${run.id}/report?format=html`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.length > 1000);
    assert.doesNotMatch(body, /WYN_TOKEN|LLM_API_KEY|token=/i);
    signatures.push(`${intent}:${(body.match(/<section class="chart">/g) || []).length}:${run.analysis.charts.map(chart => chart.title).join('|')}`);
  }
  assert.equal(new Set(signatures).size, signatures.length);
  return `${runs.size} persisted runs and dynamic exports`;
});

if (process.exitCode) process.exit(process.exitCode);
console.log('UAT V2.1 COMPLETE: all live acceptance cases passed.');
