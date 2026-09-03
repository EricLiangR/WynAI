import { normalizeAIInteractionRequest, normalizeAIInteractionResponse } from './lib/protocol/interaction-contract.mjs';

const SCHEMA = 'wynai.smart-query-adapter/v1';
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

export function createSmartQueryCompatibilityAdapter({ mode = 'legacy' } = {}) {
  const normalizedMode = ['legacy', 'shadow', 'canary', 'platform'].includes(mode) ? mode : 'legacy';
  return {
    schema: SCHEMA,
    version: 1,
    mode: normalizedMode,
    normalizeRequest(input) {
      const request = normalizeAIInteractionRequest(input);
      return { schema: SCHEMA, version: 1, mode: normalizedMode, request };
    },
    normalizeResponse(input) {
      const response = normalizeAIInteractionResponse(input);
      return { schema: SCHEMA, version: 1, mode: normalizedMode, response };
    },
    snapshot({ request = null, response = null, conversation = null } = {}) {
      return {
        numericResults: clone(response?.document?.blocks?.filter(block => block.type === 'kpi').map(block => ({ id: block.id, value: block.value })) || []),
        filters: clone(request?.context?.activeFilters || []),
        permissions: clone({ dataset: request?.dataset || null, conversationId: request?.conversationId || null }),
        evidenceRelations: clone(response?.document?.evidence || []),
        terminalStatus: response?.status || 'unknown',
        skillSemantics: clone(request?.skills || []),
        userVisibleAnswer: clone(response?.document || conversation || null),
      };
    },
  };
}

export const smartQueryCompatibilityAdapterVersion = SCHEMA;
