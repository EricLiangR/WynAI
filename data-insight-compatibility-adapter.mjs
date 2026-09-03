import { normalizeInsightInput } from './lib/data-insights/insight-input.mjs';
import { buildBusinessResultSnapshot, compareCompatibilitySnapshots } from './platform-compatibility-contract.mjs';

const SCHEMA = 'wynai.data-insight-adapter/v1';
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function semanticVisibleAnswer(value) {
  if (!value || typeof value !== 'object') return value || null;
  const sections = ['managementSummary', 'keyFindings', 'risks', 'actions', 'followUps'];
  if (sections.some(section => Array.isArray(value[section]))) {
    return Object.fromEntries(sections.map(section => [section, (Array.isArray(value[section]) ? value[section] : []).map(item => ({
      evidenceIds: Array.isArray(item?.evidenceIds) ? [...item.evidenceIds].sort() : [],
      verificationRequired: item?.verificationRequired === true,
    }))]));
  }
  if (Array.isArray(value.blocks)) {
    return {
      blocks: value.blocks.map(block => ({
        type: block?.type || null,
        title: block?.title || null,
        evidenceIds: Array.isArray(block?.evidenceIds) ? [...block.evidenceIds].sort() : [],
      })),
    };
  }
  return value;
}

export function createDataInsightCompatibilityAdapter({ mode = 'legacy', register = null } = {}) {
  const normalizedMode = ['legacy', 'shadow', 'canary', 'platform'].includes(mode) ? mode : 'legacy';
  return {
    schema: SCHEMA,
    version: 1,
    mode: normalizedMode,
    adapt(input) {
      const normalized = normalizeInsightInput(input);
      return { schema: SCHEMA, version: 1, mode: normalizedMode, input: normalized };
    },
    register(input, options = {}) {
      const envelope = this.adapt(input);
      return typeof register === 'function' ? register(envelope.input, options) : envelope;
    },
    snapshot(record = {}) {
      const input = record.input || record;
      const resultSets = Array.isArray(input.resultSets) ? input.resultSets : [];
      const result = record.result || record.output || null;
      return {
        numericResults: resultSets.map(resultSet => ({ id: resultSet.id, statistics: clone(resultSet.statistics || null) })),
        filters: clone(input.scope?.filters || input.context?.filters || []),
        permissions: clone({ scope: input.scope || null, actor: record.actor || null, organizationId: record.organizationId || null }),
        evidenceRelations: clone(input.evidence || []),
        terminalStatus: record.status || (record.document ? 'completed' : 'accepted'),
        skillSemantics: clone(record.skill || input.context?.skills || []),
        userVisibleAnswer: semanticVisibleAnswer(record.document || null),
        businessResult: buildBusinessResultSnapshot(result || { status: record.status || null, structured: record.document || null }),
      };
    },
  };
}

export async function runDataInsightShadow({ legacy, candidate, input, legacySnapshot = null, candidateSnapshot = null } = {}) {
  if (typeof legacy !== 'function' || typeof candidate !== 'function') throw new Error('双跑需要 legacy 和 candidate 执行器');
  // Keep the baseline-first ordering used by the platform runtime. Identical
  // candidate requests can then reuse the LLM gateway cache instead of racing
  // into two independent stochastic generations.
  const legacyResult = await legacy(input);
  const candidateResult = await candidate(input);
  const before = typeof legacySnapshot === 'function' ? legacySnapshot(legacyResult) : legacyResult?.snapshot || legacyResult;
  const after = typeof candidateSnapshot === 'function' ? candidateSnapshot(candidateResult) : candidateResult?.snapshot || candidateResult;
  return { schema: 'wynai.data-insight-shadow-run/v1', version: 1, legacy: clone(legacyResult), candidate: clone(candidateResult), comparison: compareCompatibilitySnapshots(before, after) };
}

export const dataInsightCompatibilityAdapterVersion = SCHEMA;
