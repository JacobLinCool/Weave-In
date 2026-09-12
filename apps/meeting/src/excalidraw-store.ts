import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

export const MAX_EXCALIDRAW_ELEMENTS = 1_000;
const MAX_FRAME_BYTES = 16_384;
const ID = /^[a-zA-Z0-9_-]{1,100}$/u;
const TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'freedraw', 'text', 'frame']);
const BASE_KEYS = ['id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'roundness', 'seed', 'version', 'versionNonce', 'index', 'isDeleted', 'groupIds', 'frameId', 'boundElements', 'updated', 'link', 'locked'];
const EXTRA_KEYS: Record<string, string[]> = {
  text: ['fontSize', 'fontFamily', 'text', 'textAlign', 'verticalAlign', 'containerId', 'originalText', 'autoResize', 'lineHeight'],
  line: ['points', 'lastCommittedPoint', 'startBinding', 'endBinding', 'startArrowhead', 'endArrowhead'],
  arrow: ['points', 'lastCommittedPoint', 'startBinding', 'endBinding', 'startArrowhead', 'endArrowhead', 'elbowed', 'fixedSegments', 'startIsSpecial', 'endIsSpecial'],
  freedraw: ['points', 'pressures', 'simulatePressure', 'lastCommittedPoint'],
  frame: ['name'],
};
const ARROWHEADS = new Set(['arrow', 'bar', 'dot', 'circle', 'circle_outline', 'triangle', 'triangle_outline', 'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many']);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => number(v, min, max) && Number.isSafeInteger(v);
const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const nullableId = (v: unknown) => v === null || id(v);
const point = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(n => number(n, -1e6, 1e6));
const color = (v: unknown) => typeof v === 'string' && /^(?:transparent|#[0-9a-f]{3,8})$/iu.test(v);
const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const choice = (v: unknown, choices: unknown[]) => choices.includes(v);
function binding(v: unknown): boolean {
  // Native bindings may use null for a non-fixed point. Elbow endpoints can lie
  // just outside a shape, so their normalized ratios are not restricted to 0..1.
  // The native focus calculation also returns an unclamped distance ratio.
  return v === null || (record(v) && id(v['elementId']) && number(v['focus'], -1e6, 1e6) && number(v['gap'], 0, 1e6)
    && (v['fixedPoint'] === undefined || v['fixedPoint'] === null || point(v['fixedPoint'])));
}

/** Validate native scene records without importing the browser-only Excalidraw runtime. */
export function parseExcalidrawElement(value: unknown): ExcalidrawElement | null {
  if (!record(value) || !TYPES.has(value['type'] as string)) return null;
  const v = value;
  const minDimension = choice(v['type'], ['line', 'arrow', 'freedraw']) ? -1e6 : 0;
  if (!id(v['id']) || !number(v['x'], -1e6, 1e6) || !number(v['y'], -1e6, 1e6)
    || !number(v['width'], minDimension, 1e6) || !number(v['height'], minDimension, 1e6) || !number(v['angle'], -100, 100)) return null;
  if (!color(v['strokeColor']) || !color(v['backgroundColor']) || !choice(v['fillStyle'], ['hachure', 'cross-hatch', 'solid', 'zigzag'])
    || !choice(v['strokeStyle'], ['solid', 'dashed', 'dotted']) || !number(v['strokeWidth'], 0, 100)
    || !number(v['roughness'], 0, 10) || !number(v['opacity'], 0, 100)) return null;
  if (!integer(v['seed'], 0, 2 ** 32 - 1) || !integer(v['version'], 1, 1e12) || !integer(v['versionNonce'], 0, 2 ** 32 - 1)
    || !integer(v['updated'], 0) || typeof v['isDeleted'] !== 'boolean' || typeof v['locked'] !== 'boolean') return null;
  if (!(v['index'] === null || (typeof v['index'] === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,127}$/u.test(v['index'])))
    || !Array.isArray(v['groupIds']) || v['groupIds'].length > 100 || !v['groupIds'].every(id) || !nullableId(v['frameId'])) return null;
  if (!(v['roundness'] === null || (record(v['roundness']) && choice(v['roundness']['type'], [1, 2, 3])
    && (v['roundness']['value'] === undefined || number(v['roundness']['value'], 0, 1e6))))) return null;
  if (!(v['boundElements'] === null || (Array.isArray(v['boundElements']) && v['boundElements'].length <= MAX_EXCALIDRAW_ELEMENTS
    && v['boundElements'].every(b => record(b) && id(b['id']) && choice(b['type'], ['text', 'arrow']))))) return null;
  if (!(v['link'] === null || (typeof v['link'] === 'string' && v['link'].length <= 2048 && /^(?:https?:\/\/|mailto:|#)/iu.test(v['link'])))) return null;
  if (v['type'] === 'text' && (!text(v['text'], 4000) || !text(v['originalText'], 4000) || !number(v['fontSize'], 1, 1000)
    || !integer(v['fontFamily'], 1, 100) || !choice(v['textAlign'], ['left', 'center', 'right'])
    || !choice(v['verticalAlign'], ['top', 'middle', 'bottom']) || !nullableId(v['containerId'])
    || typeof v['autoResize'] !== 'boolean' || !number(v['lineHeight'], .1, 10))) return null;
  if (choice(v['type'], ['line', 'arrow', 'freedraw'])) {
    if (!Array.isArray(v['points']) || v['points'].length > 2000 || !v['points'].every(point)
      || !(v['lastCommittedPoint'] === null || point(v['lastCommittedPoint']))) return null;
  }
  if (choice(v['type'], ['line', 'arrow'])) {
    if (!binding(v['startBinding']) || !binding(v['endBinding'])
      || !(v['startArrowhead'] === null || ARROWHEADS.has(v['startArrowhead'] as string))
      || !(v['endArrowhead'] === null || ARROWHEADS.has(v['endArrowhead'] as string))) return null;
    if (v['type'] === 'arrow' && typeof v['elbowed'] !== 'boolean') return null;
    if (v['fixedSegments'] !== undefined && !(v['fixedSegments'] === null || (Array.isArray(v['fixedSegments']) && v['fixedSegments'].length <= 100
      && v['fixedSegments'].every(s => record(s) && point(s['start']) && point(s['end']) && integer(s['index'], 0, 2000))))) return null;
    for (const key of ['startIsSpecial', 'endIsSpecial']) if (v[key] !== undefined && v[key] !== null && typeof v[key] !== 'boolean') return null;
  }
  if (v['type'] === 'freedraw' && (!Array.isArray(v['pressures']) || v['pressures'].length > 2000
    || !v['pressures'].every(p => number(p, 0, 1)) || typeof v['simulatePressure'] !== 'boolean')) return null;
  if (v['type'] === 'frame' && !(v['name'] === null || text(v['name'], 200))) return null;
  // Clone only native rendering fields; customData and unknown payloads never enter the scene.
  const clean = Object.fromEntries([...BASE_KEYS, ...(EXTRA_KEYS[v['type'] as string] ?? [])]
    .filter(key => v[key] !== undefined).map(key => [key, v[key]]));
  try {
    const encoded = JSON.stringify({ type: 'excalidraw', element: clean });
    if (new TextEncoder().encode(encoded).byteLength > MAX_FRAME_BYTES) return null;
    return JSON.parse(encoded).element as ExcalidrawElement;
  } catch { return null; }
}

const sameVersion = (a: ExcalidrawElement | undefined, b: ExcalidrawElement) => a?.version === b.version && a.versionNonce === b.versionNonce;
// This is Excalidraw 0.18's reconciliation rule: lower nonce wins an equal-version conflict.
const newer = (incoming: ExcalidrawElement, current: ExcalidrawElement | undefined) => !current
  || incoming.version > current.version || (incoming.version === current.version && incoming.versionNonce < current.versionNonce);
interface Change { before: ExcalidrawElement | undefined; after: ExcalidrawElement }

export class ExcalidrawStore {
  #records = new Map<string, ExcalidrawElement>();
  #snapshot: readonly ExcalidrawElement[] = [];
  #listeners = new Set<() => void>();
  #undo: Change[][] = [];
  #redo: Change[][] = [];
  constructor(private publish: (element: ExcalidrawElement) => void) {}
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  snapshot = (): readonly ExcalidrawElement[] => this.#snapshot;
  records = (): readonly ExcalidrawElement[] => this.#snapshot;
  get = (elementId: string): ExcalidrawElement | undefined => this.#records.get(elementId);
  get size(): number { return this.#records.size; }
  get canUndo(): boolean { return this.#undo.length > 0; }
  get canRedo(): boolean { return this.#redo.length > 0; }
  #notify(): void {
    this.#snapshot = [...this.#records.values()].sort((a, b) => {
      const ai = a.index ?? '', bi = b.index ?? '';
      return ai === bi ? (a.id < b.id ? -1 : a.id === b.id ? 0 : 1) : ai < bi ? -1 : 1;
    });
    for (const listener of this.#listeners) listener();
  }
  merge = (incoming: ExcalidrawElement): boolean => {
    const element = parseExcalidrawElement(incoming);
    if (!element) return false;
    const current = this.#records.get(element.id);
    if (!current && this.size >= MAX_EXCALIDRAW_ELEMENTS) return false;
    if (!newer(element, current)) return true;
    this.#records.set(element.id, element); this.#notify(); return true;
  };
  /** Native onChange snapshots include deletion tombstones; absence alone is not deletion. */
  update = (elements: readonly ExcalidrawElement[]): boolean => {
    const parsed = elements.map(parseExcalidrawElement);
    if (parsed.some(e => !e)) return false;
    const valid = parsed as ExcalidrawElement[];
    const ids = new Set([...this.#records.keys(), ...valid.map(e => e.id)]);
    if (ids.size > MAX_EXCALIDRAW_ELEMENTS || new Set(valid.map(e => e.id)).size !== valid.length) return false;
    const changes: Change[] = valid.flatMap(after => {
      const before = this.#records.get(after.id);
      return newer(after, before) ? [{ before, after }] : [];
    });
    if (!changes.length) return true;
    for (const { after } of changes) this.#records.set(after.id, after);
    this.#undo.push(changes); if (this.#undo.length > 100) this.#undo.shift(); this.#redo = [];
    for (const { after } of changes) this.publish(after);
    this.#notify(); return true;
  };
  commit = (elements: readonly ExcalidrawElement[]): boolean => this.update(elements);
  #reverse(source: Change[][], target: Change[][]): void {
    const changes = source.pop();
    if (!changes) return;
    // A native edit may contain a container, its bound label and arrow ports.
    // Reverting only part after a collaborator edit can orphan those bindings.
    if (changes.some(change => !sameVersion(this.#records.get(change.after.id), change.after))) {
      this.#notify(); return;
    }
    const inverse: Change[] = [];
    for (const change of changes) {
      const current = this.#records.get(change.after.id);
      const after = parseExcalidrawElement({ ...(change.before ?? { ...change.after, isDeleted: true }),
        version: current!.version + 1, versionNonce: crypto.getRandomValues(new Uint32Array(1))[0]! >>> 1, updated: Date.now() });
      if (!after) { this.#notify(); return; }
      inverse.push({ before: current, after });
    }
    for (const { after } of inverse) this.#records.set(after.id, after);
    if (inverse.length) target.push(inverse);
    for (const { after } of inverse) this.publish(after);
    this.#notify();
  }
  undo = (): void => this.#reverse(this.#undo, this.#redo);
  redo = (): void => this.#reverse(this.#redo, this.#undo);
  reset = (): void => { this.#records.clear(); this.#undo = []; this.#redo = []; this.#notify(); };
}
