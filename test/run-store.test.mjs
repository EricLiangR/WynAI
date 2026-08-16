import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
