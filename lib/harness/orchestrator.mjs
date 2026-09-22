import { buildExplorationArtifacts, buildDynamicReportMarkdown } from '../analytics/exploration-artifacts.mjs';
import {
  buildSystemProbeRequests,
  createFollowupPlan,
  createInitialExplorationPlan,
  queryFingerprint,
} from '../planning/exploration-planner.mjs';
import { DatasetNoneAdapter } from '../query/adapters/dataset-none.mjs';
import { ControlledWaxAdapter } from '../query/adapters/controlled-wax.mjs';
import { assertAdaptersAllowed, assertExecutionAllowed, resolveExecutionPolicy } from '../query/execution-policy.mjs';
import { QueryRouter } from '../query/router.mjs';
import { summarizeResultSet } from '../query/result-normalizer.mjs';
import { buildSemanticCapabilityProfile } from '../semantics/capability-profiler.mjs';

const DEFAULT_BUDGET = Object.freeze({
  maxRounds: 3,
  maxQueries: 10,
  maxConcurrentQueries: 4,
  maxAggregateRowsPerQuery: 20000,
  maxDetailRowsPerQuery: 20000,
  maxRuntimeMs: 180000,
});

function timelineEvent(type, detail = {}) {
  return { type, at: new Date().toISOString(), ...detail };
}

async function executeInBatches(router, requests, context, batchSize, events, round) {
  const outcomes = [];
  const failures = [];
  for (let index = 0; index < requests.length; index += batchSize) {
    const batch = requests.slice(index, index + batchSize);
    const settled = await Promise.all(batch.map(async input => {
      events.push(timelineEvent('query.started', { queryId: input.id, purpose: input.purpose, round }));
      try {
        const outcome = await router.execute(input, context);
        events.push(timelineEvent('query.completed', {
          queryId: outcome.request.id,
          adapter: outcome.executionPlan.adapter,
          rowCount: outcome.resultSet.statistics.rowCount,
          round,
        }));
        return { status: 'fulfilled', outcome: { ...outcome, round } };
      } catch (error) {
        events.push(timelineEvent('query.degraded', { queryId: input.id, message: error.message, round }));
        return { status: 'rejected', input, error };
      }
    }));
    for (const item of settled) {
      if (item.status === 'fulfilled') outcomes.push(item.outcome);
      else failures.push({ request: item.input, round, message: item.error.message, attempts: item.error.attempts || [] });
    }
  }
  return { outcomes, failures };
}

function restoreDetailRows(resultSet) {
  return (resultSet?.rows || []).map(row => Object.fromEntries(resultSet.schema.map(column => [column.sourceField, row[column.name]])));
}

function overviewAggregate(outcome) {
  if (!outcome) return null;
  return {
    rows: outcome.resultSet.rows,
    plan: {
      id: 'overview',
      purpose: outcome.request.purpose,
      queryType: outcome.executionPlan.adapter,
      spec: { canonicalRequestId: outcome.request.id, mode: outcome.request.mode },
    },
    durationMs: outcome.resultSet.provenance.durationMs,
    truncated: outcome.resultSet.quality.isTruncated,
  };
}

function findingFromInsight(insight) {
  return {
    id: insight.id.replace(/^insight-/, 'finding-'),
    type: insight.category === '质量' ? 'risk' : 'fact',
    topic: insight.topic || 'quality',
    title: insight.title,
    claim: insight.statement,
    evidenceIds: insight.evidenceIds || [],
    counterEvidenceIds: [],
    confidence: insight.confidence || 'medium',
    verificationStatus: insight.evidenceIds?.length ? 'verified' : 'needs-review',
    businessImpact: insight.category === '质量' ? 'medium' : 'high',
    reportPriority: insight.category === '质量' ? 0.65 : 0.9,
  };
}

function uniqueRequests(requests) {
  const ids = new Set();
  const fingerprints = new Set();
  return requests.filter(request => {
    if (!request || ids.has(request.id)) return false;
    const fingerprint = queryFingerprint(request);
    if (fingerprints.has(fingerprint)) return false;
    ids.add(request.id);
    fingerprints.add(fingerprint);
    return true;
  });
}

