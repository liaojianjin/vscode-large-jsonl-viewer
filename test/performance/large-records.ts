import { open, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { identity, writeExactly } from '../../src/io/files';

async function create(file: string, valueBytes: number, arrayItems = 0): Promise<void> {
  const handle = await open(file, 'wx'); let position = 0;
  const append = async (bytes: Buffer) => { await writeExactly(handle, bytes, position); position += bytes.length; };
  try {
    await append(Buffer.from('{"id":9007199254740993,"text":"'));
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let rest = valueBytes; rest > 0;) { const bytes = chunk.subarray(0, Math.min(rest, chunk.length)); await append(bytes); rest -= bytes.length; }
    await append(Buffer.from('","items":['));
    for (let i = 0; i < arrayItems; i += 1000) await append(Buffer.from(Array.from({ length: Math.min(1000, arrayItems - i) }, (_, n) => `${i + n}`).join(',') + (i + 1000 < arrayItems ? ',' : '')));
    await append(Buffer.from(']}\n'));
  } finally { await handle.close(); }
}
async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'jsonl-large-record-'));
  const results: unknown[] = [];
  try {
    for (const valueMiB of [32, 256]) {
      const file = path.join(directory, `${valueMiB}.jsonl`); await create(file, valueMiB * 1024 * 1024, valueMiB === 32 ? 1000000 : 0);
      const source = await identity(file), started = performance.now(), baselineRss = process.memoryUsage().rss;
      let peakRss = baselineRss, firstProgressMs = 0;
      const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
      const worker = new Worker(path.resolve('dist/workers/record.cjs'), { workerData: { task: 'record', file, source, start: 0, end: source.size, firstLine: true, limitBytes: 8 * 1024 * 1024 }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      const page = await new Promise<any>((resolve, reject) => {
        worker.once('error', reject);
        worker.on('message', message => {
          if (message.type === 'large') { if (!firstProgressMs) firstProgressMs = performance.now() - started; if (message.page.done) resolve(message.page); }
          else if (message.type === 'failure') reject(new Error(message.error));
        });
      });
      clearInterval(timer); if (!page.valid || page.children.length !== 3 || page.children[0].preview !== '9007199254740993') throw new Error('Large record validation/literal preservation failed.');
      const elapsedMs = performance.now() - started; await worker.terminate();
      const cancellationWorker = new Worker(path.resolve('dist/workers/record.cjs'), { workerData: { task: 'record', file, source, start: 0, end: source.size, firstLine: true, limitBytes: 1 } });
      await new Promise<void>(resolve => cancellationWorker.once('message', () => resolve()));
      const cancelStarted = performance.now(); await cancellationWorker.terminate(); const cancelMs = performance.now() - cancelStarted;
      results.push({ valueMiB, bytes: source.size, elapsedMs, firstProgressMs, peakProcessRssMiB: peakRss / 1024 / 1024, incrementalRssMiB: (peakRss - baselineRss) / 1024 / 1024, cancelMs, capturedChildren: page.children.length, arrayCount: page.children[2].count, includesWebview: false });
    }
    await mkdir('benchmark-results', { recursive: true }); await writeFile('benchmark-results/large-records.json', JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
