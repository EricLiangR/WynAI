const VERSION = 'wynai.model-capability/v1';

const DEFAULT_PROFILE = Object.freeze({
  contextWindowTokens: 32_768,
  maxInputTokens: 20_000,
  maxOutputTokens: 4_096,
  safetyReserveTokens: 2_048,
  protocolOverheadTokens: 1_024,
  supportsJson: true,
  supportsStreaming: false,
  tokenEstimator: 'conservative-json',
});

function integer(value, fallback, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

export function normalizeModelCapability(profile = {}, defaults = {}) {
  const source = { ...DEFAULT_PROFILE, ...defaults, ...profile };
  const contextWindowTokens = integer(source.contextWindowTokens, DEFAULT_PROFILE.contextWindowTokens, 4_096);
  const maxOutputTokens = Math.min(integer(source.maxOutputTokens, DEFAULT_PROFILE.maxOutputTokens, 256), contextWindowTokens - 1_024);
  const safetyReserveTokens = integer(source.safetyReserveTokens, DEFAULT_PROFILE.safetyReserveTokens, 0);
  const protocolOverheadTokens = integer(source.protocolOverheadTokens, DEFAULT_PROFILE.protocolOverheadTokens, 0);
  const maximumInput = Math.max(1_024, contextWindowTokens - maxOutputTokens - safetyReserveTokens - protocolOverheadTokens);
  const maxInputTokens = Math.min(integer(source.maxInputTokens, maximumInput, 1_024), maximumInput);
  return {
    schema: VERSION,
    provider: source.provider ? String(source.provider) : null,
    model: source.model ? String(source.model) : null,
    contextWindowTokens,
    maxInputTokens,
    maxOutputTokens,
    safetyReserveTokens,
    protocolOverheadTokens,
    supportsJson: source.supportsJson !== false,
    supportsStreaming: source.supportsStreaming === true,
    tokenEstimator: String(source.tokenEstimator || DEFAULT_PROFILE.tokenEstimator),
    source: source.source ? String(source.source) : 'platform-default',
  };
}

export function resolveModelBudget(profile = {}, { operationCapTokens = null, outputReserveTokens = null } = {}) {
  const normalized = normalizeModelCapability(profile);
  const outputReserve = Math.min(normalized.contextWindowTokens - 1_024, integer(outputReserveTokens, normalized.maxOutputTokens, 256));
  const availableByWindow = Math.max(1_024, normalized.contextWindowTokens - outputReserve - normalized.safetyReserveTokens - normalized.protocolOverheadTokens);
  const operationCap = operationCapTokens == null ? Number.POSITIVE_INFINITY : integer(operationCapTokens, normalized.maxInputTokens, 1_024);
  const inputBudgetTokens = Math.min(normalized.maxInputTokens, availableByWindow, operationCap);
  return {
    schema: 'wynai.model-budget/v1',
    provider: normalized.provider,
    model: normalized.model,
    operationCapTokens: Number.isFinite(operationCap) ? operationCap : null,
    contextWindowTokens: normalized.contextWindowTokens,
    inputBudgetTokens,
    outputReserveTokens: outputReserve,
    safetyReserveTokens: normalized.safetyReserveTokens,
    protocolOverheadTokens: normalized.protocolOverheadTokens,
    tokenEstimator: normalized.tokenEstimator,
  };
}

export function estimateJsonTokens(value, { charsPerToken = 4 } = {}) {
  const divisor = Math.max(1, Number(charsPerToken) || 4);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { serialized = ''; }
  return Math.ceil(String(serialized || '').length / divisor);
}

export function modelCapabilityDefaults() { return clone(DEFAULT_PROFILE); }
export const modelCapabilityVersion = VERSION;
