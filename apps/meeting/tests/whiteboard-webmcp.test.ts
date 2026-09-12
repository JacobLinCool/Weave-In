import { describe, expect, it } from 'vitest';
import { WhiteboardStore, type BoardElement } from '../src/whiteboard-model';
import { editExcalidrawWhiteboard, editWhiteboard, importMermaidWhiteboard, type MermaidImporter } from '../src/whiteboard-webmcp';
import { ExcalidrawStore } from '../src/excalidraw-store';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

function fixture() {
  const remote = new WhiteboardStore(() => {}, 'bob');
  const published: BoardElement[] = [];
  const store = new WhiteboardStore(element => { published.push(element); remote.merge(element); }, 'alice');
  const run = (input: unknown) => editWhiteboard(store, input);
  const edit = (...operations: unknown[]) => run({ action: 'edit', operations });
  return { store, remote, published, run, edit };
}
const node = (id: string, x = 0) => ({ op: 'create', id, kind: 'rectangle', x, y: 0, text: '中文段落\nSecond line' });

describe('whiteboard WebMCP operations', () => {
  it('creates every shape kind, connects nodes in one batch, and publishes to participants', () => {
    const { store, remote, run, edit } = fixture();
    const result = edit(
      node('start'), { ...node('decision', 400), kind: 'diamond' }, { ...node('note', 600), kind: 'note' },
      { ...node('text', 700), kind: 'text' },
      { op: 'create', id: 'ink', kind: 'pen', x: 5, y: 10, points: [[0, 0], [100, 100]] },
      { op: 'create', id: 'edge', kind: 'connector', x: 0, y: 0, from: 'start', to: 'decision' },
    );
    expect(result).toMatchObject({ ok: true, shared: true, count: 6, canUndo: true, canRedo: false });
    expect(remote.snapshot()).toEqual(store.snapshot());
    expect(run({ action: 'read', limit: 2 })).toMatchObject({ nextOffset: 2, hasMore: true, count: 6 });
    expect(run({ action: 'read', offset: 4, limit: 2 })).toMatchObject({ nextOffset: 6, hasMore: false });
  });

  it('keeps text bound to its node when moving and resizing, then undoes as one transaction', () => {
    const { store, remote, run, edit } = fixture();
    edit(node('shape'));
    edit({ op: 'update', id: 'shape', text: '長文'.repeat(250), x: -150, y: 600, width: 360, height: 240 });
    expect(store.snapshot()).toHaveLength(1);
    expect(store.get('shape')).toMatchObject({ id: 'shape', x: -150, y: 600, width: 360, height: 240, text: '長文'.repeat(250) });
    expect(remote.snapshot()).toEqual(store.snapshot());
    run({ action: 'undo' });
    expect(store.get('shape')).toMatchObject({ x: 0, y: 0, width: 180, text: '中文段落\nSecond line' });
    run({ action: 'redo' });
    expect(store.get('shape')?.text).toHaveLength(500);
    expect(remote.snapshot()).toEqual(store.snapshot());
  });

  it('deletes connected edges and restores the node and edge in a single undo', () => {
    const { store, remote, edit, run } = fixture();
    edit(node('a'), node('b'), { op: 'create', id: 'edge', kind: 'connector', x: 0, y: 0, from: 'a', to: 'b' });
    const deletion = edit({ op: 'delete', id: 'a' });
    expect(deletion.changedIds).toEqual(['a', 'edge']);
    expect(store.snapshot().map(e => e.id)).toEqual(['b']);
    run({ action: 'undo' });
    expect(store.snapshot().map(e => e.id)).toEqual(['a', 'b', 'edge']);
    expect(remote.snapshot()).toEqual(store.snapshot());
  });

  it('does not undo a newer collaborator edit', () => {
    const { store, edit, run } = fixture();
    edit(node('a'));
    const a = store.get('a')!;
    store.merge({ ...a, text: 'Bob’s latest edit', actor: 'bob', clock: a.clock + 10 });
    expect(run({ action: 'undo' }).changedIds).toEqual([]);
    expect(store.get('a')?.text).toBe('Bob’s latest edit');
  });

  it('validates the complete batch before creating or publishing anything', () => {
    const { store, published, edit } = fixture();
    expect(() => edit(node('valid'), { ...node('bad'), text: 'x'.repeat(501) })).toThrow('Invalid shape');
    expect(store.size).toBe(0);
    expect(published).toEqual([]);
    expect(() => edit(node('a'), { op: 'create', id: 'edge', kind: 'connector', x: 0, y: 0, from: 'a', to: 'missing' })).toThrow('endpoints');
    expect(store.size).toBe(0);
  });

  it('rejects malformed operations, extra fields, oversized batches and out-of-range geometry', () => {
    const { store, run, edit } = fixture();
    for (const input of [null, [], {}, { action: 'reset' }, { action: 'undo', operations: [] }, { action: 'read', limit: 101 }, { action: 'read', offset: -1 }, { action: 'edit', operations: [] }, { action: 'edit', operations: Array.from({ length: 51 }, (_, i) => node(`n${i}`)) }]) {
      expect(() => run(input)).toThrow();
    }
    for (const operation of [
      { ...node('a'), x: Infinity }, { ...node('a'), x: 20_001 }, { ...node('a'), y: NaN },
      { ...node('a'), width: 19 }, { ...node('a'), height: 1201 }, { ...node('a'), color: 'red' },
      { ...node('a'), deleted: true }, { ...node('a'), id: '<script>' }, { ...node('a'), kind: 'unknown' },
      { ...node('a'), points: [[0, 1], [2, 3]] }, { ...node('a'), from: 'b' },
      { ...node('a'), kind: 'pen', points: [[0, 0]] },
      { ...node('a'), kind: 'pen', points: Array.from({ length: 257 }, () => [0, 0]) },
      { op: 'update', id: 'missing', x: 50 }, { op: 'erase', id: 'a' },
    ]) expect(() => edit(operation)).toThrow();
    expect(store.size).toBe(0);
  });

  it('rejects duplicate or deleted ids and connectors targeting pen strokes', () => {
    const { edit } = fixture();
    edit(node('a'));
    expect(() => edit(node('a'))).toThrow('already exists');
    expect(() => edit({ op: 'update', id: 'a' })).toThrow('at least one');
    edit({ op: 'delete', id: 'a' });
    expect(() => edit(node('a'))).toThrow('already exists');
    expect(() => edit({ op: 'update', id: 'a', text: 'hidden' })).toThrow('No visible');
    edit(node('b'), { ...node('ink'), kind: 'pen', points: [[0, 0], [10, 10]] });
    expect(() => edit({ op: 'create', id: 'edge', kind: 'connector', x: 0, y: 0, from: 'b', to: 'ink' })).toThrow('endpoints');
  });
});

