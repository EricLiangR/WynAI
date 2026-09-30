import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAINTENANCE_DISPOSITIONS, DEFAULT_RETENTION_DAYS, RUNTIME_RETENTION, formatBytes, resolveRetention } from '../lib/runtime-retention.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

test('保留策略覆盖全部运行数据目录且默认只回收诊断类数据', () => {
  for (const [name, policy] of Object.entries(RUNTIME_RETENTION)) {
    assert.ok(Number.isInteger(policy.maxItems) && policy.maxItems > 0, `${name} 的 maxItems 必须是正整数`);
    assert.ok(['durable', 'audit', 'diagnostic'].includes(policy.disposition), `${name} 的 disposition 非法`);
    if (policy.retentionDays != null) assert.ok(Number.isFinite(policy.retentionDays) && policy.retentionDays > 0, `${name} 的 retentionDays 必须是正数`);
  }
  assert.deepEqual([...DEFAULT_MAINTENANCE_DISPOSITIONS], ['diagnostic']);
  assert.equal(DEFAULT_RETENTION_DAYS, 7);
  assert.equal(resolveRetention('not-a-real-dir'), null);
});

test('诊断类数据默认按 7 天滚动保留，业务数据不受时间策略影响', () => {
  for (const name of ['operation-events', 'insight-diagnostics']) {
    assert.equal(RUNTIME_RETENTION[name].retentionDays, DEFAULT_RETENTION_DAYS, `${name} 应按默认天数滚动保留`);
    assert.equal(RUNTIME_RETENTION[name].disposition, 'diagnostic');
  }
  for (const [name, policy] of Object.entries(RUNTIME_RETENTION)) {
    if (policy.disposition === 'durable') assert.equal(policy.retentionDays, undefined, `${name} 是业务数据，不应设时间保留`);
  }
});

test('保留策略与 server.mjs 实际使用的 maxItems 保持一致', async () => {
  const source = await readFile(join(projectRoot, 'server.mjs'), 'utf8');
  for (const [name, policy] of Object.entries(RUNTIME_RETENTION)) {
    const anchor = source.indexOf(`join(dataDir, '${name}')`);
    assert.ok(anchor >= 0, `server.mjs 未找到 ${name} 的 JsonRunStore 目录配置`);
    // 取目录出现位置之后的片段，并在遇到下一个 dataDir 目录前停止，避免串行匹配到别的目录。
    const tail = source.slice(anchor);
    const nextAnchor = tail.indexOf('join(dataDir, ', 1);
    const window = nextAnchor > 0 ? tail.slice(0, nextAnchor) : tail;
    const match = /maxItems:\s*([0-9_]+)/.exec(window);
    assert.ok(match, `server.mjs 未找到 ${name} 的 maxItems 配置`);
    const actual = Number(match[1].replaceAll('_', ''));
    assert.equal(actual, policy.maxItems, `${name} 的 maxItems 与 lib/runtime-retention.mjs 不一致：server=${actual} policy=${policy.maxItems}`);
  }
});

test('维护脚本可解析 CLI 参数且默认 dry-run', async () => {
  const source = await readFile(join(projectRoot, 'scripts', 'maintain-runtime-data.mjs'), 'utf8');
  // 默认必须是预览模式，避免误删生产数据。
  assert.match(source, /apply:\s*false/);
  assert.match(source, /--apply/);
  assert.match(source, /DEFAULT_MAINTENANCE_DISPOSITIONS/);
});

test('formatBytes 输出可读体积', () => {
  assert.equal(formatBytes(0), '0B');
  assert.equal(formatBytes(1024), '1.00KB');
  assert.equal(formatBytes(1024 * 1024 * 3), '3.00MB');
  assert.equal(formatBytes(undefined), '0B');
});
