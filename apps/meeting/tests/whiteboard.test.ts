import { describe, expect, it } from 'vitest';
import { WhiteboardStore, newBoardShape, parseBoardElement, type BoardElement } from '../src/whiteboard-model';
import { parsePeerMessage } from '../src/protocol';
const note = () => newBoardShape('note', 10, 20, '#f6d878');
describe('whiteboard edit planning model', () => {
  it('preserves deletion records when seeding a planning store', () => {
    const b = new WhiteboardStore(() => {}, 'b');
    const a = new WhiteboardStore(e => b.merge(e), 'a');
    const shape = note(); a.commit([shape]);
    expect(b.snapshot()[0]?.id).toBe(shape.id);
    a.commit([{ ...shape, deleted: true }]);
    const late = new WhiteboardStore(() => {}, 'late');
    a.records().forEach(e => late.merge(e));
    expect(late.snapshot()).toEqual([]);
    late.merge({ ...shape, clock: 1, actor: 'a' });
    expect(late.snapshot()).toEqual([]);
  });
  it('converges concurrent edits regardless of message order and duplicate replay', () => {
    const a = new WhiteboardStore(() => {}, 'a'), b = new WhiteboardStore(() => {}, 'b');
    const shape = note(); a.commit([shape]); b.merge(a.records()[0]!);
    a.commit([{ ...shape, text: 'A' }]); b.commit([{ ...shape, text: 'B' }]);
    const av = a.records()[0]!, bv = b.records()[0]!;
    a.merge(bv); b.merge(av); a.merge(av); b.merge(bv);
    expect(a.snapshot()).toEqual(b.snapshot()); expect(a.snapshot()[0]?.text).toBe('B');
  });
  it('undo and redo synchronize, but never undo a newer collaborator edit', () => {
    const b = new WhiteboardStore(() => {}, 'b'), a = new WhiteboardStore(e => b.merge(e), 'a');
    const shape = note(); a.commit([shape]); a.undo();
    expect(b.snapshot()).toEqual([]); a.redo(); expect(b.snapshot()).toHaveLength(1);
    b.commit([{ ...shape, text: 'Collaborator' }]); a.merge(b.records()[0]!); a.undo();
    expect(a.snapshot()[0]?.text).toBe('Collaborator');
  });
  it('reconciles independent offline changes on reconnect', () => {
    const a = new WhiteboardStore(() => {}, 'a'), b = new WhiteboardStore(() => {}, 'b');
    a.commit([note()]); b.commit([note()]);
    a.records().forEach(e => b.merge(e)); b.records().forEach(e => a.merge(e));
    expect(a.snapshot()).toEqual(b.snapshot()); expect(a.snapshot()).toHaveLength(2);
    a.reset(); expect(a.records()).toEqual([]); expect(a.canUndo).toBe(false);
  });
  it('rejects malformed planning records', () => {
    const record: BoardElement = { ...note(), actor: 'a', clock: 1 };
    for (const change of [{ x: Infinity }, { width: NaN }, { text: 'x'.repeat(501) }, { points: [[0, 'x']] }, { clock: -1 }, { color: 'url(evil)' }, { kind: 'connector', from: 'a', to: 'a' }]) {
      expect(parseBoardElement({ ...record, ...change })).toBeNull();
    }
    const maximal = { ...record, text: '\\'.repeat(500), points: Array.from({ length: 256 }, () => [-19999.123456789012, -19999.123456789012]) };
    expect(parseBoardElement(maximal)).not.toBeNull();
  });
  it('does not accept planning records as a room transport message', () => {
    expect(parsePeerMessage({ type: 'whiteboard', element: { ...note(), actor: 'a', clock: 1 } })).toBeNull();
  });
});
