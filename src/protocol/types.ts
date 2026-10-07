export type IndexState = 'indexing' | 'paused' | 'cancelled' | 'saving' | 'complete' | 'changed' | 'error';
export interface Progress {
  state: IndexState; size: number; scannedBytes: number; lines: number; initialReady: number;
  speed: number; elapsedMs: number; etaSeconds?: number; restored: boolean; warning?: string; error?: string;
}
export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
export interface OutlineNode {
  id: string; parent?: string; key: string; kind: JsonKind; depth: number; start: number; end: number;
  line: number; column: number; count?: number; preview?: string;
}
export interface FoldRange { start: number; end: number; depth: number }
export interface NormalRecord {
  mode: 'normal'; raw: string; formatted: string; valid: boolean; bom: boolean; outline: OutlineNode[];
  folds: FoldRange[]; issues: { message: string; line: number; column: number }[]; outlineTruncated: boolean;
}
export interface LargeNode {
  id: string; key: string; kind: JsonKind; start: number; end: number; count?: number; preview: string;
}
export interface LargePage {
  mode: 'large'; root: LargeNode; children: LargeNode[]; skip: number; total: number; scannedBytes: number;
  size: number; valid: boolean; done: boolean; error?: string;
}
export interface ViewLayout {
  viewportWidth: number; viewportHeight: number; contentWidth: number; contentHeight: number;
  wordWrap: boolean; textHeight: number; unwrappedTextHeight: number;
}
export type ClientMessage =
  | { type: 'startupError'; message: string }
  | { type: 'rendered'; line: number; mode: 'normal' | 'large'; valid: boolean; outlineCount: number; foldCount: number; layout?: ViewLayout }
  | { type: 'ready'; line?: number }
  | { type: 'navigate'; line: number }
  | { type: 'last' | 'cancelJump' | 'pause' | 'resume' | 'cancelIndex' | 'reload' | 'copyRaw' | 'exportRaw' }
  | { type: 'page'; node: string; skip: number; request: number }
  | { type: 'window'; node: string; offset: number; request: number };
export function parseClientMessage(value: unknown): ClientMessage | undefined {
  if (!value || typeof value !== 'object') return;
  const m = value as Record<string, unknown>;
  if (typeof m.type !== 'string') return;
  const integer = (n: unknown, min = 0) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
  switch (m.type) {
    case 'startupError': if (typeof m.message === 'string' && m.message.length <= 2000) return { type: 'startupError', message: m.message }; return;
    case 'rendered': {
      const layout = m.layout as ViewLayout | undefined;
      const validLayout = layout && typeof layout.wordWrap === 'boolean' && ['viewportWidth', 'viewportHeight', 'contentWidth', 'contentHeight', 'textHeight', 'unwrappedTextHeight'].every(key => integer((layout as unknown as Record<string, unknown>)[key]));
      if (integer(m.line, 1) && (m.mode === 'normal' || m.mode === 'large') && typeof m.valid === 'boolean' && integer(m.outlineCount) && integer(m.foldCount)) return { type: 'rendered', line: m.line as number, mode: m.mode, valid: m.valid, outlineCount: m.outlineCount as number, foldCount: m.foldCount as number, layout: validLayout ? layout : undefined };
      return;
    }
    case 'ready': return { type: 'ready', line: integer(m.line, 1) ? m.line as number : undefined };
    case 'navigate': if (integer(m.line, 1)) return { type: 'navigate', line: m.line as number }; return;
    case 'page': case 'window': {
      if (typeof m.node !== 'string' || m.node.length > 40 || !integer(m.request, 1)) return;
      const field = m.type === 'page' ? 'skip' : 'offset';
      if (!integer(m[field])) return;
      return m.type === 'page' ? { type: 'page', node: m.node, skip: m.skip as number, request: m.request as number } : { type: 'window', node: m.node, offset: m.offset as number, request: m.request as number };
    }
    case 'last': case 'cancelJump': case 'pause': case 'resume': case 'cancelIndex': case 'reload': case 'copyRaw': case 'exportRaw': return { type: m.type };
  }
}
