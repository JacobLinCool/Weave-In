import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';
import { MAX_EXCALIDRAW_ELEMENTS, parseExcalidrawElement } from './excalidraw-store';
import { BOARD_COLORS, MAX_BOARD_RECORDS, newBoardShape, parseBoardElement, WhiteboardStore, type BoardElement, type BoardKind, type BoardShape } from './whiteboard-model';

export const MAX_WHITEBOARD_OPERATIONS = 50;
export const MAX_WHITEBOARD_READ = 100;
export const MAX_MERMAID_SOURCE = 12_000;
export const MAX_MERMAID_ELEMENTS = 300;
const ID = /^[a-zA-Z0-9_-]{1,64}$/u;
const KINDS = ['note', 'rectangle', 'diamond', 'text', 'pen', 'connector'];
const FIELDS = ['x', 'y', 'width', 'height', 'color', 'text', 'points', 'from', 'to'];
const numberSchema = { type: 'number', minimum: -20_000, maximum: 20_000 };
const fieldsSchema = {
  x: numberSchema,
  y: numberSchema,
  width: { type: 'number', minimum: 20, maximum: 1200 },
  height: { type: 'number', minimum: 20, maximum: 1200 },
  color: { type: 'string', enum: BOARD_COLORS },
  text: { type: 'string', maxLength: 500 },
  points: { type: 'array', minItems: 2, maxItems: 256, items: { type: 'array', minItems: 2, maxItems: 2, items: numberSchema }, description: 'Pen coordinates relative to this stroke’s x and y.' },
  from: { type: 'string', pattern: ID.source, description: 'Connector source node id.' },
  to: { type: 'string', pattern: ID.source, description: 'Connector destination node id.' },
};
const idSchema = { type: 'string', pattern: ID.source };

export const WHITEBOARD_EDIT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['read', 'edit', 'mermaid', 'undo', 'redo'] },
    source: { type: 'string', minLength: 1, maxLength: MAX_MERMAID_SOURCE, description: 'Mermaid only: a flowchart or graph definition, with native editable nodes, labels and arrows. No markdown fences, initialization directives or images.' },
    x: { ...numberSchema, description: 'Mermaid only: left edge of the imported diagram. Defaults to the right of existing content.' },
    y: { ...numberSchema, description: 'Mermaid only: top edge of the imported diagram. Defaults to the top of existing content, or zero.' },
    offset: { type: 'integer', minimum: 0, description: 'Read only: starting index in the current board snapshot.' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_WHITEBOARD_READ, default: MAX_WHITEBOARD_READ, description: 'Read only: page size. Read again after editing; indices can change.' },
    operations: {
      type: 'array', minItems: 1, maxItems: MAX_WHITEBOARD_OPERATIONS,
      items: { oneOf: [
        { type: 'object', properties: { op: { const: 'create' }, id: idSchema, kind: { type: 'string', enum: KINDS }, ...fieldsSchema }, required: ['op', 'kind', 'x', 'y'], additionalProperties: false },
        { type: 'object', properties: { op: { const: 'update' }, id: idSchema, ...fieldsSchema }, required: ['op', 'id'], additionalProperties: false },
        { type: 'object', properties: { op: { const: 'delete' }, id: idSchema }, required: ['op', 'id'], additionalProperties: false },
      ] },
      description: 'Edit only: validated together and committed as one undo step. Supply create ids to reference new nodes in same-batch connectors. Deleting a node also deletes its connectors.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

export interface WhiteboardEditResult {
  ok: true;
  shared: true;
  action: 'read' | 'edit' | 'mermaid' | 'undo' | 'redo';
  count: number;
  elements: Array<BoardElement | ExcalidrawElement>;
  changedIds: string[];
  canUndo: boolean;
  canRedo: boolean;
  nextOffset?: number;
  hasMore?: boolean;
  imported?: number;
  sourceKind?: 'mermaid-flowchart';
}

export interface ExcalidrawToolStore {
  snapshot(): readonly ExcalidrawElement[];
  commit(elements: readonly ExcalidrawElement[]): boolean;
  undo(): void;
  redo(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}
type ConvertElements = typeof import('@excalidraw/excalidraw')['convertToExcalidrawElements'];
function assertAuthorized(authorized: () => boolean): void {
  if (!authorized()) throw new Error('This whiteboard action is no longer authorized. Nothing was changed.');
}
export interface MermaidImporter {
  parse(source: string): Promise<{ elements: ExcalidrawElementSkeleton[]; files?: Record<string, unknown> }>;
  convert: ConvertElements;
  restore: typeof import('@excalidraw/excalidraw')['restoreElements'];
}

function validateMermaidInput(args: Record<string, unknown>): { source: string; x?: number; y?: number } {
  onlyKeys(args, ['action', 'source', 'x', 'y']);
  if (typeof args['source'] !== 'string' || !args['source'].trim() || args['source'].length > MAX_MERMAID_SOURCE) throw new Error('`source` must contain 1–12000 characters of Mermaid flowchart syntax.');
  const source = args['source'].trim();
  const definition = source.replace(/^\s*%%[^\n]*$/gmu, '').trimStart();
  if (!/^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)(?:\s|;|$)/u.test(definition)) throw new Error('Only Mermaid flowchart or graph diagrams are supported. Start with, for example, `flowchart TD`.');
  if (/%%\s*\{/u.test(source)) throw new Error('Mermaid initialization directives are not supported.');
  if (/<\s*(?:img|image|iframe|object|embed|script|link)\b/iu.test(source) || /@\s*\{[^}]*\b(?:img|image|icon)\s*:/iu.test(source)) throw new Error('Mermaid images and embedded content are not supported; use text and native shapes.');
  const position: { source: string; x?: number; y?: number } = { source };
  for (const axis of ['x', 'y'] as const) {
    const value = args[axis];
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 20_000) throw new Error(`\`${axis}\` must be a finite coordinate within ±20000.`);
      position[axis] = value;
    }
  }
  return position;
}

