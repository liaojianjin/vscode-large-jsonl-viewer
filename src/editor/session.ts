import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { stat, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Identity } from '../io/files';
import type { Progress } from '../protocol/types';

export class FileSession extends EventEmitter {
  generation = 1;
  source?: Identity;
  progress: Progress = { state: 'indexing', size: 0, scannedBytes: 0, lines: 0, initialReady: 0, speed: 0, elapsedMs: 0, restored: false };
  private worker?: Worker;
  private monitor?: ReturnType<typeof setInterval>;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: [number, number]): void; reject(error: Error): void }>();
  private disposed = false;
  private busy = 0;
  constructor(readonly file: string, readonly directory: string, readonly workerPath: string, readonly chunkBytes: number) { super(); this.start(); }
  private start(): void {
    const generation = this.generation;
    this.worker = new Worker(this.workerPath, { workerData: { file: this.file, directory: this.directory, chunkBytes: this.chunkBytes } });
    this.worker.on('message', message => {
      if (generation !== this.generation || this.disposed || this.progress.state === 'changed') return;
      if (message.type === 'initialized') { this.source = message.source; this.emit('source'); }
      if (message.type === 'progress') { this.progress = message.progress; this.emit('progress', this.progress); }
      if (message.type === 'range') {
        const request = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) { request?.reject(new Error(message.error)); this.fail(message.error, false); }
        else request?.resolve(message.range);
      }
      if (message.type === 'failure') this.fail(message.error, message.changed);
    });
    this.worker.on('error', error => { if (generation === this.generation && !this.disposed) this.fail(error.message, false); });
    this.worker.on('exit', code => { if (code && generation === this.generation && !this.disposed) this.fail(`索引 worker 退出 (${code})。`, false); });
    this.monitor = setInterval(() => { void this.validate().catch(error => this.fail(error.message, true)); }, 2000);
    this.monitor.unref();
  }
  async validate(): Promise<void> {
    if (!this.source || this.disposed) return;
    const s = await stat(this.file), expected = this.source;
    if (s.size !== expected.size || s.mtimeMs !== expected.mtimeMs || s.ctimeMs !== expected.ctimeMs || s.ino !== expected.ino || s.dev !== expected.dev) {
      this.fail('源文件已变化，旧索引已失效。点击“重建索引”读取新版本。', true);
      throw new Error('源文件已变化。');
    }
  }
  fail(message: string, changed: boolean): void {
    if (this.disposed || ['changed', 'error'].includes(this.progress.state)) return;
    this.progress = { ...this.progress, state: changed ? 'changed' : 'error', error: message, speed: 0, etaSeconds: undefined };
    for (const request of this.pending.values()) request.reject(new Error(message)); this.pending.clear();
    void this.worker?.terminate();
    this.emit('progress', this.progress); this.emit('invalid', message);
  }
  async range(line: number): Promise<[number, number]> {
    await this.validate();
    if (['changed', 'error'].includes(this.progress.state)) throw new Error(this.progress.error);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId; this.pending.set(id, { resolve, reject }); this.worker!.postMessage({ type: 'range', id, line });
    });
  }
  control(state: 'running' | 'paused' | 'cancelled'): void {
    if (['complete', 'changed', 'error'].includes(this.progress.state)) return;
    this.worker?.postMessage({ type: 'control', state });
  }
  async reload(): Promise<void> {
    this.generation++;
    if (this.monitor) clearInterval(this.monitor);
    await this.worker?.terminate();
    await rm(path.join(this.directory, 'manifest.json'), { force: true }).catch(() => {});
    for (const request of this.pending.values()) request.reject(new Error('索引已重建。')); this.pending.clear();
    this.source = undefined; this.busy = 0;
    this.progress = { state: 'indexing', size: 0, scannedBytes: 0, lines: 0, initialReady: 0, speed: 0, elapsedMs: 0, restored: false };
    this.emit('reset'); this.start();
  }
  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    if (this.monitor) clearInterval(this.monitor);
    for (const request of this.pending.values()) request.reject(new Error('文档已关闭。')); this.pending.clear();
    const worker = this.worker;
    this.removeAllListeners();
    return new Promise(resolve => {
      if (!worker) { resolve(); return; }
      const timeout = setTimeout(() => { void worker.terminate().then(() => resolve()); }, 1000); timeout.unref();
      worker.once('exit', () => { clearTimeout(timeout); resolve(); });
      worker.postMessage({ type: 'control', state: 'disposed' });
    });
  }
  foreground(delta: number): void { this.busy = Math.max(0, this.busy + delta); this.worker?.postMessage({ type: 'foreground', busy: this.busy > 0 }); }
}
/** LRU cleanup runs outside indexing and skips all active sessions. */
export async function pruneCache(root: string, budget: number, active: Set<string>): Promise<void> {
  const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
  const entries: { directory: string; size: number; time: number }[] = [];
  for (const dir of directories) {
    if (!dir.isDirectory() || !/^[a-f0-9]{64}$/.test(dir.name)) continue;
    const directory = path.join(root, dir.name);
    const names = await readdir(directory).catch(() => []);
    let size = 0;
    for (const name of names) size += (await stat(path.join(directory, name)).catch(() => ({ size: 0 }))).size;
    const info = await stat(path.join(directory, 'manifest.json')).catch(() => ({ mtimeMs: 0 }));
    entries.push({ directory, size, time: info.mtimeMs });
    if (!active.has(directory)) {
      // Remove abandoned page snapshots left by a crash, keeping committed pages.
      try {
        const m = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
        const keep = new Set((m.pages as { file: string }[]).map(p => p.file));
        for (const name of names) if ((name.startsWith('page-') && !keep.has(name)) || name.endsWith('.tmp')) await rm(path.join(directory, name), { force: true });
      } catch { /* Invalid caches are rebuilt when opened. */ }
    }
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries.sort((a, b) => a.time - b.time)) {
    if (total <= budget) break;
    if (active.has(entry.directory)) continue;
    await rm(entry.directory, { recursive: true, force: true }); total -= entry.size;
  }
}
