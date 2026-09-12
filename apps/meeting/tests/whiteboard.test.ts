import { describe, expect, it } from 'vitest';
import { WhiteboardStore, newBoardShape, parseBoardElement, connectorPath, type BoardElement } from '../src/whiteboard-model';
import { parsePeerMessage, MAX_PEER_MESSAGE_BYTES } from '../src/protocol';
const note = () => newBoardShape('note', 10, 20, '#f6d878');
describe('shared whiteboard', () => {
  it('synchronizes edits without a mounted whiteboard and replays deletions to late joiners', () => {
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
  it('rejects malformed remote records and keeps maximal frames bounded', () => {
    const record: BoardElement = { ...note(), actor: 'a', clock: 1 };
    for (const change of [{ x: Infinity }, { width: NaN }, { text: 'x'.repeat(501) }, { points: [[0, 'x']] }, { clock: -1 }, { color: 'url(evil)' }, { kind: 'connector', from: 'a', to: 'a' }]) {
      expect(parseBoardElement({ ...record, ...change })).toBeNull();
      expect(parsePeerMessage({ type: 'whiteboard', element: { ...record, ...change } })).toBeNull();
    }
    const maximal = { ...record, text: '\\'.repeat(500), points: Array.from({ length: 256 }, () => [-19999.123456789012, -19999.123456789012]) };
    const frame = { type: 'whiteboard', element: maximal };
    expect(parsePeerMessage(frame)).not.toBeNull();
    expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThan(MAX_PEER_MESSAGE_BYTES);
  });
  it('keeps connectors attached when a node moves', () => {
    const a = { ...note(), kind: 'rectangle' as const, x: 0, y: 0, width: 100, height: 100 };
    const b = { ...a, id: 'b', x: 300 };
    expect(connectorPath(a, b)).toBe('M 100 50 L 200 50 L 300 50');
    expect(connectorPath(a, { ...b, x: 500 })).toBe('M 100 50 L 300 50 L 500 50');
  });
});

 it('routes vertical diamond connections with a vertical final segment', () => {
   const a = { ...note(), kind: 'diamond' as const, x: 0, y: 0, width: 180, height: 90 };
   const b = { ...a, id: 'b', y: 240 };
   expect(connectorPath(a, b)).toBe('M 90 90 L 90 165 L 90 240');
   expect(connectorPath(b, a)).toBe('M 90 240 L 90 165 L 90 90');
   expect(connectorPath(a, { ...b, x: 20 })).toBe('M 90 90 L 90 165 L 110 165 L 110 240');
 });
