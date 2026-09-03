/**
 * Platform candidate business orchestrators.
 *
 * The platform migration runtime owns routing. This module owns the candidate
 * business boundary so modules can migrate independently without changing the
 * legacy executor or leaking migration metadata into user-facing documents.
 */
const SCHEMA = 'wynai.platform-business-orchestrator/v1';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function countInsightRows(input = {}) {
  return (Array.isArray(input.resultSets) ? input.resultSets : [])
    .reduce((total, resultSet) => total + (Array.isArray(resultSet?.rows) ? resultSet.rows.length : 0), 0);
}

export function buildInsightCandidateContextAudit({ record = null, prompt = '' } = {}) {
  const input = record?.input || record || {};
  const datasets = Array.isArray(input.datasets) ? input.datasets : [];
  const resultSets = Array.isArray(input.resultSets) ? input.resultSets : [];
  const skills = Array.isArray(input.context?.skills)
    ? input.context.skills
    : Array.isArray(record?.skill?.refs) ? record.skill.refs : [];
  return {
    schema: 'wynai.platform-context-audit/v1',
    version: 1,
    originalQuestionPresent: Boolean(String(prompt || input.title || '').trim()),
    datasetCount: datasets.length,
    resultSetCount: resultSets.length,
    rowCount: countInsightRows(input),
    skillCount: skills.length,
    permissionScopePresent: Boolean(input.scope || input.context?.permissions),
    evidenceCount: Array.isArray(input.evidence) ? input.evidence.length : 0,
    preservedCoreContext: ['original-question', 'dataset-metadata', 'permissions-and-scope', 'evidence-provenance'],
  };
}

function decorateInsightResult(result, audit, startedAt) {
  if (!result || typeof result !== 'object') return result;
  const orchestration = result.orchestration && typeof result.orchestration === 'object'
    ? result.orchestration
    : {};
  return {
    ...result,
    orchestration: {
      ...orchestration,
      platformCandidate: {
        schema: SCHEMA,
        version: 1,
        profile: 'data-insight-platform-candidate-v1',
        stagePolicy: 'planner-critic-narrator-preserve',
        contextAudit: clone(audit),
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    },
  };
}

/**
 * Candidate data-insight orchestration boundary. `execute` remains injected so
 * the module's LLM policy can evolve independently from the legacy path.
 */
export function createCandidateInsightOrchestrator({ execute } = {}) {
  if (typeof execute !== 'function') throw new TypeError('候选数据洞察编排器需要 execute 函数');
  return {
    schema: SCHEMA,
    version: 1,
    profile: 'data-insight-platform-candidate-v1',
    async run({ record = null, prompt = '', diagnosticContext = {} } = {}) {
      const startedAt = Date.now();
      const contextAudit = buildInsightCandidateContextAudit({ record, prompt });
      const result = await execute({
        record,
        prompt,
        ...diagnosticContext,
        migrationPath: 'candidate',
        orchestrationProfile: 'data-insight-platform-candidate-v1',
        contextAudit,
      });
      return decorateInsightResult(result, contextAudit, startedAt);
    },
  };
}

export function buildSmartQueryCandidateContextAudit(input = {}) {
  return {
    schema: 'wynai.platform-context-audit/v1',
    version: 1,
    originalQuestionPresent: Boolean(String(input.question || '').trim() || (Array.isArray(input.messages) && input.messages.length)),
    messageCount: Array.isArray(input.messages) ? input.messages.length : 0,
    activeMetricCount: Array.isArray(input.context?.activeMetrics) ? input.context.activeMetrics.length : 0,
    activeDimensionCount: Array.isArray(input.context?.activeDimensions) ? input.context.activeDimensions.length : 0,
    activeFilterCount: Array.isArray(input.context?.activeFilters) ? input.context.activeFilters.length : 0,
    skillCount: Array.isArray(input.skills) ? input.skills.length : 0,
    datasetId: input.dataset?.id || input.datasetId || null,
    preservedCoreContext: ['original-question', 'active-conversation-context', 'dataset-metadata', 'skill-references', 'permissions-and-scope'],
  };
}

export function createCandidateSmartQueryOrchestrator({ normalize } = {}) {
  if (typeof normalize !== 'function') throw new TypeError('候选智能问数编排器需要 normalize 函数');
  return {
    schema: SCHEMA,
    version: 1,
    profile: 'smart-query-platform-candidate-v1',
    run(input = {}) {
      const contextAudit = buildSmartQueryCandidateContextAudit(input);
      const request = normalize(clone(input));
      return {
        request,
        candidate: {
          schema: SCHEMA,
          version: 1,
          profile: 'smart-query-platform-candidate-v1',
          contextAudit,
        },
      };
    },
  };
}

export const platformBusinessOrchestratorVersion = SCHEMA;
