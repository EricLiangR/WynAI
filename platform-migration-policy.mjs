const MODES = ['legacy', 'shadow', 'canary', 'platform'];
const REQUIRED_GATES = ['automatedTests', 'contractValidation', 'goldenBaseline', 'uatEvidence', 'rollbackReady'];

export function normalizeMigrationMode(value) { return MODES.includes(String(value || '').trim()) ? String(value).trim() : 'legacy'; }

function normalizePercentage(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

function normalizeSet(value) {
  return new Set((Array.isArray(value) ? value : String(value || '').split(',')).map(item => String(item || '').trim()).filter(Boolean));
}

function stableBucket(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

/**
 * Deterministic, request-local migration routing. It never mutates the
 * configured fallback and is safe to use for shadow/canary percentage rollout.
 */
export function createMigrationRoutingPolicy({ defaultMode = 'legacy', moduleModes = {}, percentage = 100, users = [], organizations = [], salt = 'wynai-platform-v1' } = {}) {
  const normalizedDefault = normalizeMigrationMode(defaultMode);
  const normalizedModules = Object.fromEntries(Object.entries(moduleModes || {}).map(([module, mode]) => [String(module), normalizeMigrationMode(mode)]));
  const rolloutPercentage = normalizePercentage(percentage);
  const userAllowList = normalizeSet(users);
  const organizationAllowList = normalizeSet(organizations);

  function resolve({ module = 'unknown', identity = {}, context = {} } = {}) {
    const actor = String(identity?.userId || identity?.actor || context?.userId || context?.actor || '').trim();
    const organizationId = String(identity?.organizationId || context?.organizationId || '').trim();
    const requestedMode = normalizedModules[module] || normalizedDefault;
    const allowListed = Boolean((actor && userAllowList.has(actor)) || (organizationId && organizationAllowList.has(organizationId)));
    const key = `${salt}:${module}:${organizationId}:${actor}`;
    const bucket = stableBucket(key);
    const selected = requestedMode === 'legacy'
      ? 'legacy'
      : allowListed || bucket < rolloutPercentage ? requestedMode : 'legacy';
    return {
      mode: selected,
      configuredMode: requestedMode,
      module,
      bucket,
      percentage: rolloutPercentage,
      allowListed,
      reason: requestedMode === 'legacy' ? 'configured-legacy' : selected === requestedMode ? (allowListed ? 'allow-list' : 'percentage') : 'outside-rollout',
    };
  }

  function snapshot() {
    return {
      schema: 'wynai.platform-migration-routing/v1',
      version: 1,
      defaultMode: normalizedDefault,
      moduleModes: { ...normalizedModules },
      percentage: rolloutPercentage,
      allowListConfigured: { users: userAllowList.size > 0, organizations: organizationAllowList.size > 0 },
      saltVersion: salt,
    };
  }

  return { schema: 'wynai.platform-migration-routing/v1', version: 1, resolve, snapshot };
}

export function evaluateMigrationPromotion({ mode, gates = {}, comparisons = [], openDefects = [], goldenReport = null, goldenCaseIds = [] } = {}) {
  const normalizedMode = normalizeMigrationMode(mode);
  const goldenDecision = goldenReport ? evaluateGoldenBaselineReport(goldenReport, { requiredCaseIds: goldenCaseIds }) : null;
  const effectiveGates = goldenDecision ? { ...gates, goldenBaseline: goldenDecision.passed } : gates;
  const failedGates = REQUIRED_GATES.filter(name => effectiveGates[name] !== true);
  const blockingComparisons = comparisons.filter(item => item?.passed === false && (item?.differences || []).some(diff => diff.blocking));
  const blockingDefects = openDefects.filter(item => ['P0', 'P1', 'CRITICAL'].includes(String(item?.severity || item?.risk || '').trim().toUpperCase()));
  const reasons = [];
  if (failedGates.length) reasons.push(`验收门禁未完成：${failedGates.join('、')}`);
  if (blockingComparisons.length) reasons.push(`存在 ${blockingComparisons.length} 个阻断差异`);
  if (blockingDefects.length) reasons.push(`存在 ${blockingDefects.length} 个 P0/P1 缺陷`);
  const canPromote = normalizedMode !== 'legacy' && reasons.length === 0;
  return { schema: 'wynai.platform-migration-decision/v1', version: 1, mode: normalizedMode, canPromote, rollbackMode: 'legacy', reasons, blockingComparisonCount: blockingComparisons.length, blockingDefectCount: blockingDefects.length, goldenBaseline: goldenDecision };
}

/** Validate the machine-readable golden UAT report before it is used as a
 * promotion gate. A manually supplied boolean remains supported for older
 * callers, but a supplied report must prove every required case. */
export function evaluateGoldenBaselineReport(report = {}, { requiredCaseIds = [] } = {}) {
  const required = [...new Set((Array.isArray(requiredCaseIds) ? requiredCaseIds : []).map(String).filter(Boolean))];
  const results = Array.isArray(report?.results) ? report.results : [];
  const byId = new Map(results.map(item => [String(item?.id || ''), item]));
  const missingCaseIds = required.filter(id => !byId.has(id));
  const invalidCases = results.filter(item => {
    const generationStatus = item?.generate?.status;
    return item?.comparison?.passed !== true
      || Number(item?.comparison?.differenceCount || 0) !== 0
      || item?.lifecycle?.valid !== true
      || Number(item?.lifecycle?.openAttempts || 0) !== 0
      || !['completed', 'completed-partial'].includes(generationStatus)
      || item?.generate?.provider !== 'llm-orchestrated';
  }).map(item => String(item?.id || 'unknown'));
  const passed = report?.schema === 'wynai.platform-golden-uat/v1'
    && Number(report?.summary?.total) === results.length
    && results.length > 0
    && missingCaseIds.length === 0
    && invalidCases.length === 0;
  return {
    schema: 'wynai.platform-golden-decision/v1',
    version: 1,
    passed,
    requiredCaseCount: required.length,
    resultCount: results.length,
    missingCaseIds,
    invalidCases,
  };
}

export const platformMigrationModes = Object.freeze([...MODES]);
