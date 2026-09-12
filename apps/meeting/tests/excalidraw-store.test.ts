import { describe, expect, it } from 'vitest';
import { ExcalidrawStore, MAX_EXCALIDRAW_ELEMENTS, parseExcalidrawElement } from '../src/excalidraw-store';
import { MAX_PEER_MESSAGE_BYTES, parsePeerMessage } from '../src/protocol';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

function element(overrides: Record<string, unknown> = {}): ExcalidrawElement {
  const value = parseExcalidrawElement({ id: 'shape', type: 'rectangle', x: 140, y: 90, width: 240, height: 150,
    angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#ffec99', fillStyle: 'solid', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 0, opacity: 100, roundness: { type: 3 }, seed: 42, version: 1,
    versionNonce: 100, index: 'a0', isDeleted: false, groupIds: [], frameId: null,
    boundElements: null, updated: 1, link: null, locked: false, ...overrides });
  if (!value) throw new Error('Invalid fixture');
  return value;
}
function boundText(overrides: Record<string, unknown> = {}): ExcalidrawElement {
  return element({ id: 'label', type: 'text', x: 150, y: 100, width: 220, height: 120, index: 'a1',
    text: '第一行\n\n保留多行中文', originalText: '第一行\n\n保留多行中文', fontSize: 20, fontFamily: 2,
    textAlign: 'center', verticalAlign: 'middle', containerId: 'shape', autoResize: true, lineHeight: 1.25,
    ...overrides });
}

