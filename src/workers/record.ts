import { parentPort, workerData } from 'node:worker_threads';
import { open } from 'node:fs/promises';
import { assertIdentity, decodeRecord, readExactly } from '../io/files';
import { processRecord, RecordBudgetError } from '../json/normal';
import { streamPage } from '../json/stream';
const port = parentPort!;
async function main(): Promise<void> {
  const { file, source, start, end, limitBytes, task, firstLine } = workerData;
  if (task === 'window') {
    const handle = await open(file, 'r');
    try {
      await assertIdentity(file, handle, source);
      const offset = Math.min(end - start, workerData.offset), position = start + offset;
      const buffer = Buffer.alloc(Math.min(65536, end - position));
      await readExactly(handle, buffer, position);
      // Align boundaries to UTF-8 sequences. Windows are fragments, never complete JSON values.
      let begin = 0, finish = buffer.length;
      while (begin < finish && (buffer[begin] & 0xc0) === 0x80) begin++;
      if (position + finish < end) {
        let last = finish - 1;
        while (last >= begin && (buffer[last] & 0xc0) === 0x80) last--;
        if (last >= begin) { const b = buffer[last], needed = b < 128 ? 1 : b < 224 ? 2 : b < 240 ? 3 : 4; if (finish - last < needed) finish = last; }
      }
      const text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(begin, finish));
      await assertIdentity(file, handle, source);
      port.postMessage({ type: 'window', text, offset: offset + begin, next: offset + finish, total: end - start });
    } finally { await handle.close(); }
    return;
  }
  if (task === 'record' && end - start <= limitBytes) {
    const handle = await open(file, 'r');
    try {
      await assertIdentity(file, handle, source);
      const bytes = Buffer.alloc(end - start); await readExactly(handle, bytes, start);
      let record;
      try { const { raw, bom } = decodeRecord(bytes, firstLine); record = processRecord(raw, bom); }
      catch (error) { if (error instanceof RecordBudgetError) record = undefined; else {
        const hex = bytes.subarray(0, 65536).toString('hex').replace(/(.{2})/g, '$1 ');
        const preview = `UTF-8 解码失败。以下为前 ${Math.min(bytes.length, 65536)} 字节的十六进制片段：\n${hex}`;
        record = { mode: 'normal', raw: preview, formatted: preview, valid: false, bom: false, outline: [], folds: [], issues: [{ message: `UTF-8 解码失败：${(error as Error).message}`, line: 1, column: 1 }], outlineTruncated: false };
      } }
      await assertIdentity(file, handle, source);
      if (record) { port.postMessage({ type: 'record', record }); return; }
    } finally { await handle.close(); }
  }
  port.postMessage({ type: 'largeStart', start, end });
  const page = await streamPage({ file, source, start, end, firstLine, skip: workerData.skip ?? 0, update: page => port.postMessage({ type: 'large', page }) });
  port.postMessage({ type: 'large', page });
}
main().catch(error => port.postMessage({ type: 'failure', error: error.message, changed: error.name === 'FileChangedError' })).finally(() => port.close());
