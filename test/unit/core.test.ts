import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { scanFile, type ScanControl } from '../../src/index/scanner';
import { OffsetStore, PAGE_ENTRIES } from '../../src/index/store';
import { decodeRecord, identity, readExactly, writeExactly } from '../../src/io/files';
import { processRecord, RecordBudgetError } from '../../src/json/normal';
import { streamPage } from '../../src/json/stream';
import { parseClientMessage } from '../../src/protocol/types';

const running = (): ScanControl => ({ state: 'running', wait: async () => {} });
async function fixture(data: string | Buffer): Promise<{ dir: string; file: string; cache: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-test-')), file = path.join(dir, 'source.jsonl');
  await writeFile(file, data); return { dir, file, cache: path.join(dir, 'cache') };
}
// Independent physical-line oracle: it does not use the index scanner or offset store.
function oracle(bytes: Buffer): [number, number][] {
  const result: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) { result.push([start, i + 1]); start = i + 1; }
  if (start < bytes.length) result.push([start, bytes.length]);
  return result;
}
for (const data of ['', '{}', '{}\n', '{}\n\nnull', '\n\n', '{}\r\n[1,2]\r\n', '\ufeff{"中😀":"a\\nb"}\n0', 'true\rfalse', Array.from({ length: 101 }, (_, i) => `{"n":${i}}`).join('\n')]) {
  test(`byte boundaries: ${JSON.stringify(data.slice(0, 40))}`, async () => {
    const f = await fixture(data);
    try {
      const bytes = Buffer.from(data), expected = oracle(bytes), states: number[] = [];
      const store = await scanFile({ file: f.file, directory: f.cache, chunkBytes: 3, control: running(), progress: p => states.push(p.lines) });
      assert.equal(store.count - 1, expected.length);
      for (let i = 0; i < expected.length; i++) assert.deepEqual(await store.range(i + 1), expected[i]);
      const cached = new OffsetStore(f.cache, await identity(f.file)); await cached.initialize(); assert.equal(cached.restored, true); assert.equal(cached.complete, true);
      assert.ok(states.every((n, i) => !i || n >= states[i - 1]));
    } finally { await rm(f.dir, { recursive: true }); }
  });
}
test('first records become readable before reaching EOF, including beyond 100', async () => {
  const f = await fixture(Array.from({ length: 250 }, (_, i) => `${i}`).join('\n'));
  try {
    let firstBytes = Infinity, firstLines = 0;
    const store = await scanFile({ file: f.file, directory: f.cache, chunkBytes: 8, control: running(), progress: p => { if (p.lines && !firstLines) { firstLines = p.lines; firstBytes = p.scannedBytes; } } });
    assert.equal(firstLines, 1); assert.ok(firstBytes < (await identity(f.file)).size); assert.equal(store.count - 1, 250); assert.ok((await store.range(101))[0] > 0);
  } finally { await rm(f.dir, { recursive: true }); }
});
test('cancelled checkpoint resumes from a complete boundary', async () => {
  const f = await fixture('0\n1\n' + '"' + 'x'.repeat(1000) + '"\n3');
  try {
    const control = running();
    let stopped = false;
    control.wait = async () => { control.state = 'disposed'; };
    const partial = await scanFile({ file: f.file, directory: f.cache, chunkBytes: 4, control, progress: p => { if (p.lines === 1 && !stopped) { stopped = true; control.state = 'cancelled'; } } });
    assert.ok(partial.count - 1 < 4);
    const restored = new OffsetStore(f.cache, await identity(f.file)); await restored.initialize(); assert.equal(restored.restored, true); assert.equal(restored.complete, false); assert.equal(restored.safeByte, (await partial.range(partial.count - 1))[1]);
    const complete = await scanFile({ file: f.file, directory: f.cache, chunkBytes: 7, control: running(), progress: () => {} }); assert.equal(complete.count - 1, 4);
  } finally { await rm(f.dir, { recursive: true }); }
});
test('paged offsets retain positions greater than 4 GiB and detect damaged pages', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-offset-test-'));
  try {
    const source = { size: 2 ** 40, mtimeMs: 1, ctimeMs: 1, dev: 1, ino: 1, fingerprint: 'fixture' };
    const store = new OffsetStore(dir, source); await store.initialize();
    for (let i = 1; i < PAGE_ENTRIES + 20; i++) await store.append(2 ** 32 + i * 100);
    await store.checkpoint(false);
    const cached = new OffsetStore(dir, source); await cached.initialize();
    assert.equal(await cached.get(PAGE_ENTRIES + 1), 2 ** 32 + (PAGE_ENTRIES + 1) * 100);
    const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const page = path.join(dir, m.pages[0].file), bytes = await readFile(page); bytes[40] ^= 1; await writeFile(page, bytes);
    const damaged = new OffsetStore(dir, source); await damaged.initialize(); assert.equal(damaged.restored, false); assert.equal(damaged.count, 1);
  } finally { await rm(dir, { recursive: true }); }
});
test('source changes invalidate caches and running scans', async () => {
  const f = await fixture('0\n1\n2\n');
  try {
    await scanFile({ file: f.file, directory: f.cache, control: running(), progress: () => {} });
    await writeFile(f.file, 'new version');
    const cache = new OffsetStore(f.cache, await identity(f.file)); await cache.initialize(); assert.equal(cache.restored, false);
    let edited = false;
    await assert.rejects(scanFile({ file: f.file, directory: f.cache, chunkBytes: 2, control: running(), progress: p => { if (p.scannedBytes > 0 && !edited) { edited = true; void writeFile(f.file, '0'); } } }));
  } finally { await rm(f.dir, { recursive: true }); }
});
test('short reads and writes loop and zero progress throws', async () => {
  const bytes = Buffer.from('abcdefghij'), output = Buffer.alloc(bytes.length);
  await readExactly({ read: async (b, offset, length, position) => { const count = Math.min(2, length); bytes.copy(b, offset, position, position + count); return { bytesRead: count }; } }, output, 0);
  assert.deepEqual(output, bytes);
  const written = Buffer.alloc(bytes.length);
  await writeExactly({ write: async (b, offset, length, position) => { const count = Math.min(3, length); b.copy(written, position, offset, offset + count); return { bytesWritten: count }; } }, bytes);
  assert.deepEqual(written, bytes);
  await assert.rejects(readExactly({ read: async () => ({ bytesRead: 0 }) }, output, 0));
  await assert.rejects(writeExactly({ write: async () => ({ bytesWritten: 0 }) }, output));
  await assert.rejects(readExactly({ read: async () => ({ bytesRead: 1 }) }, output, 0, () => true), /Cancelled/);
});
test('UTF-8 decoding is strict and BOM/CRLF removal is explicit', () => {
  assert.deepEqual(decodeRecord(Buffer.from('\ufeff{"😀":1}\r\n'), true), { raw: '{"😀":1}', bom: true });
  assert.throws(() => decodeRecord(Buffer.from([0xff, 10]), false));
  assert.equal(decodeRecord(Buffer.from('0\r'), false).raw, '0\r');
});
test('normal formatting preserves literal numbers, duplicates, escapes and order', () => {
  const raw = '{"2":9007199254740993,"1":-0,"dup":1.2300000000000000001,"dup":1e+09,"中😀":{"a/b.c":"\\u4e2d"}}';
  const r = processRecord(raw);
  assert.equal(r.valid, true);
  assert.equal(r.formatted.replace(/\s/g, ''), raw); assert.equal(r.outline.filter(n => n.key === 'dup').length, 2);
  assert.equal(new Set(r.outline.map(n => n.id)).size, r.outline.length);
  const key = r.outline.find(n => n.key === 'a/b.c')!;
  assert.equal(r.formatted.split('\n')[key.line - 1].slice(key.column - 1, key.column + 7), '"a/b.c":');
});
for (const raw of ['', '{"a":1,}', '//hello\n{}', '{"a":NaN}', '[1,,2]', '0 1']) test(`strict normal rejects ${raw}`, () => { assert.equal(processRecord(raw).valid, false); });
test('normal nodes/format expansion respect complexity budget', () => {
  assert.throws(() => processRecord('['.repeat(200) + '0' + ']'.repeat(200)), RecordBudgetError);
  assert.throws(() => processRecord('[' + '0,'.repeat(100001) + '0]'), RecordBudgetError);
});
test('large flat normal arrays format in one pass without changing any tokens', () => {
  const raw = '[' + Array.from({ length: 30000 }, (_, i) => `${i}.000e+0`).join(',') + ']';
  const record = processRecord(raw); assert.equal(record.valid, true); assert.equal(record.formatted.replace(/\s/g, ''), raw);
  assert.equal(record.outline[0].count, 30000); assert.equal(record.outlineTruncated, true);
});
for (const raw of ['{"a":9007199254740993,"a":{"😀":[true,false,null,-0,1e+9]},"s":"x\\\"y\\u00ef"}', '[0,{},[],"中😀"]', '1e-20', 'true', 'null', '"😀"', '{}', '[]']) {
  test(`streaming validates across every 1-byte boundary: ${raw.slice(0, 40)}`, async () => {
    const f = await fixture(raw);
    try {
      const source = await identity(f.file), page = await streamPage({ file: f.file, source, start: 0, end: source.size, chunkBytes: 1 });
      assert.equal(page.valid, true, page.error); assert.equal(page.root.end, source.size);
      for (const node of page.children) { assert.equal(node.preview || (await readFile(f.file)).subarray(node.start, node.end).toString().slice(0, 1), node.preview || (node.kind === 'object' ? '{' : '[')); }
    } finally { await rm(f.dir, { recursive: true }); }
  });
}
for (const raw of ['{"a":1,}', '[1,]', '[01]', '1.', '1e', 'tru', 'truefalse', '{"a" 0}', '{"a":}', '"a\nb"', '"\\q"', '[}', '[] []', '', '\ufeff0', '"\\u00xz"']) test(`strict stream rejects ${JSON.stringify(raw)}`, async () => {
  const f = await fixture(raw);
  try { const source = await identity(f.file); const page = await streamPage({ file: f.file, source, start: 0, end: source.size, chunkBytes: 2 }); assert.equal(page.valid, false, raw); }
  finally { await rm(f.dir, { recursive: true }); }
});
test('streaming paginates huge arrays and nested containers without holding all children', async () => {
  const f = await fixture('{"many":[' + Array.from({ length: 10000 }, (_, i) => `{"i":${i}}`).join(',') + ']}\r\n');
  try {
    const source = await identity(f.file), root = await streamPage({ file: f.file, source, start: 0, end: source.size, chunkBytes: 19 });
    assert.equal(root.valid, true); assert.equal(root.children[0].count, 10000);
    const n = root.children[0], page = await streamPage({ file: f.file, source, start: n.start, end: n.end, skip: 9900, chunkBytes: 23 });
    assert.equal(page.valid, true); assert.equal(page.children.length, 100); assert.equal(page.children[0].key, '[9900]'); assert.equal(page.total, 10000);
    const child = page.children[0], inner = await streamPage({ file: f.file, source, start: child.start, end: child.end }); assert.equal(inner.children[0].preview, '9900');
  } finally { await rm(f.dir, { recursive: true }); }
});
test('streaming accepts first-line BOM, catches bad UTF-8 and cancels', async () => {
  const f = await fixture('\ufeff{"a":"😀"}\n');
  try {
    const source = await identity(f.file);
    assert.equal((await streamPage({ file: f.file, source, start: 0, end: source.size, firstLine: true, chunkBytes: 1 })).valid, true);
    await assert.rejects(streamPage({ file: f.file, source, start: 0, end: source.size, cancelled: () => true }), /Cancelled/);
    await writeFile(f.file, Buffer.from([34, 0xff, 34])); const invalid = await identity(f.file);
    assert.equal((await streamPage({ file: f.file, source: invalid, start: 0, end: invalid.size })).valid, false);
  } finally { await rm(f.dir, { recursive: true }); }
});
test('protocol rejects arbitrary paths, negative/fractional/unsafe positions', () => {
  for (const line of [-1, 0, 1.5, '4', Infinity, 2 ** 53]) assert.equal(parseClientMessage({ type: 'navigate', line }), undefined);
  assert.equal(parseClientMessage({ type: 'read', path: '/secret' }), undefined);
  assert.equal(parseClientMessage({ type: 'page', node: 'b0', skip: -1, request: 1 }), undefined);
  assert.deepEqual(parseClientMessage({ type: 'navigate', line: 101, path: '/secret' }), { type: 'navigate', line: 101 });
});