function buildRunPlan({ metadata, planning, hypotheses, firstRound, followupRound, failures }) {
  const queryCount = firstRound.length + followupRound.length;
  return {
    focus: planning.focus,
    intent: planning.intent,
    plannerMode: planning.mode,
    criticMode: planning.criticMode,
    summary: planning.summary,
    selectedFields: planning.profile.roles,
    steps: [
      { id: 'semantic', title: '建立语义能力画像', detail: `识别 ${metadata.fieldCount || 0} 个字段和 ${Object.values(planning.profile.capabilities).filter(Boolean).length} 类可用能力`, status: 'completed' },
      { id: 'planner', title: '生成问题驱动分析计划', detail: `${planning.mode} · ${planning.intent} · ${planning.summary}`, status: planning.degradedReason ? 'partial' : 'completed' },
      ...hypotheses.map(item => ({
        id: item.id,
        title: item.question,
        detail: `${item.businessValue} · ${item.status}`,
        status: item.status === 'supported' ? 'completed' : item.status === 'rejected' ? 'skipped' : item.status,
      })),
      { id: 'critic', title: '根据结果决定下钻或停止', detail: `${planning.criticMode} · ${planning.criticSummary || '未追加查询'}`, status: planning.criticDegradedReason ? 'partial' : 'completed' },
      { id: 'routing', title: '执行受控查询', detail: `${queryCount} 个查询，第二轮 ${followupRound.length} 个，失败 ${failures.length} 个`, status: failures.length ? 'partial' : 'completed' },
      { id: 'evidence', title: '生成证据与动态呈现', detail: '仅使用本次实际查询结果生成 Finding、图表和报告章节', status: 'completed' },
    ],
  };
}

function applyAssessments(hypotheses, assessments, queryRecords) {
  const assessmentMap = new Map((assessments || []).map(item => [item.hypothesisId, item]));
  for (const item of hypotheses) {
    const assessed = assessmentMap.get(item.id);
    if (assessed) {
      item.status = assessed.status === 'needs_followup' ? 'testing' : assessed.status;
      item.stopReason = assessed.reason || null;
      item.triggerResultSetIds = assessed.triggerResultSetIds || [];
      continue;
    }
    const related = queryRecords.filter(record => record.request.hypothesisId === item.id);
    item.status = related.some(record => record.status === 'completed') ? 'supported' : 'inconclusive';
    if (item.status === 'inconclusive') item.stopReason = '相关查询未成功完成';
  }
  for (const item of hypotheses.filter(candidate => candidate.status === 'testing')) {
    const childCompleted = hypotheses.some(candidate => candidate.parentHypothesisId === item.id && candidate.status === 'supported');
    if (childCompleted) item.status = 'supported';
  }
}

