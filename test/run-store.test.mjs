import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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

// 固定的“当前时间”，让按时间保留的断言可复现。
const NOW = Date.parse('2026-09-30T00:00:00.000Z');
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();

test('按时间保留：超出保留窗口的记录在启动时从磁盘删除', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-retention-runs-'));
  try {
    // 写入 3 旧 2 新；maxItems 足够大，确保删除只由时间策略触发。
    const seeded = new JsonRunStore(directory, { maxItems: 100 });
    await seeded.init();
    const cases = [[30, 'old30'], [20, 'old20'], [8, 'old08'], [6, 'new06'], [1, 'new01']];
    for (const [days, tag] of cases) {
      await seeded.save({ id: `operation-event-${tag}00000000`, at: daysAgo(days), event: `d${days}` });
    }
    assert.equal((await readdir(directory)).length, 5);

    const store = new JsonRunStore(directory, { maxItems: 100, retentionDays: 7, now: () => NOW });
    await store.init();

    // 只剩窗口内的 2 条，过期记录已从内存与磁盘同时移除。
    assert.equal(store.list().length, 2);
    assert.equal((await readdir(directory)).length, 2);
    assert.ok(store.list().every(item => Date.parse(item.at) >= NOW - 7 * 86_400_000));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('按时间保留：每次保存都会滚动清理过期记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-retention-rolling-'));
  try {
    // 直接落盘一条 30 天前的历史记录。
    await writeFile(join(directory, 'operation-event-old0000001.json'), JSON.stringify({ id: 'operation-event-old0000001', at: daysAgo(30) }), 'utf8');
    const store = new JsonRunStore(directory, { maxItems: 100, retentionDays: 7, now: () => NOW });
    await store.init();
    // 写入一条新记录触发 prune：过期记录清理，新记录保留。
    await store.save({ id: 'operation-event-new0000001', at: daysAgo(1), event: 'new' });
    const left = (await readdir(directory)).filter(name => name.endsWith('.json'));
    assert.deepEqual(left, ['operation-event-new0000001.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('按时间保留：缺少业务时间字段时回退到文件 mtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-retention-unknown-'));
  try {
    // 无业务时间字段时，以 mtime 作为时间依据：旧 mtime 视为过期，新 mtime 视为有效。
    const staleFile = join(directory, 'operation-event-stale00001.json');
    const freshFile = join(directory, 'operation-event-fresh00001.json');
    await writeFile(staleFile, JSON.stringify({ id: 'operation-event-stale00001', event: 'legacy' }), 'utf8');
    await writeFile(freshFile, JSON.stringify({ id: 'operation-event-fresh00001', event: 'legacy' }), 'utf8');
    const stale = new Date(NOW - 30 * 86_400_000);
    const fresh = new Date(NOW - 1 * 86_400_000);
    await utimes(staleFile, stale, stale);
    await utimes(freshFile, fresh, fresh);

    const store = new JsonRunStore(directory, { maxItems: 100, retentionDays: 7, now: () => NOW });
    await store.init();
    assert.deepEqual(store.list().map(item => item.id), ['operation-event-fresh00001']);
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('按时间保留：retentionDays 未设置时不影响原有条数裁剪行为', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wynai-retention-off-'));
  try {
    const store = new JsonRunStore(directory, { maxItems: 2 });
    await store.init();
    await store.save(run('run-00000001', 1));
    await store.save(run('run-00000002', 2));
    await store.save(run('run-00000003', 3));
    // 仅按条数裁剪，仍保留最新 2 条。
    assert.deepEqual(store.list().map(item => item.id), ['run-00000003', 'run-00000002']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
