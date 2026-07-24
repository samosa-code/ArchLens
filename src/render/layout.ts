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
  nodes: { id: string; width: number; height: number; containerId?: string }[];
  edges: { source: string; target: string }[];
  /** Container boundaries (VPC/Subnet/cluster/stack/...) — Ticket 3.6.1. Omitted entirely behaves identically to before that ticket. */
  containers?: LayoutContainerInput[];
}

/**
 * One container boundary to lay out. `minWidth`/`minHeight` are a floor,
 * not a fixed size — sized by the caller from the container's own label
 * (the same way a real node is sized), since `layout.ts` itself is
 * DOM-free and never measures text. Confirmed directly against
 * `@dagrejs/dagre` (not assumed): a compound-graph cluster node given no
 * explicit size and no children comes back from `dagre.layout()` with no
 * width/height at all — an empty container would otherwise be
 * unrenderable, which the AC explicitly treats as unacceptable ("never
 * silently dropped"). A non-empty container still auto-expands well
 * beyond this floor to fit its real content.
 */
export interface LayoutContainerInput {
  id: string;
  /** The container this one nests inside, if any. */
  parentId?: string;
  minWidth: number;
  minHeight: number;
}

export interface LayoutNode {
  /** Top-left x — ready to use directly as an SVG `<rect>`'s `x`, unlike dagre's native center-based coordinate. */
  x: number;
  /** Top-left y — see {@link LayoutNode.x}. */
  y: number;
  width: number;
  height: number;
}

/** A laid-out container boundary — same top-left coordinate convention as {@link LayoutNode}. */
export type LayoutContainer = LayoutNode;

export interface LayoutEdge {
  source: string;
  target: string;
  /** The polyline dagre routed this edge through — at least 2 points, never a single straight-line stub computed independently of the actual layout. */
  points: { x: number; y: number }[];
}

export interface LayoutResult {
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  /** Laid-out container boundaries (Ticket 3.6.1) — empty when `LayoutInput.containers` was omitted or empty. */
  containers: Map<string, LayoutContainer>;
  /** Overall diagram width — guaranteed to cover every node's AND every container's bounding box, computed from the actual positioned elements rather than trusted blindly from dagre's own reported graph size. */
  width: number;
  /** See {@link LayoutResult.width}. */
  height: number;
}

interface ComponentGroup {
  nodes: LayoutInput['nodes'];
  edges: LayoutInput['edges'];
  containers: LayoutContainerInput[];
}

/**
 * Groups `nodes`/`edges`/`containers` into connected components (undirected
 * — an edge or a containment relationship connects its two ends regardless
 * of direction) via BFS, laid out independently and packed (see
 * {@link packComponents}) — real multi-template graphs are very often
 * *not* one connected graph.
 *
 * Containment counts as connectivity here, alongside real edges: a
 * `containment`-kind `ArchEdge` is never part of `edges` at all (nesting
 * is expressed purely via `containerId`/`parentId` — see
 * `fromArchitectureGraph.ts`), so a bare resource sitting alone in a
 * subnet with zero other references is a common, real case. Without
 * treating container membership as connectivity, a VPC and its own
 * subnet could be torn apart across the packed grid, landing in
 * different shelves of the same diagram.
 */
function findConnectedComponents(input: LayoutInput): ComponentGroup[] {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const containers = input.containers ?? [];
  const containersById = new Map(containers.map((c) => [c.id, c]));

  const adjacency = new Map<string, Set<string>>();
  const ensure = (id: string): Set<string> => adjacency.get(id) ?? adjacency.set(id, new Set()).get(id)!;
  for (const node of input.nodes) ensure(node.id);
  for (const container of containers) ensure(container.id);

  for (const edge of input.edges) {
    // An edge naming a node absent from `input.nodes` must never be
    // traversed here — that node doesn't exist in `nodesById`, so
    // treating it as a real component member would crash when this
    // function's caller looks it up. Consistent with `layoutComponent`'s
    // own "skip, don't throw" handling of the same case.
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue;
    ensure(edge.source).add(edge.target);
    ensure(edge.target).add(edge.source);
  }
  for (const node of input.nodes) {
    if (node.containerId !== undefined && containersById.has(node.containerId)) {
      ensure(node.id).add(node.containerId);
      ensure(node.containerId).add(node.id);
    }
  }
  for (const container of containers) {
    if (container.parentId !== undefined && containersById.has(container.parentId)) {
      ensure(container.id).add(container.parentId);
      ensure(container.parentId).add(container.id);
    }
  }

  const visited = new Set<string>();
  const groups: ComponentGroup[] = [];

  const allStartIds = [...input.nodes.map((n) => n.id), ...containers.map((c) => c.id)];
  for (const startId of allStartIds) {
    if (visited.has(startId)) continue;

    const memberIds = new Set<string>();
    const queue = [startId];
    visited.add(startId);
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

    const memberNodes = input.nodes.filter((n) => memberIds.has(n.id));
    const memberContainers = containers.filter((c) => memberIds.has(c.id));
    const memberEdges = input.edges.filter((edge) => memberIds.has(edge.source) && memberIds.has(edge.target));
    groups.push({ nodes: memberNodes, edges: memberEdges, containers: memberContainers });
  }

  return groups;
}

