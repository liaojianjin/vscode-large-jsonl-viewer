import { format, printParseErrorCode, visit } from 'jsonc-parser';
import type { FoldRange, JsonKind, NormalRecord, OutlineNode } from '../protocol/types';

export class RecordBudgetError extends Error { constructor() { super('该记录的结构超过常规编辑器预算，切换流式模式。'); } }
export function processRecord(raw: string, bom = false): NormalRecord {
  const issues: NormalRecord['issues'] = [];
  let depth = 0, nodes = 0;
  const started = Date.now();
  const budget = () => { if (++nodes > 100000 || depth > 128 || Date.now() - started > 2000) throw new RecordBudgetError(); };
  visit(raw, {
    onObjectBegin: () => { depth++; budget(); }, onArrayBegin: () => { depth++; budget(); },
    onObjectEnd: () => { depth--; }, onArrayEnd: () => { depth--; }, onLiteralValue: budget,
    onError: (code, _offset, _length, line, column) => { if (issues.length < 20) issues.push({ message: printParseErrorCode(code), line: line + 1, column: column + 1 }); }
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (issues.length) return { mode: 'normal', raw, formatted: raw, valid: false, bom, outline: [], folds: [], issues, outlineTruncated: false };
  const edits = format(raw, undefined, { tabSize: 2, insertSpaces: true, eol: '\n' });
  const formattedSize = raw.length + edits.reduce((sum, edit) => sum + edit.content.length - edit.length, 0);
  if (formattedSize > 16 * 1024 * 1024 || Date.now() - started > 2000) throw new RecordBudgetError();
  // Apply non-overlapping formatter edits in one pass. Rebuilding the whole
  // string for each edit makes flat arrays with many tokens quadratic.
  const pieces: string[] = []; let cursor = 0;
  for (const edit of edits.slice().sort((a, b) => a.offset - b.offset || a.length - b.length)) {
    if (edit.offset < cursor) throw new Error('格式化编辑范围重叠。');
    pieces.push(raw.slice(cursor, edit.offset), edit.content); cursor = edit.offset + edit.length;
  }
  pieces.push(raw.slice(cursor));
  const formatted = pieces.join(''), outline: OutlineNode[] = [], folds: FoldRange[] = [];
  const stack: { id: string; kind: JsonKind; count: number; start: number; depth: number; node?: OutlineNode; key?: { value: string; offset: number; line: number; column: number } }[] = [];
  let truncated = false;
  const add = (kind: JsonKind, offset: number, length: number, line: number, column: number): OutlineNode | undefined => {
    const parent = stack.at(-1), level = stack.length;
    const property = parent?.key;
    const key = property?.value ?? (parent?.kind === 'array' ? `[${parent.count}]` : '$');
    if (parent) { parent.count++; parent.key = undefined; }
    if (level > 2) return;
    if (outline.length >= 2000) { truncated = true; return; }
    const node: OutlineNode = { id: `u${offset}`, parent: parent?.id, key, kind, depth: level, start: offset, end: offset + length, line: (property?.line ?? line) + 1, column: (property?.column ?? column) + 1, preview: kind !== 'object' && kind !== 'array' ? formatted.slice(offset, offset + Math.min(length, 100)) : undefined };
    outline.push(node); return node;
  };
  const begin = (kind: JsonKind) => (offset: number, length: number, line: number, column: number) => {
    const node = add(kind, offset, length, line, column);
    stack.push({ id: `u${offset}`, kind, count: 0, start: line + 1, depth: stack.length, node });
  };
  const end = (offset: number, length: number, line: number) => {
    const item = stack.pop()!;
    if (item.node) { item.node.end = offset + length; item.node.count = item.count; }
    if (line + 1 > item.start) folds.push({ start: item.start, end: line + 1, depth: item.depth });
  };
  visit(formatted, {
    onObjectBegin: begin('object'), onArrayBegin: begin('array'), onObjectEnd: end, onArrayEnd: end,
    onObjectProperty: (key, offset, _length, line, column) => { stack.at(-1)!.key = { value: key, offset, line, column }; },
    onLiteralValue: (value, offset, length, line, column) => { add(value === null ? 'null' : typeof value as JsonKind, offset, length, line, column); }
  }, { disallowComments: true, allowTrailingComma: false });
  return { mode: 'normal', raw, formatted, valid: true, bom, outline, folds, issues: [], outlineTruncated: truncated };
}
