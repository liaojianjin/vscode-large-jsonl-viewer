import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, open, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { writeExactly, safePosition, sameIdentity, type Identity } from '../io/files';

export const PAGE_ENTRIES = 4096;
interface Page { file: string; count: number; first: number; last: number }
interface Manifest { version: 1; source: Identity; count: number; safeByte: number; complete: boolean; pages: Page[] }
export class OffsetStore {
  private pages: Page[] = [];
  private memory = new Map<number, Buffer>();
  private tail = Buffer.alloc(PAGE_ENTRIES * 8);
  private tailCount = 0;
  private tailDirty = true;
  count = 0;
  safeByte = 0;
  complete = false;
  restored = false;
  private oldTail?: string;
  constructor(readonly directory: string, readonly source: Identity) {}
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      if ((await stat(path.join(this.directory, 'manifest.json'))).size > 16 * 1024 * 1024) throw new Error('索引头部过大。');
      const bytes = await readFile(path.join(this.directory, 'manifest.json'));
      if (bytes.length > 16 * 1024 * 1024) throw new Error('索引头部过大。');
      const m = JSON.parse(bytes.toString()) as Manifest;
      if (m.version !== 1 || !sameIdentity(m.source, this.source) || !Array.isArray(m.pages) || !Number.isSafeInteger(m.count) || m.count < 1 || typeof m.complete !== 'boolean') throw new Error('索引头部无效。');
      safePosition(m.safeByte);
      let count = 0, previous = -1;
      for (let i = 0; i < m.pages.length; i++) {
        const p = m.pages[i];
        if (!/^page-[a-f0-9-]+\.bin$/.test(p.file) || !Number.isInteger(p.count) || p.count < 1 || p.count > PAGE_ENTRIES || (i < m.pages.length - 1 && p.count !== PAGE_ENTRIES)) throw new Error('索引页目录无效。');
        safePosition(p.first); safePosition(p.last);
        if ((i === 0 && p.first !== 0) || p.first <= previous || p.last < p.first || p.last > this.source.size) throw new Error('索引页范围无效。');
        previous = p.last; count += p.count;
      }
      if (count !== m.count || previous !== m.safeByte || (m.complete && m.safeByte !== this.source.size)) throw new Error('索引检查点无效。');
      this.pages = m.pages; this.count = count; this.safeByte = m.safeByte; this.complete = m.complete;
      const lastIndex = this.pages.length - 1;
      const buffer = await this.loadPage(lastIndex);
      if (this.pages[lastIndex].count < PAGE_ENTRIES) {
        buffer.copy(this.tail); this.tailCount = this.pages[lastIndex].count; this.oldTail = this.pages.pop()!.file;
        this.memory.delete(lastIndex);
      }
      await this.get(0);
      this.tailDirty = false; this.restored = true;
      const now = new Date(); await utimes(path.join(this.directory, 'manifest.json'), now, now).catch(() => {});
    } catch {
      this.pages = []; this.memory.clear(); this.tailCount = 0; this.count = 0; this.safeByte = 0; this.complete = false; this.oldTail = undefined;
      await this.append(0);
    }
  }
  async append(offset: number): Promise<void> {
    safePosition(offset);
    if (this.count && offset <= this.safeByte) throw new Error('索引偏移不单调。');
    this.tail.writeBigUInt64LE(BigInt(offset), this.tailCount * 8);
    this.tailCount++; this.count++; this.safeByte = offset; this.tailDirty = true;
    if (this.tailCount === PAGE_ENTRIES) {
      const p = await this.savePage(this.tail, this.tailCount);
      this.pages.push(p); this.keep(this.pages.length - 1, this.tail);
      this.tail = Buffer.alloc(PAGE_ENTRIES * 8); this.tailCount = 0; this.tailDirty = false;
    }
  }
  async get(index: number): Promise<number> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) throw new Error('索引位置越界。');
    const pageIndex = Math.floor(index / PAGE_ENTRIES), local = index % PAGE_ENTRIES;
    const buffer = pageIndex === this.pages.length ? this.tail : await this.loadPage(pageIndex);
    return safePosition(Number(buffer.readBigUInt64LE(local * 8)));
  }
  async range(line: number): Promise<[number, number]> {
    if (!Number.isSafeInteger(line) || line < 1 || line >= this.count) throw new Error('该行尚未索引或已越界。');
    return [await this.get(line - 1), await this.get(line)];
  }
  private keep(index: number, buffer: Buffer): void {
    this.memory.delete(index); this.memory.set(index, buffer);
    while (this.memory.size > 128) this.memory.delete(this.memory.keys().next().value!);
  }
  private async loadPage(index: number): Promise<Buffer> {
    const existing = this.memory.get(index);
    if (existing) { this.keep(index, existing); return existing; }
    const p = this.pages[index];
    if ((await stat(path.join(this.directory, p.file))).size !== 36 + p.count * 8) throw new Error('索引页长度损坏。');
    const file = await readFile(path.join(this.directory, p.file));
    if (file.length !== 36 + p.count * 8 || file.readUInt32LE(32) !== p.count || !createHash('sha256').update(file.subarray(32)).digest().equals(file.subarray(0, 32))) throw new Error('索引页损坏，请重新建立索引。');
    const buffer = file.subarray(36);
    let previous = -1;
    for (let i = 0; i < p.count; i++) {
      const offset = safePosition(Number(buffer.readBigUInt64LE(i * 8)));
      if (offset <= previous || offset > this.source.size) throw new Error('索引页偏移无效。');
      previous = offset;
    }
    if (Number(buffer.readBigUInt64LE(0)) !== p.first || previous !== p.last) throw new Error('索引页边界损坏。');
    this.keep(index, buffer); return buffer;
  }
  private async savePage(buffer: Buffer, count: number): Promise<Page> {
    const file = `page-${randomUUID()}.bin`;
    const data = Buffer.alloc(36 + count * 8);
    data.writeUInt32LE(count, 32); buffer.copy(data, 36, 0, count * 8);
    createHash('sha256').update(data.subarray(32)).digest().copy(data, 0);
    const handle = await open(path.join(this.directory, file), 'wx');
    try { await writeExactly(handle, data); await handle.sync(); } finally { await handle.close(); }
    return { file, count, first: Number(buffer.readBigUInt64LE(0)), last: Number(buffer.readBigUInt64LE((count - 1) * 8)) };
  }
  async checkpoint(complete: boolean): Promise<void> {
    let tailPage: Page | undefined;
    if (this.tailCount) {
      if (!this.tailDirty && this.oldTail) tailPage = { file: this.oldTail, count: this.tailCount, first: Number(this.tail.readBigUInt64LE(0)), last: this.safeByte };
      else tailPage = await this.savePage(this.tail, this.tailCount);
    }
    const m: Manifest = { version: 1, source: this.source, count: this.count, safeByte: this.safeByte, complete, pages: tailPage ? [...this.pages, tailPage] : this.pages };
    const temp = path.join(this.directory, `manifest-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx');
    try { await writeExactly(handle, Buffer.from(JSON.stringify(m))); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path.join(this.directory, 'manifest.json'));
    if (this.oldTail && this.oldTail !== tailPage?.file) await unlink(path.join(this.directory, this.oldTail)).catch(() => {});
    this.oldTail = tailPage?.file; this.tailDirty = false; this.complete = complete;
  }
}
