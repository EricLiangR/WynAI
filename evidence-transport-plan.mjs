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

export const evidenceTransportPlanVersion = VERSION;
