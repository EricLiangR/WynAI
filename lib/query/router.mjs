import { normalizeCanonicalQueryRequest } from '../planning/query-request-schema.mjs';

function publicExecutionPlan(plan) {
  const { compiled, ...safe } = plan;
  return safe;
}

export class QueryRouter {
  constructor(adapters = []) {
    this.adapters = adapters;
  }

  capabilityMatrix() {
    return this.adapters.map(adapter => ({ id: adapter.id, version: adapter.version, ...adapter.capabilities }));
  }

  route(request, context) {
    const candidates = this.adapters
      .filter(adapter => adapter.canExecute(request, context))
      .map(adapter => ({ adapter, estimate: adapter.estimate(request, context) }))
      .sort((a, b) => a.estimate.cost - b.estimate.cost);
    if (!candidates.length) {
      const error = new Error(`没有适配器可以执行 ${request.mode} 查询“${request.purpose}”`);
      error.status = 422;
      throw error;
    }
    return candidates;
  }

  async execute(input, context) {
    const request = normalizeCanonicalQueryRequest(context.metadata, input);
    const candidates = this.route(request, { ...context, request });
    const errors = [];
    for (const candidate of candidates) {
      const adapterContext = { ...context, request };
      const executionPlan = candidate.adapter.compile(request, adapterContext);
      try {
        const rawResult = await candidate.adapter.execute(executionPlan, adapterContext);
        const resultSet = candidate.adapter.normalize(rawResult, executionPlan, adapterContext);
        return { request, executionPlan: publicExecutionPlan(executionPlan), resultSet };
      } catch (error) {
        if (['QUERY_RESULT_EXCEEDS_LIMIT', 'QUERY_RESULT_INCOMPLETE'].includes(error?.code)) {
          error.requestId = request.id;
          throw error;
        }
        errors.push({
          adapter: candidate.adapter.id,
          phase: 'execute',
          code: error?.code || 'QUERY_ADAPTER_FAILED',
          status: error?.status || null,
          message: error?.message || '查询适配器执行失败',
          retryable: Boolean(error?.retryable),
        });
        // A failed execution cannot silently switch to a sample or weaker adapter.
        break;
      }
    }
    const error = new Error(`查询“${request.purpose}”执行失败：${errors.map(item => `${item.adapter}: ${item.message}`).join('；')}`);
    error.code = 'QUERY_EXECUTION_FAILED';
    error.status = 502;
    error.attempts = errors;
    error.requestId = request.id;
    throw error;
  }
}
