import { describe, expect, it } from 'vitest';
import { newBoardShape, parseBoardElement, WhiteboardStore, type BoardElement } from '../src/whiteboard-model';

// Keep explicit empty lines and non-ASCII characters at the accepted text limit.
const longText = '共同編輯白板，保留每一行文字。\n\n下一行包含中文與 English。\n'.repeat(20).slice(0, 500);
const editableKinds = ['note', 'rectangle', 'diamond', 'text'] as const;

function connectedStores() {
  const received: BoardElement[] = [];
  const remote = new WhiteboardStore(() => {}, 'remote');
  const local = new WhiteboardStore(element => {
    // Compact records are local planning inputs; native Excalidraw records use the peer channel.
    const parsed = parseBoardElement(JSON.parse(JSON.stringify(element)));
    if (!parsed) throw new Error('Rejected whiteboard planning input');
    received.push(parsed);
    remote.merge(parsed);
  }, 'local');
  return { local, remote, received };
}

describe('whiteboard planning text and geometry', () => {
  it.each(editableKinds)('synchronizes all 500 characters and the expanded %s in one record', kind => {
    const { local, remote, received } = connectedStores();
    const shape = newBoardShape(kind, 320, 240, '#f6d878');
    local.commit([shape]);
    received.length = 0;

    local.commit([{ ...shape, text: longText, height: 1200 }]);

    expect(longText).toHaveLength(500);
    expect(longText).toContain('\n\n');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: shape.id, text: longText, height: 1200, x: 320, y: 240 });
    expect(local.records()).toHaveLength(1);
    expect(remote.snapshot()).toEqual(local.snapshot());

    const lateJoiner = new WhiteboardStore(() => {}, 'late');
    remote.records().forEach(record => lateJoiner.merge(record));
    expect(lateJoiner.get(shape.id)?.text).toBe(longText);
    expect(lateJoiner.get(shape.id)?.height).toBe(1200);
  });

  it.each(editableKinds)('preserves long %s text through movement and resizing', kind => {
    const { local, remote } = connectedStores();
    const shape = { ...newBoardShape(kind, 320, 240, '#f6d878'), text: longText, height: 900 };
    local.commit([shape]);

    local.commit([{ ...local.get(shape.id)!, x: -180, y: 680 }]);
    expect(remote.get(shape.id)).toMatchObject({ text: longText, x: -180, y: 680, width: 180, height: 900 });

    local.commit([{ ...local.get(shape.id)!, width: 420, height: 1100 }]);
    expect(remote.get(shape.id)).toMatchObject({ text: longText, x: -180, y: 680, width: 420, height: 1100 });
    expect(local.records()).toHaveLength(1);
    expect(remote.records()).toHaveLength(1);
    expect(remote.snapshot()).toEqual(local.snapshot());
  });

  it.each(editableKinds)('undoes and redoes %s text plus automatic height together', kind => {
    const { local, remote, received } = connectedStores();
    const shape = { ...newBoardShape(kind, 320, 240, '#f6d878'), text: '原始文字\n第二行' };
    local.commit([shape]);
    const expanded = { ...shape, text: longText, height: 1200 };
    local.commit([expanded]);

    received.length = 0;
    local.undo();
    expect(received).toHaveLength(1);
    expect(local.get(shape.id)).toMatchObject(shape);
    expect(remote.snapshot()).toEqual(local.snapshot());

    received.length = 0;
    local.redo();
    expect(received).toHaveLength(1);
    expect(local.get(shape.id)).toMatchObject(expanded);
    expect(remote.snapshot()).toEqual(local.snapshot());
    expect(local.records()).toHaveLength(1);
    expect(remote.records()).toHaveLength(1);
  });
});
