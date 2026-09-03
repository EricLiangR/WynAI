import { createHash } from 'node:crypto';
import { platformCompatibilityRequiredLosslessContext } from './platform-compatibility-contract.mjs';

const SCHEMA = 'wynai.platform-context-manifest/v1';
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function hash(value) { return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex'); }
function fail(message, code = 'PLATFORM_CONTEXT_INVALID') { const error = new Error(message); error.code = code; error.status = 422; throw error; }

export function compilePlatformContextManifest({ question, input, skills = [], skillPlan = null, evidencePack = null, permissions = null } = {}) {
  const normalizedQuestion = String(question || input?.title || '').trim();
  if (!normalizedQuestion) fail('平台上下文缺少原始问题');
  if (!input || typeof input !== 'object') fail('平台上下文缺少标准输入');
  const resultSets = Array.isArray(input.resultSets) ? input.resultSets : [];
  if (!resultSets.length) fail('平台上下文缺少结果集');
  const evidencePolicy = evidencePack?.policy || {};
  if (evidencePolicy.rawRowsToLlm === true) fail('平台上下文禁止向 LLM 发送原始明细', 'RAW_ROWS_TO_LLM_FORBIDDEN');
  const contextClasses = Object.fromEntries(platformCompatibilityRequiredLosslessContext.map(name => [name, 'required-lossless']));
  return {
    schema: SCHEMA,
    version: 1,
    source: { inputSchema: input.schema || null, inputHash: hash(input), questionHash: hash(normalizedQuestion) },
    contextClasses,
    references: {
      datasetIds: (input.datasets || []).map(item => item?.id).filter(Boolean),
      resultSetIds: resultSets.map(item => item?.id).filter(Boolean),
      skillRefs: skills.map(skill => `${skill.id}@${skill.version}`).filter(Boolean),
      skillPlanVersion: skillPlan?.schema || null,
      evidencePackVersion: evidencePack?.schema || null,
    },
    permissions: permissions ? { present: true, hash: hash(permissions) } : { present: false, hash: null },
    transport: {
      rawRowsToLlm: false,
      aggregateMode: evidencePolicy.aggregateRowsToLlm || 'complete-or-explicit-lossless-chunks',
      chunking: evidencePolicy.chunking || 'lossless-partition',
      sourceTruncated: Boolean(input.quality?.isTruncated),
      evidenceOmittedGroups: Number(evidencePack?.coverage?.omittedGroups || 0),
    },
  };
}

export function validatePlatformEvidenceTransport(evidencePack) {
  if (!evidencePack || typeof evidencePack !== 'object') fail('Evidence Pack 缺失');
  if (evidencePack.policy?.rawRowsToLlm === true) fail('Evidence Pack 禁止 rawRowsToLlm=true', 'RAW_ROWS_TO_LLM_FORBIDDEN');
  const coverage = evidencePack.coverage || {};
  const omittedGroups = Number(coverage.omittedGroups || 0);
  if (!Number.isInteger(omittedGroups) || omittedGroups < 0) fail('Evidence Pack omittedGroups 无效');
  if (coverage.groupingsComplete === true && omittedGroups > 0) fail('Evidence Pack 完整标记与省略分组矛盾');
  return {
    schema: 'wynai.platform-evidence-transport/v1',
    version: 1,
    valid: true,
    rawRowsToLlm: false,
    lossless: omittedGroups === 0 || coverage.reason === 'explicit-platform-limit',
    omittedGroups,
    reason: omittedGroups > 0 ? coverage.reason || 'unspecified-limit' : null,
  };
}

export const platformContextManifestVersion = SCHEMA;
