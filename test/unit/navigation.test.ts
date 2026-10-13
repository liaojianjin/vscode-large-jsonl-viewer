import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordHistory, randomLine } from '../../webview/navigation';
import { parseClientMessage } from '../../src/protocol/types';

test('back/forward traverses committed visits, with repeated rows kept as distinct visits', () => {
  const h = new RecordHistory();
  for (const line of [1, 12, 80, 12]) { h.requestVisit(line); assert.equal(h.commit(line), true); }
  assert.equal(h.requestMove(-1), 80); h.commit(80);
  assert.equal(h.requestMove(-1), 12); h.commit(12);
  assert.equal(h.requestMove(1), 80); h.commit(80);
  assert.equal(h.requestMove(1), 12); h.commit(12);
  assert.deepEqual(h.snapshot(), { entries: [1, 12, 80, 12], cursor: 3 }); assert.equal(h.canGoForward, false);
});
test('cancelled, failed and stale jumps leave committed history and forward branch intact', () => {
  const h = new RecordHistory(); for (const line of [1, 9, 20]) h.commit(line);
  h.requestMove(-1); h.commit(9);
  const before = h.snapshot();
  h.requestVisit(7000); h.cancel(); assert.deepEqual(h.snapshot(), before); assert.equal(h.canGoForward, true);
  h.requestVisit(17); h.requestVisit(18); assert.equal(h.commit(17), false); assert.deepEqual(h.snapshot(), before);
  assert.equal(h.commit(18), true); assert.deepEqual(h.snapshot(), { entries: [1, 9, 18], cursor: 2 }); assert.equal(h.canGoForward, false);
});
test('rapid back requests advance from the pending cursor and commit only the latest target', () => {
  const h = new RecordHistory(); [1, 10, 20, 30].forEach(n => h.commit(n));
  assert.equal(h.requestMove(-1), 20); assert.equal(h.requestMove(-1), 10);
  assert.equal(h.commit(20), false); assert.equal(h.current, 30);
  assert.equal(h.commit(10), true); assert.equal(h.current, 10);
  assert.equal(h.requestMove(-1), 1); h.commit(1); assert.equal(h.requestMove(-1), undefined);
});
test('history survives view recreation, remains bounded, and clears on a new file version', () => {
  const h = new RecordHistory(undefined, 3); [1, 2, 3, 4].forEach(n => h.commit(n));
  assert.deepEqual(h.snapshot(), { entries: [2, 3, 4], cursor: 2 });
  h.requestMove(-1); h.commit(3);
  const restored = new RecordHistory(h.snapshot(), 3); assert.equal(restored.current, 3); assert.equal(restored.canGoForward, true);
  restored.clear(); assert.equal(restored.canGoBack, false); assert.deepEqual(restored.snapshot(), { entries: [], cursor: -1 });
  for (const bad of [{ entries: [1, -3], cursor: 0 }, { entries: [1], cursor: 4 }, { entries: ['2'], cursor: 0 }]) assert.equal(new RecordHistory(bad).current, undefined);
});
test('single row visits do not add duplicate history entries', () => {
  const h = new RecordHistory(); h.commit(1); h.requestVisit(1); h.commit(1); h.commit(1);
  assert.deepEqual(h.snapshot(), { entries: [1], cursor: 0 }); assert.equal(h.canGoBack, false);
});
test('random selection covers each other row, including positions beyond 32 bits', () => {
  assert.equal(randomLine(0, 1), undefined); assert.equal(randomLine(1, 1), 1);
  const picks = [0, .25, .5, .75].map(r => randomLine(5, 3, () => r)); assert.deepEqual(picks, [1, 2, 4, 5]);
  assert.equal(randomLine(2, 1, () => .5), 2); assert.equal(randomLine(2, 2, () => .5), 1);
  const count = 2 ** 32 + 500;
  const last = randomLine(count, 1, () => 1 - Number.EPSILON)!; assert.ok(last > 2 ** 32); assert.ok(last <= count);
  assert.throws(() => randomLine(10, 1, () => 1));
});
test('expansion preference protocol enforces depth boundaries', () => {
  for (const depth of [-1, 0, 3, 128]) assert.deepEqual(parseClientMessage({ type: 'setExpandDepth', depth }), { type: 'setExpandDepth', depth });
  for (const depth of [-2, 129, 2.5, '3', null, NaN]) assert.equal(parseClientMessage({ type: 'setExpandDepth', depth }), undefined);
});
