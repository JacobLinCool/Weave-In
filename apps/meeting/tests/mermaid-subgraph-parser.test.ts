import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMermaidFlowChartDiagram } from '@excalidraw/mermaid-to-excalidraw/dist/parser/flowchart.js';

// Exercise the installed dependency patch. These DOM stubs test ID resolution;
// browser QA separately checks real SVG geometry, native grouping and bindings.
function parse(ids: string[], groups: string[], svgId = 'mermaid-to-excalidraw-12') {
  vi.stubGlobal('document', { createElement: () => ({
    innerHTML: '', get value() { return this.innerHTML; },
  }) });
  const clusters = ids.map((id, i) => ({
    id, childNodes: [], parentElement: null,
    getAttribute: () => null, querySelector: () => null,
    getBBox: () => ({ width: (i + 1) * 100, height: 200, x: 0, y: 0 }),
  }));
  const container = {
    querySelector: (selector: string) => selector === 'svg' ? { id: svgId } : null,
    querySelectorAll: (selector: string) => selector === 'g.cluster[id]' ? clusters : [],
  } as unknown as Element;
  const db = {
    getVertices: () => new Map(), getEdges: () => [], getClasses: () => new Map(),
    getSubGraphs: () => groups.map(id => ({ id, title: id, nodes: [], classes: [] })),
  } as unknown as Parameters<typeof parseMermaidFlowChartDiagram>[0];
  return parseMermaidFlowChartDiagram(db, container).subGraphs;
}

afterEach(() => vi.unstubAllGlobals());
describe('Mermaid subgraph DOM compatibility', () => {
  it('resolves actual Mermaid 11 diagram-prefixed clusters without suffix collisions', () => {
    const groups = parse(['mermaid-to-excalidraw-12-X-P', 'mermaid-to-excalidraw-12-P'], ['P', 'X-P']);
    expect(groups.map(group => [group.id, group.width])).toEqual([['P', 200], ['X-P', 100]]);
  });
  it('retains the original unprefixed cluster format', () => {
    expect(parse(['P'], ['P'])[0]).toMatchObject({ id: 'P', width: 100 });
  });
  it('does not accept another diagram or a partial group match', () => {
    expect(() => parse(['mermaid-to-excalidraw-11-P', 'mermaid-to-excalidraw-12-X-P'], ['P'])).toThrow('SubGraph element not found');
  });
  it('supports group IDs containing selector punctuation without interpolation', () => {
    expect(parse(["mermaid-to-excalidraw-12-team's-group"], ["team's-group"])[0]?.id).toBe("team's-group");
  });
});
