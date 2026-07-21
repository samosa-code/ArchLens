import * as dagre from '@dagrejs/dagre';

/**
 * Deliberately decoupled from `GraphNode`/`GraphEdge` (Sprint 2) and from
 * anything label/rendering-specific — `computeLayout()` only ever needs a
 * bounding box per node and a source/target per edge. Sizing nodes from
 * their labels (a rendering concern) belongs in `render/browser/app.ts`,
 * not here, so this module stays a pure, reusable graph-layout utility —
 * and, having no DOM dependency at all, is directly unit-testable in Node
 * (`__test__/layout.test.ts`) without a browser.
 */
export interface LayoutInput {
  nodes: { id: string; width: number; height: number }[];
  edges: { source: string; target: string }[];
}

export interface LayoutNode {
  /** Top-left x — ready to use directly as an SVG `<rect>`'s `x`, unlike dagre's native center-based coordinate. */
  x: number;
  /** Top-left y — see {@link LayoutNode.x}. */
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
  /** The polyline dagre routed this edge through — at least 2 points, never a single straight-line stub computed independently of the actual layout. */
  points: { x: number; y: number }[];
}

export interface LayoutResult {
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  /** Overall diagram width — guaranteed to cover every node's bounding box, computed from the actual positioned nodes rather than trusted blindly from dagre's own reported graph size. */
  width: number;
  /** See {@link LayoutResult.width}. */
  height: number;
}

/**
 * Groups `nodes`/`edges` into connected components (undirected — an edge
 * connects its source and target regardless of direction) via BFS. A node
 * with no edges at all is its own single-node component. Real multi-
 * template graphs are very often *not* one connected graph (e.g. several
 * independent example templates merged together, or several unrelated
 * stacks in one real account) — dagre has no concept of this and lays out
 * every disconnected piece within one hierarchical pass, which is what
 * produced the pathologically wide, "skewed" diagrams `computeLayout`
 * used to generate (confirmed directly: a real 5-template merge produced
 * an 18:1 width:height diagram). Laying out each component independently,
 * then packing the results (see {@link packComponents}), fixes this.
 */
function findConnectedComponents(input: LayoutInput): { nodes: LayoutInput['nodes']; edges: LayoutInput['edges'] }[] {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));

  const adjacency = new Map<string, Set<string>>();
  for (const node of input.nodes) adjacency.set(node.id, new Set());
  for (const edge of input.edges) {
    // An edge naming a node absent from `input.nodes` must never be
    // traversed here — that node doesn't exist in `nodesById`, so
    // treating it as a real component member would crash when this
    // function's caller looks it up. Consistent with `layoutComponent`'s
    // own "skip, don't throw" handling of the same case.
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const visited = new Set<string>();
  const components: { nodes: LayoutInput['nodes']; edges: LayoutInput['edges'] }[] = [];

  for (const node of input.nodes) {
    if (visited.has(node.id)) continue;

    const memberIds = new Set<string>();
    const queue = [node.id];
    visited.add(node.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      memberIds.add(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    const memberNodes = [...memberIds].map((id) => nodesById.get(id)!);
    const memberEdges = input.edges.filter((edge) => memberIds.has(edge.source) && memberIds.has(edge.target));
    components.push({ nodes: memberNodes, edges: memberEdges });
  }

  return components;
}

/** Runs `@dagrejs/dagre` over a single connected (or single-node) component. Local coordinates only — packing/offsetting is the caller's job. */
function layoutComponent(nodes: LayoutInput['nodes'], edges: LayoutInput['edges']): LayoutResult {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60, marginx: 10, marginy: 10 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    graph.setNode(node.id, { width: node.width, height: node.height });
  }
  // `edges` here is already confined to this component's own members
  // (see `findConnectedComponents`), but the same "skip, don't throw" for
  // a genuinely undeclared endpoint still applies for defense in depth.
  const nodeIds = new Set(nodes.map((node) => node.id));
  edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
    graph.setEdge(edge.source, edge.target, {}, String(index));
  });

  dagre.layout(graph);

  const positioned = new Map<string, LayoutNode>();
  let width = 0;
  let height = 0;
  for (const id of graph.nodes()) {
    const dagreNode = graph.node(id);
    const x = dagreNode.x - dagreNode.width / 2;
    const y = dagreNode.y - dagreNode.height / 2;
    positioned.set(id, { x, y, width: dagreNode.width, height: dagreNode.height });
    width = Math.max(width, x + dagreNode.width);
    height = Math.max(height, y + dagreNode.height);
  }

  const positionedEdges: LayoutEdge[] = [];
  for (const edgeKey of graph.edges()) {
    const edgeData = graph.edge(edgeKey);
    positionedEdges.push({ source: edgeKey.v, target: edgeKey.w, points: edgeData.points ?? [] });
  }

  return { nodes: positioned, edges: positionedEdges, width, height };
}