/** Parsing and conversion finish before touching the live scene; invalid input never publishes partial diagrams. */
export async function importMermaidWhiteboard(store: ExcalidrawToolStore, input: unknown, importer?: MermaidImporter, authorized: () => boolean = () => true): Promise<WhiteboardEditResult> {
  assertAuthorized(authorized);
  const args = record(input);
  if (args['action'] !== 'mermaid') throw new Error('Expected action mermaid.');
  const { source, x, y } = validateMermaidInput(args);
  let engine = importer;
  if (!engine) {
    const [mermaid, excalidraw] = await Promise.all([import('@excalidraw/mermaid-to-excalidraw'), import('@excalidraw/excalidraw')]);
    assertAuthorized(authorized);
    engine = {
      parse: async definition => await mermaid.parseMermaidToExcalidraw(definition, { startOnLoad: false, maxEdges: 150, maxTextSize: MAX_MERMAID_SOURCE, themeVariables: { fontSize: '20px' }, flowchart: { curve: 'linear' } }),
      convert: excalidraw.convertToExcalidrawElements, restore: excalidraw.restoreElements,
    };
  }
  let parsed: Awaited<ReturnType<MermaidImporter['parse']>>;
  try { parsed = await engine.parse(source); }
  catch (error) { throw new Error(`Mermaid could not be parsed. Nothing was changed. ${error instanceof Error ? error.message : 'Check the flowchart syntax.'}`); }
  assertAuthorized(authorized);
  if (!parsed.elements.length || parsed.elements.length > MAX_MERMAID_ELEMENTS) throw new Error('Mermaid must produce 1–300 native elements. Split a larger diagram into smaller flowcharts.');
  if (Object.keys(parsed.files ?? {}).length || parsed.elements.some(element => ['image', 'iframe', 'embeddable'].includes(element.type))) throw new Error('This Mermaid diagram requires an image fallback. Use supported flowchart shapes so every node stays editable.');
  // Regenerate ids so repeated imports never overwrite nodes, labels, or bindings from earlier imports.
  const skeletons = parsed.elements.map(element => element.type === 'arrow' ? { ...element, id: crypto.randomUUID() } : element);
  const generated = engine.convert(skeletons, { regenerateIds: true });
  if (!generated.length || generated.length > MAX_MERMAID_ELEMENTS) throw new Error('Mermaid must produce at most 300 native elements including bound labels.');
  // Re-read after asynchronous parsing: a collaborator's edit during conversion must remain in the scene.
  const current = store.snapshot(), existingIds = new Set(current.map(element => element.id));
  if (current.length + generated.length > MAX_EXCALIDRAW_ELEMENTS) throw new Error('This diagram would exceed the shared board’s 1000-element history limit. Nothing was changed.');
  if (generated.some(element => existingIds.has(element.id)) || new Set(generated.map(element => element.id)).size !== generated.length) throw new Error('The imported diagram contains conflicting element ids. Nothing was changed.');
  const visible = current.filter(element => !element.isDeleted);
  const targetX = x ?? (visible.length ? Math.max(...visible.map(element => element.x + element.width)) + 120 : 0);
  const targetY = y ?? (visible.length ? Math.min(...visible.map(element => element.y)) : 0);
  const dx = targetX - Math.min(...generated.map(element => element.x)), dy = targetY - Math.min(...generated.map(element => element.y));
  const groupIds = new Map<string, string>();
  const positioned = generated.map(element => ({ ...element, x: element.x + dx, y: element.y + dy, index: null, version: 1, updated: Date.now(),
    groupIds: element.groupIds.map(group => { if (!groupIds.has(group)) groupIds.set(group, crypto.randomUUID()); return groupIds.get(group)!; }),
  }));
  const scene = engine.restore(structuredClone([...current, ...positioned]), null, { repairBindings: true });
  const importedIds = new Set(generated.map(element => element.id));
  const imported = scene.filter(element => importedIds.has(element.id));
  if (imported.length !== generated.length || scene.some(element => !parseExcalidrawElement(element))) throw new Error('The Mermaid result contains unsupported or oversized native elements. Nothing was changed.');
  assertAuthorized(authorized);
  if (!store.commit(scene)) throw new Error('The shared board rejected the Mermaid diagram. Nothing was changed.');
  return { ok: true, shared: true, action: 'mermaid', sourceKind: 'mermaid-flowchart', imported: imported.length, count: store.snapshot().filter(element => !element.isDeleted).length, elements: imported, changedIds: imported.map(element => element.id), canUndo: store.canUndo, canRedo: store.canRedo };
}

