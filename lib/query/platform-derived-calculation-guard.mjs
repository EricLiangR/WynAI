import { assertCompleteAggregateContract, createPlatformDerivedContract } from './result-contract.mjs';
import { resolveDerivedOperation } from './derived-operation-registry.mjs';

function guardError(message, details = {}) {
  return Object.assign(new Error(message), { code: 'PLATFORM_DERIVED_OPERATION_FORBIDDEN', status: 422, details });
}

export class PlatformDerivedCalculationGuard {
  execute({ rows, contract, step }) {
    if (step?.executionOwner !== 'platform-derived') throw guardError('平台派生计算只能执行 executionOwner=platform-derived 的步骤', { step });
    const operation = resolveDerivedOperation(step.operationId, step.operationVersion);
    if (!operation) throw guardError(`派生操作未注册：${step.operationId || 'unknown'}@${step.operationVersion || 'unknown'}`, { step });
    assertCompleteAggregateContract(contract, operation.operationId);
    if (operation.allowedGrains && !operation.allowedGrains.includes(step.grain)) throw guardError(`派生操作 ${operation.operationId} 不支持时间粒度 ${step.grain || 'unknown'}`, { step });
    const output = operation.execute(rows.map(row => ({ ...row })), step);
    return {
      rows: output.rows,
      warnings: output.warnings || [],
      contract: createPlatformDerivedContract(contract, operation),
      ledgerEntry: {
        operationId: operation.operationId,
        operationVersion: operation.operationVersion,
        executionOwner: 'platform-derived',
        inputContract: contract.type,
        outputContract: 'platform-derived-result',
        changesBusinessScope: Boolean(step.changesBusinessScope),
        requiresCompleteAggregate: true,
        inputRowCount: rows.length,
        outputRowCount: output.rows.length,
        status: 'executed',
      },
    };
  }
}

export const platformDerivedCalculationGuard = new PlatformDerivedCalculationGuard();
