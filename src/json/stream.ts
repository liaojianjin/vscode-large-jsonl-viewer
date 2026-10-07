import { open } from 'node:fs/promises';
import { assertIdentity, readExactly, type Identity } from '../io/files';
import type { JsonKind, LargeNode, LargePage } from '../protocol/types';

interface Token { type: JsonKind | '{' | '}' | '[' | ']' | ':' | ','; start: number; end: number; preview: string }
interface Frame { node: LargeNode; state: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd'; count: number; key?: string; captured: boolean }
/** A strict incremental byte tokenizer. Token previews are bounded; numbers are never converted. */
class Tokenizer {
  private mode: 'idle' | 'string' | 'number' | 'keyword' = 'idle';
  private start = 0;
  private preview: number[] = [];
  private tokenLength = 0;
  private escape = false;
  private unicode = 0;
  private numberState = '';
  private keyword = '';
  private keywordIndex = 0;
  constructor(private emit: (token: Token) => void) {}
  private add(b: number): void { this.tokenLength++; if (this.preview.length < 4096) this.preview.push(b); }
  private finish(type: Token['type'], end: number): void {
    let preview = Buffer.from(this.preview).toString('utf8');
    if (this.tokenLength > this.preview.length) preview = preview.slice(0, 200) + '…';
    this.emit({ type, start: this.start, end, preview });
    this.mode = 'idle'; this.preview = []; this.tokenLength = 0;
  }
  private error(offset: number): never { throw new Error(`无效 JSON，记录内字节 ${offset + 1}。`); }
  feed(buffer: Buffer, base: number): void {
    for (let i = 0; i < buffer.length; i++) {
      const b = buffer[i], offset = base + i;
      if (this.mode === 'string') {
        this.add(b);
        if (this.unicode) { if (!((b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102))) this.error(offset); this.unicode--; }
        else if (this.escape) { this.escape = false; if (b === 117) this.unicode = 4; else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(b)) this.error(offset); }
        else if (b === 92) this.escape = true;
        else if (b === 34) this.finish('string', offset + 1);
        else if (b < 32) this.error(offset);
        continue;
      }
      if (this.mode === 'keyword') {
        if (this.keywordIndex < this.keyword.length) {
          if (b !== this.keyword.charCodeAt(this.keywordIndex++)) this.error(offset);
          this.add(b); continue;
        }
        this.finish(this.keyword === 'null' ? 'null' : 'boolean', offset); i--; continue;
      }
      if (this.mode === 'number') {
        const digit = b >= 48 && b <= 57;
        const state = this.numberState;
        if (state === 'sign') { if (!digit) this.error(offset); this.numberState = b === 48 ? 'zero' : 'integer'; }
        else if ((state === 'zero' || state === 'integer') && b === 46) this.numberState = 'dot';
        else if (['zero', 'integer', 'fraction'].includes(state) && (b === 101 || b === 69)) this.numberState = 'exp';
        else if (state === 'integer' && digit) { /* another integer digit */ }
        else if (state === 'dot' && digit) this.numberState = 'fraction';
        else if (state === 'fraction' && digit) { /* another fraction digit */ }
        else if (state === 'exp' && (b === 43 || b === 45)) this.numberState = 'expSign';
        else if ((state === 'exp' || state === 'expSign') && digit) this.numberState = 'expDigits';
        else if (state === 'expDigits' && digit) { /* another exponent digit */ }
        else {
          if (!['zero', 'integer', 'fraction', 'expDigits'].includes(state)) this.error(offset);
          this.finish('number', offset); i--; continue;
        }
        this.add(b); continue;
      }
      if ([32, 9, 10, 13].includes(b)) continue;
      this.start = offset;
      if ([123, 125, 91, 93, 58, 44].includes(b)) { this.emit({ type: String.fromCharCode(b) as Token['type'], start: offset, end: offset + 1, preview: '' }); continue; }
      this.add(b);
      if (b === 34) this.mode = 'string';
      else if (b === 45 || (b >= 48 && b <= 57)) { this.mode = 'number'; this.numberState = b === 45 ? 'sign' : b === 48 ? 'zero' : 'integer'; }
      else if (b === 116 || b === 102 || b === 110) { this.mode = 'keyword'; this.keyword = b === 116 ? 'true' : b === 102 ? 'false' : 'null'; this.keywordIndex = 1; }
      else this.error(offset);
    }
  }
  end(offset: number): void {
    if (this.mode === 'keyword' && this.keywordIndex === this.keyword.length) this.finish(this.keyword === 'null' ? 'null' : 'boolean', offset);
    else if (this.mode === 'number' && ['zero', 'integer', 'fraction', 'expDigits'].includes(this.numberState)) this.finish('number', offset);
    else if (this.mode !== 'idle') this.error(offset);
  }
}
export interface StreamOptions {
  file: string; source: Identity; start: number; end: number; skip?: number; limit?: number; chunkBytes?: number;
  firstLine?: boolean; update?(page: LargePage): void; cancelled?(): boolean;
}
/** Keeps only the selected page and an explicit depth-limited stack, regardless of record size. */
export async function streamPage(options: StreamOptions): Promise<LargePage> {
  const handle = await open(options.file, 'r'), decoder = new TextDecoder('utf8', { fatal: true, ignoreBOM: true });
  const children: LargeNode[] = [], stack: Frame[] = [];
  const skip = options.skip ?? 0, limit = Math.min(100, options.limit ?? 100);
  let root: LargeNode | undefined, rootDone = false, position = options.start, lastUpdate = 0;
  const makePage = (done: boolean, error?: string): LargePage => ({ mode: 'large', root: root ? { ...root, end: root.end < root.start ? options.end : root.end } : { id: `b${options.start}`, key: '$', kind: 'null', start: options.start, end: options.end, preview: '' }, children: children.filter(n => n.end >= 0), skip, total: root?.count ?? stack[0]?.count ?? 0, scannedBytes: position - options.start, size: options.end - options.start, done, valid: done && !error, error });
  const fail = (t: Token): never => { throw new Error(`无效 JSON，文件字节 ${t.start + 1}：意外的 ${t.type}。`); };
  const tokenizer = new Tokenizer(t => {
    const parent = stack.at(-1);
    if (parent?.node.kind === 'object' && (parent.state === 'keyOrEnd' || parent.state === 'key')) {
      if (t.type === 'string') {
        try { parent.key = JSON.parse(t.preview) as string; } catch { parent.key = t.preview.slice(0, 200); }
        parent.state = 'colon'; return;
      }
      if (!(parent.state === 'keyOrEnd' && t.type === '}')) fail(t);
    }
    if (parent?.state === 'colon') { if (t.type !== ':') fail(t); parent.state = 'value'; return; }
    if (t.type === '}' || t.type === ']') {
      if (!parent || (parent.node.kind === 'object' ? t.type !== '}' : t.type !== ']') || !['commaOrEnd', 'keyOrEnd', 'valueOrEnd'].includes(parent.state)) fail(t);
      parent!.node.end = t.end; parent!.node.count = parent!.count;
      stack.pop(); if (!stack.length) rootDone = true; return;
    }
    if (parent?.state === 'commaOrEnd') {
      if (t.type !== ',') fail(t);
      parent.state = parent.node.kind === 'object' ? 'key' : 'value'; return;
    }
    if (parent && !['value', 'valueOrEnd'].includes(parent.state)) fail(t);
    if (rootDone || (!parent && root)) fail(t);
    if (t.type === ':' || t.type === ',') fail(t);
    const kind = t.type === '{' ? 'object' : t.type === '[' ? 'array' : t.type as JsonKind;
    const index = parent?.count ?? 0, captured = stack.length === 1 && index >= skip && index < skip + limit;
    const node: LargeNode = { id: `b${t.start}`, key: parent?.key ?? (parent ? `[${index}]` : '$'), kind, start: t.start, end: kind === 'object' || kind === 'array' ? -1 : t.end, preview: t.preview.slice(0, 240) };
    if (parent) { parent.count++; parent.state = 'commaOrEnd'; parent.key = undefined; }
    else root = node;
    if (captured) children.push(node);
    if (kind === 'object' || kind === 'array') {
      if (stack.length >= 2048) throw new Error('嵌套超过 2048 层，已停止结构扫描；可以继续查看原文窗口。');
      stack.push({ node, count: 0, captured, state: kind === 'object' ? 'keyOrEnd' : 'valueOrEnd' });
    } else if (!parent) rootDone = true;
  });
  try {
    await assertIdentity(options.file, handle, options.source);
    let contentEnd = options.end;
    const lastBytes = Buffer.alloc(Math.min(2, contentEnd - options.start));
    await readExactly(handle, lastBytes, contentEnd - lastBytes.length);
    if (lastBytes.at(-1) === 10) { contentEnd--; if (lastBytes.at(-2) === 13) contentEnd--; }
    if (options.firstLine && contentEnd - position >= 3) {
      const prefix = Buffer.alloc(3); await readExactly(handle, prefix, position);
      if (prefix.equals(Buffer.from([239, 187, 191]))) position += 3;
    }
    const buffer = Buffer.alloc(options.chunkBytes ?? 128 * 1024);
    while (position < contentEnd) {
      if (options.cancelled?.()) throw new Error('Cancelled');
      const chunk = buffer.subarray(0, Math.min(buffer.length, contentEnd - position));
      await readExactly(handle, chunk, position, options.cancelled);
      decoder.decode(chunk, { stream: true });
      tokenizer.feed(chunk, position); position += chunk.length;
      if (Date.now() - lastUpdate >= 250) { lastUpdate = Date.now(); await assertIdentity(options.file, handle, options.source); options.update?.(makePage(false)); }
    }
    decoder.decode(); tokenizer.end(contentEnd);
    if (!rootDone || stack.length || !root) throw new Error('无效 JSON：记录为空或容器未结束。');
    await assertIdentity(options.file, handle, options.source);
    return makePage(true);
  } catch (error) {
    if ((error as Error).name === 'FileChangedError' || (error as Error).message === 'Cancelled') throw error;
    return makePage(true, (error as Error).message);
  } finally { await handle.close(); }
}