// The adapter tests inject a deterministic converter. Actual Excalidraw layout and screenshots
// are exercised through the browser tools; this worker test runtime has no DOM/font canvas.
const convertFixture: typeof import('@excalidraw/excalidraw')['convertToExcalidrawElements'] = (skeletons) => {
  const result = (skeletons ?? []).map(raw => ({
    id: 'fixture', x: 0, y: 0, width: 180, height: 90, angle: 0, strokeColor: '#343a40', backgroundColor: '#f6d878',
    fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, roundness: null, seed: 1, version: 1, versionNonce: 1,
    index: null, isDeleted: false, groupIds: [], frameId: null, boundElements: [], updated: 1, link: null, locked: false, ...raw,
  })) as unknown as Array<Record<string, unknown>>;
  const labels: Record<string, unknown>[] = [];
  for (const element of result) {
    const label = element['label'] as { id?: string; text: string } | undefined;
    if (label?.text) {
      const labelId = label.id ?? `${element['id'] as string}_label`;
      labels.push({ ...element, ...label, id: labelId, type: 'text', text: label.text, originalText: label.text,
        x: (element['x'] as number) + 10, y: (element['y'] as number) + 10, width: (element['width'] as number) - 20,
        height: 25, fontSize: 20, fontFamily: 2, textAlign: 'center', verticalAlign: 'middle', containerId: element['id'], autoResize: true, lineHeight: 1.25, boundElements: null });
      (element['boundElements'] as unknown[]).push({ id: labelId, type: 'text' });
    }
    if (element['type'] === 'arrow') {
      element['lastCommittedPoint'] = null;
      for (const end of ['start', 'end']) {
        const endpoint = element[end] as { id: string } | undefined;
        if (!endpoint) continue;
        element[`${end}Binding`] = { elementId: endpoint.id, focus: 0, gap: 1 };
        const node = result.find(candidate => candidate['id'] === endpoint.id)!;
        node['boundElements'] = [...(node['boundElements'] as unknown[]), { id: element['id'], type: 'arrow' }];
      }
    }
  }
  return [...result, ...labels] as unknown as ReturnType<typeof import('@excalidraw/excalidraw')['convertToExcalidrawElements']>;
};