function nativeShape(element: ExcalidrawElement, elements: ReadonlyMap<string, ExcalidrawElement>): BoardElement | null {
  if (element.type === 'text' && element.containerId) return null;
  const kind: BoardKind | null = element.type === 'rectangle' || element.type === 'ellipse' ? 'rectangle' : element.type === 'diamond' ? 'diamond' : element.type === 'text' ? 'text' : element.type === 'freedraw' || element.type === 'line' ? 'pen' : element.type === 'arrow' ? 'connector' : null;
  if (!kind) return null;
  const boundText = element.boundElements?.find(bound => bound.type === 'text');
  const label = boundText ? elements.get(boundText.id) : undefined;
  return {
    ...newBoardShape(kind, element.x, element.y, (BOARD_COLORS as readonly string[]).includes(element.backgroundColor) ? element.backgroundColor : BOARD_COLORS[0]),
    id: element.id, x: element.x, y: element.y, width: Math.max(20, element.width), height: Math.max(20, element.height),
    text: element.type === 'text' ? element.originalText : label?.type === 'text' ? label.originalText : '',
    points: element.type === 'freedraw' || element.type === 'line' ? element.points.map(point => [point[0], point[1]]) : [],
    from: element.type === 'arrow' ? element.startBinding?.elementId ?? '' : '',
    to: element.type === 'arrow' ? element.endBinding?.elementId ?? '' : '',
    deleted: element.isDeleted, clock: element.version, actor: 'native',
  };
}

