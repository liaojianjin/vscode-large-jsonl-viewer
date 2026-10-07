import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { identity } from '../../src/io/files';
import { FileSession } from '../../src/editor/session';

test('packaged worker lifecycle, range requests, reopen cache and invalidation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-session-')), file = path.join(dir, 'source.jsonl'), cache = path.join(dir, 'cache');
  await writeFile(file, Array.from({ length: 110 }, (_, i) => `{"i":${i}}`).join('\n'));
  const create = () => new FileSession(file, cache, path.resolve('dist/workers/index.cjs'), 1024);
  let session = create();
  try {
    const complete = async () => { while (session.progress.state !== 'complete') { if (session.progress.state === 'error') throw new Error(session.progress.error); await once(session, 'progress'); } };
    await complete(); assert.equal(session.progress.lines, 110); assert.ok((await session.range(101))[0] > 0);
    session.dispose(); await new Promise(resolve => setTimeout(resolve, 100));
    session = create(); await complete(); assert.equal(session.progress.restored, true);
    await writeFile(file, 'changed'); await assert.rejects(session.range(1)); assert.equal(session.progress.state, 'changed');
    await session.reload(); await complete(); assert.equal(session.progress.lines, 1);
  } finally { session.dispose(); await new Promise(resolve => setTimeout(resolve, 100)); await rm(dir, { recursive: true }); }
});
test('record worker preserves numbers and exposes bounded raw windows', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-record-')), file = path.join(dir, 'source.jsonl');
  const raw = '{"n":9007199254740993,"中文😀":"' + '😀'.repeat(20000) + '"}'; await writeFile(file, raw);
  try {
    const source = await identity(file);
    const worker = new Worker(path.resolve('dist/workers/record.cjs'), { workerData: { task: 'record', file, source, start: 0, end: source.size, limitBytes: 1024 * 1024, firstLine: true } });
    const [m] = await once(worker, 'message'); assert.equal(m.type, 'record'); assert.match(m.record.formatted, /9007199254740993/); await once(worker, 'exit');
    const fragment = new Worker(path.resolve('dist/workers/record.cjs'), { workerData: { task: 'window', file, source, start: 0, end: source.size, offset: 65535 } });
    const [window] = await once(fragment, 'message'); assert.equal(window.type, 'window'); assert.ok(window.text.length <= 65536); assert.ok(!window.text.includes('\ufffd')); await once(fragment, 'exit');
  } finally { await rm(dir, { recursive: true }); }
});
test('random record reads use exact 64-bit positions in a sparse file beyond 4 GiB', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-sparse-')), file = path.join(dir, 'sparse.jsonl'), position = 2 ** 32 + 123;
  const handle = await open(file, 'wx'); const bytes = Buffer.from('{"position":4294967419}\n');
  await handle.write(bytes, 0, bytes.length, position); await handle.close();
  try {
    const source = await identity(file);
    const worker = new Worker(path.resolve('dist/workers/record.cjs'), { workerData: { task: 'record', file, source, start: position, end: position + bytes.length, firstLine: false, limitBytes: 1024 } });
    const [message] = await once(worker, 'message'); assert.equal(message.type, 'record'); assert.equal(message.record.raw, bytes.toString().trim()); await once(worker, 'exit');
  } finally { await rm(dir, { recursive: true }); }
});
