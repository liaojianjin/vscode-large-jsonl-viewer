import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js';
import '../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import './style.css';
import { VIEWER_HTML } from './template';
import type { LargeNode, LargePage, NormalRecord, OutlineNode, Progress } from '../src/protocol/types';

const vscode: { postMessage(value: unknown): void; getState(): any; setState(value: unknown): void } = (globalThis as any).jsonlHostApi;
delete (globalThis as any).jsonlHostApi;
const saved = vscode.getState() ?? {};
const send = (value: unknown) => vscode.postMessage(value);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
monaco.languages.register({ id: 'json' });
monaco.languages.setLanguageConfiguration('json', { brackets: [['{', '}'], ['[', ']']] });
monaco.languages.setMonarchTokensProvider('json', { tokenizer: { root: [
  [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'], [/"(?:[^"\\]|\\.)*"/, 'string.value'],
  [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'], [/\b(?:true|false|null)\b/, 'keyword'], [/[{}\[\]]/, '@brackets'], [/[,:]/, 'delimiter'], [/\s+/, 'white']
] } });
// This template is static. All record data is rendered using textContent or Monaco models.
$('app').innerHTML = VIEWER_HTML;
let wordWrap = saved.wordWrap !== false, outlineVisible = typeof saved.outlineVisible === 'boolean' ? saved.outlineVisible : window.innerWidth >= 720, focusMode = !!saved.focusMode;
let wrapCustomized = typeof saved.wordWrap === 'boolean';

let workerBlob: string | undefined;
(self as any).MonacoEnvironment = { getWorker: async () => {
  if (!workerBlob) { const text = await (await fetch($('resources').dataset.worker!)).text(); workerBlob = URL.createObjectURL(new Blob([text], { type: 'text/javascript' })); }
  return new Worker(workerBlob, { name: 'jsonl-editor' });
} };
const editor = monaco.editor.create($('editor'), { readOnly: true, domReadOnly: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13, tabSize: 2, wordWrap: wordWrap ? 'on' : 'off', wrappingIndent: 'indent', folding: true, foldingStrategy: 'auto', foldingMaximumRegions: 100000, renderValidationDecorations: 'on', stickyScroll: { enabled: true }, unicodeHighlight: { ambiguousCharacters: false }, ariaLabel: '当前 JSONL 记录' });
let current: NormalRecord | undefined, largePage: LargePage | undefined, currentLine = saved.line ?? 1, seq = -1, generation = -1;
let rawMode = !!saved.raw, outlineDepth = saved.depth === 2 ? 2 : 1, outlineNodes: OutlineNode[] = [], selected = '';
let progress: Progress | undefined, waiting: number | undefined, requestId = 0;
let largeRenderSeq = -1;
const largeSecond = new Map<string, LargeNode[]>();
let currentModel: monaco.editor.ITextModel | undefined;
const decorations = editor.createDecorationsCollection();
const viewStates = new Map<number, monaco.editor.ICodeEditorViewState>();
const pageRequests = new Map<number, { target: HTMLElement; node: LargeNode; kind: 'page' | 'window' }>();
const treeNodes = new Map<string, { element: HTMLElement; node: LargeNode }>();
const save = () => vscode.setState({ line: currentLine, raw: rawMode, depth: outlineDepth, width: $('sidebar').style.width, wordWrap, outlineVisible, focusMode });
if (typeof saved.width === 'string' && Number.isFinite(parseFloat(saved.width))) $('sidebar').style.width = `${Math.max(140, Math.min(400, parseFloat(saved.width)))}px`;
function updateLayout(): void {
  const visible = outlineVisible && !focusMode;
  $('sidebar').hidden = !visible; $('splitter').hidden = !visible;
  $('app').classList.toggle('focus-mode', focusMode); $('app').classList.toggle('no-wrap', !wordWrap);
  $('wrap').setAttribute('aria-pressed', String(wordWrap)); $('wrap').classList.toggle('active', wordWrap);
  $('toggle-outline').setAttribute('aria-expanded', String(visible)); $('toggle-outline').classList.toggle('active', visible);
  $('focus').setAttribute('aria-pressed', String(focusMode)); $('focus').classList.toggle('active', focusMode); $('focus').textContent = focusMode ? '退出专注' : '专注';
  editor.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' }); editor.layout();
}
function toggleWrap(): void { wordWrap = !wordWrap; wrapCustomized = true; updateLayout(); save(); }
updateLayout();
const theme = () => { const light = document.body.classList.contains('vscode-light'); monaco.editor.setTheme(document.body.classList.contains('vscode-high-contrast') ? 'hc-black' : document.body.classList.contains('vscode-high-contrast-light') ? 'hc-light' : light ? 'vs' : 'vs-dark'); };
new MutationObserver(theme).observe(document.body, { attributes: true, attributeFilter: ['class'] }); theme();
monaco.languages.registerFoldingRangeProvider('json', { provideFoldingRanges: () => rawMode || !current?.valid ? [] : current.folds.map(f => ({ start: f.start, end: f.end, kind: monaco.languages.FoldingRangeKind.Region })) });

function message(text: string, error = false, cancellable = false): void {
  $('message').hidden = false; $('message').classList.toggle('error', error);
  $('message').querySelector('span')!.textContent = text; $('cancel-jump').hidden = !cancellable;
}
function clearMessage(): void { $('message').hidden = true; }
function bytes(value: number): string { const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0; while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; } return `${value.toFixed(i ? 1 : 0)} ${units[i]}`; }
function time(seconds: number): string { return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒` : `${Math.round(seconds)} 秒`; }
function updateProgress(p: Progress): void {
  progress = p;
  $('initial-progress').textContent = p.state === 'complete' && p.lines < 100 ? `初始范围：共 ${p.lines} 行` : `前 100 行：${p.initialReady} / 100 已就绪`;
  const percentage = p.size ? 100 * p.scannedBytes / p.size : p.state === 'complete' ? 100 : 0;
  ($('progress') as HTMLProgressElement).value = percentage;
  const labels = { indexing: '正在建立索引', paused: '索引已暂停', cancelled: '索引已取消，可继续', saving: '扫描完成，正在保存索引', complete: '索引完成', changed: '源文件已变化', error: '索引错误' };
  $('index-progress').textContent = `${labels[p.state]} · ${percentage.toFixed(1)}% · ${bytes(p.scannedBytes)} / ${bytes(p.size)} · ${p.lines.toLocaleString()} 行${p.restored ? ' · 已复用缓存' : ''}`;
  $('index-summary').textContent = p.state === 'complete' ? `共 ${p.lines.toLocaleString()} 行${p.restored ? ' · 缓存' : ''}` : `${labels[p.state]} ${percentage.toFixed(1)}%`;
  $('index-summary').title = `${$('index-progress').textContent}\n${$('initial-progress').textContent}`;
  $('progress').hidden = p.state === 'complete';
  $('speed').textContent = p.state === 'indexing' ? `${p.speed ? bytes(p.speed) + '/s' : '速度估算中'} · 已用 ${time(p.elapsedMs / 1000)} · ${p.etaSeconds !== undefined ? '预计剩余 ' + time(p.etaSeconds) : '剩余时间估算中'}${p.warning ? ' · ' + p.warning : ''}` : p.warning ?? (p.state === 'complete' ? '已索引全部记录，可直接跳转任意行。' : '已就绪记录仍可浏览。');
  $('pause').textContent = p.state === 'paused' || p.state === 'cancelled' ? '继续索引' : '暂停索引';
  ($('pause') as HTMLButtonElement).disabled = ['complete', 'saving', 'changed', 'error'].includes(p.state);
  ($('cancel-index') as HTMLButtonElement).disabled = p.state !== 'indexing' && p.state !== 'paused';
  ($('last') as HTMLButtonElement).disabled = p.state !== 'complete' || p.lines === 0;
  $('reload').hidden = !['changed', 'error'].includes(p.state);
  const select = $('initial') as HTMLSelectElement;
  if (select.options.length !== p.initialReady || !select.options[0]?.value) {
    select.replaceChildren();
    for (let i = 1; i <= p.initialReady; i++) { const option = document.createElement('option'); option.value = String(i); option.textContent = `第 ${i} 行`; select.append(option); }
  }
  select.value = String(currentLine);
  if (!p.lines && p.state === 'complete') message('文件为空，没有 JSONL 记录。');
  else if (waiting !== undefined) message(`正在定位第 ${waiting.toLocaleString()} 行；当前可访问第 1–${p.lines.toLocaleString()} 行。`, false, true);
}
function setModel(text: string, language = 'json'): void {
  currentModel?.dispose();
  currentModel = monaco.editor.createModel(text, language);
  editor.setModel(currentModel); decorations.clear();
}
async function foldDepth(depth: number): Promise<void> {
  if (!current?.valid || rawMode) return;
  await editor.getAction('editor.unfoldAll')?.run();
  await editor.getAction('editor.fold')?.run({ levels: 1, direction: 'down', selectionLines: current.folds.filter(f => f.depth >= depth).map(f => f.start - 1) });
}
function renderNormal(record: NormalRecord): void {
  current = record; largePage = undefined; pageRequests.clear(); treeNodes.clear(); $('large').replaceChildren();
  largeSecond.clear(); largeRenderSeq = -1;
  $('large').hidden = true; $('editor').hidden = false;
  setModel(rawMode ? record.raw : record.formatted);
  monaco.editor.setModelMarkers(currentModel!, 'jsonl', record.issues.map(e => ({ message: e.message, severity: monaco.MarkerSeverity.Error, startLineNumber: e.line, endLineNumber: e.line, startColumn: e.column, endColumn: e.column + 1 })));
  $('details').textContent = `源文件第 ${currentLine.toLocaleString()} 行 · ${record.valid ? '严格 JSON 校验通过' : '无效记录，显示原文'}${record.bom ? ' · 已忽略文件开头 UTF-8 BOM' : ''}`;
  if (!record.valid) message(`第 ${currentLine} 行无效：${record.issues.map(e => `${e.message} (${e.line}:${e.column})`).join('；')}`, true);
  const state = viewStates.get(currentLine); if (state && !rawMode) editor.restoreViewState(state); else requestAnimationFrame(() => { void foldDepth(2); });
  renderOutline(); updateButtons();
  requestAnimationFrame(() => send({ type: 'rendered', line: currentLine, mode: 'normal', valid: record.valid, outlineCount: record.outline.length, foldCount: record.folds.length, layout: {
    viewportWidth: $('app').clientWidth, viewportHeight: $('app').clientHeight, contentWidth: $('content').clientWidth, contentHeight: $('content').clientHeight,
    wordWrap: editor.getOption(monaco.editor.EditorOption.wordWrap) === 'on', textHeight: editor.getContentHeight(), unwrappedTextHeight: currentModel!.getLineCount() * editor.getOption(monaco.editor.EditorOption.lineHeight)
  } }));
}
function updateButtons(): void {
  for (const id of ['fold-1', 'fold-2', 'unfold', 'fold-all', 'raw', 'find']) ($<HTMLButtonElement>(id)).disabled = !current;
  $('raw').textContent = rawMode ? '格式化正文' : '原始文本';
  ($<HTMLButtonElement>('copy')).disabled = !current && !largePage;
  ($<HTMLButtonElement>('export')).disabled = !current && !largePage;
}
function renderOutline(): void {
  outlineNodes = current?.valid && !rawMode ? current.outline.filter(n => n.depth <= outlineDepth) : [];
  if (largePage) outlineNodes = largePage.children.flatMap((n, i) => [
    { ...n, parent: largePage!.root.id, depth: 1, line: i + 1, column: 1 },
    ...(outlineDepth === 2 ? (largeSecond.get(n.id) ?? []).map(child => ({ ...child, parent: n.id, depth: 2, line: i + 1, column: 1 })) : [])
  ]).slice(0, 2000);
  $('outline-inner').style.height = `${outlineNodes.length * 28}px`;
  $('outline-hint').textContent = largePage ? '点击字段展开分页结构；标量可按 64 KiB 窗口查看。' : current?.outlineTruncated ? '导航已达 2,000 项预算；正文和查找仍可使用。' : rawMode ? '切回格式化正文以使用结构定位。' : current && !current.valid ? '无效记录无法生成完整结构。' : '点击 key 定位正文，重复 key 按位置区分。';
  $('depth-1').classList.toggle('active', outlineDepth === 1); $('depth-2').classList.toggle('active', outlineDepth === 2);
  paintOutline();
}
function paintOutline(): void {
  const container = $('outline'), inner = $('outline-inner'); inner.replaceChildren();
  const start = Math.max(0, Math.floor(container.scrollTop / 28) - 4), end = Math.min(outlineNodes.length, Math.ceil((container.scrollTop + container.clientHeight) / 28) + 4);
  for (let i = start; i < end; i++) {
    const node = outlineNodes[i], row = document.createElement('button');
    row.className = 'outline-row' + (selected === node.id ? ' selected' : ''); row.style.top = `${i * 28}px`; row.style.paddingLeft = `${12 + Math.max(0, node.depth - 1) * 16}px`;
    row.title = `${node.key} · ${node.kind} · ${node.id}`;
    const key = document.createElement('span'); key.className = 'key'; key.textContent = node.key;
    const type = document.createElement('span'); type.className = 'type'; type.textContent = `${node.kind}${node.count !== undefined ? `(${node.count})` : ''}`;
    row.append(key, type); row.onclick = () => { void reveal(node); }; inner.append(row);
  }
}
async function reveal(node: OutlineNode): Promise<void> {
  selected = node.id; paintOutline();
  if (largePage) { const found = treeNodes.get(node.id); if (found) { found.element.scrollIntoView({ block: 'center' }); await expandNode(found.element, found.node); } return; }
  if (!current) return;
  const ancestors = current.folds.filter(f => f.start < node.line && f.end >= node.line).map(f => f.start - 1);
  await editor.getAction('editor.unfold')?.run({ levels: 1, direction: 'down', selectionLines: ancestors });
  editor.setPosition({ lineNumber: node.line, column: node.column }); editor.revealLineInCenter(node.line); editor.focus();
  decorations.set([{ range: new monaco.Range(node.line, 1, node.line, 1), options: { isWholeLine: true, className: 'focus-line' } }]);
}
$('outline').addEventListener('scroll', paintOutline, { passive: true }); new ResizeObserver(paintOutline).observe($('outline'));
let syncScheduled = false;
function syncOutline(): void {
  if (syncScheduled || !current || rawMode) return;
  syncScheduled = true;
  requestAnimationFrame(() => {
    syncScheduled = false;
    const position = editor.getPosition(), visible = editor.getVisibleRanges()[0];
    if (!position && !visible) return;
    const line = position?.lineNumber ?? visible.startLineNumber;
    const offset = currentModel!.getOffsetAt({ lineNumber: line, column: position?.column ?? 1 });
    const node = outlineNodes.filter(n => n.start <= offset && n.end >= offset).at(-1) ?? outlineNodes.filter(n => n.line <= line).at(-1);
    if (node && selected !== node.id) { selected = node.id; const index = outlineNodes.indexOf(node); const container = $('outline'); if (index * 28 < container.scrollTop || index * 28 > container.scrollTop + container.clientHeight - 28) container.scrollTop = Math.max(0, index * 28 - container.clientHeight / 2); paintOutline(); }
  });
}
editor.onDidChangeCursorPosition(syncOutline); editor.onDidScrollChange(() => {
  if (!current || rawMode || syncScheduled) return;
  const line = editor.getVisibleRanges()[0]?.startLineNumber;
  const node = outlineNodes.filter(n => n.line <= (line ?? 1)).at(-1); if (node) { selected = node.id; paintOutline(); }
});

function requestPage(target: HTMLElement, node: LargeNode, skip: number): void {
  pageRequests.clear();
  const id = ++requestId; pageRequests.set(id, { target, node, kind: 'page' });
  target.textContent = '正在扫描此节点的子项…'; send({ type: 'page', node: node.id, skip, request: id });
}
function requestWindow(target: HTMLElement, node: LargeNode, offset: number): void {
  pageRequests.clear();
  const id = ++requestId; pageRequests.set(id, { target, node, kind: 'window' }); send({ type: 'window', node: node.id, offset, request: id });
}
async function expandNode(element: HTMLElement, node: LargeNode): Promise<void> {
  let child = element.querySelector<HTMLElement>(':scope > .tree-children');
  if (child) { child.hidden = !child.hidden; return; }
  child = document.createElement('div'); child.className = 'tree-children'; element.append(child);
  if (node.kind === 'array' || node.kind === 'object') requestPage(child, node, 0); else requestWindow(child, node, 0);
}
function treeNode(node: LargeNode): HTMLElement {
  const element = document.createElement('div'); element.className = 'tree-node';
  const header = document.createElement('div'); header.className = 'tree-header';
  const toggle = document.createElement('button'); toggle.className = 'tree-toggle'; toggle.textContent = '▸'; toggle.setAttribute('aria-label', `展开 ${node.key}`);
  const label = document.createElement('span'); label.className = 'label'; label.textContent = `${node.key} · ${node.kind}${node.count !== undefined ? `(${node.count})` : ''}`;
  const preview = document.createElement('span'); preview.className = 'preview'; preview.textContent = node.preview;
  toggle.onclick = () => { void expandNode(element, node); }; header.append(toggle, label, preview); element.append(header);
  treeNodes.set(node.id, { element, node });
  while (treeNodes.size > 2000) treeNodes.delete(treeNodes.keys().next().value!);
  return element;
}
function showPage(target: HTMLElement, page: LargePage): void {
  target.replaceChildren();
  for (const node of page.children) target.append(treeNode(node));
  const pager = document.createElement('div'); pager.className = 'pager';
  const info = document.createElement('span'); info.textContent = `第 ${page.children.length ? page.skip + 1 : 0}–${page.skip + page.children.length} 项 / ${page.done ? page.total.toLocaleString() : '正在扫描'}`;
  const previous = document.createElement('button'); previous.textContent = '上一页'; previous.disabled = page.skip === 0; previous.onclick = () => requestPage(target, page.root, Math.max(0, page.skip - 100));
  const next = document.createElement('button'); next.textContent = '下一页'; next.disabled = !page.done || page.skip + page.children.length >= page.total; next.onclick = () => requestPage(target, page.root, page.skip + 100);
  pager.append(info, previous, next); target.append(pager);
  if (page.error) { const error = document.createElement('p'); error.textContent = page.error; target.append(error); }
  if ($('large').querySelectorAll('.tree-node').length > 2000) {
    for (const subtree of $('large').querySelectorAll<HTMLElement>('.tree-children')) {
      if (subtree !== target && !subtree.contains(target)) { subtree.remove(); if ($('large').querySelectorAll('.tree-node').length <= 1500) break; }
    }
    for (const [id, value] of treeNodes) if (!value.element.isConnected) treeNodes.delete(id);
  }
}
function renderLarge(page: LargePage): void {
  const first = largeRenderSeq !== seq;
  current = undefined; largePage = page; currentModel?.dispose(); currentModel = undefined; editor.setModel(null);
  $('editor').hidden = true; $('large').hidden = false;
  const container = $('large');
  if (first) { container.replaceChildren(); treeNodes.clear(); largeSecond.clear(); pageRequests.clear(); largeRenderSeq = seq; }
  let status = container.querySelector<HTMLElement>('.large-status');
  if (!status) { status = document.createElement('div'); status.className = 'large-status'; container.append(status); }
  status.textContent = `超长记录模式 · ${bytes(page.size)} · ${page.done ? page.valid ? '严格 JSON 校验通过' : '校验失败' : `校验中 ${page.size ? (100 * page.scannedBytes / page.size).toFixed(1) : 0}%`} · 每页最多 100 项`;
  if (first) {
    const preview = document.createElement('button'); preview.textContent = '查看原文窗口';
    const windowTarget = document.createElement('div'); preview.onclick = () => requestWindow(windowTarget, largePage!.root, 0);
    const tree = document.createElement('div'); tree.id = 'root-tree';
    container.append(preview, windowTarget, tree);
  }
  const rootTree = $('root-tree');
  if (page.done || rootTree.children.length === 0 || Number(rootTree.dataset.nodes) !== page.children.length) {
    showPage(rootTree, page); rootTree.dataset.nodes = String(page.children.length);
  }
  $('details').textContent = `源文件第 ${currentLine.toLocaleString()} 行 · 分页结构 / 64 KiB 原文窗口 · 结构扫描未完成时不代表合法 JSON`;
  renderOutline(); updateButtons();
  if (page.error) message(page.error, true);
  if (page.done) requestAnimationFrame(() => send({ type: 'rendered', line: currentLine, mode: 'large', valid: page.valid, outlineCount: page.children.length, foldCount: 0 }));
}
function navigate(line: number): void {
  if (!Number.isSafeInteger(line) || line < 1) { message('请输入从 1 开始的整数行号。', true); return; }
  const state = editor.saveViewState(); if (state && current && !rawMode) { viewStates.delete(currentLine); viewStates.set(currentLine, state); while (viewStates.size > 10) viewStates.delete(viewStates.keys().next().value!); }
  waiting = line; send({ type: 'navigate', line });
}
$('first').onclick = () => navigate(1); $('previous').onclick = () => navigate(Math.max(1, currentLine - 1)); $('next').onclick = () => navigate(currentLine + 1);
$('go').onclick = () => navigate(Number(($('line') as HTMLInputElement).value)); $('line').onkeydown = event => { if (event.key === 'Enter') $('go').click(); };
$('initial').onchange = () => navigate(Number(($('initial') as HTMLSelectElement).value)); $('last').onclick = () => { if (progress?.state === 'complete') navigate(progress.lines); };
$('pause').onclick = () => send({ type: progress?.state === 'paused' || progress?.state === 'cancelled' ? 'resume' : 'pause' }); $('cancel-index').onclick = () => send({ type: 'cancelIndex' }); $('reload').onclick = () => send({ type: 'reload' });
$('cancel-jump').onclick = () => { waiting = undefined; send({ type: 'cancelJump' }); }; $('dismiss').onclick = clearMessage;
$('fold-1').onclick = () => { void foldDepth(1); }; $('fold-2').onclick = () => { void foldDepth(2); }; $('unfold').onclick = () => { void editor.getAction('editor.unfoldAll')?.run(); }; $('fold-all').onclick = () => { void editor.getAction('editor.foldAll')?.run(); };
$('raw').onclick = () => { rawMode = !rawMode; if (current) renderNormal(current); save(); }; $('find').onclick = () => { void editor.getAction('actions.find')?.run(); };
$('copy').onclick = () => send({ type: 'copyRaw' }); $('export').onclick = () => send({ type: 'exportRaw' });
$('wrap').onclick = toggleWrap;
$('toggle-outline').onclick = () => { if (focusMode) { focusMode = false; outlineVisible = true; } else outlineVisible = !outlineVisible; updateLayout(); save(); };
$('close-outline').onclick = () => { outlineVisible = false; updateLayout(); save(); };
$('focus').onclick = () => { focusMode = !focusMode; updateLayout(); save(); };
$('more').addEventListener('click', event => { if ((event.target as HTMLElement).closest('button:not(:disabled)')) ($('more') as HTMLDetailsElement).open = false; });
document.addEventListener('pointerdown', event => { for (const menu of document.querySelectorAll<HTMLDetailsElement>('.dropdown[open]')) if (!menu.contains(event.target as Node)) menu.open = false; });
for (const depth of [1, 2]) $(`depth-${depth}`).onclick = () => { outlineDepth = depth; renderOutline(); save(); };
window.addEventListener('keydown', event => {
  if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); navigate(Math.max(1, currentLine - 1)); }
  else if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); navigate(currentLine + 1); }
  else if (event.altKey && event.code === 'KeyZ') { event.preventDefault(); toggleWrap(); }
  else if (event.key === 'Escape') { for (const menu of document.querySelectorAll<HTMLDetailsElement>('.dropdown[open]')) menu.open = false; }
});
$('splitter').onpointerdown = event => {
  const splitter = $('splitter'); splitter.setPointerCapture(event.pointerId);
  splitter.onpointermove = e => { $('sidebar').style.width = `${Math.min(window.innerWidth * .3, Math.max(140, window.innerWidth - e.clientX))}px`; };
  splitter.onpointerup = () => { splitter.onpointermove = null; save(); };
};
$('splitter').onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { $('sidebar').style.width = `${Math.min(window.innerWidth * .3, Math.max(140, $('sidebar').clientWidth + (event.key === 'ArrowLeft' ? 20 : -20)))}px`; save(); } };
window.addEventListener('message', event => {
  const m = event.data;
  if (!m || typeof m.type !== 'string' || typeof m.seq !== 'number' || typeof m.generation !== 'number') return;
  if (m.generation < generation || (m.generation === generation && m.seq < seq)) return;
  if (m.generation > generation) { current = undefined; largePage = undefined; viewStates.clear(); pageRequests.clear(); treeNodes.clear(); }
  generation = m.generation; seq = m.seq;
  if (m.type === 'restore') send({ type: 'ready', line: currentLine });
  else if (m.type === 'progress') updateProgress(m.progress);
  else if (m.type === 'waiting') { waiting = m.line; message(`正在定位第 ${m.line.toLocaleString()} 行；已索引 ${progress?.lines.toLocaleString() ?? 0} 行。`, false, true); }
  else if (m.type === 'loading') { waiting = undefined; message(`正在读取第 ${m.line.toLocaleString()} 行 · ${bytes(m.bytes)}…`); }
  else if (m.type === 'record' || m.type === 'large') {
    currentLine = m.line; waiting = undefined; clearMessage(); ($('line') as HTMLInputElement).value = String(currentLine); ($('initial') as HTMLSelectElement).value = String(currentLine);
    if (m.type === 'record') renderNormal(m.record); else renderLarge(m.page); save();
  } else if (m.type === 'largeStart') {
    currentLine = m.line;
    renderLarge({ mode: 'large', root: { id: `b${m.start}`, key: '$', kind: 'string', start: m.start, end: m.end, preview: '' }, children: [], skip: 0, total: 0, scannedBytes: 0, size: m.end - m.start, done: false, valid: false });
    message('超长记录：正在增量校验。扫描可通过切行取消；可立即查看有界原文窗口。');
  }
  else if (m.type === 'page') {
    const request = pageRequests.get(m.request); if (request?.kind === 'page') {
      showPage(request.target, m.page);
      if (largePage?.root.id === m.node) { largePage = m.page; renderOutline(); }
      else if (largePage?.children.some(n => n.id === m.node)) { largeSecond.set(m.node, m.page.children); renderOutline(); }
      if (m.page.done) pageRequests.delete(m.request);
    }
  } else if (m.type === 'window') {
    const request = pageRequests.get(m.request); if (request?.kind !== 'window') return;
    request.target.replaceChildren(); const info = document.createElement('p'); info.className = 'hint'; info.textContent = `原文片段：字节 ${m.offset.toLocaleString()}–${m.next.toLocaleString()} / ${m.total.toLocaleString()}；不是完整 JSON 值。`;
    const pre = document.createElement('pre'); pre.className = 'fragment'; pre.textContent = m.text;
    const previous = document.createElement('button'); previous.textContent = '上一窗口'; previous.disabled = m.offset === 0; previous.onclick = () => requestWindow(request.target, request.node, Math.max(0, m.offset - 65536));
    const next = document.createElement('button'); next.textContent = '下一窗口'; next.disabled = m.next >= m.total; next.onclick = () => requestWindow(request.target, request.node, m.next);
    request.target.append(info, pre, previous, next); pageRequests.delete(m.request);
  } else if (m.type === 'empty') { waiting = undefined; current = undefined; largePage = undefined; currentModel?.dispose(); editor.setModel(null); $('large').replaceChildren(); renderOutline(); updateButtons(); message(m.message); }
  else if (m.type === 'error' || m.type === 'invalid') { waiting = undefined; message(m.message, true); if (m.type === 'invalid') { current = undefined; largePage = undefined; currentModel?.dispose(); editor.setModel(null); $('large').replaceChildren(); renderOutline(); updateButtons(); } }
  else if (m.type === 'notice') message(m.message);
  else if (m.type === 'jumpCancelled') { waiting = undefined; clearMessage(); }
  else if (m.type === 'reset') { currentModel?.dispose(); editor.setModel(null); current = undefined; largePage = undefined; $('large').replaceChildren(); renderOutline(); updateButtons(); }
  else if (m.type === 'config') { editor.updateOptions({ minimap: { enabled: m.minimap } }); if (!wrapCustomized && typeof m.wordWrap === 'boolean') { wordWrap = m.wordWrap; updateLayout(); } }
});
window.addEventListener('pagehide', () => { editor.dispose(); currentModel?.dispose(); if (workerBlob) URL.revokeObjectURL(workerBlob); });
updateButtons(); send({ type: 'ready', line: Number.isSafeInteger(currentLine) && currentLine > 0 ? currentLine : 1 });
