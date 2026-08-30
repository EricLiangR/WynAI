import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsightDiagnosticLookupError, InsightDiagnosticStore, summarizeDiagnosticLifecycle } from './insight-diagnostic-store.mjs';
import { JsonRunStore } from './lib/run-store.mjs';
import { createLlmGateway } from './llm-gateway.mjs';

test('diagnostic store appends, resolves unique prefixes, and survives reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-diagnostic-'));
  try {
    const persistence = new JsonRunStore(directory, { maxItems: 10 });
    const first = new InsightDiagnosticStore({ persistence, idFactory: () => 'evt-fixed' });
    await first.init();
    await first.append('ins-12345678-aaaa', 'input.accepted', { prompt: '真实输入', rows: [{ value: 1 }] }, { actor: 'tester' });
    await first.append('ins-12345678-aaaa', 'generation.finished', { status: 'completed' });
    assert.equal(first.get('ins-12345678').events.length, 2);

    const second = new InsightDiagnosticStore({ persistence });
    await second.init();
    const restored = second.get('ins-12345678-aaaa');
    assert.equal(restored.schema, 'wynai.insight-diagnostic/v1');
    assert.deepEqual(restored.events.map(event => event.type), ['input.accepted', 'generation.finished']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('diagnostic store rejects ambiguous prefixes', async () => {
  const store = new InsightDiagnosticStore();
  await store.append('ins-abcdefgh-1111', 'input.accepted');
  await store.append('ins-abcdefgh-2222', 'input.accepted');
  assert.throws(() => store.get('ins-abcdefgh'), error => error instanceof InsightDiagnosticLookupError && error.code === 'INSIGHT_DIAGNOSTIC_PREFIX_AMBIGUOUS');
});

test('gateway emits complete provider attempt diagnostics', async () => {
  const events = [];
  const gateway = createLlmGateway({
    providers: [{ id: 'primary', baseUrl: 'https://llm.example.test/v1', apiKey: 'secret', model: 'demo' }],
    timeoutMs: 1000,
    firstByteTimeoutMs: 1000,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }], request }) };
    },
  });
  const value = await gateway.completeJson([{ role: 'user', content: 'keep this' }], { operation: 'insight-planner', onEvent: event => { events.push(event); } });
  assert.deepEqual(value, { ok: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'gateway.attempt');
  assert.equal(events[0].operation, 'insight-planner');
  assert.equal(events[0].request.messages[0].content, 'keep this');
  assert.equal(events[0].response.choices[0].message.content, '{"ok":true}');
  assert.equal(events[0].request.apiKey, undefined);
});

test('diagnostic lifecycle detects open and closed generation attempts', () => {
  const closed = summarizeDiagnosticLifecycle([
    { type: 'generation.started', at: '2026-08-30T00:00:00.000Z', runId: 'ir-closed', data: { runId: 'ir-closed', attempt: 1, attemptId: 'at-closed' } },
    { type: 'generation.finished', at: '2026-08-30T00:00:01.000Z', runId: 'ir-closed', data: { runId: 'ir-closed', attempt: 1, attemptId: 'at-closed', status: 'failed' } },
  ]);
  assert.equal(closed.valid, true);
  assert.equal(closed.openAttempts, 0);
  const open = summarizeDiagnosticLifecycle([
    { type: 'generation.started', at: '2026-08-30T00:00:00.000Z', runId: 'ir-open', data: { runId: 'ir-open', attempt: 1, attemptId: 'at-open' } },
  ]);
  assert.equal(open.valid, false);
  assert.equal(open.openAttempts, 1);
});

