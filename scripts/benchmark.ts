import { mkdtemp, open, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { identity, readExactly } from '../src/io/files';
import { scanFile } from '../src/index/scanner';
const args = process.argv.slice(2);
const arg = (key: string, fallback: string) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
async function main(): Promise<void> {
  const file = path.resolve(arg('file', 'fixtures/sample.jsonl')), source = await identity(file), chunk = Number(arg('chunkMiB', '4')) * 1024 * 1024;
  const fixture = JSON.parse(await readFile(`${file}.fixture.json`, 'utf8'));
  const directory = await mkdtemp(path.join(tmpdir(), 'jsonl-benchmark-'));
  try {
    const sequentialRead = async () => {
      const started = performance.now(), handle = await open(file, 'r'), buffer = Buffer.alloc(chunk);
      try { for (let position = 0; position < source.size; position += buffer.length) await readExactly(handle, buffer.subarray(0, Math.min(buffer.length, source.size - position)), position); } finally { await handle.close(); }
      return performance.now() - started;
    };
    const firstReadMs = await sequentialRead();
    let started = performance.now();
    started = performance.now(); let first100Ms: number | undefined, peakRss = process.memoryUsage().rss;
    const memory = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
    const store = await scanFile({ file, directory, chunkBytes: chunk, control: { state: 'running', wait: async () => {} }, progress: p => { if (p.initialReady === 100 && first100Ms === undefined) first100Ms = performance.now() - started; } });
    const indexMs = performance.now() - started; clearInterval(memory);
    const readMs = await sequentialRead();
    if (store.count - 1 !== fixture.rows) throw new Error('Independent generated row count mismatch.');
    const latencies: number[] = []; let seed = 42;
    const recordSource = await identity(file);
    for (let i = 0; i < 30; i++) {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32; const line = 1 + seed % fixture.rows;
      const start = performance.now(), range = await store.range(line);
      const worker = new Worker(path.resolve('dist/workers/record.cjs'), { workerData: { task: 'record', file, source: recordSource, start: range[0], end: range[1], firstLine: line === 1, limitBytes: 8 * 1024 * 1024 } });
      await new Promise<void>((resolve, reject) => { worker.once('error', reject); worker.on('message', message => { if (message.type === 'record' || message.type === 'large' && message.page.done) resolve(); else if (message.type === 'failure') reject(new Error(message.error)); }); });
      latencies.push(performance.now() - start); await worker.terminate();
    }
    latencies.sort((a, b) => a - b);
    const result = { date: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version, fileBytes: source.size, rows: fixture.rows, chunkMiB: chunk / 1024 / 1024, cacheCondition: 'OS cache uncontrolled; warm read reference runs after indexing, first read also reported; not a cold disk benchmark', firstReadMs, readMs, indexMs, readMiBPerSecond: source.size / 1024 / 1024 / (readMs / 1000), indexMiBPerSecond: source.size / 1024 / 1024 / (indexMs / 1000), throughputRatio: readMs / indexMs, first100Ms, peakProcessRssMiB: peakRss / 1024 / 1024, randomRecordBackendP50Ms: latencies[14], randomRecordBackendP95Ms: latencies[28], includesWebview: false };
    console.log(JSON.stringify(result, null, 2)); await mkdir('benchmark-results', { recursive: true }); await writeFile(path.resolve(arg('out', `benchmark-results/${source.size}-${chunk}.json`)), JSON.stringify(result, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
