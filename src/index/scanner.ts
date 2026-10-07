import { open, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertIdentity, identity, readExactly, type Identity } from '../io/files';
import { OffsetStore } from './store';
import type { Progress } from '../protocol/types';

export interface ScanControl { state: 'running' | 'paused' | 'cancelled' | 'disposed'; foreground?: boolean; wait(): Promise<void> }
export interface ScanOptions { file: string; directory: string; chunkBytes?: number; control: ScanControl; progress(p: Progress): void; initialized?(store: OffsetStore, source: Identity): void }
export async function scanFile(options: ScanOptions): Promise<OffsetStore> {
  const source = await identity(options.file);
  let store = new OffsetStore(options.directory, source), warning: string | undefined;
  try { await store.initialize(); } catch {
    store = new OffsetStore(await mkdtemp(path.join(tmpdir(), 'large-jsonl-index-')), source);
    await store.initialize(); warning = '索引缓存不可写，正在使用临时索引；重新打开后可能需要重建。';
  }
  options.initialized?.(store, source);
  const handle = await open(options.file, 'r');
  const buffer = Buffer.alloc(options.chunkBytes ?? 4 * 1024 * 1024);
  let position = store.safeByte, startTime = Date.now(), lastPublish = 0, lastCheck = Date.now();
  let checkpointAt = Date.now(), lastInitial = Math.min(100, store.count - 1);
  const samples: { time: number; bytes: number }[] = [{ time: startTime, bytes: position }];
  const publish = (state: Progress['state'], force = false) => {
    const now = Date.now(); if (!force && now - lastPublish < 250) return;
    lastPublish = now;
    if (state === 'indexing') samples.push({ time: now, bytes: position });
    while (samples.length > 2 && samples[1].time < now - 10000) samples.shift();
    const duration = (now - samples[0].time) / 1000;
    const speed = state === 'indexing' && duration > 0 ? (position - samples[0].bytes) / duration : 0;
    options.progress({ state, size: source.size, scannedBytes: position, lines: store.count - 1, initialReady: Math.min(100, store.count - 1), speed, elapsedMs: now - startTime, etaSeconds: duration >= 2 && speed > 0 ? (source.size - position) / speed : undefined, restored: store.restored, warning });
  };
  try {
    publish(store.complete ? 'complete' : 'indexing', true);
    if (store.complete) return store;
    while (position < source.size) {
      if (options.control.state === 'disposed') { await store.checkpoint(false).catch(() => {}); return store; }
      if (options.control.state !== 'running') {
        await store.checkpoint(false).catch(() => { warning = '保存索引检查点失败，当前会话仍可访问已索引行。'; });
        publish(options.control.state === 'paused' ? 'paused' : 'cancelled', true);
        await options.control.wait(); samples.splice(0, samples.length, { time: Date.now(), bytes: position });
        continue;
      }
      const length = Math.min(buffer.length, source.size - position);
      await readExactly(handle, buffer.subarray(0, length), position);
      let found = buffer.indexOf(10, 0);
      while (found >= 0 && found < length) {
        await store.append(position + found + 1);
        if (store.count - 1 <= 100 && store.count - 1 > lastInitial) {
          lastInitial = store.count - 1;
          // Publish first record and then bounded groups before completing this chunk.
          if (lastInitial === 1 || lastInitial % 10 === 0) {
            const endOfChunk = position; position += found + 1; publish('indexing', true); position = endOfChunk;
          }
        }
        found = buffer.indexOf(10, found + 1);
      }
      position += length; publish('indexing');
      if (options.control.foreground && store.count > 100) await new Promise(resolve => setTimeout(resolve, 10));
      if (Date.now() - lastCheck > 1000) { await assertIdentity(options.file, handle, source); lastCheck = Date.now(); }
      if (Date.now() - checkpointAt > 2000) {
        await store.checkpoint(false).catch(() => { warning = '保存索引检查点失败，重新打开后将恢复上次有效检查点。'; });
        checkpointAt = Date.now();
      }
    }
    if (store.safeByte < source.size) await store.append(source.size);
    await assertIdentity(options.file, handle, source);
    publish('saving', true);
    await store.checkpoint(true).catch(() => { warning = '完整索引保存失败；当前会话可用，下次打开需继续索引。'; });
    store.complete = true;
    await assertIdentity(options.file, handle, source);
    publish('complete', true);
    return store;
  } finally { await handle.close(); }
}
