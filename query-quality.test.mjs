import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeQueryQuality } from './query-quality.mjs';
test('quality summary aggregates indicators', () => { const result = summarizeQueryQuality([{ traceId: 't1', event: 'request.completed', at: '2026-09-12T00:00:00Z', datasetId: 'sales', durationMs: 100, details: { qualityVersion: 1, status: 'ok', hasResult: true, resultRows: 1, llmCalls: 2, repairAttempted: true, resultLimited: false, totals: [] } }, { traceId: 't2', event: 'request.completed', at: '2026-09-12T00:01:00Z', datasetId: 'sales', durationMs: 200, details: { qualityVersion: 1, status: 'ok', hasResult: true, resultRows: 0, emptyResult: true, resultLimited: false, totals: [] } }, { traceId: 't3', event: 'request.failed', at: '2026-09-12T00:02:00Z', datasetId: 'sales', durationMs: 300, details: { qualityVersion: 1, code: 'LLM_TIMEOUT', hasResult: false } }]); assert.equal(result.total.requests, 3); assert.equal(result.total.failed, 1); assert.equal(result.total.emptyResultRate, 1 / 2); assert.equal(result.total.errorCodes.LLM_TIMEOUT, 1); });
test('quality summary supports windows and excludes raw events', () => { const result = summarizeQueryQuality([{ traceId: 't1', event: 'request.completed', at: '2026-09-11T00:00:00Z', details: { prompt: 'secret' } }], { since: '2026-09-12T00:00:00Z' }); assert.equal(result.total.requests, 0); assert.equal('events' in result, false); });

test('quality summary derives transport retry from gateway attempts', () => {
  const result = summarizeQueryQuality([
    { traceId: 'retry-1', event: 'request.accepted', at: '2026-09-12T00:00:00Z', datasetId: 'sales' },
    { traceId: 'retry-1', event: 'gateway.attempt', at: '2026-09-12T00:00:00Z', datasetId: 'sales', details: { attempt: 1, model: 'm' } },
    { traceId: 'retry-1', event: 'gateway.attempt', at: '2026-09-12T00:00:01Z', datasetId: 'sales', details: { attempt: 2, model: 'm' } },
    { traceId: 'retry-1', event: 'request.completed', at: '2026-09-12T00:00:02Z', datasetId: 'sales', durationMs: 200, details: { qualityVersion: 1, status: 'ok', hasResult: true, resultRows: 1, totals: [] } },
  ]);
  assert.equal(result.total.transportRetried, undefined);
  assert.equal(result.total.retryRate, 1);
  assert.equal(result.records[0].transportRetried, true);
});
