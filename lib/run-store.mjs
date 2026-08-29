import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function runTimestamp(run) {
  return Date.parse(run?.completedAt || run?.createdAt || '') || 0;
}

function validRunId(value) {
  const id = String(value || '');
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error('无效的分析运行 ID');
  return id;
}

export class JsonRunStore {
  constructor(directory, { maxItems = 100 } = {}) {
    this.directory = directory;
    this.maxItems = Math.max(1, Number(maxItems) || 100);
    this.runs = new Map();
    this.writeQueues = new Map();
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter(name => /^[a-zA-Z0-9-]{8,80}\.json$/.test(name));
    const loaded = await Promise.all(files.map(async name => {
      try {
        const run = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
        return run?.id && run.id === name.slice(0, -5) ? run : null;
      } catch {
        return null;
      }
    }));
    for (const run of loaded.filter(Boolean).sort((a, b) => runTimestamp(a) - runTimestamp(b))) {
      this.runs.set(run.id, run);
    }
    await this.prune();
    return this.list();
  }

  get(id) {
    return this.runs.get(validRunId(id)) || null;
  }

  list() {
    return [...this.runs.values()].sort((a, b) => runTimestamp(b) - runTimestamp(a));
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
    const stale = this.list().slice(this.maxItems);
    for (const run of stale) {
      this.runs.delete(run.id);
      await rm(join(this.directory, `${run.id}.json`), { force: true });
    }
  }
}
