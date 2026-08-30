const VERSION = 'wynai.evidence-transport-plan/v1';
const MODES = new Set(['auto', 'aggregate-catalog', 'lossless-row-chunk', 'adaptive-hybrid']);

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function list(value) { return [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean))]; }

export function normalizeTransportPolicy(policy = {}) {
  const mode = MODES.has(String(policy.mode || 'auto')) ? String(policy.mode || 'auto') : 'auto';
  const evidenceLevel = ['aggregate', 'aggregate-sufficient', 'row-relationship-allowed'].includes(String(policy.defaultEvidenceLevel || 'aggregate'))
    ? String(policy.defaultEvidenceLevel || 'aggregate')
    : 'aggregate';
  return {
    mode,
    allowLosslessChunking: policy.allowLosslessChunking !== false,
    defaultEvidenceLevel: evidenceLevel,
  };
}

export function createEvidenceTransportPlan({
  mode = 'auto',
  initialMode = null,
  finalMode = null,
  reason = [],
  modelBudget = null,
  evidence = {},
  decisionTrace = [],
  policy = {},
} = {}) {
  const normalizedMode = MODES.has(String(mode)) ? String(mode) : 'auto';
  const normalizedInitial = initialMode && MODES.has(String(initialMode)) ? String(initialMode) : normalizedMode;
  const normalizedFinal = finalMode && MODES.has(String(finalMode)) ? String(finalMode) : normalizedMode;
  return {
    schema: VERSION,
    mode: normalizedMode,
    initialMode: normalizedInitial,
    finalMode: normalizedFinal,
    policy: normalizeTransportPolicy(policy),
    reason: list(reason),
    modelBudget: clone(modelBudget),
    evidence: {
      sourceRowCount: Number.isFinite(Number(evidence.sourceRowCount)) ? Number(evidence.sourceRowCount) : 0,
      representedRowCount: Number.isFinite(Number(evidence.representedRowCount)) ? Number(evidence.representedRowCount) : 0,
      omittedGroups: Number.isFinite(Number(evidence.omittedGroups)) ? Number(evidence.omittedGroups) : 0,
      chunkCount: Number.isFinite(Number(evidence.chunkCount)) ? Number(evidence.chunkCount) : 0,
      lossless: evidence.lossless !== false,
    },
    decisionTrace: Array.isArray(decisionTrace) ? decisionTrace.map(item => clone(item)).filter(Boolean) : [],
  };
}

export function decideEvidenceTransport({ policy = {}, skillPlan = null, pack = {}, modelBudget = null } = {}) {
  const normalizedPolicy = normalizeTransportPolicy({ ...policy, ...(skillPlan?.transportPolicy || {}) });
  const methods = Array.isArray(skillPlan?.methods) ? skillPlan.methods : [];
  const coreRowLevel = methods.some(method => method?.priority === 'core' && method?.rowLevel === true && method?.allowLosslessChunking !== false);
  const sourceRowCount = (pack.resultSets || []).reduce((sum, resultSet) => sum + (Array.isArray(resultSet?.rows) ? resultSet.rows.length : 0), 0)
    + (pack.evidence || []).reduce((sum, item) => sum + (Array.isArray(item?.value) ? item.value.length : 0), 0);
  const omittedGroups = Number(pack.coverage?.omittedGroups || pack.coverage?.evidenceCoverage?.omittedGroups || 0);
  const reasons = [];
  let finalMode = 'aggregate-catalog';
  if (normalizedPolicy.mode === 'aggregate-catalog') reasons.push('policy-aggregate-catalog');
  else if (normalizedPolicy.mode === 'lossless-row-chunk') { finalMode = 'lossless-row-chunk'; reasons.push('policy-lossless-row-chunk'); }
  else if (normalizedPolicy.mode === 'adaptive-hybrid') { finalMode = coreRowLevel ? 'lossless-row-chunk' : 'aggregate-catalog'; reasons.push(coreRowLevel ? 'core-row-level-method' : 'core-aggregate-sufficient'); }
  else if (coreRowLevel && normalizedPolicy.allowLosslessChunking) { finalMode = 'lossless-row-chunk'; reasons.push('auto-core-row-level-method'); }
  else { reasons.push('auto-aggregate-first'); }
  if (omittedGroups > 0) reasons.push('explicit-platform-omission');
  if (sourceRowCount === 0) reasons.push('no-row-payload');
  if (modelBudget?.inputBudgetTokens) reasons.push(`input-budget-${modelBudget.inputBudgetTokens}`);
  return createEvidenceTransportPlan({
    mode: normalizedPolicy.mode,
    initialMode: 'aggregate-catalog',
    finalMode,
    reason: reasons,
    modelBudget,
    evidence: { sourceRowCount, representedRowCount: sourceRowCount, omittedGroups, chunkCount: finalMode === 'lossless-row-chunk' ? Math.max(1, Math.ceil(sourceRowCount / 500)) : 0, lossless: true },
    decisionTrace: [{ step: 'core-row-level', value: coreRowLevel }, { step: 'evidence-coverage', omittedGroups }, { step: 'selection', mode: finalMode }],
    policy: normalizedPolicy,
  });
}

export const evidenceTransportPlanVersion = VERSION;
