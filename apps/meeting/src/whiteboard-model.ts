/** Bounded shape model for planning WebMCP edits before conversion to native Excalidraw records. */
export const BOARD_COLORS = ['#f6d878', '#f4a27e', '#97d9b7', '#98bde8', '#c4ace8', '#f3eee3'] as const;
export type BoardKind = 'note' | 'rectangle' | 'diamond' | 'text' | 'pen' | 'connector';
export interface BoardShape {
  id: string;
  kind: BoardKind;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text: string;
  points: [number, number][];
  from: string;
  to: string;
  deleted: boolean;
}
export interface BoardElement extends BoardShape { clock: number; actor: string }
const ID = /^[a-zA-Z0-9_-]{1,64}$/u;
const KINDS = new Set(['note', 'rectangle', 'diamond', 'text', 'pen', 'connector']);
export const MAX_BOARD_RECORDS = 1_000;
const coordinate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 20_000;
export const clampBoard = (v: number): number => Math.round(Math.min(20_000, Math.max(-20_000, v)) * 10) / 10;

export function parseBoardElement(value: unknown): BoardElement | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v['id'] !== 'string' || !ID.test(v['id']) || typeof v['actor'] !== 'string' || !ID.test(v['actor'])) return null;
  if (!Number.isSafeInteger(v['clock']) || (v['clock'] as number) < 1 || (v['clock'] as number) > 1e12) return null;
  if (!KINDS.has(v['kind'] as string) || typeof v['deleted'] !== 'boolean') return null;
  if (!coordinate(v['x']) || !coordinate(v['y'])) return null;
  if (typeof v['width'] !== 'number' || v['width'] < 20 || v['width'] > 1200 || !Number.isFinite(v['width'])) return null;
  if (typeof v['height'] !== 'number' || v['height'] < 20 || v['height'] > 1200 || !Number.isFinite(v['height'])) return null;
  if (typeof v['color'] !== 'string' || !(BOARD_COLORS as readonly string[]).includes(v['color'])) return null;
  if (typeof v['text'] !== 'string' || v['text'].length > 500) return null;
  if (typeof v['from'] !== 'string' || (v['from'] && !ID.test(v['from'])) || typeof v['to'] !== 'string' || (v['to'] && !ID.test(v['to']))) return null;
  if (v['kind'] === 'connector' && (!v['from'] || !v['to'] || v['from'] === v['to'])) return null;
  if (!Array.isArray(v['points']) || v['points'].length > 256) return null;
  if (v['points'].some(p => !Array.isArray(p) || p.length !== 2 || !coordinate(p[0]) || !coordinate(p[1]))) return null;
  return {
    id: v['id'], actor: v['actor'], clock: v['clock'] as number, kind: v['kind'] as BoardKind,
    x: v['x'], y: v['y'], width: v['width'], height: v['height'], color: v['color'], text: v['text'],
    from: v['from'], to: v['to'], deleted: v['deleted'], points: v['points'].map(p => [p[0], p[1]]),
  };
}
const sameVersion = (a: BoardElement | undefined, b: BoardElement) => a?.clock === b.clock && a.actor === b.actor;
interface Change { before: BoardElement | undefined; after: BoardElement }

export class WhiteboardStore {
  readonly actor: string;
  #clock = 0;
  #records = new Map<string, BoardElement>();
  #snapshot: BoardElement[] = [];
  #listeners = new Set<() => void>();
  #undo: Change[][] = [];
  #redo: Change[][] = [];
  constructor(private publish: (element: BoardElement) => void, actor: string = crypto.randomUUID()) { this.actor = actor; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  snapshot = (): BoardElement[] => this.#snapshot;
  records = (): BoardElement[] => [...this.#records.values()];
  get canUndo(): boolean { return this.#undo.length > 0; }
  get canRedo(): boolean { return this.#redo.length > 0; }
  get size(): number { return this.#records.size; }
  get(id: string): BoardElement | undefined { return this.#records.get(id); }
  #notify(): void {
    this.#snapshot = [...this.#records.values()].filter(e => !e.deleted).sort((a, b) => a.id < b.id ? -1 : 1);
    for (const listener of this.#listeners) listener();
  }
  merge(element: BoardElement): void {
    const current = this.#records.get(element.id);
    if (!current && this.size >= MAX_BOARD_RECORDS) return;
    this.#clock = Math.max(this.#clock, element.clock);
    if (current && (current.clock > element.clock || (current.clock === element.clock && current.actor >= element.actor))) return;
    this.#records.set(element.id, element);
    this.#notify();
  }
  commit(shapes: BoardShape[]): void {
    const changes: Change[] = [];
    for (const shape of shapes) {
      const before = this.#records.get(shape.id);
      if (!before && this.size >= MAX_BOARD_RECORDS) continue;
      const after = parseBoardElement({ ...shape, clock: ++this.#clock, actor: this.actor });
      if (!after) continue;
      this.#records.set(after.id, after);
      changes.push({ before, after });
      this.publish(after);
    }
    if (!changes.length) return;
    this.#undo.push(changes);
    if (this.#undo.length > 100) this.#undo.shift();
    this.#redo = [];
    this.#notify();
  }
  #reverse(source: Change[][], target: Change[][]): void {
    const changes = source.pop();
    if (!changes) return;
    const inverse: Change[] = [];
    for (const change of changes) {
      const current = this.#records.get(change.after.id);
      // Undo only our own unchanged edit; never overwrite a collaborator's newer edit.
      if (!sameVersion(current, change.after)) continue;
      const after: BoardElement = { ...(change.before ?? { ...change.after, deleted: true }), clock: ++this.#clock, actor: this.actor };
      this.#records.set(after.id, after);
      inverse.push({ before: current, after });
      this.publish(after);
    }
    if (inverse.length) target.push(inverse);
    this.#notify();
  }
  undo = (): void => this.#reverse(this.#undo, this.#redo);
  redo = (): void => this.#reverse(this.#redo, this.#undo);
  reset(): void { this.#records.clear(); this.#undo = []; this.#redo = []; this.#clock = 0; this.#notify(); }
}

export function newBoardShape(kind: BoardKind, x: number, y: number, color: string): BoardShape {
  return { id: crypto.randomUUID(), kind, x: clampBoard(x), y: clampBoard(y), width: 180, height: kind === 'note' ? 150 : 90, color, text: '', points: [], from: '', to: '', deleted: false };
}

/** Route through cardinal ports, with a nonzero final segment for arrow orientation. */
