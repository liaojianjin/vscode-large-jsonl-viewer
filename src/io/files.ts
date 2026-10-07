import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export class FileChangedError extends Error {
  constructor() { super('源文件已变化，请重新建立索引。'); this.name = 'FileChangedError'; }
}
export interface Identity { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number; fingerprint: string }
export interface Reader { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> }
export interface Writer { write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number }> }
export function safePosition(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('无效或超出安全整数范围的文件位置。');
  return value;
}
export async function readExactly(reader: Reader, buffer: Buffer, position: number, cancelled = () => false): Promise<void> {
  safePosition(position); safePosition(position + buffer.length);
  let offset = 0;
  while (offset < buffer.length) {
    if (cancelled()) throw new Error('Cancelled');
    const { bytesRead } = await reader.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead <= 0 || bytesRead > buffer.length - offset) throw new Error('读取时遇到意外 EOF 或无效短读。');
    offset += bytesRead;
  }
}
export async function writeExactly(writer: Writer, buffer: Buffer, position = 0): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await writer.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten <= 0 || bytesWritten > buffer.length - offset) throw new Error('写入索引时发生无效短写。');
    offset += bytesWritten;
  }
}
export async function identity(file: string): Promise<Identity> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('仅支持本地普通文件。');
    safePosition(info.size);
    const hash = createHash('sha256');
    for (const position of [0, Math.max(0, info.size - 65536)]) {
      const buffer = Buffer.alloc(Math.min(65536, info.size - position));
      await readExactly(handle, buffer, position);
      hash.update(buffer);
    }
    const result = { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino, fingerprint: hash.digest('hex') };
    await assertIdentity(file, handle, result);
    return result;
  } finally { await handle.close(); }
}
export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.dev === b.dev && a.ino === b.ino && a.fingerprint === b.fingerprint;
}
export async function assertIdentity(file: string, handle: FileHandle, expected: Identity): Promise<void> {
  const infos = await Promise.all([stat(file), handle.stat()]);
  for (const info of infos) {
    if (info.size !== expected.size || info.mtimeMs !== expected.mtimeMs || info.ctimeMs !== expected.ctimeMs || info.dev !== expected.dev || info.ino !== expected.ino) throw new FileChangedError();
  }
}
export function decodeRecord(buffer: Buffer, firstLine: boolean): { raw: string; bom: boolean } {
  let end = buffer.length;
  if (end && buffer[end - 1] === 10) { end--; if (end && buffer[end - 1] === 13) end--; }
  const bom = firstLine && end >= 3 && buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191;
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(bom ? 3 : 0, end));
  return { raw, bom };
}
