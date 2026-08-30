import assert from 'node:assert/strict';

const baseUrl = (process.env.UVT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const question = process.env.UAT_INSIGHT_PROMPT || '请从销售趋势、利润质量、地区贡献和异常风险角度给出有证据支撑的业务洞察。';

async function json(url, options) {
  const response = await fetch(`${baseUrl}${url}`, options);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

const health = await json('/api/llm/health');
assert.equal(health.response.status, 200, `LLM 健康检查失败：${health.payload.code || health.payload.status} ${health.payload.message || ''}`);
assert.equal(health.payload.ok, true);
assert.equal(health.payload.status, 'healthy');

const list = await json('/api/data-insights');
assert.equal(list.response.status, 200);
const requestedInsightId = String(process.env.UAT_INSIGHT_ID || '').trim();
const candidate = requestedInsightId
  ? (list.payload.items || []).find(item => item.insightId === requestedInsightId) || { insightId: requestedInsightId }
  : (list.payload.items || []).find(item => Number(item.rowCount) > 0 && Number(item.columnCount) > 0);
assert.ok(candidate?.insightId, '没有可用于真实数据洞察 E2E 的结果集');

const generated = await json(`/api/data-insights/${candidate.insightId}/generate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ insightId: candidate.insightId, prompt: question }),
});
assert.equal(generated.response.status, 200, `数据洞察生成失败：${generated.payload.error?.code || generated.payload.code} ${generated.payload.error?.message || generated.payload.message || ''}`);
assert.ok(['completed', 'completed-partial'].includes(generated.payload.status), `真实 LLM 洞察状态不可接受：${generated.payload.status}`);
assert.equal(generated.payload.provider, 'llm-orchestrated');
assert.ok(generated.payload.content?.trim(), '真实 LLM 未返回洞察正文');
const stages = generated.payload.orchestration?.stageAudit || [];
const stageNames = stages.map(item => item.stage);
assert.deepEqual(stageNames.slice(0, 3), ['planner', 'critic', 'narrator']);
assert.ok(stageNames.slice(3).every(stage => stage === 'narrator-repair'), '仅允许受控 narrator-repair 追加阶段');
assert.ok(stageNames.filter(stage => stage === 'narrator-repair').length <= 1, 'Narrator 修订不得超过一次');
assert.ok(stages.every(item => item.status === 'completed'), 'Planner/Critic/Narrator 未全部成功');
assert.ok(generated.payload.document?.blocks?.some(block => block.content?.trim()), '页面文档没有可展示正文');
assert.ok(generated.payload.document?.blocks?.some(block => block.title === '管理摘要' && block.content?.trim()), '管理摘要没有可展示正文');

const diagnostics = await json(`/api/data-insights/${candidate.insightId}/diagnostics`);
assert.equal(diagnostics.response.status, 200, '洞察诊断记录不可读取');
const evidenceEvent = [...(diagnostics.payload.events || [])].reverse().find(event => event.type === 'evidence.pack.created');
assert.ok(evidenceEvent?.data?.evidencePack, '缺少 Evidence Pack 诊断');
const coverage = evidenceEvent.data.evidencePack.coverage || {};
if (coverage.sourceCompleteness?.isTruncated === false) {
  assert.equal(coverage.omittedGroups, 0, '完整 InsightInput 的核心派生证据不得再次截断');
  assert.equal(coverage.groupingsComplete, true, '核心派生证据必须完整');
}
assert.equal(coverage.businessSparsity?.missingRowsAreZero, false, '业务无记录不能自动解释为零值');

console.log(JSON.stringify({
  status: 'passed',
  insightId: generated.payload.insightId,
  provider: generated.payload.provider,
  model: generated.payload.model,
  stages: stages.map(item => ({ stage: item.stage, status: item.status, durationMs: item.durationMs })),
  contentLength: generated.payload.content.length,
  coverage,
}, null, 2));