describe('native Excalidraw WebMCP adapter', () => {
  function nativeFixture() {
    const remote = new ExcalidrawStore(() => {}), store = new ExcalidrawStore(element => { remote.merge(element); });
    const run = (input: unknown) => editExcalidrawWhiteboard(store, input, convertFixture);
    const edit = (...operations: unknown[]) => run({ action: 'edit', operations });
    return { store, remote, run, edit };
  }

  it('preserves native label ids, binding and relative position when editing a node', async () => {
    const { store, remote, edit } = nativeFixture();
    await edit(node('a'));
    const labelId = store.get('a')!.boundElements!.find(element => element.type === 'text')!.id;
    await edit({ op: 'update', id: 'a', x: 350, y: 220, width: 300, text: '長文字'.repeat(160) });
    expect(store.get(labelId)).toMatchObject({ containerId: 'a', x: 360, y: 230, originalText: '長文字'.repeat(160), isDeleted: false });
    expect(store.snapshot().filter(element => !element.isDeleted)).toHaveLength(2);
    expect(store.get('a')!.boundElements).toEqual([{ id: labelId, type: 'text' }]);
    expect(remote.snapshot()).toEqual(store.snapshot());
    await expect(edit({ op: 'update', id: labelId, text: 'detached' })).rejects.toThrow('bound to a');
  });

  it('creates native arrow bindings and removes the node, label and connected arrow together', async () => {
    const { store, remote, run, edit } = nativeFixture();
    await edit(node('a'), node('b', 400), { op: 'create', id: 'edge', kind: 'connector', x: 0, y: 0, from: 'a', to: 'b' });
    expect(store.get('edge')).toMatchObject({ type: 'arrow', startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } });
    const labelId = store.get('a')!.boundElements!.find(element => element.type === 'text')!.id;
    await edit({ op: 'delete', id: 'a' });
    for (const id of ['a', labelId, 'edge']) expect(store.get(id)!.isDeleted).toBe(true);
    expect(store.get('b')!.boundElements).not.toContainEqual({ type: 'arrow', id: 'edge' });
    await run({ action: 'undo' });
    expect(store.get('edge')!.isDeleted).toBe(false);
    expect(store.get(labelId)!.isDeleted).toBe(false);
    expect(remote.snapshot()).toEqual(store.snapshot());
  });

  it('clears a bound label without leaving a detached text object', async () => {
    const { store, edit } = nativeFixture();
    await edit(node('a'));
    await edit({ op: 'update', id: 'a', text: '' });
    expect(store.get('a')!.boundElements).toEqual([]);
    expect(store.snapshot().filter(element => !element.isDeleted).map(element => element.id)).toEqual(['a']);
  });

  it('rejects invalid native batches without publishing and returns native read pages', async () => {
    const { store, run, edit } = nativeFixture();
    await expect(edit(node('a'), { ...node('bad'), text: 'x'.repeat(501) })).rejects.toThrow();
    expect(store.size).toBe(0);
    await edit(node('a'));
    expect(await run({ action: 'read', limit: 1 })).toMatchObject({ count: 2, nextOffset: 1, hasMore: true });
    await expect(run({ action: 'read', limit: null })).rejects.toThrow();
  });

  it('moves existing long-label and large native nodes without truncating untouched fields', async () => {
    const { store, edit } = nativeFixture();
    const native = convertFixture([{ type: 'rectangle', id: 'large', x: 0, y: 0, width: 1500, height: 1700, label: { text: '長文'.repeat(600) } }], { regenerateIds: false });
    expect(store.commit(native)).toBe(true);
    await edit({ op: 'update', id: 'large', x: 200, y: 400 });
    expect(store.get('large')).toMatchObject({ x: 200, y: 400, width: 1500, height: 1700 });
    expect(store.get('large_label')).toMatchObject({ originalText: '長文'.repeat(600), containerId: 'large' });
  });

  it('keeps connector labels when moving their endpoint node', async () => {
    const { store, edit } = nativeFixture();
    await edit(node('a'), node('b', 400), { op: 'create', id: 'edge', kind: 'connector', x: 0, y: 0, from: 'a', to: 'b', text: '條件成立' });
    const labelId = store.get('edge')!.boundElements!.find(element => element.type === 'text')!.id;
    await edit({ op: 'update', id: 'b', x: 600, y: 300 });
    expect(store.get(labelId)).toMatchObject({ containerId: 'edge', originalText: '條件成立', isDeleted: false });
    expect(store.get('edge')!.boundElements).toContainEqual({ id: labelId, type: 'text' });
  });
});

