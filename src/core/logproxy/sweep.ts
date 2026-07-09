// 保存管理: 純粋な planSweep（何を gzip/削除するか決める）と、薄い executor runSweep。
// - idle な live .jsonl を segment gzip 化（<session>.<ts>.jsonl.gz、atomic rename、元 .jsonl 削除）
// - keepDays 超過は .jsonl/.jsonl.gz とも削除（prune が gzip より優先）
// - アクティブなセッション（書込 in-flight）は gzip しない
import { promises as fs } from "node:fs";
import { join } from "node:path";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const FILE_MODE = 0o600;

const LIVE_SUFFIX = ".jsonl";
const GZ_SUFFIX = ".jsonl.gz";

export interface SweepFile {
  name: string;
  mtimeMs: number;
}

export interface SweepOptions {
  keepDays: number;
  gzipIdleMinutes: number;
  activeSessions?: ReadonlySet<string>;
}

export interface SweepPlan {
  toGzip: string[];
  toDelete: string[];
}

/** ファイル名からセッションIDを導く（live: <session>.jsonl / gz: <session>.<ts>.jsonl.gz）。 */
export const sessionOf = (name: string): string => {
  if (name.endsWith(GZ_SUFFIX)) {
    const base = name.slice(0, -GZ_SUFFIX.length);
    const dot = base.lastIndexOf(".");
    return dot >= 0 ? base.slice(0, dot) : base;
  }
  if (name.endsWith(LIVE_SUFFIX)) return name.slice(0, -LIVE_SUFFIX.length);
  return name;
};

export const planSweep = (
  files: SweepFile[],
  now: number,
  opts: SweepOptions,
): SweepPlan => {
  const keepMs = opts.keepDays * DAY_MS;
  const gzipMs = opts.gzipIdleMinutes * MINUTE_MS;
  const active = opts.activeSessions ?? new Set<string>();
  const toGzip: string[] = [];
  const toDelete: string[] = [];
  for (const f of files) {
    const age = now - f.mtimeMs;
    if (age > keepMs) {
      toDelete.push(f.name); // prune は gzip より優先
      continue;
    }
    if (f.name.endsWith(GZ_SUFFIX)) continue; // 既に圧縮済みは再gzipしない
    if (!f.name.endsWith(LIVE_SUFFIX)) continue;
    if (age > gzipMs && !active.has(sessionOf(f.name))) toGzip.push(f.name);
  }
  return { toGzip, toDelete };
};

export interface RunSweepOptions extends SweepOptions {
  dir: string;
  now: number;
}

export const runSweep = async (
  o: RunSweepOptions,
): Promise<{ gzipped: number; deleted: number }> => {
  let entries: string[];
  try {
    entries = await fs.readdir(o.dir);
  } catch {
    return { gzipped: 0, deleted: 0 };
  }

  const files: SweepFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(LIVE_SUFFIX) && !name.endsWith(GZ_SUFFIX)) continue;
    try {
      const st = await fs.stat(join(o.dir, name));
      files.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      // stat 失敗はスキップ
    }
  }

  const plan = planSweep(files, o.now, o);
  let gzipped = 0;
  let deleted = 0;

  for (const name of plan.toGzip) {
    try {
      const src = join(o.dir, name);
      const gzName = `${sessionOf(name)}.${o.now}.jsonl.gz`;
      const tmp = join(o.dir, `${gzName}.tmp`);
      const data = await fs.readFile(src);
      await fs.writeFile(tmp, Bun.gzipSync(new Uint8Array(data)), {
        mode: FILE_MODE,
      });
      await fs.rename(tmp, join(o.dir, gzName)); // atomic
      await fs.unlink(src);
      gzipped++;
    } catch {
      // ファイル単位で fail-open
    }
  }

  for (const name of plan.toDelete) {
    try {
      await fs.unlink(join(o.dir, name));
      deleted++;
    } catch {
      // スキップ
    }
  }

  return { gzipped, deleted };
};
