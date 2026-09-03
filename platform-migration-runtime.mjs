import { compareCompatibilitySnapshots } from './platform-compatibility-contract.mjs';

const MODES = new Set(['legacy', 'shadow', 'canary', 'platform']);

function clone(value) { return value == null ? value : structuredClone(value); }
function candidateMetadata(value) {
  return clone(value?.orchestration?.platformCandidate || value?.candidate || null);
}

function normalizeMode(value) {
  const mode = String(value || 'legacy').trim();
  return MODES.has(mode) ? mode : 'legacy';
}

function migrationError(message, code = 'PLATFORM_MIGRATION_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.status = code === 'PLATFORM_SHADOW_BLOCKED' ? 409 : 400;
  return error;
}

/**
 * Executes a module through the configured migration mode. Shadow never changes
 * the user-visible result; blocking differences are retained for the release gate.
 */
export function createPlatformMigrationRuntime({ mode = 'legacy', resolveMode = null, onEvent = null } = {}) {
  const configuredMode = normalizeMode(mode);

  function resolveCurrentMode({ module, input, context } = {}) {
    if (typeof resolveMode !== 'function') return { mode: configuredMode, routing: null };
    const resolved = resolveMode({ module, input, context });
    if (typeof resolved === 'string') return { mode: normalizeMode(resolved), routing: null };
    return { mode: normalizeMode(resolved?.mode || configuredMode), routing: clone(resolved) };
  }

  async function emit(event, currentMode) {
    if (typeof onEvent === 'function') await onEvent({ schema: 'wynai.platform-migration-event/v1', version: 1, mode: currentMode, at: new Date().toISOString(), ...clone(event) });
  }

  async function run({ module, input = null, context = null, legacy, candidate, snapshot = null, fallbackOnCandidateError = true } = {}) {
    if (!module || typeof legacy !== 'function' || typeof candidate !== 'function') throw migrationError('迁移运行时需要 module、legacy 和 candidate 执行器');
    const routing = resolveCurrentMode({ module, input, context });
    const currentMode = routing.mode;
    const snap = typeof snapshot === 'function' ? snapshot : value => value;
    if (currentMode === 'legacy') {
      const result = await legacy(input);
      await emit({ event: 'migration.legacy', module, outcome: 'selected', routing: routing.routing }, currentMode);
      return { schema: 'wynai.platform-migration-run/v1', version: 1, mode: currentMode, module, routing: clone(routing.routing), result: clone(result), legacy: clone(result), candidate: null, candidateMetadata: null, comparison: null, fallback: false };
    }

    if (currentMode === 'shadow') {
      // Run the baseline first so identical candidate requests can reuse the
      // request-scoped LLM gateway cache. Parallel calls race past the cache
      // and produce two independent stochastic generations, making the
      // compatibility gate report narrator drift as a platform regression.
      let legacyAttempt;
      try {
        legacyAttempt = { status: 'fulfilled', value: await legacy(input) };
      } catch (error) {
        legacyAttempt = { status: 'rejected', reason: error };
      }
      if (legacyAttempt.status === 'rejected') throw legacyAttempt.reason;
      const legacyResult = legacyAttempt.value;
      let candidateAttempt;
      try {
        candidateAttempt = { status: 'fulfilled', value: await candidate(input) };
      } catch (error) {
        candidateAttempt = { status: 'rejected', reason: error };
      }
      if (candidateAttempt.status === 'rejected') {
        const candidateError = { code: candidateAttempt.reason?.code || 'CANDIDATE_FAILED', message: candidateAttempt.reason?.message || '候选路径失败' };
        await emit({ event: 'migration.shadow', module, outcome: 'candidate-failed', routing: routing.routing, candidateError }, currentMode);
        return { schema: 'wynai.platform-migration-run/v1', version: 1, mode: currentMode, module, routing: clone(routing.routing), result: clone(legacyResult), legacy: clone(legacyResult), candidate: null, candidateMetadata: null, comparison: null, fallback: false, candidateError };
      }
      const candidateResult = candidateAttempt.value;
      const comparison = compareCompatibilitySnapshots(snap(legacyResult), snap(candidateResult));
      await emit({ event: 'migration.shadow', module, outcome: comparison.passed ? 'matched' : 'blocked', routing: routing.routing, comparison }, currentMode);
      return { schema: 'wynai.platform-migration-run/v1', version: 1, mode: currentMode, module, routing: clone(routing.routing), result: clone(legacyResult), legacy: clone(legacyResult), candidate: clone(candidateResult), candidateMetadata: candidateMetadata(candidateResult), comparison, fallback: false };
    }

    try {
      const candidateResult = await candidate(input);
      await emit({ event: 'migration.candidate', module, outcome: 'selected', routing: routing.routing }, currentMode);
      return { schema: 'wynai.platform-migration-run/v1', version: 1, mode: currentMode, module, routing: clone(routing.routing), result: clone(candidateResult), legacy: null, candidate: clone(candidateResult), candidateMetadata: candidateMetadata(candidateResult), comparison: null, fallback: false };
    } catch (error) {
      if (currentMode === 'canary' && fallbackOnCandidateError) {
        const legacyResult = await legacy(input);
        await emit({ event: 'migration.candidate', module, outcome: 'fallback', routing: routing.routing, error: { code: error.code || 'CANDIDATE_FAILED', message: error.message } }, currentMode);
        return { schema: 'wynai.platform-migration-run/v1', version: 1, mode: currentMode, module, routing: clone(routing.routing), result: clone(legacyResult), legacy: clone(legacyResult), candidate: null, candidateMetadata: null, comparison: null, fallback: true, fallbackError: { code: error.code || 'CANDIDATE_FAILED', message: error.message } };
      }
      await emit({ event: 'migration.candidate', module, outcome: 'failed', routing: routing.routing, error: { code: error.code || 'CANDIDATE_FAILED', message: error.message } }, currentMode);
      throw error;
    }
  }

  return { schema: 'wynai.platform-migration-runtime/v1', version: 1, mode: configuredMode, configuredMode, dynamicRouting: typeof resolveMode === 'function', run };
}

export const platformMigrationRuntimeModes = Object.freeze([...MODES]);