test('adaptive context contracts normalize budgets, transport policy, and Skill boundaries', async () => {
  const { normalizeModelCapability, resolveModelBudget, estimateJsonTokens } = await import('./model-capability-profile.mjs');
  const { normalizeTransportPolicy, createEvidenceTransportPlan, decideEvidenceTransport } = await import('./evidence-transport-plan.mjs');
  const { compileSkillPlan } = await import('./skill-plan.mjs');
  const profile = normalizeModelCapability();
  assert.equal(profile.contextWindowTokens, 32768);
  assert.equal(resolveModelBudget(profile, { operationCapTokens: 18000 }).inputBudgetTokens, 18000);
  assert.equal(estimateJsonTokens({ hello: 'world' }, { charsPerToken: 4 }), Math.ceil(JSON.stringify({ hello: 'world' }).length / 4));
  for (const contextWindowTokens of [16384, 32768, 131072]) {
    const configured = normalizeModelCapability({ contextWindowTokens, maxInputTokens: contextWindowTokens, maxOutputTokens: 4096 });
    const budget = resolveModelBudget(configured);
    assert.ok(budget.inputBudgetTokens + budget.outputReserveTokens + budget.safetyReserveTokens + budget.protocolOverheadTokens <= contextWindowTokens);
  }
  assert.deepEqual(normalizeTransportPolicy({ mode: 'invalid', allowLosslessChunking: false }), { mode: 'auto', allowLosslessChunking: false, defaultEvidenceLevel: 'aggregate' });
  const transport = createEvidenceTransportPlan({ mode: 'auto', initialMode: 'aggregate-catalog', finalMode: 'lossless-row-chunk', reason: ['core-evidence-insufficient'], evidence: { sourceRowCount: 418, representedRowCount: 418, chunkCount: 2 } });
  assert.equal(transport.finalMode, 'lossless-row-chunk');
  const decided = decideEvidenceTransport({ skillPlan: { transportPolicy: { mode: 'auto', allowLosslessChunking: true }, methods: [{ id: 'row-anomaly', priority: 'core', rowLevel: true, allowLosslessChunking: true }] }, pack: { resultSets: [{ rows: [{ value: 1 }] }] }, modelBudget: { inputBudgetTokens: 12000 } });
  assert.equal(decided.finalMode, 'lossless-row-chunk');
  assert.ok(decided.reason.includes('auto-core-row-level-method'));
  const skillPlan = compileSkillPlan({ schema: [{ name: '月份' }, { name: '收入' }], skills: [{ id: 'sales-trend', version: '1.0.0', coreMethods: ['trend'], evidenceRequirements: { trend: ['月份', '收入'] }, methodPolicies: { trend: { evidenceLevel: 'aggregate-sufficient' } }, transportPolicy: { mode: 'auto' } }] });
  assert.equal(skillPlan.transportPolicy.mode, 'auto');
  assert.equal(skillPlan.methods[0].evidenceLevel, 'aggregate-sufficient');
});

test('418-row aggregate evidence is summarized per item and does not expand Planner context', async () => {
  const { buildEvidencePack } = await import('./lib/data-insights/evidence-pack.mjs');
  const { runInsightLlmOrchestration } = await import('./lib/data-insights/llm-orchestrator.mjs');
  const rows = Array.from({ length: 418 }, (_, index) => ({ 月份: `2024-${String((index % 6) + 1).padStart(2, '0')}`, 地区: `区域${index}`, 销售额: index + 1 }));
  const input = buildEvidencePack({ evidence: [{ id: 'ev-418', title: '月度区域结果', value: rows }], resultSets: [] });
  let plannerContent = '';
  const llm = { enabled: true, model: 'fake', completeJson: async (messages, options) => {
    if (options.operation === 'insight-planner') { plannerContent = messages[1].content; return { schema: 'wynai.insight-planner/v1', hypotheses: [], toolRequests: [] }; }
    if (options.operation === 'insight-critic') return { schema: 'wynai.insight-critic/v1', verdict: 'sufficient', assessments: [], followUps: [] };
    return { schema: 'wynai.insight-narrator/v1', managementSummary: [{ text: '证据摘要可核验。', evidenceIds: ['ev-418'] }], keyFindings: [{ text: '结果保留完整行数。', evidenceIds: ['ev-418'] }], risks: [{ text: '暂无明确风险。', evidenceIds: ['ev-418'] }], actions: [{ text: '继续复核。', evidenceIds: ['ev-418'] }] };
  } };
  const result = await runInsightLlmOrchestration({ llm, input });
  assert.equal(result.status, 'completed');
  assert.equal(input.evidence[0].value.length, 418);
  assert.match(plannerContent, /chunked-summary-all-rows/);
  assert.match(plannerContent, /rowCount/);
  assert.doesNotMatch(plannerContent, /区域417/);
  assert.equal(result.contextBudget.plannerCatalogTransmission, 'summary-and-evidence-id-only');
});
