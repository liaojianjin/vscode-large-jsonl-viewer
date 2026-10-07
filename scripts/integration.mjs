import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const directory = await mkdtemp(path.join(tmpdir(), 'jsonl-vscode-test-'));
try {
  await runTests({
    vscodeExecutablePath: process.env.JSONL_VSCODE_EXECUTABLE ?? (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : undefined),
    extensionDevelopmentPath: process.env.JSONL_EXTENSION_PATH ?? process.cwd(), extensionTestsPath: path.resolve('dist/integration/suite.cjs'),
    extensionTestsEnv: { JSONL_UI_SMOKE: process.argv.includes('--ui') ? '1' : '0' },
    launchArgs: ['--user-data-dir', path.join(directory, 'user'), '--extensions-dir', path.join(directory, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-extensions'],
  });
} finally { await rm(directory, { recursive: true, force: true }); }
