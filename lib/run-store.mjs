import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 一次最多并发打开的读取句柄数。
 * 无界 Promise.all 会在记录较多时触发 EMFILE（Windows 约 8K 句柄），
 * 被 load 的 catch 吞掉后会造成「内存索引 < 磁盘文件」的静默丢失。
 */
const LOAD_CONCURRENCY = Math.max(1, Number(process.env.WYN_AI_STORE_LOAD_CONCURRENCY) || 64);

const DAY_MS = 86_400_000;

function parseTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 记录时间戳按可信度回退：完成时间 → 创建时间 → 更新时间 → 事件时间。
 * operation-event 等事件流记录没有 createdAt/completedAt，必须回退到 `at`，
 * 否则全部为 0，排序退化为插入顺序，prune 会删除「最新」而非「最旧」。
 *
 * `fallbackMs` 用于记录缺少任何业务时间字段时的兜底（通常为文件 mtime），
 * 保证按时间保留策略不会把「时间未知」的旧记录误判为已过期而删除。
 */
function runTimestamp(run, fallbackMs = 0) {
  return parseTimestamp(run?.completedAt)
    ?? parseTimestamp(run?.createdAt)
    ?? parseTimestamp(run?.updatedAt)
    ?? parseTimestamp(run?.at)
    ?? fallbackMs;
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

/** 解析保留天数：0/负数/非法值表示不按时间保留。 */
function normalizeRetentionDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return null;
  return days;
}

/**
 * 是否超出保留窗口。
 * 时间未知（age 为 0 或非有限值）时一律视为「未过期」，
 * 避免把无法判定时间的记录当作旧数据删除。
 */
function isExpired(age, cutoff) {
  return cutoff != null && Number.isFinite(age) && age > 0 && age < cutoff;
}

function validRunId(value) {
  const id = String(value || '');
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error('无效的分析运行 ID');
  return id;
}

export class JsonRunStore {
  constructor(directory, { maxItems = 100, retentionDays = null, now = () => Date.now(), loadConcurrency = LOAD_CONCURRENCY } = {}) {
    this.directory = directory;
    this.maxItems = Math.max(1, Number(maxItems) || 100);
    this.retentionDays = normalizeRetentionDays(retentionDays);
    this.now = now;
    this.loadConcurrency = Math.max(1, Number(loadConcurrency) || LOAD_CONCURRENCY);
    this.runs = new Map();
    this.ages = new Map();
    this.writeQueues = new Map();
    this.loadStats = { files: 0, loaded: 0, skipped: 0, failed: 0 };
  }

  /** 保留窗口的时间下界；未启用按时间保留时返回 null。 */
  retentionCutoff() {
    return this.retentionDays == null ? null : this.now() - this.retentionDays * DAY_MS;
  }

  /** 记录当前时间戳；内存条目可能来自 save()，需与磁盘加载保持一致。 */
  trackAge(id, run, fallbackMs = 0) {
    this.ages.set(id, runTimestamp(run, fallbackMs));
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter(name => /^[a-zA-Z0-9-]{8,80}\.json$/.test(name));
    const stats = { files: files.length, loaded: 0, skipped: 0, failed: 0 };
    // 并发读取记录与其 mtime，作为缺少业务时间字段时的兜底。
    const metas = await mapWithConcurrency(files, this.loadConcurrency, async name => {
      try {
        const file = join(this.directory, name);
        const [raw, fileStat] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
        const run = JSON.parse(raw);
        if (!run?.id || run.id !== name.slice(0, -5)) {
          stats.skipped += 1;
          return null;
        }
        stats.loaded += 1;
        return { run, mtimeMs: fileStat.mtimeMs };
      } catch {
        stats.failed += 1;
        return null;
      }
    });
    this.loadStats = stats;
    if (stats.failed > 0 || stats.skipped > 0) {
      console.warn(`Run store ${this.directory} skipped ${stats.skipped} misnamed and ${stats.failed} unreadable record(s) out of ${stats.files}`);
    }
    const available = metas.filter(Boolean);
    const cutoff = this.retentionCutoff();
    this.ages.clear();
    for (const { run, mtimeMs } of available) this.trackAge(run.id, run, mtimeMs);
    // 过期记录不再装载进内存；因未进入 this.runs，必须在此显式删除磁盘文件，
    // 否则 prune() 无法看到它们，过期文件会永久残留。
    const retained = available.filter(({ run, mtimeMs }) => !isExpired(runTimestamp(run, mtimeMs), cutoff));
    const expired = available.filter(({ run, mtimeMs }) => isExpired(runTimestamp(run, mtimeMs), cutoff));
    if (expired.length > 0) {
      let removed = 0;
      for (const { run } of expired) {
        this.ages.delete(run.id);
        try {
          await rm(join(this.directory, `${run.id}.json`), { force: true });
          removed += 1;
        } catch (error) {
          console.error(`Run store failed to remove expired record ${run.id}`, error?.code || error?.message);
        }
      }
      console.warn(`Run store ${this.directory} retention ${this.retentionDays}d removed ${removed}/${expired.length} expired record(s) out of ${available.length}`);
    }
    for (const { run, mtimeMs } of retained.sort((a, b) => compareRunsAscending(a.run, b.run))) {
      this.runs.set(run.id, run);
      this.trackAge(run.id, run, mtimeMs);
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
      this.trackAge(id, persisted);
      await this.prune();
      return persisted;
    } finally {
      await rm(temporary, { force: true }).catch(() => null);
    }
  }
  /**
   * 双重保留策略：
   * - 按时间：超出 retentionDays 的记录一律删除（滚动保留）；
   * - 按条数：仅在启用 maxItems 时生效，作为记录数上限的安全网。
   *
   * 时间未知的记录不会被误删：`runTimestamp` 已回退到 mtime。
   */
  async prune() {
    const cutoff = this.retentionCutoff();
    const expired = cutoff == null ? [] : this.list().filter(run => isExpired(this.ages.get(run.id) ?? runTimestamp(run), cutoff));
    const overflow = this.list().slice(this.maxItems);
    // 合并去重，避免同一条记录被删除两次。
    const removable = new Map();
    for (const run of [...expired, ...overflow]) removable.set(run.id, run);
    let removed = 0;
    for (const run of removable.values()) {
      this.runs.delete(run.id);
      this.ages.delete(run.id);
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
