const CONTRACT_SCHEMA = 'wynai.query-result-contract/v1';

function integer(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function contractError(message, details = {}) {
  return Object.assign(new Error(message), { code: 'QUERY_RESULT_CONTRACT_INVALID', status: 422, details });
}

export function createWynResultContract({ request, rawResult, returnedRowCount }) {
  const returned = integer(returnedRowCount);
  const total = integer(rawResult?.totalRows) ?? (rawResult?.isComplete === true ? returned : null);
  const userLimited = String(request?.limitSource || '').startsWith('user-');
  const sourceLimited = Boolean(rawResult?.truncated || rawResult?.limitReached);
  const sampled = Boolean(rawResult?.isSample);
  const estimated = Boolean(rawResult?.isEstimated);
  const complete = rawResult?.isComplete === true && !sampled && !estimated
    && total != null && returned != null
    && (userLimited ? returned <= total : returned === total)
    && (!sourceLimited || userLimited);
  const aggregate = !['projection', 'mining'].includes(request?.mode);
  const type = !complete || userLimited
    ? 'wyn-limited-result'
    : aggregate ? 'wyn-complete-aggregate-result' : 'wyn-detail-result';
  return Object.freeze({
    schema: CONTRACT_SCHEMA,
    version: 1,
    type,
    issuedBy: 'wyn-query-adapter',
    requestId: request?.id || null,
    aggregate,
    isComplete: complete,
    isSample: sampled,
    isTruncated: sourceLimited && !userLimited,
    isEstimated: estimated,
    userLimitApplied: userLimited,
    totalRowCount: total,
    returnedRowCount: returned,
    countVerified: total != null && returned != null && (userLimited ? returned <= total : returned === total),
  });
}

export function createPlatformDerivedContract(inputContract, operation) {
  assertCompleteAggregateContract(inputContract, operation?.operationId || 'unknown');
  return Object.freeze({
    ...inputContract,
    type: 'platform-derived-result',
    issuedBy: 'platform-derived-calculation-guard',
    derivedFrom: inputContract.type,
    operationId: operation.operationId,
    operationVersion: operation.operationVersion,
  });
}

export function assertCompleteAggregateContract(contract, operationId = 'platform-derived') {
  const reasons = [];
  if (contract?.schema !== CONTRACT_SCHEMA) reasons.push('缺少受治理的结果契约');
  if (!['wyn-complete-aggregate-result', 'platform-derived-result'].includes(contract?.type)) reasons.push(`输入类型 ${contract?.type || 'unknown'} 不允许派生计算`);
  if (contract?.aggregate !== true) reasons.push('输入不是 Wyn 聚合结果');
  if (contract?.isComplete !== true) reasons.push('输入未证明完整');
  if (contract?.isSample) reasons.push('输入是样本');
  if (contract?.isTruncated) reasons.push('输入已截断');
  if (contract?.isEstimated) reasons.push('输入是估算结果');
  if (contract?.userLimitApplied) reasons.push('输入只包含用户限制范围');
  if (!contract?.countVerified) reasons.push('Wyn 总行数与返回行数未完成一致性校验');
  if (integer(contract?.totalRowCount) == null || integer(contract?.returnedRowCount) == null) reasons.push('结果行数不可验证');
  if (integer(contract?.totalRowCount) !== integer(contract?.returnedRowCount)) reasons.push('Wyn 总行数与返回行数不一致');
  if (reasons.length) throw contractError(`派生操作 ${operationId} 被完整性守卫阻断：${reasons.join('；')}。平台未使用部分数据进行推算。`, { operationId, contract, reasons });
  return contract;
}

export const queryResultContractSchema = CONTRACT_SCHEMA;
