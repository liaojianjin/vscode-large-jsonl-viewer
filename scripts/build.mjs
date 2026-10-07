import { build, context } from 'esbuild';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

await mkdir('dist/webview', { recursive: true });
const common = { bundle: true, logLevel: 'info', sourcemap: false, mainFields: ['module', 'main'] };
const configs = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', target: 'node20', external: ['vscode'] },
  { ...common, entryPoints: { index: 'src/workers/index.ts', record: 'src/workers/record.ts' }, outdir: 'dist/workers', outExtension: { '.js': '.cjs' }, platform: 'node', target: 'node20' },
  { ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview/main.js', platform: 'browser', target: 'es2022', minify: true, loader: { '.ttf': 'file' } },
  { ...common, entryPoints: ['webview/bootstrap.ts'], outfile: 'dist/webview/bootstrap.js', platform: 'browser', target: 'es2022', minify: true },
  { ...common, entryPoints: ['node_modules/monaco-editor/esm/vs/editor/editor.worker.js'], outfile: 'dist/webview/editor.worker.js', platform: 'browser', format: 'iife', minify: true, target: 'es2022' },
  { ...common, entryPoints: (await readdir('test/unit')).filter(f => f.endsWith('.test.ts')).map(f => path.join('test/unit', f)), outdir: 'dist/test', outExtension: { '.js': '.cjs' }, platform: 'node', target: 'node20' },
  { ...common, entryPoints: ['test/integration/suite.ts'], outfile: 'dist/integration/suite.cjs', platform: 'node', target: 'node20', external: ['vscode'] },
  { ...common, entryPoints: ['test/performance/large-records.ts'], outfile: 'dist/performance/large-records.cjs', platform: 'node', target: 'node20' },
  { ...common, entryPoints: ['scripts/generate-fixtures.ts', 'scripts/benchmark.ts'], outdir: 'dist/scripts', outExtension: { '.js': '.cjs' }, platform: 'node', target: 'node20' }
].filter(c => c.entryPoints.length !== 0);
if (process.argv.includes('--watch')) {
  for (const config of configs) await (await context(config)).watch();
} else {
  for (const config of configs) await build(config);
}
// esbuild emits both Monaco and application CSS alongside main.js.
await writeFile('dist/webview/licenses.txt', await readFile('node_modules/monaco-editor/LICENSE'));
await writeFile('dist/webview/ThirdPartyNotices.txt', await readFile('node_modules/monaco-editor/ThirdPartyNotices.txt'));
await writeFile('dist/webview/jsonc-parser-LICENSE.txt', await readFile('node_modules/jsonc-parser/LICENSE.md'));
