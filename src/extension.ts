import * as vscode from 'vscode';
import { ViewerProvider, VIEW_TYPE } from './editor/provider';
export function activate(context: vscode.ExtensionContext): ViewerProvider {
  const provider = new ViewerProvider(context);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: false } }));
  context.subscriptions.push(vscode.commands.registerCommand('largeJsonl.open', async (uri?: vscode.Uri) => {
    const target = uri ?? (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'JSON Lines': ['jsonl', 'ndjson'] } }))?.[0];
    if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
  }));
  for (const command of ['random', 'back', 'forward'] as const) context.subscriptions.push(vscode.commands.registerCommand(`largeJsonl.${command}`, () => provider.executeViewCommand(command)));
  context.subscriptions.push({ dispose: () => { for (const session of provider.sessions.values()) session.dispose(); } });
  return provider;
}