type ComponentLayout = { nodes: Map<string, LayoutNode>; edges: LayoutEdge[]; containers: Map<string, LayoutContainer>; width: number; height: number };

/**
 * Runs `@dagrejs/dagre` over a single connected (or single-node) component.
 * Compound mode (`layoutComponentCompound`) when containers are present;
 * falls back to a flat layout (`layoutComponentFlatFallback`) if that
 * throws — see the fallback function's own comment for why this isn't
 * just paranoia. Local coordinates only — packing/offsetting is the
 * caller's job.
 */
function layoutComponent(nodes: LayoutInput['nodes'], edges: LayoutInput['edges'], containers: LayoutContainerInput[]): ComponentLayout {
  if (containers.length === 0) return layoutComponentCompound(nodes, edges, containers);
  try {
    return layoutComponentCompound(nodes, edges, containers);
  } catch {
    return layoutComponentFlatFallback(nodes, edges, containers);
  }
}

function layoutComponentCompound(nodes: LayoutInput['nodes'], edges: LayoutInput['edges'], containers: LayoutContainerInput[]): ComponentLayout {
  const graph = new dagre.graphlib.Graph({ multigraph: true, compound: true });
  graph.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60, marginx: 10, marginy: 10, ranker: 'longest-path' });
  graph.setDefaultEdgeLabel(() => ({}));

  const containersById = new Map(containers.map((c) => [c.id, c]));
  for (const container of containers) {
    graph.setNode(container.id, { width: container.minWidth, height: container.minHeight });
  }
  for (const node of nodes) {
    graph.setNode(node.id, { width: node.width, height: node.height });
  }
  for (const node of nodes) {
    if (node.containerId !== undefined && containersById.has(node.containerId)) {
      graph.setParent(node.id, node.containerId);
    }
  }
  for (const container of containers) {
    if (container.parentId !== undefined && containersById.has(container.parentId)) {
      graph.setParent(container.id, container.parentId);
    }
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
  const positionedContainers = new Map<string, LayoutContainer>();
  let width = 0;
  let height = 0;

  const extract = (id: string): LayoutNode => {
    const dagreNode = graph.node(id);
    const x = dagreNode.x - dagreNode.width / 2;
    const y = dagreNode.y - dagreNode.height / 2;
    width = Math.max(width, x + dagreNode.width);
    height = Math.max(height, y + dagreNode.height);
    return { x, y, width: dagreNode.width, height: dagreNode.height };
  };

  for (const node of nodes) positioned.set(node.id, extract(node.id));
  for (const container of containers) positionedContainers.set(container.id, extract(container.id));

  const positionedEdges: LayoutEdge[] = [];
  for (const edgeKey of graph.edges()) {
    const edgeData = graph.edge(edgeKey);
    positionedEdges.push({ source: edgeKey.v, target: edgeKey.w, points: edgeData.points ?? [] });
  }

  return { nodes: positioned, edges: positionedEdges, containers: positionedContainers, width, height };
}

/** Padding added around a container's fallback-computed bounding box (the union of its members), so the boundary doesn't touch member rects edge-to-edge. */
const CONTAINER_FALLBACK_PADDING = 30;