describe('native Excalidraw scene sharing', () => {
  it('retains native text bindings and layout through JSON and late-join replay', () => {
    const remote = new ExcalidrawStore(() => {});
    const local = new ExcalidrawStore(e => {
      const message = parsePeerMessage(JSON.parse(JSON.stringify({ type: 'excalidraw', element: e })));
      if (!message || message.type !== 'excalidraw') throw new Error('Invalid frame');
      remote.merge(message.element);
    });
    const container = element({ boundElements: [{ id: 'label', type: 'text' }] });
    const label = boundText({ text: '長文字與換行\n'.repeat(60), originalText: '長文字與換行\n'.repeat(60), height: 750 });
    expect(local.update([container, label])).toBe(true);
    expect(remote.snapshot()).toEqual(local.snapshot());
    expect(remote.get('label')).toEqual(label);
    const late = new ExcalidrawStore(() => {});
    local.records().forEach(e => late.merge(e));
    expect(late.snapshot()).toEqual(local.snapshot());
    expect(late.get('shape')?.boundElements).toEqual([{ id: 'label', type: 'text' }]);
  });

  it('converges equal-version edits using the native lower-nonce rule regardless of replay order', () => {
    const a = new ExcalidrawStore(() => {}), b = new ExcalidrawStore(() => {});
    const first = element({ version: 4, versionNonce: 90, x: 400 });
    const winner = element({ version: 4, versionNonce: 10, x: 700 });
    a.merge(first); a.merge(winner); b.merge(winner); b.merge(first);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.get('shape')?.x).toBe(700);
    a.merge(element({ version: 3, versionNonce: 0 }));
    expect(a.get('shape')).toEqual(winner);
  });

  it('retains deletion tombstones and does not resurrect stale native elements', () => {
    const store = new ExcalidrawStore(() => {});
    store.update([element(), boundText()]);
    store.update([element({ version: 2, isDeleted: true }), boundText({ version: 2, isDeleted: true })]);
    const late = new ExcalidrawStore(() => {});
    store.records().forEach(e => late.merge(e));
    late.merge(element()); late.merge(boundText());
    expect(late.snapshot()).toHaveLength(2);
    expect(late.snapshot().every(e => e.isDeleted)).toBe(true);
  });

  it('keeps native elbow-arrow bindings, fixed segments and fractional ordering', () => {
    const store = new ExcalidrawStore(() => {});
    const arrow = element({ id: 'arrow', type: 'arrow', index: 'a2', width: 300, height: 80,
      points: [[0, 0], [150, 0], [150, 80], [300, 80]], lastCommittedPoint: null,
      startBinding: { elementId: 'shape', focus: 0, gap: 1, fixedPoint: [1, .5] },
      endBinding: { elementId: 'other', focus: 0, gap: 1, fixedPoint: [0, .5] },
      startArrowhead: null, endArrowhead: 'arrow', elbowed: true,
      fixedSegments: [{ start: [150, 0], end: [150, 80], index: 2 }], startIsSpecial: false, endIsSpecial: null });
    store.merge(arrow); store.merge(boundText()); store.merge(element());
    expect(store.get('arrow')).toEqual(arrow);
    expect(store.snapshot().map(e => e.id)).toEqual(['shape', 'label', 'arrow']);
  });

  it('accepts native free bindings and out-of-outline elbow binding ratios', () => {
    const regular = element({ id: 'arrow', type: 'arrow', width: -300, height: -80,
      points: [[0, 0], [-300, -80]], lastCommittedPoint: null,
      startBinding: { elementId: 'shape', focus: 0, gap: 1, fixedPoint: null },
      endBinding: { elementId: 'other', focus: 1.02, gap: 1, fixedPoint: null },
      startArrowhead: null, endArrowhead: 'arrow', elbowed: false });
    expect(parsePeerMessage({ type: 'excalidraw', element: regular })).toEqual({ type: 'excalidraw', element: regular });
    const elbowed = { ...regular, elbowed: true,
      startBinding: { elementId: 'shape', focus: 0, gap: 0, fixedPoint: [1.02, .5] },
      endBinding: { elementId: 'other', focus: 0, gap: 0, fixedPoint: [-.02, .5] },
      fixedSegments: [], startIsSpecial: false, endIsSpecial: false };
    const parsed = parseExcalidrawElement(elbowed);
    expect(parsed).toEqual(elbowed);
    for (const fixedPoint of [[Infinity, .5], ['x', .5], [0, 1, 2]]) {
      expect(parseExcalidrawElement({ ...elbowed, startBinding: { ...elbowed.startBinding, fixedPoint } })).toBeNull();
    }
  });

  it('accepts ordinary native line and freehand drawing snapshots', () => {
    const common = { points: [[0, 0], [-24.5, 18], [-90, -40]], lastCommittedPoint: null, width: -90, height: -40 };
    const line = element({ ...common, id: 'line', type: 'line',
      startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null });
    const freehand = element({ ...common, id: 'freehand', type: 'freedraw', pressures: [0, .5, 1], simulatePressure: false });
    const store = new ExcalidrawStore(() => {});
    expect(store.update([line, freehand])).toBe(true);
    expect(store.get('line')).toEqual(line); expect(store.get('freehand')).toEqual(freehand);
    expect(parseExcalidrawElement({ ...freehand, pressures: [NaN] })).toBeNull();
  });

  it('publishes no duplicate changes and atomically undoes bound text plus container geometry', () => {
    const published: ExcalidrawElement[] = [];
    const store = new ExcalidrawStore(e => published.push(e));
    let notifications = 0; store.subscribe(() => { notifications += 1; });
    const initial = [element(), boundText()]; store.update(initial);
    store.update(initial);
    expect(published).toHaveLength(2); expect(notifications).toBe(1);
    const changes = [element({ version: 2, height: 700 }), boundText({ version: 2, height: 680, text: '更新\n'.repeat(80) })];
    store.commit(changes); store.undo();
    expect(store.get('shape')?.height).toBe(150);
    expect(store.get('label')).toMatchObject({ text: '第一行\n\n保留多行中文', height: 120 });
    store.redo();
    expect(store.get('shape')?.height).toBe(700);
    expect(store.get('label')).toMatchObject({ text: '更新\n'.repeat(80), height: 680 });
    expect(store.size).toBe(2);
  });

  it('does not undo a collaborator update and clears scene plus history on reset', () => {
    const store = new ExcalidrawStore(() => {});
    store.update([element()]); store.merge(element({ version: 4, x: 900 })); store.undo();
    expect(store.get('shape')?.x).toBe(900);
    store.reset();
    expect(store.snapshot()).toEqual([]); expect(store.canUndo).toBe(false); expect(store.canRedo).toBe(false);
  });

  it('skips an entire undo transaction when a collaborator changes its bound label', () => {
    const published: ExcalidrawElement[] = [];
    const store = new ExcalidrawStore(e => published.push(e));
    store.commit([element({ boundElements: [{ id: 'label', type: 'text' }] }), boundText()]);
    store.merge(boundText({ version: 3, text: 'Collaborator text', originalText: 'Collaborator text' }));
    published.length = 0;
    store.undo();
    expect(published).toEqual([]);
    expect(store.get('shape')).toMatchObject({ isDeleted: false, boundElements: [{ id: 'label', type: 'text' }] });
    expect(store.get('label')).toMatchObject({ isDeleted: false, containerId: 'shape', text: 'Collaborator text' });
    expect(store.canRedo).toBe(false);
  });

  it('skips an entire redo transaction after a collaborator changes its restored container', () => {
    const store = new ExcalidrawStore(() => {});
    store.commit([element(), boundText()]);
    store.commit([element({ version: 2, height: 700 }), boundText({ version: 2, height: 680 })]);
    store.undo();
    store.merge(element({ version: 10, x: 950 }));
    store.redo();
    expect(store.get('shape')).toMatchObject({ version: 10, x: 950, height: 150 });
    expect(store.get('label')).toMatchObject({ height: 120 });
  });

  it('isolates native input mutation from stored versions, nested bindings and undo history', () => {
    const store = new ExcalidrawStore(() => {});
    const imported = element({ boundElements: [{ id: 'label', type: 'text' }], groupIds: ['diagram'] });
    store.update([imported, boundText()]);
    const changed = { ...imported, version: 2, versionNonce: 200, x: 400 };
    store.update([changed]);

    // Excalidraw mutates its own scene objects. Previously submitted references
    // must not be able to rewrite the store's accepted version or undo snapshot.
    Object.assign(changed, { x: 900, version: 99 });
    (imported.boundElements as Array<{ id: string; type: 'text' }>)[0]!.id = 'mutated';
    (imported.groupIds as string[]).push('mutated');
    expect(store.get('shape')).toMatchObject({ x: 400, version: 2,
      boundElements: [{ id: 'label', type: 'text' }], groupIds: ['diagram'] });
    store.undo();
    expect(store.get('shape')).toMatchObject({ x: 140, version: 3,
      boundElements: [{ id: 'label', type: 'text' }], groupIds: ['diagram'] });
  });

  it('preserves grouped diagram nodes, frame membership and labels bound to native arrows', () => {
    const store = new ExcalidrawStore(() => {});
    const frame = element({ id: 'frame', type: 'frame', name: '流程子圖', index: 'a0', width: 700, height: 500 });
    const node = element({ id: 'shape', frameId: 'frame', groupIds: ['diagram'], index: 'a1',
      boundElements: [{ id: 'arrow', type: 'arrow' }] });
    const arrow = element({ id: 'arrow', type: 'arrow', index: 'a2', frameId: 'frame', groupIds: ['diagram'],
      points: [[0, 0], [300, 0]], lastCommittedPoint: null, startBinding: { elementId: 'shape', focus: 0, gap: 1 },
      endBinding: null, startArrowhead: null, endArrowhead: 'arrow', elbowed: false,
      boundElements: [{ id: 'label', type: 'text' }] });
    const label = boundText({ containerId: 'arrow', frameId: 'frame', groupIds: ['diagram'], index: 'a3',
      originalText: '成功\n進入下一步', text: '成功\n進入下一步' });
    // Arrival order cannot discard references to members whose frames arrive later.
    for (const e of [label, arrow, node, frame]) {
      const message = parsePeerMessage(JSON.parse(JSON.stringify({ type: 'excalidraw', element: e })));
      if (!message || message.type !== 'excalidraw') throw new Error('Invalid diagram frame');
      expect(store.merge(message.element)).toBe(true);
    }
    expect(store.snapshot()).toEqual([frame, node, arrow, label]);
  });

  it('rejects invalid native payloads, unsupported embeds and oversized UTF-8 frames', () => {
    const base = element();
    for (const change of [{ x: Infinity }, { version: 0 }, { versionNonce: -1 }, { type: 'iframe' },
      { index: '<script>' }, { strokeColor: 'url(https://example.test)' }, { link: 'javascript:alert(1)' },
      { boundElements: [{ id: 'label', type: 'iframe' }] }, { groupIds: [3] }]) {
      expect(parsePeerMessage({ type: 'excalidraw', element: { ...base, ...change } })).toBeNull();
    }
    const large = { ...boundText(), text: '繁'.repeat(4000), originalText: '繁'.repeat(4000) };
    expect(parsePeerMessage({ type: 'excalidraw', element: large })).toBeNull();
    const safe = boundText({ text: '繁'.repeat(1500), originalText: '繁'.repeat(1500) });
    expect(new TextEncoder().encode(JSON.stringify({ type: 'excalidraw', element: safe })).length).toBeLessThan(MAX_PEER_MESSAGE_BYTES);
    expect(parsePeerMessage({ type: 'excalidraw', element: safe })).not.toBeNull();
  });

  it('rejects a whole local transaction before publishing if any member exceeds limits', () => {
    const published: ExcalidrawElement[] = [];
    const store = new ExcalidrawStore(e => published.push(e));
    const invalid = { ...boundText(), text: 'a'.repeat(4001) } as ExcalidrawElement;
    expect(store.update([element(), invalid])).toBe(false);
    expect(store.snapshot()).toEqual([]); expect(published).toEqual([]);
    const scene = Array.from({ length: MAX_EXCALIDRAW_ELEMENTS }, (_, i) => element({ id: `item_${i}` }));
    expect(store.update(scene)).toBe(true);
    published.length = 0;
    expect(store.update([element({ id: 'item_0', version: 2 }), element({ id: 'extra' })])).toBe(false);
    expect(store.get('item_0')?.version).toBe(1);
    expect(store.size).toBe(MAX_EXCALIDRAW_ELEMENTS); expect(published).toEqual([]);
  });
});
