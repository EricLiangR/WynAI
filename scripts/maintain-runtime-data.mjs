#!/usr/bin/env node
/**
 * 运行时过程数据维护脚本。
 *
 * 背景：JsonRunStore 只在 init()/save() 时按 maxItems 裁剪。若历史版本在句柄耗尽
 * （EMFILE）时静默丢弃记录，prune 会基于不完整的索引执行，导致目录无限增长
 * （本仓库曾出现 operation-events 31,078 个文件 vs 10,000 上限）。
 *
 * 用法：
 *   node scripts/maintain-runtime-data.mjs [--data-dir data] [--apply]
 *                                             [--dispositions diagnostic,audit]
 *                                             [--max-items-dir operation-events=3000]
 *                                             [--json]
 *
 * 默认 dry-run，只输出计划；加 --apply 才真正删除文件。
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  DEFAULT_MAINTENANCE_DISPOSITIONS,
  RUNTIME_RETENTION,
  formatBytes,
  resolveRetention,
} from '../lib/runtime-retention.mjs';

function parseArgs(argv) {
  const options = {
    dataDir: 'data',
    apply: false,
    dispositions: [...DEFAULT_MAINTENANCE_DISPOSITIONS],
    overrides: new Map(),
    retentionDays: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--data-dir') options.dataDir = argv[++index] || options.dataDir;
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length);
    else if (arg === '--retention-days') options.retentionDays = Number(argv[++index]);
    else if (arg.startsWith('--retention-days=')) options.retentionDays = Number(arg.slice('--retention-days='.length));
    else if (arg === '--dispositions') options.dispositions = String(argv[++index] || '').split(',').map(item => item.trim()).filter(Boolean);
    else if (arg.startsWith('--dispositions=')) options.dispositions = arg.slice('--dispositions='.length).split(',').map(item => item.trim()).filter(Boolean);
    else if (arg === '--max-items-dir') options.overrides.set(...splitOverride(argv[++index]));
    else if (arg.startsWith('--max-items-dir=')) options.overrides.set(...splitOverride(arg.slice('--max-items-dir='.length)));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`无法识别的参数：${arg}`);
  }
  if (options.retentionDays != null && (!Number.isFinite(options.retentionDays) || options.retentionDays < 0)) throw new Error(`--retention-days 需要非负数字，收到：${options.retentionDays}`);
  return options;
}

function splitOverride(value) {
  const [name, raw] = String(value || '').split('=');
  const maxItems = Number(raw);
  if (!name || !Number.isInteger(maxItems) || maxItems < 1) throw new Error(`--max-items-dir 需要 name=正整数，收到：${value}`);
  return [name, maxItems];
}

const RUN_FILE = /^[a-zA-Z0-9-]{8,80}\.json$/;

/** 读取记录时间：业务时间字段优先，缺失时回退到文件 mtime，保证排序可用。 */
async function readSortKey(file, fallbackMs) {
  try {
    const record = JSON.parse(await readFile(file, 'utf8'));
    for (const key of ['completedAt', 'createdAt', 'updatedAt', 'at']) {
      const parsed = Date.parse(record?.[key] || '');
      if (Number.isFinite(parsed)) return { time: parsed, source: key, id: record?.id || null };
    }
  } catch { /* 损坏记录回退到 mtime */ }
  return { time: fallbackMs, source: 'mtime', id: null };
}

