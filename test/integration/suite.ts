import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ViewerProvider } from '../../src/editor/provider';
export async function run(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-host-test-')), file = path.join(dir, 'fixture.jsonl');
  try {
    await writeFile(file, Array.from({ length: 125 }, (_, i) => `{"i":${i},"n":9007199254740993,"中😀":{"value":true},"long":"${'中文😀abcdefgh'.repeat(300)}"}`).join('\n'));
    const extension = vscode.extensions.getExtension<ViewerProvider>('local-jsonl-tools.large-jsonl-viewer'); assert.ok(extension);
    const provider = await extension.activate(), uri = vscode.Uri.file(file);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'largeJsonl.viewer');
    const deadline = Date.now() + 15000;
    while (!provider.sessions.get(uri.toString()) || provider.sessions.get(uri.toString())?.progress.state !== 'complete') {
      if (Date.now() > deadline) throw new Error('Custom editor index readiness timed out.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(provider.sessions.get(uri.toString())!.progress.lines, 125);
    assert.ok(!vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString()), 'Source must not be loaded as a TextDocument');
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
    assert.ok(tabs.some(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'largeJsonl.viewer'));
    assert.ok((await provider.sessions.get(uri.toString())!.range(125))[0] > 0);
    while (!provider.renderedViews.get(uri.toString())) {
      if (provider.viewErrors.has(uri.toString())) throw new Error(provider.viewErrors.get(uri.toString()));
      if (Date.now() > deadline) throw new Error('Monaco Webview rendering timed out.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const rendered = provider.renderedViews.get(uri.toString())!;
    assert.equal(rendered.mode, 'normal'); assert.equal(rendered.valid, true); assert.ok(rendered.outlineCount >= 4); assert.ok(rendered.foldCount >= 2);
    assert.ok(rendered.layout); assert.equal(rendered.layout.wordWrap, true);
    assert.ok(rendered.layout.textHeight > rendered.layout.unwrappedTextHeight, 'Long values must actually wrap to multiple display rows');
    assert.ok(rendered.layout.contentWidth / rendered.layout.viewportWidth >= .7, 'JSON content must occupy at least 70% of viewer width');
    assert.ok(rendered.layout.contentHeight / rendered.layout.viewportHeight >= .8, 'JSON content must occupy at least 80% of viewer height');
    console.log(`Viewer layout verified: content ${Math.round(100 * rendered.layout.contentWidth / rendered.layout.viewportWidth)}% width, ${Math.round(100 * rendered.layout.contentHeight / rendered.layout.viewportHeight)}% height, long text wraps.`);
    if (process.env.JSONL_UI_SMOKE === '1') { console.log('UI smoke window ready; keeping isolated host open for five minutes.'); await new Promise(resolve => setTimeout(resolve, 300000)); }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('Extension Host integration passed: readonly custom editor, progressive index, random access, cleanup.');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