/** Uses Excalidraw's converter for its own text layout and bidirectional bindings. */
export async function editExcalidrawWhiteboard(store: ExcalidrawToolStore, input: unknown, converter?: ConvertElements, authorized: () => boolean = () => true): Promise<WhiteboardEditResult> {
  assertAuthorized(authorized);
  const args = record(input), action = args['action'];
  if (action === 'mermaid') return importMermaidWhiteboard(store, input, undefined, authorized);
  if (action !== 'read' && action !== 'edit' && action !== 'undo' && action !== 'redo') throw new Error('`action` must be read, edit, mermaid, undo or redo.');
  onlyKeys(args, action === 'edit' ? ['action', 'operations'] : action === 'read' ? ['action', 'offset', 'limit'] : ['action']);
  const result = (elements: ExcalidrawElement[], changedIds: string[] = []): WhiteboardEditResult => ({ ok: true, shared: true, action, count: store.snapshot().filter(element => !element.isDeleted).length, elements, changedIds, canUndo: store.canUndo, canRedo: store.canRedo });
  if (action === 'read') {
    const offset = args['offset'] === undefined ? 0 : args['offset'], limit = args['limit'] === undefined ? MAX_WHITEBOARD_READ : args['limit'];
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('`offset` must be a non-negative integer.');
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_WHITEBOARD_READ) throw new Error('`limit` must be an integer between 1 and 100.');
    const scene = store.snapshot().filter(element => !element.isDeleted), page = scene.slice(offset as number, (offset as number) + (limit as number));
    const nextOffset = Math.min(scene.length, (offset as number) + page.length);
    return { ...result(page), nextOffset, hasMore: nextOffset < scene.length };
  }
  if (action === 'undo' || action === 'redo') {
    const before = new Map(store.snapshot().map(element => [element.id, element]));
    assertAuthorized(authorized);
    store[action]();
    const changed = store.snapshot().filter(element => before.get(element.id) !== element);
    return result([...changed], changed.map(element => element.id));
  }
  const operations = args['operations'];
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_WHITEBOARD_OPERATIONS) throw new Error('`operations` must contain 1–50 edits.');
  // Load only when editing in the browser, never while importing the WebMCP schema on the server.
  const runtime = converter ? null : await import('@excalidraw/excalidraw');
  assertAuthorized(authorized);
  const convert = converter ?? runtime!.convertToExcalidrawElements;
  const before = new Map(store.snapshot().map(element => [element.id, element]));
  const planner = new WhiteboardStore(() => {}, 'webmcp');
  const nativeShapes = new Map<string, BoardElement>();
  for (const element of before.values()) {
    const shape = nativeShape(element, before);
    if (shape) {
      nativeShapes.set(shape.id, shape);
      // The legacy edit validator bounds *new input*. Keep a bounded planning proxy while
      // preserving every untouched native value below (e.g. long labels and wide diagrams).
      planner.merge({ ...shape, x: Math.max(-20_000, Math.min(20_000, shape.x)), y: Math.max(-20_000, Math.min(20_000, shape.y)),
        width: Math.min(1200, shape.width), height: Math.min(1200, shape.height), text: shape.text.slice(0, 500), points: shape.points.slice(0, 256) });
    }
  }
  for (const raw of operations) {
    const operation = record(raw), target = typeof operation['id'] === 'string' ? before.get(operation['id']) : undefined;
    if (operation['op'] === 'create' && target) throw new Error(`Id ${target.id} already exists.`);
    if (target?.type === 'text' && target.containerId) throw new Error(`Text is bound to ${target.containerId}. Update or delete that container instead.`);
  }
  const planned = editWhiteboard(planner, input);
  const changed = new Set(planned.changedIds);
  const recolored = new Set(operations.filter(raw => Object.hasOwn(record(raw), 'color')).map(raw => record(raw)['id']));
  const requestedFields = new Map<string, Set<string>>();
  for (const raw of operations) {
    const operation = record(raw), shapeId = operation['id'];
    if (typeof shapeId !== 'string') continue;
    if (!requestedFields.has(shapeId)) requestedFields.set(shapeId, new Set());
    for (const field of FIELDS) if (Object.hasOwn(operation, field)) requestedFields.get(shapeId)!.add(field);
  }
  const getShape = (shapeId: string): BoardElement => {
    const proxy = planner.get(shapeId)!, original = nativeShapes.get(shapeId), requested = requestedFields.get(shapeId);
    if (!original) return proxy;
    const shape = { ...proxy };
    for (const field of FIELDS) if (!requested?.has(field)) Object.assign(shape, { [field]: original[field as keyof BoardElement] });
    return shape;
  };
  // Moving a container also recalculates connected native arrows; labels are laid out by Excalidraw.
  for (const shape of planner.snapshot()) if (shape.kind === 'connector' && (changed.has(shape.from) || changed.has(shape.to))) changed.add(shape.id);
  const skeletons = new Map<string, ExcalidrawElementSkeleton>();
  const removed = new Set<string>();
  for (const shapeId of changed) {
    const shape = getShape(shapeId);
    const original = before.get(shapeId);
    const boundTextId = original?.boundElements?.find(bound => bound.type === 'text')?.id;
    const boundText = boundTextId ? before.get(boundTextId) : undefined;
    if (boundTextId) removed.add(boundTextId);
    if (shape.deleted) { removed.add(shapeId); continue; }
    if (shape.kind === 'connector') continue;
    const common = { ...original, id: shape.id, x: shape.x, y: shape.y, width: shape.width, height: shape.height,
      strokeColor: original?.strokeColor ?? '#343a40', backgroundColor: original && !recolored.has(shape.id) ? original.backgroundColor : shape.color, fillStyle: original?.fillStyle ?? 'solid', roughness: original?.roughness ?? 0,
      boundElements: original?.boundElements?.filter(bound => bound.type !== 'text') ?? [], };
    if (shape.kind === 'pen') {
      const base = original ?? convert([{ type: 'rectangle', x: shape.x, y: shape.y, id: shape.id }], { regenerateIds: false })[0]!;
      skeletons.set(shapeId, { ...base, ...common, type: 'freedraw', strokeColor: original && !recolored.has(shape.id) ? original.strokeColor : shape.color, points: shape.points,
        width: Math.max(...shape.points.map(point => point[0])) - Math.min(...shape.points.map(point => point[0])),
        height: Math.max(...shape.points.map(point => point[1])) - Math.min(...shape.points.map(point => point[1])),
        pressures: [], simulatePressure: true, lastCommittedPoint: null } as unknown as ExcalidrawElementSkeleton);
    } else if (shape.kind === 'text') {
      skeletons.set(shapeId, { ...common, type: 'text', strokeColor: recolored.has(shape.id) ? shape.color : common.strokeColor, text: shape.text, originalText: shape.text, fontFamily: original?.type === 'text' ? original.fontFamily : 2, fontSize: original?.type === 'text' ? original.fontSize : 20 } as ExcalidrawElementSkeleton);
    } else {
      skeletons.set(shapeId, { ...common, type: original?.type === 'ellipse' ? 'ellipse' : shape.kind === 'diamond' ? 'diamond' : 'rectangle',
        ...(shape.text ? { label: { ...(boundText?.type === 'text' ? boundText : {}), text: shape.text, originalText: shape.text,
          ...(boundTextId ? { id: boundTextId } : {}), fontFamily: boundText?.type === 'text' ? boundText.fontFamily : 2,
          fontSize: boundText?.type === 'text' ? boundText.fontSize : 20, textAlign: boundText?.type === 'text' ? boundText.textAlign : 'center',
          verticalAlign: boundText?.type === 'text' ? boundText.verticalAlign : 'middle' } } : {}) } as unknown as ExcalidrawElementSkeleton);
    }
  }
  // Convert containers first so arrow ports use their final, text-adjusted dimensions.
  const convertedNodes = convert([...skeletons.values()], { regenerateIds: false });
  const nodes = new Map([...before, ...convertedNodes.map(element => [element.id, element] as const)]);
  const arrows: ExcalidrawElementSkeleton[] = [];
  const endpointIds = new Set<string>();
  for (const shapeId of changed) {
    const shape = getShape(shapeId);
    if (shape.kind !== 'connector' || shape.deleted) continue;
    const from = nodes.get(shape.from)!, to = nodes.get(shape.to)!;
    const ax = from.x + from.width / 2, ay = from.y + from.height / 2, bx = to.x + to.width / 2, by = to.y + to.height / 2;
    const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay), sign = (horizontal ? bx - ax : by - ay) >= 0 ? 1 : -1;
    const x = horizontal ? ax + sign * from.width / 2 : ax, y = horizontal ? ay : ay + sign * from.height / 2;
    const ex = horizontal ? bx - sign * to.width / 2 : bx, ey = horizontal ? by : by - sign * to.height / 2;
    const original = before.get(shape.id);
    const labelId = original?.boundElements?.find(bound => bound.type === 'text')?.id;
    const label = labelId ? before.get(labelId) : undefined;
    arrows.push({ ...original, id: shape.id, type: 'arrow', x, y, width: Math.abs(ex - x), height: Math.abs(ey - y), points: [[0, 0], [ex - x, ey - y]],
      strokeColor: recolored.has(shape.id) ? shape.color : original?.strokeColor ?? '#343a40', roughness: 0, startBinding: null, endBinding: null,
      boundElements: original?.boundElements?.filter(bound => bound.type !== 'text') ?? [],
      ...(shape.text ? { label: { ...(label?.type === 'text' ? label : {}), ...(labelId ? { id: labelId } : {}), text: shape.text, originalText: shape.text,
        fontFamily: label?.type === 'text' ? label.fontFamily : 2, fontSize: label?.type === 'text' ? label.fontSize : 20 } } : {}),
      startArrowhead: null, endArrowhead: 'arrow', elbowed: false, start: { id: from.id }, end: { id: to.id } } as unknown as ExcalidrawElementSkeleton);
    endpointIds.add(from.id); endpointIds.add(to.id);
  }
  const converted = arrows.length ? convert([
    ...[...endpointIds].map(shapeId => nodes.get(shapeId)! as ExcalidrawElementSkeleton), ...arrows,
  ], { regenerateIds: false }) : [];
  const next = new Map(before);
  for (const element of [...convertedNodes, ...converted]) {
    next.set(element.id, { ...element, index: before.get(element.id)?.index ?? null });
    removed.delete(element.id);
  }
  for (const shapeId of removed) { const element = before.get(shapeId); if (element) next.set(shapeId, { ...element, isDeleted: true }); }
  // Clearing text removes both halves of its binding. Deleting a connector removes the reverse references.
  for (const [shapeId, element] of next) {
    const boundElements = element.boundElements?.filter(bound => !next.get(bound.id)?.isDeleted);
    if (JSON.stringify(boundElements) !== JSON.stringify(element.boundElements)) next.set(shapeId, { ...element, boundElements: boundElements ?? null });
  }
  if (runtime) {
    const restored = runtime.restoreElements(structuredClone([...next.values()]), null, { repairBindings: true });
    next.clear();
    for (const element of restored) next.set(element.id, element);
  }
  const changedElements: ExcalidrawElement[] = [];
  for (const [shapeId, element] of next) {
    const original = before.get(shapeId);
    if (JSON.stringify(original) === JSON.stringify(element)) continue;
    const updated = { ...element, version: (original?.version ?? 0) + 1, versionNonce: Math.floor(Math.random() * 0x7fffffff), updated: Date.now() };
    next.set(shapeId, updated); changedElements.push(updated);
  }
  const invalid = [...next.values()].find(element => !parseExcalidrawElement(element));
  if (invalid) {
    const { id, type, width, height, index } = invalid;
    const details = type === 'arrow' ? { elbowed: 'elbowed' in invalid ? invalid.elbowed : undefined, lastCommittedPoint: invalid.lastCommittedPoint, startBinding: invalid.startBinding, endBinding: invalid.endBinding } : {};
    throw new Error(`The shared board rejected ${id} (${type}). Nothing was changed. Details: ${JSON.stringify({ width, height, index, ...details })}`);
  }
  assertAuthorized(authorized);
  if (!store.commit([...next.values()])) throw new Error('The shared board rejected this batch because the scene exceeds its limits. Nothing was changed.');
  return result(changedElements, changedElements.map(element => element.id));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown property: ${key}.`);
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Ids must contain 1–64 letters, digits, underscores or hyphens.');
  return value;
}
function validateShape(shape: BoardShape): BoardShape {
  if (!parseBoardElement({ ...shape, clock: 1, actor: 'webmcp' })) throw new Error('Invalid shape: coordinates must be within ±20000, dimensions 20–1200, text at most 500 characters, and color one of the listed swatches.');
  if (shape.kind === 'pen' && shape.points.length < 2) throw new Error('A pen stroke needs 2–256 points.');
  if (shape.kind !== 'pen' && shape.points.length) throw new Error('Only pen strokes accept points.');
  if (shape.kind !== 'connector' && (shape.from || shape.to)) throw new Error('Only connectors accept from and to.');
  return shape;
}

/** Operates on the room's live store, so publication, tombstones and undo match manual edits. */
export function editWhiteboard(store: WhiteboardStore, input: unknown): WhiteboardEditResult {
  const args = record(input);
  const action = args['action'];
  if (action !== 'read' && action !== 'edit' && action !== 'undo' && action !== 'redo') throw new Error('`action` must be read, edit, undo or redo.');
  onlyKeys(args, action === 'edit' ? ['action', 'operations'] : action === 'read' ? ['action', 'offset', 'limit'] : ['action']);
  const result = (elements: BoardElement[], changedIds: string[] = []): WhiteboardEditResult => ({
    ok: true, shared: true, action, count: store.snapshot().length, elements, changedIds, canUndo: store.canUndo, canRedo: store.canRedo,
  });
  if (action === 'read') {
    const offset = args['offset'] ?? 0, limit = args['limit'] ?? MAX_WHITEBOARD_READ;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('`offset` must be a non-negative integer.');
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_WHITEBOARD_READ) throw new Error('`limit` must be an integer between 1 and 100.');
    const snapshot = store.snapshot(), elements = snapshot.slice(offset as number, (offset as number) + (limit as number));
    const nextOffset = Math.min(snapshot.length, (offset as number) + elements.length);
    return { ...result(elements), nextOffset, hasMore: nextOffset < snapshot.length };
  }
  if (action === 'undo' || action === 'redo') {
    const before = new Map(store.records().map(e => [e.id, e]));
    store[action]();
    const changed = store.records().filter(e => before.get(e.id) !== e);
    return result(changed, changed.map(e => e.id));
  }
  const operations = args['operations'];
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_WHITEBOARD_OPERATIONS) throw new Error('`operations` must contain 1–50 edits.');
  // Simulate and validate first: a malformed later edit must never partially publish a batch.
  const staged = new Map<string, BoardShape>(store.records().map(e => [e.id, e]));
  const changed = new Set<string>();
  for (const raw of operations) {
    const operation = record(raw), op = operation['op'];
    if (op === 'create') {
      onlyKeys(operation, ['op', 'id', 'kind', ...FIELDS]);
      if (typeof operation['kind'] !== 'string' || !KINDS.includes(operation['kind'])) throw new Error('Invalid shape kind.');
      // Validate raw coordinates before the UI factory's clamping can hide invalid values.
      if (typeof operation['x'] !== 'number' || typeof operation['y'] !== 'number') throw new Error('Create requires numeric x and y.');
      const shape = newBoardShape(operation['kind'] as BoardKind, 0, 0, BOARD_COLORS[0]);
      if (operation['id'] !== undefined) shape.id = id(operation['id']);
      if (staged.has(shape.id)) throw new Error(`Id ${shape.id} already exists, including deleted objects. Use a new id.`);
      if (staged.size >= MAX_BOARD_RECORDS) throw new Error('This board has reached its 1000-object history limit.');
      for (const field of FIELDS) if (Object.hasOwn(operation, field)) Object.assign(shape, { [field]: operation[field] });
      staged.set(shape.id, validateShape(shape));
      changed.add(shape.id);
    } else if (op === 'update' || op === 'delete') {
      onlyKeys(operation, op === 'delete' ? ['op', 'id'] : ['op', 'id', ...FIELDS]);
      const shapeId = id(operation['id']), current = staged.get(shapeId);
      if (!current || current.deleted) throw new Error(`No visible whiteboard object with id ${shapeId}.`);
      const shape = { ...current };
      if (op === 'delete') shape.deleted = true;
      else {
        if (!FIELDS.some(field => Object.hasOwn(operation, field))) throw new Error('Update requires at least one shape field.');
        for (const field of FIELDS) if (Object.hasOwn(operation, field)) Object.assign(shape, { [field]: operation[field] });
        validateShape(shape);
      }
      staged.set(shapeId, shape);
      changed.add(shapeId);
    } else throw new Error('Each operation must be create, update or delete.');
  }
  for (const shape of staged.values()) {
    if (shape.deleted || shape.kind !== 'connector') continue;
    const from = staged.get(shape.from), to = staged.get(shape.to);
    if (from?.deleted || to?.deleted) {
      if (changed.has(shape.id)) throw new Error('A connector cannot point to a deleted node.');
      staged.set(shape.id, { ...shape, deleted: true });
      changed.add(shape.id);
    } else if (!from || !to || from.kind === 'connector' || to.kind === 'connector' || from.kind === 'pen' || to.kind === 'pen') {
      // A previously received dangling connector must not block an unrelated local edit.
      if (changed.has(shape.id)) throw new Error('Connector endpoints must reference visible note, rectangle, diamond or text nodes.');
    }
  }
  store.commit([...changed].map(shapeId => staged.get(shapeId)!));
  return result([...changed].map(shapeId => store.get(shapeId)!), [...changed]);
}