describe('Mermaid import transaction', () => {
  const source = 'flowchart TD\n A[開始] --> B{是否有效}\n B -->|是| C[完成]';
  const skeleton = [{ type: 'rectangle' as const, id: 'a', x: 10, y: 20, width: 180, height: 90, groupIds: ['subgraph_shared'], label: { text: '開始', groupIds: ['subgraph_shared'] } }];
  function importer(parse: MermaidImporter['parse'] = async () => ({ elements: skeleton })): MermaidImporter {
    return {
      parse,
      convert(elements) {
        const suffix = crypto.randomUUID();
        return convertFixture(elements?.map(element => ({ ...element, id: `${element.id ?? 'generated'}_${suffix}` })) ?? [], { regenerateIds: false });
      },
      restore(elements) { return (elements ?? []) as ReturnType<MermaidImporter['restore']>; },
    };
  }

  it('adds positioned editable records, shares them, preserves existing content and isolates repeated import groups', async () => {
    const remote = new ExcalidrawStore(() => {}), store = new ExcalidrawStore(element => { remote.merge(element); });
    store.commit(convertFixture([{ type: 'rectangle', id: 'existing', x: 5, y: 8 }], { regenerateIds: false }));
    const prior = structuredClone(store.get('existing'));
    const result = await importMermaidWhiteboard(store, { action: 'mermaid', source, x: 500, y: 600 }, importer());
    expect(result).toMatchObject({ action: 'mermaid', imported: 2, sourceKind: 'mermaid-flowchart', count: 3 });
    expect(result.elements[0]).toMatchObject({ x: 500, y: 600, type: 'rectangle' });
    expect(store.get('existing')).toEqual(prior);
    const another = await importMermaidWhiteboard(store, { action: 'mermaid', source }, importer());
    expect(another.changedIds.every(id => !result.changedIds.includes(id))).toBe(true);
    const firstGroup = (result.elements[0] as ExcalidrawElement).groupIds[0];
    const secondGroup = (another.elements[0] as ExcalidrawElement).groupIds[0];
    expect(firstGroup).not.toBe(secondGroup);
    expect(remote.snapshot()).toEqual(store.snapshot());
    store.undo();
    expect(store.snapshot().filter(element => !element.isDeleted)).toHaveLength(3);
  });

  it('does not mutate the store on syntax failure, unsupported bitmap fallback or oversized output', async () => {
    const store = new ExcalidrawStore(() => {});
    await expect(importMermaidWhiteboard(store, { action: 'mermaid', source }, importer(async () => { throw new Error('Unexpected token'); }))).rejects.toThrow('could not be parsed');
    expect(store.size).toBe(0);
    await expect(importMermaidWhiteboard(store, { action: 'mermaid', source }, importer(async () => ({ elements: skeleton, files: { svg: {} } })))).rejects.toThrow('image fallback');
    await expect(importMermaidWhiteboard(store, { action: 'mermaid', source }, importer(async () => ({ elements: Array.from({ length: 301 }, () => skeleton[0]!) })))).rejects.toThrow('1–300');
    expect(store.size).toBe(0);
  });

  it('retains a collaborator’s edit received during asynchronous parsing', async () => {
    const store = new ExcalidrawStore(() => {});
    const parser = importer(async () => {
      store.merge(convertFixture([{ type: 'rectangle', id: 'arrived', x: 10, y: 20 }], { regenerateIds: false })[0]!);
      return { elements: skeleton };
    });
    await importMermaidWhiteboard(store, { action: 'mermaid', source }, parser);
    expect(store.get('arrived')!.isDeleted).toBe(false);
    expect(store.size).toBe(3);
  });

  it('rejects invalid source and unsupported options before calling the parser', async () => {
    const store = new ExcalidrawStore(() => {});
    let calls = 0;
    const parser = importer(async () => { calls++; return { elements: skeleton }; });
    for (const input of [
      { source: '' }, { source: 'x'.repeat(12_001) }, { source: 'sequenceDiagram\n A->>B: hello' },
      { source: 'flowchart TD\n%%{init: {}}%%\n A-->B' }, { source: 'flowchart TD\n A[<img src="x">]' },
      { source: 'flowchart LR\n subgraph P[Planning]\n A-->B\n end' },
      { source, x: Infinity }, { source, y: 20_001 }, { source, x: null }, { source, replace: true },
    ]) await expect(importMermaidWhiteboard(store, { action: 'mermaid', ...input }, parser)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(store.size).toBe(0);
  });
});
