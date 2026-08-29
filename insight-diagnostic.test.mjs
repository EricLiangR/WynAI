import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsightDiagnosticLookupError, InsightDiagnosticStore } from './insight-diagnostic-store.mjs';
import { JsonRunStore } from './lib/run-store.mjs';
import { createLlmGateway } from './llm-gateway.mjs';

test('diagnostic store appends, resolves unique prefixes, and survives reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-diagnostic-'));
  try {
    const persistence = new JsonRunStore(directory, { maxItems: 10 });
    const first = new InsightDiagnosticStore({ persistence, idFactory: () => 'evt-fixed' });
    await first.init();
    await first.append('ins-12345678-aaaa', 'input.accepted', { prompt: '真实输入', rows: [{ value: 1 }] }, { actor: 'tester' });
    await first.append('ins-12345678-aaaa', 'generation.finished', { status: 'completed' });
    assert.equal(first.get('ins-12345678').events.length, 2);

    const second = new InsightDiagnosticStore({ persistence });
    await second.init();
    const restored = second.get('ins-12345678-aaaa');
    assert.equal(restored.schema, 'wynai.insight-diagnostic/v1');
    assert.deepEqual(restored.events.map(event => event.type), ['input.accepted', 'generation.finished']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('diagnostic store rejects ambiguous prefixes', async () => {
  const store = new InsightDiagnosticStore();
  await store.append('ins-abcdefgh-1111', 'input.accepted');
  await store.append('ins-abcdefgh-2222', 'input.accepted');
  assert.throws(() => store.get('ins-abcdefgh'), error => error instanceof InsightDiagnosticLookupError && error.code === 'INSIGHT_DIAGNOSTIC_PREFIX_AMBIGUOUS');
});

test('gateway emits complete provider attempt diagnostics', async () => {
  const events = [];
  const gateway = createLlmGateway({
    providers: [{ id: 'primary', baseUrl: 'https://llm.example.test/v1', apiKey: 'secret', model: 'demo' }],
    timeoutMs: 1000,
    firstByteTimeoutMs: 1000,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }], request }) };
    },
  });
  const value = await gateway.completeJson([{ role: 'user', content: 'keep this' }], { operation: 'insight-planner', onEvent: event => { events.push(event); } });
  assert.deepEqual(value, { ok: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'gateway.attempt');
  assert.equal(events[0].operation, 'insight-planner');
  assert.equal(events[0].request.messages[0].content, 'keep this');
  assert.equal(events[0].response.choices[0].message.content, '{"ok":true}');
  assert.equal(events[0].request.apiKey, undefined);
});

