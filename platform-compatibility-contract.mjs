const CONTRACT_SCHEMA = 'wynai.platform-compatibility-contract/v1';
const REQUIRED_LOSSLESS = new Set(['original-question','active-conversation-context','dataset-metadata','skill-references','permissions-and-scope','derived-metric-formulas','evidence-provenance']);
const ALLOWED_CONTEXT_CLASSES = new Set(['required-lossless','lossless-compact','summarizable-with-provenance','never-forward']);
const BLOCKING_DIFFS = new Set(['numeric-results','filters','permissions','evidence-relations','terminal-status','skill-semantics','user-visible-answer','business-result']);
const REQUIRED_INVARIANT_DIFFS = new Set(['numeric-results','filters','permissions','evidence-relations','terminal-status','skill-semantics','user-visible-answer']);
function fail(message, path = '') { const error = new Error(path ? `${message} (${path})` : message); error.code = 'PLATFORM_COMPATIBILITY_CONTRACT_INVALID'; error.path = path; error.status = 400; throw error; }
function text(value, path, { required = false, max = 160 } = {}) { if (value == null && !required) return null; if (typeof value !== 'string') fail('字段必须是字符串', path); const normalized = value.trim(); if (required && !normalized) fail('字段不能为空', path); if (normalized.length > max) fail(`字段长度不能超过 ${max}`, path); return normalized; }
function list(value, path, { max = 64 } = {}) { if (!Array.isArray(value)) fail('字段必须是数组', path); const result = value.map((item, index) => text(item, `${path}[${index}]`, { required: true, max: 200 })); if (new Set(result).size !== result.length) fail('数组不能包含重复项', path); return result.slice(0, max); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
export function createCompatibilityContract({ module, adapter, versions, contextClasses, invariants, modes = ['legacy','shadow','canary','platform'] } = {}) {
  const normalizedModule = text(module, 'module', { required: true, max: 80 }); const normalizedAdapter = text(adapter, 'adapter', { required: true, max: 120 });
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) fail('versions 必须是对象', 'versions');
  const normalizedVersions = Object.fromEntries(Object.entries(versions).map(([name, version]) => [text(name, 'versions.name', { required: true, max: 80 }), text(version, `versions.${name}`, { required: true, max: 120 })])); if (!Object.keys(normalizedVersions).length) fail('至少需要一个契约版本', 'versions');
  if (!contextClasses || typeof contextClasses !== 'object' || Array.isArray(contextClasses)) fail('contextClasses 必须是对象', 'contextClasses'); const normalizedContext = {};
  for (const [name, level] of Object.entries(contextClasses)) { const normalizedName = text(name, 'contextClasses.name', { required: true, max: 100 }); const normalizedLevel = text(level, `contextClasses.${normalizedName}`, { required: true, max: 40 }); if (!ALLOWED_CONTEXT_CLASSES.has(normalizedLevel)) fail(`不支持上下文级别 ${normalizedLevel}`, `contextClasses.${normalizedName}`); normalizedContext[normalizedName] = normalizedLevel; }
  const missingLossless = [...REQUIRED_LOSSLESS].filter(name => normalizedContext[name] !== 'required-lossless'); if (missingLossless.length) fail(`核心上下文必须无损传递：${missingLossless.join('、')}`, 'contextClasses');
  if (!invariants || typeof invariants !== 'object' || Array.isArray(invariants)) fail('invariants 必须是对象', 'invariants'); const normalizedInvariants = Object.fromEntries(Object.entries(invariants).map(([name, value]) => { if (typeof value !== 'boolean') fail('不变量必须是布尔值', `invariants.${name}`); return [text(name, 'invariants.name', { required: true, max: 80 }), value]; }));
  for (const name of REQUIRED_INVARIANT_DIFFS) if (normalizedInvariants[name] !== true) fail(`阻断不变量必须启用：${name}`, `invariants.${name}`);
  const normalizedModes = list(modes, 'modes', { max: 8 }); for (const requiredMode of ['legacy','shadow','canary','platform']) if (!normalizedModes.includes(requiredMode)) fail(`迁移模式缺少 ${requiredMode}`, 'modes');
  return { schema: CONTRACT_SCHEMA, version: 1, module: normalizedModule, adapter: normalizedAdapter, versions: normalizedVersions, contextClasses: normalizedContext, invariants: normalizedInvariants, modes: normalizedModes };
}
export function validateCompatibilityContract(contract) { return createCompatibilityContract(contract); }
function valueChanged(before, after) { return JSON.stringify(before) !== JSON.stringify(after); }
export function buildBusinessResultSnapshot(result = {}) {
  const orchestration = result?.orchestration || {};
  const structured = result?.structured || {};
  const stageAudit = Array.isArray(orchestration.stageAudit)
    ? orchestration.stageAudit.map(item => ({ stage: item?.stage || null, status: item?.status || null, errorCode: item?.errorCode || item?.error?.code || null })).filter(item => item.stage).sort((a, b) => a.stage.localeCompare(b.stage))
    : [];
  const plan = value => {
    if (!value || typeof value !== 'object') return null;
    const groups = ['coreHypotheses', 'extendedHypotheses', 'optionalHypotheses', 'hypotheses', 'assessments'];
    return Object.fromEntries(groups.filter(key => Array.isArray(value[key])).map(key => [key, value[key].map(item => ({
      id: item?.id || item?.hypothesisId || null,
      methodId: item?.methodId || null,
      priority: item?.priority || null,
      blocking: item?.blocking === true,
      status: item?.status || item?.support || null,
      evidenceIds: Array.isArray(item?.evidenceIds) ? [...item.evidenceIds].sort() : Array.isArray(item?.requiredEvidenceIds) ? [...item.requiredEvidenceIds].sort() : [],
    }))]));
  };
  const narrative = Object.fromEntries(['managementSummary', 'keyFindings', 'risks', 'actions', 'followUps'].map(section => [section,
    Array.isArray(structured[section]) ? structured[section].map(item => ({
      evidenceIds: Array.isArray(item?.evidenceIds) ? [...item.evidenceIds].sort() : [],
      // Text itself is intentionally excluded: wording is not a compatibility invariant.
      hasText: Boolean(String(item?.text || item?.question || '').trim()),
    })) : [],
  ]));
  const evidence = Array.isArray(orchestration.evidence)
    ? orchestration.evidence.map(item => ({ id: item?.id || null, value: clone(item?.value), formula: item?.formula || null, scope: clone(item?.scope || null) })).filter(item => item.id).sort((a, b) => a.id.localeCompare(b.id))
    : [];
  return {
    schema: 'wynai.business-result-snapshot/v1',
    version: 1,
    status: result?.status || orchestration.status || null,
    stageAudit,
    planner: plan(orchestration.planner),
    critic: plan(orchestration.critic),
    narrative,
    evidence,
  };
}

export function compareCompatibilitySnapshots(before = {}, after = {}) { const fields = [['numeric-results', before.numericResults, after.numericResults],['filters', before.filters, after.filters],['permissions', before.permissions, after.permissions],['evidence-relations', before.evidenceRelations, after.evidenceRelations],['terminal-status', before.terminalStatus, after.terminalStatus],['skill-semantics', before.skillSemantics, after.skillSemantics],['user-visible-answer', before.userVisibleAnswer, after.userVisibleAnswer],['business-result', before.businessResult, after.businessResult]]; const differences = fields.filter(([, left, right]) => valueChanged(left, right)).map(([kind, left, right]) => ({ kind, blocking: BLOCKING_DIFFS.has(kind), before: clone(left), after: clone(right) })); return { schema: 'wynai.platform-compatibility-diff/v1', version: 1, passed: differences.every(item => !item.blocking), differences }; }
export const platformCompatibilityContractVersion = CONTRACT_SCHEMA;
export const platformCompatibilityRequiredLosslessContext = Object.freeze([...REQUIRED_LOSSLESS]);
export const platformCompatibilityBlockingDiffs = Object.freeze([...BLOCKING_DIFFS]);
