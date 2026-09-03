import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInsightCandidateContextAudit,
  buildSmartQueryCandidateContextAudit,
  createCandidateInsightOrchestrator,
  createCandidateSmartQueryOrchestrator,
} from './platform-business-orchestrators.mjs';

test('候选数据洞察编排器保留核心上下文并附加候选审计', async () => {
  const calls = [];
  const orchestrator = createCandidateInsightOrchestrator({
    execute: async input => {
      calls.push(input);
      return { status: 'completed', structured: { keyFindings: [] }, orchestration: { stageAudit: [{ stage: 'planner' }] } };
    },
  });
  const record = { input: { title: '分析销售收入', datasets: [{ id: 'dataset-1' }], resultSets: [{ rows: [{ revenue: 1 }] }], evidence: [{ id: 'ev-1' }], scope: { filters: [] }, context: { skills: ['retail@1'] } } };
  const result = await orchestrator.run({ record, prompt: '分析销售收入', diagnosticContext: { traceId: 'trace-1' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].migrationPath, 'candidate');
  assert.equal(calls[0].orchestrationProfile, 'data-insight-platform-candidate-v1');
  assert.equal(calls[0].contextAudit.rowCount, 1);
  assert.equal(result.orchestration.platformCandidate.profile, 'data-insight-platform-candidate-v1');
  assert.deepEqual(result.structured, { keyFindings: [] });
});

test('候选智能问数编排器规范化前复制输入且保留多轮上下文', () => {
  let received;
  const orchestrator = createCandidateSmartQueryOrchestrator({
    normalize: input => {
      received = input;
      return { schema: 'wynai.ai-interaction-request/v1', question: input.question, context: input.context };
    },
  });
  const input = { dataset: { id: 'dataset-1' }, question: '继续看华东', messages: [{ role: 'user', content: '上一轮' }], context: { activeMetrics: ['revenue'], activeDimensions: ['region'], activeFilters: [{ field: 'region', value: '华东' }] }, skills: ['retail@1'] };
  const result = orchestrator.run(input);
  assert.notEqual(received, input);
  assert.equal(result.request.context.activeFilters[0].value, '华东');
  assert.equal(result.candidate.contextAudit.activeFilterCount, 1);
  assert.equal(result.candidate.profile, 'smart-query-platform-candidate-v1');
});

test('候选上下文审计覆盖数据集、结果集和多轮 Skill 信息', () => {
  const insightAudit = buildInsightCandidateContextAudit({ record: { input: { title: 'x', datasets: [{ id: 'd' }], resultSets: [{ rows: [{ a: 1 }, { a: 2 }] }], context: { skills: ['s@1'] } } } });
  assert.deepEqual({ datasetCount: insightAudit.datasetCount, resultSetCount: insightAudit.resultSetCount, rowCount: insightAudit.rowCount, skillCount: insightAudit.skillCount }, { datasetCount: 1, resultSetCount: 1, rowCount: 2, skillCount: 1 });
  const smartAudit = buildSmartQueryCandidateContextAudit({ question: 'q', messages: [{ content: 'm' }], context: { activeMetrics: ['m'], activeDimensions: ['d'], activeFilters: [{}] }, skills: ['s'] });
  assert.equal(smartAudit.messageCount, 1);
  assert.equal(smartAudit.activeMetricCount, 1);
  assert.equal(smartAudit.activeDimensionCount, 1);
  assert.equal(smartAudit.skillCount, 1);
});
