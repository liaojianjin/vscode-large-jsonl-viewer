import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { realpath, open, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { assertIdentity, decodeRecord, readExactly } from '../io/files';
import { FileSession, pruneCache } from './session';
import { parseClientMessage, type LargeNode, type ViewLayout } from '../protocol/types';

export const VIEW_TYPE = 'largeJsonl.viewer';
class Document implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri, readonly session: FileSession, private readonly onDispose: () => void) {}
  dispose(): void { this.onDispose(); }
}
export class ViewerProvider implements vscode.CustomReadonlyEditorProvider<Document> {
  readonly sessions = new Map<string, FileSession>();
  readonly renderedViews = new Map<string, { line: number; mode: string; valid: boolean; outlineCount: number; foldCount: number; layout?: ViewLayout }>();
  readonly viewErrors = new Map<string, string>();
  private readonly canonicalSessions = new Map<string, { session: FileSession; references: number }>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly activeDirectories = new Set<string>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  constructor(private readonly context: vscode.ExtensionContext) { context.subscriptions.push(this.status); }
  async openCustomDocument(uri: vscode.Uri, _context: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): Promise<Document> {
    if (uri.scheme !== 'file') throw new Error('当前版本仅支持 VS Code Desktop 的本地普通文件；该 URI 不支持随机分块读取。');
    const file = await realpath(uri.fsPath);
    await this.closing.get(file);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const directory = path.join(this.context.globalStorageUri.fsPath, 'indexes', createHash('sha256').update(vscode.Uri.file(file).toString()).digest('hex'));
    const config = vscode.workspace.getConfiguration('largeJsonl');
    let entry = this.canonicalSessions.get(file);
    if (!entry) {
      entry = { session: new FileSession(file, directory, this.context.asAbsolutePath('dist/workers/index.cjs'), config.get<number>('scanChunkMiB', 4) * 1024 * 1024), references: 0 };
      this.canonicalSessions.set(file, entry);
    }
    entry.references++;
    const { session } = entry;
    this.sessions.set(uri.toString(), session); this.activeDirectories.add(directory);
    return new Document(uri, session, () => {
      this.sessions.delete(uri.toString());
      if (--entry!.references === 0) {
        this.canonicalSessions.delete(file);
        const closed = session.dispose().then(async () => {
          this.activeDirectories.delete(directory); this.closing.delete(file);
          await pruneCache(path.dirname(directory), config.get<number>('cacheLimitMiB', 512) * 1024 * 1024, this.activeDirectories).catch(() => {});
        });
        this.closing.set(file, closed);
      }
    });
  }
  async resolveCustomEditor(document: Document, panel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
    const { session } = document;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')] };
    panel.webview.html = this.html(panel.webview);
    let seq = 0, currentLine = 1, pendingLine: number | undefined = 1, reading = false, disposed = false, ready = false;
    let recordWorker: Worker | undefined, pageWorker: Worker | undefined;
    let currentRange: [number, number] | undefined;
    const nodes = new Map<string, LargeNode>();
    const send = (message: Record<string, unknown>) => { if (!disposed && ready) void panel.webview.postMessage({ ...message, seq, generation: session.generation }); };
    const terminate = () => { void recordWorker?.terminate(); void pageWorker?.terminate(); recordWorker = undefined; pageWorker = undefined; };
    const remember = (node: LargeNode) => {
      if (node.end < node.start || !currentRange || node.start < currentRange[0] || node.end > currentRange[1]) return;
      nodes.delete(node.id); nodes.set(node.id, node);
      while (nodes.size > 2000) nodes.delete(nodes.keys().next().value!);
    };
    const launch = (workerData: Record<string, unknown>, callback: (message: any) => void): Worker => {
      const requestSeq = seq, generation = session.generation;
      session.foreground(1);
      const worker = new Worker(this.context.asAbsolutePath('dist/workers/record.cjs'), { workerData: { ...workerData, file: session.file, source: session.source }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      worker.once('exit', () => { if (generation === session.generation) session.foreground(-1); });
      const handle = (message: any) => {
        if (disposed || requestSeq !== seq || generation !== session.generation || ['changed', 'error'].includes(session.progress.state)) return;
        if (message.type === 'failure') {
          if (message.changed) session.fail(message.error, true);
          else send({ type: 'error', message: message.error });
        } else callback(message);
      };
      worker.on('message', handle);
      worker.on('error', error => handle({ type: 'failure', error: error.message }));
      return worker;
    };
    const tryNavigate = async () => {
      if (!ready || pendingLine === undefined || reading || disposed) return;
      const line = pendingLine;
      if (['changed', 'error'].includes(session.progress.state)) return;
      if (line > session.progress.lines) {
        if (session.progress.state === 'complete') { pendingLine = undefined; send({ type: session.progress.lines ? 'error' : 'empty', message: session.progress.lines ? `行号越界：该文件共 ${session.progress.lines} 行。` : '文件为空，没有 JSONL 记录。' }); }
        else send({ type: 'waiting', line });
        return;
      }
      reading = true;
      const requestSeq = seq;
      try {
        const range = await session.range(line);
        if (requestSeq !== seq || disposed) return;
        pendingLine = undefined;
        send({ type: 'loading', line, bytes: range[1] - range[0] });
        recordWorker = launch({ task: 'record', start: range[0], end: range[1], firstLine: line === 1, limitBytes: vscode.workspace.getConfiguration('largeJsonl').get<number>('recordLimitMiB', 8) * 1024 * 1024 }, message => {
          if (message.type === 'record' || message.type === 'largeStart') { currentRange = range; currentLine = line; nodes.clear(); }
          if (message.type === 'largeStart') remember({ id: `b${range[0]}`, key: '$', kind: 'string', start: range[0], end: range[1], preview: '' });
          if (message.type === 'large') { remember(message.page.root); message.page.children.forEach(remember); }
          send({ ...message, line });
        });
      } catch (error) { if (requestSeq === seq) { pendingLine = undefined; send({ type: 'error', message: (error as Error).message }); } }
      finally { reading = false; if (pendingLine !== undefined) void tryNavigate(); }
    };
    const navigate = (line: number) => { seq++; terminate(); pendingLine = line; send({ type: 'waiting', line }); void tryNavigate(); };
    const onProgress = () => {
      send({ type: 'progress', progress: session.progress });
      if (panel.active) { this.status.text = session.progress.state === 'complete' ? `$(list-ordered) JSONL ${session.progress.lines.toLocaleString()} 行` : `$(sync) JSONL ${session.progress.size ? (100 * session.progress.scannedBytes / session.progress.size).toFixed(1) : 0}%`; this.status.show(); }
      void tryNavigate();
    };
    const onReset = () => { seq++; terminate(); nodes.clear(); currentRange = undefined; pendingLine = currentLine; send({ type: 'reset' }); onProgress(); };
    const onInvalid = () => { seq++; terminate(); pendingLine = undefined; send({ type: 'invalid', message: session.progress.error }); };
    session.on('progress', onProgress); session.on('reset', onReset); session.on('invalid', onInvalid);
    const receive = panel.webview.onDidReceiveMessage(async value => {
      const message = parseClientMessage(value); if (!message || disposed) return;
      try {
        if (message.type === 'startupError') { this.viewErrors.set(document.uri.toString(), message.message); console.error(`JSONL Webview: ${message.message}`); }
        else if (message.type === 'rendered') { this.renderedViews.set(document.uri.toString(), message); }
        else if (message.type === 'ready') { ready = true; onProgress(); navigate(message.line ?? currentLine); send({ type: 'config', minimap: vscode.workspace.getConfiguration('largeJsonl').get('minimap', false), wordWrap: vscode.workspace.getConfiguration('largeJsonl').get('wordWrap', true) }); }
        else if (message.type === 'navigate') navigate(message.line);
        else if (message.type === 'last') { if (session.progress.state === 'complete') navigate(Math.max(1, session.progress.lines)); else send({ type: 'error', message: '末行需要等待完整索引。' }); }
        else if (message.type === 'cancelJump') { seq++; pendingLine = undefined; terminate(); send({ type: 'jumpCancelled' }); }
        else if (message.type === 'pause') session.control('paused');
        else if (message.type === 'resume') session.control('running');
        else if (message.type === 'cancelIndex') session.control('cancelled');
        else if (message.type === 'reload') await session.reload();
        else if (message.type === 'page' || message.type === 'window') {
          const node = nodes.get(message.node); if (!node) throw new Error('节点已经过期，请重新选择记录。');
          await session.validate();
          void pageWorker?.terminate();
          pageWorker = launch({ task: message.type, start: node.start, end: node.end, skip: message.type === 'page' ? message.skip : 0, offset: message.type === 'window' ? message.offset : 0 }, result => {
            if (result.type === 'large') { remember(result.page.root); result.page.children.forEach(remember); send({ type: 'page', node: node.id, page: result.page, request: message.request }); }
            else if (result.type === 'window') send({ ...result, node: node.id, request: message.request });
          });
        } else if (message.type === 'copyRaw') {
          if (!currentRange || !session.source) return;
          const range = currentRange, line = currentLine, source = session.source;
          if (range[1] - range[0] > 8 * 1024 * 1024) throw new Error('该记录超过剪贴板预算，请使用“导出原始记录”。');
          const handle = await open(session.file, 'r');
          try {
            await assertIdentity(session.file, handle, source);
            const buffer = Buffer.alloc(range[1] - range[0]); await readExactly(handle, buffer, range[0]);
            const { raw } = decodeRecord(buffer, line === 1);
            await assertIdentity(session.file, handle, source); await vscode.env.clipboard.writeText(raw);
          } finally { await handle.close(); }
          send({ type: 'notice', message: '已复制当前原始记录。' });
        } else if (message.type === 'exportRaw') {
          if (!currentRange) return;
          const range = [...currentRange] as [number, number];
          const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(session.file), `record-${currentLine}.jsonl`)), filters: { JSONL: ['jsonl'] } });
          if (!uri) return;
          if (uri.scheme !== 'file' || uri.fsPath === session.file || await realpath(uri.fsPath).catch(() => '') === session.file) throw new Error('请选择不同于源文件的本地导出路径。');
          await session.validate();
          const temp = `${uri.fsPath}.${randomUUID()}.tmp`, generation = session.generation;
          try {
            await pipeline(createReadStream(session.file, { start: range[0], end: range[1] - 1 }), createWriteStream(temp, { flags: 'wx' }));
            await session.validate(); if (generation !== session.generation) throw new Error('源文件版本已变化，已取消导出。');
            await rename(temp, uri.fsPath); send({ type: 'notice', message: '已导出当前原始记录。' });
          } finally { await rm(temp, { force: true }).catch(() => {}); }
        }
      } catch (error) { send({ type: 'error', message: (error as Error).message }); }
    });
    const visibility = panel.onDidChangeViewState(() => {
      if (!panel.visible) { terminate(); currentRange = undefined; nodes.clear(); ready = false; }
      else { void panel.webview.postMessage({ type: 'restore', seq, generation: session.generation }); if (panel.active) onProgress(); }
      if (!panel.active) this.status.hide();
    });
    panel.onDidDispose(() => {
      disposed = true; terminate(); receive.dispose(); visibility.dispose(); this.status.hide();
      this.renderedViews.delete(document.uri.toString());
      this.viewErrors.delete(document.uri.toString());
      session.off('progress', onProgress); session.off('reset', onReset); session.off('invalid', onInvalid);
    });
  }
  private html(webview: vscode.Webview): string {
    const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', name));
    const nonce = randomBytes(16).toString('hex');
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src blob:; connect-src ${webview.cspSource};"><link rel="stylesheet" href="${resource('main.css')}"><title>Large JSONL Viewer</title></head><body><div id="app"></div><div id="resources" data-worker="${resource('editor.worker.js')}"></div><script nonce="${nonce}" src="${resource('bootstrap.js')}"></script><script nonce="${nonce}" src="${resource('main.js')}"></script></body></html>`;
  }
}