/**
 * A flat (non-compound) fallback for when `layoutComponentCompound` throws.
 * Confirmed directly against `@dagrejs/dagre` in isolation, not assumed:
 * its compound-graph edge-routing can throw `"Not possible to find
 * intersection inside of the rectangle"` on real (not pathological)
 * node/edge/container shapes at moderate scale — verified this isn't
 * simply "too many nodes" (a 200-node case with 20 containers threw; an
 * otherwise-identical 500-node case didn't), and that tuning `ranker` or
 * container minimum size doesn't reliably avoid it either. Rather than
 * let one bad component's shape crash the whole diagram, this runs a
 * plain (non-compound) dagre layout for real node positions, then derives
 * each container's box as the bounding union of its own members and
 * nested child containers (processed deepest-first, so a parent sees its
 * child's real box), padded so the boundary doesn't touch member rects
 * edge-to-edge. An empty container (no members, no children even in this
 * fallback) keeps its own flat, `minWidth`/`minHeight`-sized position —
 * still a real, visible, labeled boundary, never dropped. Consistent with
 * this project's established "degrade gracefully, never crash on a
 * structurally fine input" stance from every earlier layer.
 */
function layoutComponentFlatFallback(nodes: LayoutInput['nodes'], edges: LayoutInput['edges'], containers: LayoutContainerInput[]): ComponentLayout {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60, marginx: 10, marginy: 10, ranker: 'longest-path' });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) graph.setNode(node.id, { width: node.width, height: node.height });
  for (const container of containers) graph.setNode(container.id, { width: container.minWidth, height: container.minHeight });

  const nodeIds = new Set(nodes.map((node) => node.id));
  edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
    graph.setEdge(edge.source, edge.target, {}, String(index));
  });

  dagre.layout(graph);

  const toBox = (id: string): LayoutNode => {
    const dagreNode = graph.node(id);
    return { x: dagreNode.x - dagreNode.width / 2, y: dagreNode.y - dagreNode.height / 2, width: dagreNode.width, height: dagreNode.height };
  };

  const positioned = new Map<string, LayoutNode>();
  for (const node of nodes) positioned.set(node.id, toBox(node.id));

  // Each container's initial box is its own flat, dagre-assigned position
  // — kept as-is for a container that turns out to have no members/children
  // to union below (still real, still visible, never zero-sized).
  const containerBox = new Map<string, LayoutContainer>();
  for (const container of containers) containerBox.set(container.id, toBox(container.id));

  const membersByContainer = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.containerId === undefined) continue;
    const list = membersByContainer.get(node.containerId) ?? [];
    list.push(node.id);
    membersByContainer.set(node.containerId, list);
  }
  const childrenByParent = new Map<string, string[]>();
  for (const container of containers) {
    if (container.parentId === undefined) continue;
    const list = childrenByParent.get(container.parentId) ?? [];
    list.push(container.id);
    childrenByParent.set(container.parentId, list);
  }
  const containersById = new Map(containers.map((c) => [c.id, c]));
  const depthOf = (containerId: string): number => {
    let depth = 0;
    let current = containersById.get(containerId);
    while (current?.parentId !== undefined) {
      depth += 1;
      current = containersById.get(current.parentId);
    }
    return depth;
  };
  // Deepest containers first, so a parent's union sees its child's real
  // (possibly-expanded) box, not the child's own un-expanded fallback size.
  const deepestFirst = [...containers].sort((a, b) => depthOf(b.id) - depthOf(a.id));

  for (const container of deepestFirst) {
    const boxesToUnion: LayoutNode[] = [
      ...(membersByContainer.get(container.id) ?? []).map((id) => positioned.get(id)!),
      ...(childrenByParent.get(container.id) ?? []).map((id) => containerBox.get(id)!),
    ];
    if (boxesToUnion.length === 0) continue;

    const left = Math.min(...boxesToUnion.map((b) => b.x)) - CONTAINER_FALLBACK_PADDING;
    const top = Math.min(...boxesToUnion.map((b) => b.y)) - CONTAINER_FALLBACK_PADDING;
    const right = Math.max(...boxesToUnion.map((b) => b.x + b.width)) + CONTAINER_FALLBACK_PADDING;
    const bottom = Math.max(...boxesToUnion.map((b) => b.y + b.height)) + CONTAINER_FALLBACK_PADDING;
    containerBox.set(container.id, { x: left, y: top, width: right - left, height: bottom - top });
  }

  let width = 0;
  let height = 0;
  for (const box of positioned.values()) {
    width = Math.max(width, box.x + box.width);
    height = Math.max(height, box.y + box.height);
  }
  for (const box of containerBox.values()) {
    width = Math.max(width, box.x + box.width);
    height = Math.max(height, box.y + box.height);
  }

  const positionedEdges: LayoutEdge[] = [];
  for (const edgeKey of graph.edges()) {
    const edgeData = graph.edge(edgeKey);
    positionedEdges.push({ source: edgeKey.v, target: edgeKey.w, points: edgeData.points ?? [] });
  }

  return { nodes: positioned, edges: positionedEdges, containers: containerBox, width, height };
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
function packComponents(components: ReturnType<typeof layoutComponent>[]): { nodes: Map<string, LayoutNode>; edges: LayoutEdge[]; containers: Map<string, LayoutContainer>; width: number; height: number } {
  if (components.length === 0) return { nodes: new Map(), edges: [], containers: new Map(), width: 0, height: 0 };
  if (components.length === 1) return components[0]!;

  const totalArea = components.reduce((sum, component) => sum + component.width * component.height, 0);
  const targetWidth = Math.max(...components.map((component) => component.width), Math.sqrt(totalArea) * 1.4);

  const sorted = [...components].sort((a, b) => b.height - a.height);

  const nodes = new Map<string, LayoutNode>();
  const containers = new Map<string, LayoutContainer>();
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
    for (const [id, container] of component.containers) {
      containers.set(id, { ...container, x: container.x + shelfX, y: container.y + shelfY });
    }
    for (const edge of component.edges) {
      edges.push({ ...edge, points: edge.points.map((point) => ({ x: point.x + shelfX, y: point.y + shelfY })) });
    }

    shelfX += component.width + COMPONENT_GAP;
    shelfHeight = Math.max(shelfHeight, component.height);
    overallWidth = Math.max(overallWidth, shelfX - COMPONENT_GAP);
  }

  return { nodes, edges, containers, width: overallWidth, height: shelfY + shelfHeight };
}