const COMPONENT_GAP = 60;

/**
 * Shelf-packs already-laid-out components into a grid: sorts tallest
 * first (a standard shelf-packing heuristic — placing the biggest items
 * first tends to leave fewer awkward gaps), fills each "shelf" (row)
 * left-to-right until the next component would exceed `targetWidth`, then
 * starts a new shelf below. `targetWidth` is derived from the total
 * component area so the packed result trends toward a roughly-square
 * aspect ratio regardless of how many components there are, rather than
 * one arbitrarily wide row.
 */
function packComponents(components: LayoutResult[]): LayoutResult {
  if (components.length === 0) return { nodes: new Map(), edges: [], width: 0, height: 0 };
  if (components.length === 1) return components[0]!;

  const totalArea = components.reduce((sum, component) => sum + component.width * component.height, 0);
  const targetWidth = Math.max(...components.map((component) => component.width), Math.sqrt(totalArea) * 1.4);

  const sorted = [...components].sort((a, b) => b.height - a.height);

  const nodes = new Map<string, LayoutNode>();
  const edges: LayoutEdge[] = [];
  let shelfX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  let overallWidth = 0;

  for (const component of sorted) {
    if (shelfX > 0 && shelfX + component.width > targetWidth) {
      shelfY += shelfHeight + COMPONENT_GAP;
      shelfX = 0;
      shelfHeight = 0;
    }

    for (const [id, node] of component.nodes) {
      nodes.set(id, { ...node, x: node.x + shelfX, y: node.y + shelfY });
    }
    for (const edge of component.edges) {
      edges.push({ ...edge, points: edge.points.map((point) => ({ x: point.x + shelfX, y: point.y + shelfY })) });
    }

    shelfX += component.width + COMPONENT_GAP;
    shelfHeight = Math.max(shelfHeight, component.height);
    overallWidth = Math.max(overallWidth, shelfX - COMPONENT_GAP);
  }

  return { nodes, edges, width: overallWidth, height: shelfY + shelfHeight };
}

/**
 * Runs `@dagrejs/dagre` (the actively-maintained fork — the original
 * `dagre` package on npm hasn't published since 2022; see ADR 0006) over
 * `input`, converting its center-based node coordinates to top-left
 * (directly usable as SVG `<rect>` `x`/`y`) and computing the overall
 * diagram bounding box from the actual positioned nodes.
 *
 * **Connected components are laid out independently, then grid-packed**
 * (see {@link findConnectedComponents}/{@link packComponents}) rather than
 * handed to dagre as one graph — real multi-template input is very often
 * not one connected graph, and dagre's single-pass layout of disconnected
 * pieces produces pathologically wide diagrams (confirmed directly: an
 * 18:1 width:height ratio on a real 5-template merge). A single connected
 * graph (the common case for one template) is unaffected: with exactly
 * one component, packing is a no-op.
 *
 * An edge naming a node absent from `input.nodes` is skipped, not thrown —
 * consistent with this project's established "degrade gracefully, never
 * crash on a structurally-odd input" stance from the parser/graph layers.
 *
 * **Multigraph mode, deliberately**: two `input.edges` entries can share
 * the same `source`/`target` (Sprint 2's `GraphEdge`s are never collapsed
 * — the same two resources can be connected by more than one distinct
 * reference, per ADR 0002). `dagre.graphlib.Graph`'s *default* mode
 * treats `(source, target)` as a single edge slot — a second `setEdge`
 * call for the same pair silently overwrites the first. Caught directly
 * (not assumed) by running a real merged multi-template graph through
 * this function: 60 input edges produced only 54 rendered ones. Fixed by
 * enabling `{multigraph: true}` and giving every edge a unique `name`
 * (its index), so parallel edges between the same pair are preserved and
 * routed independently rather than silently dropped.
 */
export function computeLayout(input: LayoutInput): LayoutResult {
  const components = findConnectedComponents(input).map((component) => layoutComponent(component.nodes, component.edges));
  return packComponents(components);
}