async function collect(directory) {
  const names = (await readdir(directory)).filter(name => RUN_FILE.test(name));
  const records = [];
  let totalBytes = 0;
  for (const name of names) {
    const file = join(directory, name);
    const info = await stat(file);
    totalBytes += info.size;
    const key = await readSortKey(file, info.mtimeMs);
    records.push({ name, file, bytes: info.size, time: key.time, source: key.source, id: key.id });
  }
  // 最新在前；时间相同用文件名兜底，保证可复现。
  records.sort((a, b) => (b.time - a.time) || a.name.localeCompare(b.name));
  return { names, records, totalBytes };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法：node scripts/maintain-runtime-data.mjs [--data-dir data] [--apply] [--dispositions diagnostic] [--retention-days 7] [--max-items-dir name=N] [--json]');
    return;
  }
  const dataDir = resolve(process.cwd(), options.dataDir);
  const retroactiveCutoff = options.retentionDays == null ? null : Date.now() - options.retentionDays * 86_400_000;
  const report = {
    schema: 'wynai.runtime-data-maintenance/v1',
    dataDir,
    apply: options.apply,
    dispositions: options.dispositions,
    retroactiveRetentionDays: options.retentionDays,
    generatedAt: new Date().toISOString(),
    directories: [],
  };

  let existing = [];
  try {
    existing = (await readdir(dataDir, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name);
  } catch (error) {
    throw new Error(`运行数据目录不可读：${dataDir}（${error?.code || error?.message}）`);
  }

  for (const name of existing.sort()) {
    const policy = resolveRetention(name);
    const selected = policy ? options.dispositions.includes(policy.disposition) : false;
    const maxItems = options.overrides.get(name) ?? policy?.maxItems ?? null;
    // 优先使用 CLI 指定的天数，其次使用目录自身声明的保留天数。
    const retentionDays = options.retentionDays ?? policy?.retentionDays ?? null;
    const directory = join(dataDir, name);
    const { names, records, totalBytes } = await collect(directory);
    const entry = {
      name,
      disposition: policy?.disposition || 'unmanaged',
      maxItems,
      retentionDays,
      selected: selected || options.overrides.has(name),
      files: names.length,
      bytes: totalBytes,
      stale: 0,
      staleBytes: 0,
      deleted: 0,
    };
    if (entry.selected && (maxItems != null || retentionDays != null)) {
      // 与运行时一致的双重策略：按时间过期 ∪ 按条数溢出。
      const cutoff = retentionDays == null ? null : (retroactiveCutoff ?? Date.now() - retentionDays * 86_400_000);
      const byAge = cutoff == null ? [] : records.filter(item => item.time < cutoff);
      const byCount = maxItems == null ? [] : records.slice(maxItems);
      const staleMap = new Map();
      for (const item of [...byAge, ...byCount]) staleMap.set(item.name, item);
      const stale = [...staleMap.values()];
      entry.stale = stale.length;
      entry.staleBytes = stale.reduce((sum, item) => sum + item.bytes, 0);
      entry.staleReason = { byAge: byAge.length, byCount: byCount.length };
      const staleNames = new Set(stale.map(item => item.name));
      entry.oldestKept = records.find(item => !staleNames.has(item.name))?.name || null;
      entry.newestStale = stale[0]?.name || null;
      if (options.apply) {
        for (const item of stale) {
          try {
            await rm(item.file, { force: true });
            entry.deleted += 1;
          } catch (error) {
            console.error(`删除失败 ${item.file}：${error?.code || error?.message}`);
          }
        }
      }
    }
    report.directories.push(entry);
  }

  report.totalFiles = report.directories.reduce((sum, item) => sum + item.files, 0);
  report.totalBytes = report.directories.reduce((sum, item) => sum + item.bytes, 0);
  report.staleFiles = report.directories.reduce((sum, item) => sum + item.stale, 0);
  report.staleBytes = report.directories.reduce((sum, item) => sum + item.staleBytes, 0);
  report.deletedFiles = report.directories.reduce((sum, item) => sum + item.deleted, 0);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`运行数据目录：${dataDir}`);
  console.log(`模式：${options.apply ? 'APPLY（实际删除）' : 'DRY-RUN（仅预览）'}｜回收范围：${options.dispositions.join(', ')}`);
  if (options.retentionDays != null) console.log(`时间保留：仅保留最近 ${options.retentionDays} 天`);
  console.log('');
  for (const item of report.directories) {
    const flag = item.selected ? (item.stale > 0 ? '★' : '·') : ' ';
    const parts = [];
    if (item.retentionDays != null) parts.push(`保留 ${item.retentionDays} 天`);
    if (item.maxItems != null && item.maxItems !== null) parts.push(`上限 ${item.maxItems}`);
    const rule = parts.join(' / ') || '无';
    console.log(`${flag} ${item.name.padEnd(28)} ${String(item.files).padStart(6)} 条 / ${formatBytes(item.bytes).padStart(9)}  ${rule.padEnd(18)} 可回收 ${String(item.stale).padStart(6)} 条 / ${formatBytes(item.staleBytes)}  ${item.disposition}`);
  }
  console.log('');
  console.log(`合计：${report.totalFiles} 个文件 / ${formatBytes(report.totalBytes)}；可回收 ${report.staleFiles} 个 / ${formatBytes(report.staleBytes)}`);
  if (options.apply) console.log(`已删除：${report.deletedFiles} 个文件`);
  else if (report.staleFiles > 0) console.log('提示：加 --apply 执行删除。');
}

main().catch(error => {
  console.error(`维护脚本失败：${error?.message || error}`);
  process.exitCode = 1;
});
