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
    const target = join(this.directory, `${id}.json`);
    const temporary = join(this.directory, `${id}.${Date.now()}.tmp`);
    const persisted = JSON.parse(JSON.stringify(run));
    await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
    this.runs.delete(id);
    this.runs.set(id, persisted);
    await this.prune();
    return persisted;
  }

  async prune() {
    const stale = this.list().slice(this.maxItems);
    for (const run of stale) {
      this.runs.delete(run.id);
      await rm(join(this.directory, `${run.id}.json`), { force: true });
    }
  }
}
