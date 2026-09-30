import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRunStore } from '../lib/run-store.mjs';

function run(id, minute) {
  return {
    id,
    status: 'completed',
    createdAt: `2026-08-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
    analysis: { dataset: { id: 'sales', name: '销售数据' } },
  };
}

/** operation-event 形态：只有 `at`，没有 createdAt/completedAt。 */
function event(id, minute) {
  return { id, schema: 'wynai.operation-event/v1', at: `2026-08-01T00:${String(minute).padStart(2, '0')}:00.000Z`, event: 'smart-query.turn' };
}

test('运行仓库原子保存、自动裁剪并可在重新初始化后恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-runs-'));
  try {
    const store = new JsonRunStore(directory, { maxItems: 2 });
    await store.init();
    await store.save(run('run-00000001', 1));
    await store.save(run('run-00000002', 2));
    await store.save(run('run-00000003', 3));
    assert.deepEqual(store.list().map(item => item.id), ['run-00000003', 'run-00000002']);
    assert.equal(store.get('run-00000001'), null);

    await writeFile(join(directory, 'corrupt-0001.json'), '{not-json', 'utf8');
    const restored = new JsonRunStore(directory, { maxItems: 2 });
    await restored.init();
    assert.deepEqual(restored.list().map(item => item.id), ['run-00000003', 'run-00000002']);
    assert.equal(restored.get('run-00000002').analysis.dataset.name, '销售数据');
    assert.throws(() => restored.get('../secret'), /无效的分析运行 ID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('并发保存同一记录不会复用临时文件或留下临时文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-concurrent-runs-'));
  try {
    const store = new JsonRunStore(directory, { maxItems: 10 });
    await store.init();
    await Promise.all(Array.from({ length: 24 }, (_, index) => store.save({ ...run('run-concurrent1', index), payload: { index } })));
    const persisted = JSON.parse(await readFile(join(directory, 'run-concurrent1.json'), 'utf8'));
    assert.ok(Number.isInteger(persisted.payload.index));
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('仅有 at 字段的事件流记录按业务时间保留最新并裁剪最旧', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-event-runs-'));
  try {
    const store = new JsonRunStore(directory, { maxItems: 3 });
    await store.init();
    for (let minute = 1; minute <= 6; minute += 1) await store.save(event(`operation-event-0000000${minute}`, minute));
    assert.deepEqual(store.list().map(item => item.id), [
      'operation-event-00000006',
      'operation-event-00000005',
      'operation-event-00000004',
    ]);
    assert.deepEqual((await readdir(directory)).sort(), [
      'operation-event-00000004.json',
      'operation-event-00000005.json',
      'operation-event-00000006.json',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('重新初始化时不会因句柄耗尽静默丢弃记录，并保持磁盘与内存一致', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-reload-runs-'));
  try {
    // 低并发上限用于在测试中复现「无界 Promise.all 触发 EMFILE」的场景。
    const store = new JsonRunStore(directory, { maxItems: 40, loadConcurrency: 1 });
    await store.init();
    for (let index = 1; index <= 60; index += 1) {
      await store.save(event(`operation-event-0000${String(index).padStart(4, '0')}`, index % 60));
    }
    assert.deepEqual((await readdir(directory)).length, 40);

    const restored = new JsonRunStore(directory, { maxItems: 40, loadConcurrency: 1 });
    await restored.init();
    assert.equal(restored.loadStats.files, 40);
    assert.equal(restored.loadStats.failed, 0);
    // 关键回归：加载数量必须等于磁盘文件数与内存索引数，不允许静默丢失。
    assert.equal(restored.loadStats.loaded, 40);
    assert.equal(restored.runs.size, 40);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('损坏与命名不符的记录会被统计并按时间戳稳定排序兜底', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-degraded-runs-'));
  try {
    const store = new JsonRunStore(directory, { maxItems: 10 });
    await store.init();
    await store.save(event('operation-event-00000002', 2));
    await writeFile(join(directory, 'operation-event-00000099.json'), '{not-json', 'utf8');
    await writeFile(join(directory, 'operation-event-00000098.json'), JSON.stringify({ id: 'mismatched-id', at: '2026-08-01T00:00:09.000Z' }), 'utf8');

    const restored = new JsonRunStore(directory, { maxItems: 10 });
    await restored.init();
    assert.equal(restored.loadStats.failed, 1);
    assert.equal(restored.loadStats.skipped, 1);
    assert.equal(restored.loadStats.loaded, 1);
    assert.deepEqual(restored.list().map(item => item.id), ['operation-event-00000002']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
