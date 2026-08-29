import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBusinessQueryIntent, compileBusinessQueryIntent } from '../lib/semantics/business-query-intent.mjs';
import { parseBusinessTimeSemantics } from '../lib/semantics/time-semantics.mjs';
import { OperationalEventLog } from '../lib/observability/operational-event-log.mjs';
import { QueryRouter } from '../lib/query/router.mjs';

const metadata = { id: 'dataset-sales-v1', revision: 7, indexed: true, fields: [
  { name: '订购日期', role: 'time', type: 'Date', rawType: 'DateTime' },
  { name: '订单金额', role: 'measure', type: 'Number', rawType: 'Double' },
  { name: '订单利润', role: 'measure', type: 'Number', rawType: 'Double' },
  { name: '客户地区', role: 'geography', type: 'String', rawType: 'String' },
  { name: '客户省份', role: 'geography', type: 'String', rawType: 'String' },
] };

test('历年、按年度和按年份统一形成年度分组而不是累计结果', () => {
  for (const question of ['历年各地区销售额和利润', '按年度查看各地区销售额', '按年份统计销售额']) {
    const time = parseBusinessTimeSemantics(question, { now: new Date('2026-08-28T00:00:00+08:00') });
    assert.equal(time.grain, 'year', question);
    assert.equal(time.groupingExplicit, true, question);
    const intent = buildBusinessQueryIntent({ metadata, question, now: new Date('2026-08-28T00:00:00+08:00') });
    assert.equal(intent.time.grain, 'year', question);
    assert.equal(intent.dimensions.some(item => item.field === '订购日期' && item.grain === 'year'), true, question);
    assert.equal(compileBusinessQueryIntent(metadata, intent).status, 'supported', question);
  }
});

test('运行事件日志可记录查询计划、编译和执行失败并按 trace 回放', () => {
  const log = new OperationalEventLog();
  const traceId = 'trace-regression-001';
  log.record({ traceId, event: 'query.planned', phase: 'query', outcome: 'success', details: { requestId: 'q1', measures: [{ field: '订单金额' }] } });
  log.record({ traceId, event: 'query.compiled', phase: 'query', outcome: 'success', details: { requestId: 'q1', compiledPayloadHash: 'sha256:test' } });
  log.record({ traceId, event: 'query.execution.failed', phase: 'query', outcome: 'failed', details: { code: 'WYN_QUERY_FAILED', message: 'Generate result set failed' } });
  const events = log.trace(traceId);
  assert.deepEqual(events.map(item => item.event), ['query.planned', 'query.compiled', 'query.execution.failed']);
  assert.equal(events[2].details.message, 'Generate result set failed');
});

test('查询路由保留适配器执行失败的结构化诊断', async () => {
  const router = new QueryRouter([{
    id: 'controlled-test-adapter', version: 'test', capabilities: {},
    canExecute: () => true,
    estimate: () => ({ cost: 1 }),
    compile: () => ({ adapter: 'controlled-test-adapter' }),
    execute: async () => {
      const error = new Error('Generate result set failed');
      error.code = 'WYN_QUERY_FAILED';
      error.status = 502;
      error.retryable = true;
      throw error;
    },
    normalize: () => null,
  }]);
  await assert.rejects(
    () => router.execute({
      id: 'qry-router-diagnostic', purpose: '总销售额', mode: 'aggregate',
      dataset: { id: metadata.id, revision: metadata.revision }, select: [],
      measures: [{ field: '订单金额', aggregation: 'sum', alias: 'revenue' }], limit: 1,
    }, { metadata }),
    error => error.code === 'QUERY_EXECUTION_FAILED'
      && error.requestId === 'qry-router-diagnostic'
      && error.attempts?.[0]?.adapter === 'controlled-test-adapter'
      && error.attempts?.[0]?.code === 'WYN_QUERY_FAILED'
      && error.attempts?.[0]?.retryable === true,
  );
});
