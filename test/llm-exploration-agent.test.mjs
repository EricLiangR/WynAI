import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplorationLlm } from '../lib/llm/exploration-agent.mjs';

test('LLM 连通探针使用实际客户端且不暴露 API Key', async () => {
  let request;
  const llm = createExplorationLlm({
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret-test-key',
    model: 'test-model',
    enableThinking: false,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    },
  });

  const result = await llm.probe();
  assert.equal(result.ok, true);
  assert.equal(result.model, 'test-model');
  assert.equal(request.url, 'https://example.test/v1/chat/completions');
  assert.equal(JSON.parse(request.options.body).model, 'test-model');
  assert.equal(JSON.parse(request.options.body).enable_thinking, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-test-key/);
});

test('LLM 网络错误包含目标主机和底层错误码但不暴露 API Key', async () => {
  const cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  const llm = createExplorationLlm({
    baseUrl: 'https://dashscope.example/v1',
    apiKey: 'secret-test-key',
    model: 'test-model',
    fetchImpl: async () => { throw new TypeError('fetch failed', { cause }); },
  });

  await assert.rejects(llm.probe(), error => {
    assert.match(error.message, /dashscope\.example/);
    assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/);
    assert.match(error.message, /fetch failed/);
    assert.doesNotMatch(error.message, /secret-test-key/);
    return true;
  });
});

test('LLM 主动超时使用明确错误码而不是通用 fetch failed', async () => {
  const llm = createExplorationLlm({
    baseUrl: 'https://dashscope.example/v1',
    apiKey: 'secret-test-key',
    model: 'test-model',
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  await assert.rejects(llm.probe(), error => {
    assert.equal(error.code, 'LLM_TIMEOUT');
    assert.match(error.message, /5ms/);
    assert.doesNotMatch(error.message, /secret-test-key|fetch failed/);
    return true;
  });
});

test('调用方取消会中断意图模型请求并返回明确取消错误', async () => {
  const llm = createExplorationLlm({
    baseUrl: 'https://dashscope.example/v1',
    apiKey: 'secret-test-key',
    model: 'test-model',
    timeoutMs: 1000,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = llm.planQueryIntent({
    metadata: { id: 'dataset', name: '销售数据', fields: [] },
    question: '分析一个模糊问题',
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'REQUEST_ABORTED');
    assert.match(error.message, /请求已取消/);
    return true;
  });
});
