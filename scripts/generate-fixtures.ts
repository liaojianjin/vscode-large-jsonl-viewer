import { open, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeExactly } from '../src/io/files';
const args = process.argv.slice(2);
const argument = (key: string, fallback: string) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
export async function generate(file: string, sizeBytes: number, lineBytes = 100 * 1024, longBytes = 0): Promise<{ file: string; bytes: number; rows: number; lineBytes: number }> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || !Number.isSafeInteger(lineBytes) || lineBytes < 128 || longBytes < 0) throw new Error('Invalid fixture budget.');
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'wx');
  let position = 0, rows = 0;
  try {
    while (position < sizeBytes) {
      const length = rows === 49 && longBytes ? longBytes : lineBytes;
      const prefix = `{"id":${rows},"n":9007199254740993,"中😀":{"tags":["a","b"]},"text":"`;
      const suffix = '"}\n';
      const padding = Math.max(0, length - Buffer.byteLength(prefix + suffix));
      if (padding > 1024 * 1024) {
        const first = Buffer.from(prefix); await writeExactly(handle, first, position); position += first.length;
        const chunk = Buffer.alloc(1024 * 1024, 120);
        for (let rest = padding; rest > 0;) { const next = chunk.subarray(0, Math.min(rest, chunk.length)); await writeExactly(handle, next, position); position += next.length; rest -= next.length; }
        const last = Buffer.from(suffix); await writeExactly(handle, last, position); position += last.length;
      } else {
        const line = Buffer.from(prefix + 'x'.repeat(padding) + suffix); await writeExactly(handle, line, position); position += line.length;
      }
      rows++;
    }
  } finally { await handle.close(); }
  const result = { file, bytes: position, rows, lineBytes };
  await writeFile(`${file}.fixture.json`, JSON.stringify(result, null, 2)); return result;
}
if (require.main === module) {
  generate(path.resolve(argument('out', 'fixtures/sample.jsonl')), Number(argument('sizeMiB', '16')) * 1024 * 1024, Number(argument('lineKiB', '100')) * 1024, Number(argument('longMiB', '0')) * 1024 * 1024).then(r => console.log(JSON.stringify(r))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
