import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 一次最多并发打开的读取句柄数。
 * 无界 Promise.all 会在记录较多时触发 EMFILE（Windows 约 8K 句柄），
 * 被 load 的 catch 吞掉后会造成「内存索引 < 磁盘文件」的静默丢失。
 */
const LOAD_CONCURRENCY = Math.max(1, Number(process.env.WYN_AI_STORE_LOAD_CONCURRENCY) || 64);

function parseTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 记录时间戳按可信度回退：完成时间 → 创建时间 → 更新时间 → 事件时间。
 * operation-event 等事件流记录没有 createdAt/completedAt，必须回退到 `at`，
 * 否则全部为 0，排序退化为插入顺序，prune 会删除「最新」而非「最旧」。
 */
function runTimestamp(run) {
  return parseTimestamp(run?.completedAt)
    ?? parseTimestamp(run?.createdAt)
    ?? parseTimestamp(run?.updatedAt)
    ?? parseTimestamp(run?.at)
    ?? 0;
}

/** 时间戳相同时用 id 兜底，保证跨进程、跨平台排序稳定可复现。 */
function compareRuns(a, b) {
  const delta = runTimestamp(b) - runTimestamp(a);
  if (delta !== 0) return delta;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

/** 升序比较器（最旧在前），同样在时间戳相同时用 id 兜底。 */
function compareRunsAscending(a, b) {
  const delta = runTimestamp(a) - runTimestamp(b);
  if (delta !== 0) return delta;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

/** 有界并发 map，避免一次性打开过多文件句柄。 */
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function validRunId(value) {
  const id = String(value || '');
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error('无效的分析运行 ID');
  return id;
}

export class JsonRunStore {
  constructor(directory, { maxItems = 100, loadConcurrency = LOAD_CONCURRENCY } = {}) {
    this.directory = directory;
    this.maxItems = Math.max(1, Number(maxItems) || 100);
    this.loadConcurrency = Math.max(1, Number(loadConcurrency) || LOAD_CONCURRENCY);
    this.runs = new Map();
    this.writeQueues = new Map();
    this.loadStats = { files: 0, loaded: 0, skipped: 0, failed: 0 };
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter(name => /^[a-zA-Z0-9-]{8,80}\.json$/.test(name));
    const stats = { files: files.length, loaded: 0, skipped: 0, failed: 0 };
    const loaded = await mapWithConcurrency(files, this.loadConcurrency, async name => {
      try {
        const run = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
        if (!run?.id || run.id !== name.slice(0, -5)) {
          stats.skipped += 1;
          return null;
        }
        stats.loaded += 1;
        return run;
      } catch {
        stats.failed += 1;
        return null;
      }
    });
    this.loadStats = stats;
    if (stats.failed > 0 || stats.skipped > 0) {
      console.warn(`Run store ${this.directory} skipped ${stats.skipped} misnamed and ${stats.failed} unreadable record(s) out of ${stats.files}`);
    }
    for (const run of loaded.filter(Boolean).sort(compareRunsAscending)) {
      this.runs.set(run.id, run);
    }
    await this.prune();
    return this.list();
  }

  get(id) {
    return this.runs.get(validRunId(id)) || null;
  }

  list() {
    return [...this.runs.values()].sort(compareRuns);
  }

  async save(run) {
    const id = validRunId(run?.id);
    const persisted = JSON.parse(JSON.stringify(run));
    const previous = this.writeQueues.get(id) || Promise.resolve();
    const operation = previous
      .catch(() => null)
      .then(() => this.writePersisted(id, persisted));
    this.writeQueues.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.writeQueues.get(id) === operation) this.writeQueues.delete(id);
    }
  }

  async writePersisted(id, persisted) {
    const target = join(this.directory, `${id}.json`);
    const temporary = join(this.directory, `${id}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temporary, target);
          break;
        } catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 4) throw error;
          await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
      this.runs.delete(id);
      this.runs.set(id, persisted);
      await this.prune();
      return persisted;
    } finally {
      await rm(temporary, { force: true }).catch(() => null);
    }
  }
  async prune() {
    if (this.runs.size <= this.maxItems) return 0;
    const stale = this.list().slice(this.maxItems);
    let removed = 0;
    for (const run of stale) {
      this.runs.delete(run.id);
      try {
        await rm(join(this.directory, `${run.id}.json`), { force: true });
        removed += 1;
      } catch (error) {
        console.error(`Run store failed to prune ${run.id}`, error?.code || error?.message);
      }
    }
    return removed;
  }
}
