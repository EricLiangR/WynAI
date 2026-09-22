const EXECUTION_POLICIES = Object.freeze({
  'smart-query': Object.freeze({
    id: 'smart-query',
    allowedAdapterIds: Object.freeze(['wyn-wax-controlled']),
    allowSampleResults: false,
  }),
  'data-insight': Object.freeze({
    id: 'data-insight',
    allowedAdapterIds: Object.freeze(['wyn-wax-controlled', 'wyn-dataset-none-json']),
    allowSampleResults: true,
  }),
});

function policyError(message, details = {}) {
  return Object.assign(new Error(message), {
    code: 'QUERY_EXECUTION_POLICY_VIOLATION',
    status: 500,
    details,
  });
}

export function resolveExecutionPolicy(value) {
  const id = String(value || '').trim();
  if (!id) throw policyError('必须显式声明查询执行策略', { policy: null });
  const policy = EXECUTION_POLICIES[id];
  if (!policy) throw policyError(`未知查询执行策略：${id}`, { policy: id });
  return policy;
}

export function assertAdaptersAllowed(adapters = [], policyInput) {
  const policy = resolveExecutionPolicy(policyInput);
  const adapterIds = adapters.map(adapter => String(adapter?.id || '').trim()).filter(Boolean);
  const forbidden = adapterIds.filter(id => !policy.allowedAdapterIds.includes(id));
  if (forbidden.length) {
    throw policyError(`执行策略 ${policy.id} 禁止适配器：${forbidden.join('、')}`, {
      policy: policy.id,
      allowedAdapterIds: policy.allowedAdapterIds,
      forbiddenAdapterIds: forbidden,
    });
  }
  return policy;
}

export function assertExecutionAllowed(execution = {}, policyInput) {
  const policy = resolveExecutionPolicy(policyInput);
  const adapter = String(execution?.executionPlan?.adapter || execution?.provenance?.adapter || '').trim();
  if (!adapter || !policy.allowedAdapterIds.includes(adapter)) {
    throw policyError(`执行策略 ${policy.id} 不接受查询适配器：${adapter || '(missing)'}`, {
      policy: policy.id,
      allowedAdapterIds: policy.allowedAdapterIds,
      adapter,
    });
  }
  const quality = execution?.resultSet?.quality || execution?.quality || {};
  if (!policy.allowSampleResults && quality.isSample) {
    throw policyError(`执行策略 ${policy.id} 禁止样本结果作为业务查询结果`, {
      policy: policy.id,
      adapter,
      isSample: true,
    });
  }
  return execution;
}

export function assertRunExecutionAllowed(run = {}, policyInput) {
  const policy = resolveExecutionPolicy(policyInput);
  for (const query of run.queries || []) {
    if (query?.status && query.status !== 'completed') continue;
    assertExecutionAllowed({
      executionPlan: query?.executionPlan,
      resultSet: { quality: { isSample: false } },
    }, policy.id);
  }
  if (!policy.allowSampleResults) {
    const sample = (run.resultSets || []).find(resultSet => resultSet?.quality?.isSample);
    if (sample) {
      throw policyError(`执行策略 ${policy.id} 禁止样本结果作为业务查询结果`, {
        policy: policy.id,
        resultSetId: sample.id || null,
        isSample: true,
      });
    }
  }
  return run;
}

export const queryExecutionPolicies = EXECUTION_POLICIES;
