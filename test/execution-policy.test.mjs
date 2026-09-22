import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DatasetNoneAdapter } from '../lib/query/adapters/dataset-none.mjs';
import {
  assertAdaptersAllowed,
  assertExecutionAllowed,
  assertRunExecutionAllowed,
  resolveExecutionPolicy,
} from '../lib/query/execution-policy.mjs';
import { MultiDatasetQueryService } from '../lib/query/multi-dataset.mjs';

test('所有平台查询入口必须显式声明执行策略', () => {
  assert.throws(() => resolveExecutionPolicy(), error => error?.code === 'QUERY_EXECUTION_POLICY_VIOLATION'
    && /必须显式声明/.test(error.message));
  assert.throws(() => new MultiDatasetQueryService(), error => error?.code === 'QUERY_EXECUTION_POLICY_VIOLATION'
    && /必须显式声明/.test(error.message));
});

test('Smart Query 生产模块不得直接依赖 NONE 适配器且服务装配固定策略', () => {
  for (const relativePath of ['../lib/conversation/session.mjs', '../lib/query/multi-dataset.mjs']) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /DatasetNoneAdapter|query\/adapters\/dataset-none|wyn-dataset-none-json/);
  }
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const start = server.indexOf('const conversations = new SmartQueryConversationStore');
  const end = server.indexOf('const smartQueryCompatibilityAdapter', start);
  assert.ok(start >= 0 && end > start, '应能定位 Smart Query 服务装配块');
  assert.match(server.slice(start, end), /executionPolicy:\s*'smart-query'/);
  assert.doesNotMatch(server, /executeDatasetQuery\(datasetId,\s*\{\s*queryType\s*=\s*['"]NONE['"]/);
  assert.match(server, /必须显式声明 Wyn 查询类型（WAX 或 NONE）/);
  assert.match(server, /loadDataInsightQualitySampleRows/);
  assert.doesNotMatch(server, /async function loadDatasetRows/);
});

test('Smart Query 执行策略拒绝注册 NONE 样本适配器', () => {
  assert.throws(() => new MultiDatasetQueryService({
    adapters: [new DatasetNoneAdapter()],
    executionPolicy: 'smart-query',
  }), error => error?.code === 'QUERY_EXECUTION_POLICY_VIOLATION'
    && /禁止适配器/.test(error.message));
});

test('Smart Query 执行策略拒绝任何被标记为样本的业务结果', () => {
  assert.throws(() => assertExecutionAllowed({
    executionPlan: { adapter: 'wyn-wax-controlled' },
    resultSet: { quality: { isSample: true } },
  }, 'smart-query'), error => error?.code === 'QUERY_EXECUTION_POLICY_VIOLATION'
    && /禁止样本结果/.test(error.message));
});

test('Smart Query 交付边界拒绝 NONE 查询记录和样本结果集', () => {
  assert.throws(() => assertRunExecutionAllowed({
    queries: [{ status: 'completed', executionPlan: { adapter: 'wyn-dataset-none-json' } }],
    resultSets: [],
  }, 'smart-query'), error => error?.code === 'QUERY_EXECUTION_POLICY_VIOLATION'
    && /不接受查询适配器/.test(error.message));
  assert.throws(() => assertRunExecutionAllowed({
    queries: [{ status: 'completed', executionPlan: { adapter: 'wyn-wax-controlled' } }],
    resultSets: [{ id: 'rs-sample', quality: { isSample: true } }],
  }, 'smart-query'), error => error?.code === 'QUERY_EXECUTION_POLICY_VIOLATION'
    && /禁止样本结果/.test(error.message));
});

test('数据洞察执行策略保留明确的 NONE 质量采样能力', () => {
  const policy = assertAdaptersAllowed([new DatasetNoneAdapter()], 'data-insight');
  const execution = {
    executionPlan: { adapter: 'wyn-dataset-none-json' },
    resultSet: { quality: { isSample: true } },
  };
  assert.equal(policy.id, 'data-insight');
  assert.equal(assertExecutionAllowed(execution, policy.id), execution);
  assert.equal(resolveExecutionPolicy('data-insight').allowSampleResults, true);
});