export async function runAutonomousAnalysis({
  metadata,
  focus = '',
  constraints = {},
  executeDatasetQuery,
  analyzeDataset,
  explorationAgent = null,
  skills = [],
  budget = DEFAULT_BUDGET,
  strictMode = false,
  executionPolicy,
}) {
  const startedAt = Date.now();
  const events = [timelineEvent('run.started'), timelineEvent('semantic.started')];
  const resolvedExecutionPolicy = resolveExecutionPolicy(executionPolicy);
  const adapters = resolvedExecutionPolicy.id === 'smart-query'
    ? [new ControlledWaxAdapter()]
    : [new ControlledWaxAdapter(), new DatasetNoneAdapter()];
  assertAdaptersAllowed(adapters, resolvedExecutionPolicy.id);
  const router = new QueryRouter(adapters);
  const filters = Array.isArray(constraints.filters) ? constraints.filters : [];
  const profile = buildSemanticCapabilityProfile(metadata);
  events.push(timelineEvent('semantic.completed', { fieldCount: metadata.fieldCount, capabilities: profile.capabilities }));

  const initialPlan = await createInitialExplorationPlan({
    metadata,
    profile,
    focus,
    filters,
    skills,
    budget,
    aiPlanner: explorationAgent?.enabled ? explorationAgent.plan : null,
  });
  if (strictMode && initialPlan.mode === 'deterministic-fallback') {
    const error = new Error(`严格分析禁止 Planner 降级：${initialPlan.degradedReason || 'AI Planner 未生成有效计划'}`);
    error.status = 422;
    throw error;
  }
  if (strictMode && !initialPlan.requests.length) {
    const error = new Error('严格分析未生成可执行的探索查询');
    error.status = 422;
    throw error;
  }
  events.push(timelineEvent('planner.completed', { mode: initialPlan.mode, intent: initialPlan.intent, summary: initialPlan.summary }));
  const systemHypothesis = {
    id: 'hyp-system-baseline',
    question: '当前数据范围和最小经营基线是否可用？',
    businessValue: '为后续探索提供可复核口径',
    priority: 1,
    status: 'candidate',
    requiredEvidence: ['质量样本', '全量概览'],
    parentHypothesisId: null,
    generatedBy: 'system-probe/v2.1',
    stopReason: null,
  };
  const hypotheses = [systemHypothesis, ...initialPlan.hypotheses];
  hypotheses.forEach(item => events.push(timelineEvent('hypothesis.created', { hypothesisId: item.id, question: item.question, generatedBy: item.generatedBy })));

  const initialRequests = uniqueRequests([
    ...buildSystemProbeRequests(metadata, profile, filters, skills),
    ...initialPlan.requests,
  ]).slice(0, budget.maxQueries);
  const context = { metadata, executeDatasetQuery };
  const first = await executeInBatches(router, initialRequests, context, budget.maxConcurrentQueries, events, 1);
  first.outcomes.forEach(outcome => assertExecutionAllowed(outcome, resolvedExecutionPolicy.id));
  const sampleOutcome = first.outcomes.find(item => item.request.id === 'qry-system-quality');
  if (!sampleOutcome) {
    const error = new Error(`受控质量样本未能读取：${first.failures.find(item => item.request.id === 'qry-system-quality')?.message || '未知错误'}`);
    error.status = 502;
    throw error;
  }
  if (strictMode && first.failures.length) {
    const error = new Error(`严格分析首轮查询失败：${first.failures.map(item => `${item.request.id}: ${item.message}`).join('；')}`);
    error.status = 422;
    error.diagnostics = {
      phase: 'initial-query',
      failures: first.failures.map(item => ({ request: item.request, message: item.message, round: item.round })),
      fallbackExecuted: false,
    };
    throw error;
  }

  const executedFingerprints = new Set(first.outcomes.map(item => queryFingerprint(item.request)));
  const remainingBudget = Math.max(0, budget.maxQueries - initialRequests.length);
  const followupPlan = await createFollowupPlan({
    metadata,
    profile,
    focus,
    filters,
    skills,
    initialPlan,
    outcomes: first.outcomes,
    remainingBudget,
    executedFingerprints,
    aiCritic: explorationAgent?.enabled ? explorationAgent.critique : null,
  });
  if (strictMode && followupPlan.degradedReason) {
    const error = new Error(`严格分析禁止 Critic 降级：${followupPlan.degradedReason}`);
    error.status = 422;
    error.diagnostics = {
      phase: 'critic',
      mode: followupPlan.mode,
      attempts: followupPlan.attempts || 2,
      degradedReason: followupPlan.degradedReason,
      validationErrors: followupPlan.validationErrors || [],
      lastInvalidCritique: followupPlan.lastInvalidCritique || null,
      fallbackExecuted: false,
    };
    throw error;
  }
  for (const item of followupPlan.hypotheses) {
    hypotheses.push(item);
    events.push(timelineEvent('hypothesis.created', { hypothesisId: item.id, question: item.question, generatedBy: item.generatedBy }));
  }
  events.push(timelineEvent('critic.completed', { mode: followupPlan.mode, summary: followupPlan.summary, followupQueries: followupPlan.requests.length }));
  const followupRequests = uniqueRequests(followupPlan.requests).slice(0, remainingBudget);
  const second = await executeInBatches(router, followupRequests, context, budget.maxConcurrentQueries, events, 2);
  second.outcomes.forEach(outcome => assertExecutionAllowed(outcome, resolvedExecutionPolicy.id));
  const allOutcomes = [...first.outcomes, ...second.outcomes];
  const allFailures = [...first.failures, ...second.failures];
  if (strictMode && allFailures.length) {
    const error = new Error(`严格分析存在查询失败：${allFailures.map(item => `${item.request.id}: ${item.message}`).join('；')}`);
    error.status = 422;
    error.diagnostics = { failures: allFailures.map(item => ({ request: item.request, message: item.message, round: item.round })) };
    throw error;
  }

  const overviewOutcome = allOutcomes.find(item => item.request.id === 'qry-system-overview');
  const overview = overviewAggregate(overviewOutcome);
  const rows = restoreDetailRows(sampleOutcome.resultSet);
  const analysis = analyzeDataset({
    metadata,
    rows,
    aggregates: overview ? { overview } : null,
    filters: sampleOutcome.request.filters,
    goal: focus || '自主发现当前数据中最有价值的经营问题。',
    rowLimit: sampleOutcome.request.limit,
  });

  const artifacts = buildExplorationArtifacts(allOutcomes);
  const retainedEvidenceIds = new Set(['ev-total', 'ev-orders', 'ev-average', 'ev-profit', 'ev-margin', 'ev-quality']);
  analysis.version = 'analysis-run/v2.1';
  analysis.focus = focus;
  analysis.charts = artifacts.charts;
  analysis.insights = [
    ...analysis.insights.filter(item => item.id === 'insight-quality'),
    ...artifacts.insights,
  ];
  analysis.evidence = [
    ...analysis.evidence.filter(item => retainedEvidenceIds.has(item.id)),
    ...artifacts.evidence,
  ];

  const queryRecords = allOutcomes.map(outcome => ({
    request: outcome.request,
    executionPlan: outcome.executionPlan,
    resultSetId: outcome.resultSet.id,
    round: outcome.round,
    status: 'completed',
  }));
  queryRecords.push(...allFailures.map(item => ({ request: item.request, executionPlan: null, resultSetId: null, round: item.round, status: 'degraded', error: item.message })));
  applyAssessments(hypotheses, followupPlan.assessments, queryRecords);

  analysis.execution = {
    dataSource: 'wyn-dataset-api',
    queryType: 'CANONICAL_EXPLORATION_V21',
    sampleQueryType: sampleOutcome.executionPlan.adapter,
    sampleRowLimit: sampleOutcome.request.limit,
    filters: sampleOutcome.request.filters,
    waxStatus: allOutcomes.some(item => item.executionPlan.adapter === 'wyn-wax-controlled') ? 'completed' : 'fallback',
    waxQueryCount: allOutcomes.filter(item => item.executionPlan.adapter === 'wyn-wax-controlled').length,
    queryCount: queryRecords.length,
    adapterCount: new Set(allOutcomes.map(item => item.executionPlan.adapter)).size,
    queryPlans: queryRecords.map(item => ({
      id: item.request.id,
      hypothesisId: item.request.hypothesisId,
      topic: item.request.topic,
      purpose: item.request.purpose,
      mode: item.request.mode,
      round: item.round,
      lineage: item.request.lineage,
      adapter: item.executionPlan?.adapter || null,
      status: item.status,
      durationMs: allOutcomes.find(outcome => outcome.request.id === item.request.id)?.resultSet.provenance.durationMs ?? null,
    })),
    sqlAllowed: false,
    strictMode: Boolean(strictMode),
  };
  const planning = {
    focus,
    intent: initialPlan.intent,
    mode: initialPlan.mode,
    model: initialPlan.model,
    summary: initialPlan.summary,
    methods: initialPlan.aiMethods || [],
    requestedMethods: initialPlan.aiRequestedMethods || initialPlan.aiMethods || [],
    aiHypotheses: initialPlan.aiHypotheses || [],
    degradedReason: initialPlan.degradedReason,
    criticMode: followupPlan.mode,
    criticSummary: followupPlan.summary,
    criticDegradedReason: followupPlan.degradedReason || null,
    criticRepairs: followupPlan.repairs || [],
    skillRefs: skills.map(skill => `${skill.id}@${skill.version}`),
    profile,
  };
  analysis.planning = {
    intent: planning.intent,
    plannerMode: planning.mode,
    plannerModel: planning.model,
    plannerSummary: planning.summary,
    plannerMethods: planning.methods,
    plannerRequestedMethods: planning.requestedMethods,
    aiHypotheses: planning.aiHypotheses,
    plannerDegradedReason: planning.degradedReason,
    criticMode: planning.criticMode,
    criticSummary: planning.criticSummary,
    criticDegradedReason: planning.criticDegradedReason,
    criticRepairs: planning.criticRepairs,
    skillRefs: planning.skillRefs,
  };
  analysis.profile.sourceTruncated = sampleOutcome.resultSet.quality.isTruncated;
  analysis.profile.sourceLimitReached = sampleOutcome.resultSet.quality.limitReached;
  analysis.profile.sourceTruncationConfidence = sampleOutcome.resultSet.quality.truncationConfidence;
  analysis.plan = buildRunPlan({ metadata, planning, hypotheses, firstRound: first.outcomes, followupRound: second.outcomes, failures: allFailures });
  analysis.report.markdown = buildDynamicReportMarkdown(analysis, planning);
  analysis.report.summary = [planning.summary, ...analysis.insights.map(item => item.statement)];
  analysis.report.actions = ['围绕已验证信号补充业务事件、责任主体和管理口径复核，再制定行动方案。'];

  const findings = analysis.insights.map(findingFromInsight);
  const validEvidence = new Set(analysis.evidence.map(item => item.id));
  const evidencedClaims = analysis.insights.filter(item => item.evidenceIds?.length && item.evidenceIds.every(id => validEvidence.has(id))).length;
  analysis.validation = {
    ...analysis.validation,
    claimCount: analysis.insights.length,
    evidencedClaimCount: evidencedClaims,
    evidenceCoverage: analysis.insights.length ? Math.round(evidencedClaims / analysis.insights.length * 100) : 100,
    scopeVerifiedClaims: artifacts.evidence.filter(item => item.verification?.valid).length,
    scopeRejectedClaims: artifacts.evidence.filter(item => item.verification && !item.verification.valid).length,
    executionStrategy: resolvedExecutionPolicy.id === 'smart-query'
      ? 'smart-query-wax-only'
      : 'data-insight-governed-routing',
    sqlAllowed: false,
    strictMode: Boolean(strictMode),
  };

  events.push(timelineEvent('evidence.verified', { findings: findings.length, coverage: analysis.validation.evidenceCoverage }));
  events.push(timelineEvent('report.completed'));
  const warnings = [initialPlan.degradedReason, followupPlan.degradedReason, ...allFailures.map(item => item.message)].filter(Boolean);
  if (strictMode && warnings.length) {
    const error = new Error(`严格分析禁止降级：${warnings.join('；')}`);
    error.status = 422;
    throw error;
  }
  return {
    version: 'analysis-run/v2.1',
    analysis,
    hypotheses,
    queries: queryRecords,
    resultSets: allOutcomes.map(outcome => summarizeResultSet(outcome.resultSet, {
      retainRows: !['projection', 'mining'].includes(outcome.request.mode),
    })),
    findings,
    budget: {
      ...budget,
      usedQueries: queryRecords.length,
      usedRounds: followupRequests.length ? 2 : 1,
      runtimeMs: Date.now() - startedAt,
    },
    audit: {
      capabilityMatrix: router.capabilityMatrix(),
      planning: analysis.planning,
      timeline: events,
      warnings,
    },
  };
}

export { DEFAULT_BUDGET };