/**
 * Runs `@dagrejs/dagre` (the actively-maintained fork — the original
 * `dagre` package on npm hasn't published since 2022; see ADR 0006) over
 * `input`, converting its center-based node coordinates to top-left
 * (directly usable as SVG `<rect>` `x`/`y`) and computing the overall
 * diagram bounding box from the actual positioned nodes and containers.
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
 * **Container boundaries (Ticket 3.6.1)** use dagre's own compound-graph
 * support (`compound: true` + `setParent()`) rather than hand-rolled
 * bounding-box math — confirmed directly (not assumed) that dagre
 * auto-computes a correctly-sized, correctly-nested cluster box from its
 * children, expanding beyond the container's own `minWidth`/`minHeight`
 * floor exactly when real content needs the room.
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
/**
 * Converts a real dagre-routed polyline into an all-right-angle path
 * (Ticket 3.6.3) — a diagonal segment (differing x AND y) gets one
 * vertical-horizontal-vertical elbow inserted at its midpoint-y, so the
 * rendered line reads as a clean orthogonal connector (matching the
 * project's TB layout — vertical is the primary flow axis) instead of a
 * diagonal one crossing the whole gap between ranks. A segment that's
 * already purely vertical or horizontal is left completely untouched — no
 * pointless extra bend on the common case where dagre already lines two
 * points up. Endpoints are always preserved exactly; only the path between
 * them changes.
 */
export function toOrthogonalPoints(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 2) return points;

  const result: { x: number; y: number }[] = [points[0]!];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (a.x !== b.x && a.y !== b.y) {
      const midY = (a.y + b.y) / 2;
      result.push({ x: a.x, y: midY });
      result.push({ x: b.x, y: midY });
    }
    result.push(b);
  }
  return result;
}

export function computeLayout(input: LayoutInput): LayoutResult {
  const components = findConnectedComponents(input).map((component) => layoutComponent(component.nodes, component.edges, component.containers));
  const packed = packComponents(components);
  return { ...packed, edges: packed.edges.map((edge) => ({ ...edge, points: toOrthogonalPoints(edge.points) })) };
}
