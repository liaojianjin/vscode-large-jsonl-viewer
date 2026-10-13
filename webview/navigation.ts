export interface HistorySnapshot { entries: number[]; cursor: number }
export function validLine(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1; }

/** Only records rows that reached the view. Pending, cancelled and failed jumps do not consume history. */
export class RecordHistory {
  private entries: number[] = [];
  private cursor = -1;
  private pending?: { line: number; cursor?: number };
  constructor(snapshot?: unknown, readonly limit = 200) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid history budget');
    if (!snapshot || typeof snapshot !== 'object') return;
    const value = snapshot as HistorySnapshot;
    if (!Array.isArray(value.entries) || value.entries.length > 1000 || !value.entries.every(validLine) || !Number.isInteger(value.cursor) || value.cursor < 0 || value.cursor >= value.entries.length) return;
    const start = Math.max(0, value.cursor - limit + 1);
    this.entries = value.entries.slice(start, start + limit); this.cursor = value.cursor - start;
  }
  get current(): number | undefined { return this.entries[this.cursor]; }
  get pendingLine(): number | undefined { return this.pending?.line; }
  private get effectiveCursor(): number { return this.pending?.cursor ?? this.cursor; }
  get canGoBack(): boolean { return this.effectiveCursor > 0; }
  get canGoForward(): boolean { return this.effectiveCursor >= 0 && this.effectiveCursor < this.entries.length - 1; }
  requestVisit(line: number): void { if (!validLine(line)) throw new Error('Invalid history line'); this.pending = { line }; }
  requestMove(direction: -1 | 1): number | undefined {
    const cursor = this.effectiveCursor + direction;
    if (cursor < 0 || cursor >= this.entries.length) return;
    this.pending = { line: this.entries[cursor], cursor }; return this.pending.line;
  }
  commit(line: number): boolean {
    if (!validLine(line) || this.pending && this.pending.line !== line) return false;
    if (this.pending?.cursor !== undefined) this.cursor = this.pending.cursor;
    else if (this.current !== line) {
      this.entries.splice(this.cursor + 1); this.entries.push(line); this.cursor = this.entries.length - 1;
      if (this.entries.length > this.limit) { this.entries.shift(); this.cursor--; }
    }
    this.pending = undefined; return true;
  }
  cancel(): void { this.pending = undefined; }
  clear(): void { this.entries = []; this.cursor = -1; this.cancel(); }
  snapshot(): HistorySnapshot { return { entries: [...this.entries], cursor: this.cursor }; }
}

/** Uniform over accessible rows, excluding the current row when another row exists; no 32-bit positions. */
export function randomLine(count: number, current: number | undefined, random = Math.random): number | undefined {
  if (!validLine(count)) return;
  if (count === 1) return 1;
  const sample = random(); if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error('Invalid random sample');
  const exclude = validLine(current) && current <= count;
  const candidate = 1 + Math.floor(sample * (exclude ? count - 1 : count));
  return exclude && candidate >= current! ? candidate + 1 : candidate;
}
