import { describe, expect, test } from 'vitest';
import { computeLayout, toOrthogonalPoints, type LayoutInput } from '../layout.js';

function rectsOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function assertNoOverlaps(nodes: Map<string, { x: number; y: number; width: number; height: number }>): void {
  const list = [...nodes.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      expect(rectsOverlap(list[i]!, list[j]!)).toBe(false);
    }
  }
}

describe('computeLayout — basic correctness', () => {
  test('positions every input node exactly once', () => {
    const input: LayoutInput = {
      nodes: [
        { id: 'a', width: 100, height: 40 },
        { id: 'b', width: 100, height: 40 },
        { id: 'c', width: 100, height: 40 },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
      ],
    };
    const result = computeLayout(input);
    expect(result.nodes.size).toBe(3);
    expect([...result.nodes.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  test('produces coordinates as top-left (x, y), not dagre\'s native center-based coordinates', () => {
    // A single, isolated node: dagre centers it within the graph's margin
    // (marginx/marginy: 10, configured in computeLayout). computeLayout
    // must convert dagre's native center-based (x, y) to top-left, so the
    // node's top-left should land exactly at (marginx, marginy) = (10, 10)
    // — not at dagre's own center coordinate, and not assuming zero margin.
    const result = computeLayout({ nodes: [{ id: 'solo', width: 100, height: 40 }], edges: [] });
    const node = result.nodes.get('solo')!;
    expect(node.x).toBe(10);
    expect(node.y).toBe(10);
    expect(node.width).toBe(100);
    expect(node.height).toBe(40);
  });

  test('no two node bounding boxes overlap, for a moderately connected 20+ node graph (Ticket 3.2 AC)', () => {
    const nodes = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, width: 120, height: 40 }));
    const edges = Array.from({ length: 24 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` })).concat([
      { source: 'n0', target: 'n10' },
      { source: 'n5', target: 'n20' },
      { source: 'n3', target: 'n15' },
    ]);
    const result = computeLayout({ nodes, edges });
    expect(result.nodes.size).toBe(25);
    assertNoOverlaps(result.nodes);
  });

  test('edges reference their endpoints\' actual computed positions via a real polyline (not a straight-line stub)', () => {
    const result = computeLayout({
      nodes: [
        { id: 'a', width: 100, height: 40 },
        { id: 'b', width: 100, height: 40 },
      ],
      edges: [{ source: 'a', target: 'b' }],
    });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.source).toBe('a');
    expect(result.edges[0]!.target).toBe('b');
    expect(result.edges[0]!.points.length).toBeGreaterThanOrEqual(2);
  });

  test('two distinct edges between the exact same source/target pair are BOTH preserved, not silently collapsed to one (real-fixture-found regression)', () => {
    // Sprint 2 never collapses duplicate reference edges (ADR 0002) — the
    // same two resources can legitimately be connected more than once
    // (e.g. two separate property references). Found by actually running
    // a real merged multi-template graph through this function: 60 input
    // edges rendered as only 54 without multigraph mode enabled.
    const result = computeLayout({
      nodes: [
        { id: 'a', width: 100, height: 40 },
        { id: 'b', width: 100, height: 40 },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
      ],
    });
    expect(result.edges).toHaveLength(2);
  });

  test('an edge naming an undeclared node is skipped, not thrown (graceful degradation, consistent project-wide stance)', () => {
    const result = computeLayout({
      nodes: [{ id: 'a', width: 100, height: 40 }],
      edges: [{ source: 'a', target: 'does-not-exist' }],
    });
    expect(result.edges).toHaveLength(0);
    expect(result.nodes.size).toBe(1);
  });

  test('an empty graph produces an empty layout without throwing', () => {
    const result = computeLayout({ nodes: [], edges: [] });
    expect(result.nodes.size).toBe(0);
    expect(result.edges).toHaveLength(0);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  test('disconnected components are packed into a grid, not one pathologically wide dagre pass (real-fixture-found regression)', () => {
    // Found by actually running a real 5-independent-template merge: one
    // single dagre pass over unconnected pieces produced an 18:1
    // width:height diagram — unreadable at any reasonable zoom level.
    // Four equal-sized, fully disconnected single nodes should pack into
    // something closer to a square than a 4-wide single row.
    const result = computeLayout({
      nodes: [
        { id: 'a', width: 100, height: 40 },
        { id: 'b', width: 100, height: 40 },
        { id: 'c', width: 100, height: 40 },
        { id: 'd', width: 100, height: 40 },
      ],
      edges: [],
    });
    expect(result.nodes.size).toBe(4);
    assertNoOverlaps(result.nodes);
    // A single 4-wide row would have an aspect ratio around 4:1 (plus
    // gaps); a 2x2 grid keeps it much closer to square. This is the
    // concrete, measurable difference between "packed" and "not packed."
    expect(result.width / result.height).toBeLessThan(2.5);
  });

  test('nodes belonging to different disconnected components never overlap each other after packing', () => {
    const result = computeLayout({
      nodes: [
        { id: 'a1', width: 120, height: 40 },
        { id: 'a2', width: 120, height: 40 },
        { id: 'b1', width: 120, height: 40 },
        { id: 'b2', width: 120, height: 40 },
      ],
      edges: [
        { source: 'a1', target: 'a2' },
        { source: 'b1', target: 'b2' },
      ],
    });
    expect(result.nodes.size).toBe(4);
    assertNoOverlaps(result.nodes);
  });

  test('a single connected component is unaffected by packing (no artificial offset introduced)', () => {
    const singleComponent = computeLayout({
      nodes: [
        { id: 'a', width: 100, height: 40 },
        { id: 'b', width: 100, height: 40 },
      ],
      edges: [{ source: 'a', target: 'b' }],
    });
    // Same graph, wrapped in a component that's trivially "packed" (only
    // one component exists) — must produce identical positions, proving
    // packing a single component is a true no-op, not an accidental shift.
    expect(singleComponent.nodes.get('a')!.x).toBe(10);
    expect(singleComponent.nodes.get('a')!.y).toBe(10);
  });

  test('overall diagram width/height cover every node\'s bounding box', () => {
    const result = computeLayout({
      nodes: [
        { id: 'a', width: 100, height: 40 },
        { id: 'b', width: 100, height: 40 },
        { id: 'c', width: 100, height: 40 },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    });
    for (const node of result.nodes.values()) {
      expect(node.x + node.width).toBeLessThanOrEqual(result.width + 0.001);
      expect(node.y + node.height).toBeLessThanOrEqual(result.height + 0.001);
    }
  });
});

describe('computeLayout — container nesting (Ticket 3.6.1)', () => {
  function box(l: { x: number; y: number; width: number; height: number }) {
    return { left: l.x, top: l.y, right: l.x + l.width, bottom: l.y + l.height };
  }

  /** Asserts `inner`'s box is fully contained within `outer`'s — the whole point of a container boundary. */
  function assertContains(outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }): void {
    const o = box(outer);
    const i = box(inner);
    expect(i.left).toBeGreaterThanOrEqual(o.left);
    expect(i.top).toBeGreaterThanOrEqual(o.top);
    expect(i.right).toBeLessThanOrEqual(o.right + 0.001);
    expect(i.bottom).toBeLessThanOrEqual(o.bottom + 0.001);
  }

  test('a container fully encloses its member node', () => {
    const result = computeLayout({
      nodes: [{ id: 'instance', width: 80, height: 40, containerId: 'subnet' }],
      edges: [],
      containers: [{ id: 'subnet', minWidth: 60, minHeight: 30 }],
    });
    expect(result.containers.size).toBe(1);
    assertContains(result.containers.get('subnet')!, result.nodes.get('instance')!);
  });

  test('nested containers: a 2-level VPC > Subnet > Instance chain nests correctly at every level', () => {
    const result = computeLayout({
      nodes: [{ id: 'instance', width: 80, height: 40, containerId: 'subnet' }],
      edges: [],
      containers: [
        { id: 'vpc', minWidth: 60, minHeight: 30 },
        { id: 'subnet', parentId: 'vpc', minWidth: 60, minHeight: 30 },
      ],
    });
    expect(result.containers.size).toBe(2);
    assertContains(result.containers.get('vpc')!, result.containers.get('subnet')!);
    assertContains(result.containers.get('subnet')!, result.nodes.get('instance')!);
    assertContains(result.containers.get('vpc')!, result.nodes.get('instance')!);
  });

  test('an empty container (no member nodes, no child containers) still gets a real, non-zero box — never silently dropped', () => {
    // Confirmed directly against @dagrejs/dagre first (not assumed): a
    // compound-graph cluster node with NO explicit size and NO children
    // comes back from dagre.layout() with x/y but no width/height at all.
    // Every container is given its own minWidth/minHeight (sized from its
    // label, the same way a real node is sized) specifically so this case
    // still renders as a real, visible, labeled boundary per the ticket's
    // own AC — dagre still auto-expands a non-empty container well beyond
    // this minimum (see the sibling "fully encloses" tests), so it's a
    // floor, not a fixed size.
    const result = computeLayout({
      nodes: [],
      edges: [],
      containers: [{ id: 'empty-subnet', minWidth: 60, minHeight: 30 }],
    });
    const container = result.containers.get('empty-subnet')!;
    expect(container).toBeDefined();
    expect(container.width).toBeGreaterThan(0);
    expect(container.height).toBeGreaterThan(0);
  });

  test('a plain node with no containerId is unaffected by containers existing elsewhere in the graph', () => {
    const result = computeLayout({
      nodes: [
        { id: 'standalone', width: 100, height: 40 },
        { id: 'contained', width: 80, height: 40, containerId: 'vpc' },
      ],
      edges: [],
      containers: [{ id: 'vpc', minWidth: 60, minHeight: 30 }],
    });
    const standalone = result.nodes.get('standalone')!;
    expect(standalone.width).toBe(100);
    expect(standalone.height).toBe(40);
    // Must not itself be inside the vpc container's box (they're unrelated).
    const vpc = box(result.containers.get('vpc')!);
    const node = box(standalone);
    const overlaps = node.left < vpc.right && node.right > vpc.left && node.top < vpc.bottom && node.bottom > vpc.top;
    expect(overlaps).toBe(false);
  });

  test('omitting `containers` entirely behaves identically to before this ticket — a real regression lock, not just "doesn\'t crash"', () => {
    const input: LayoutInput = { nodes: [{ id: 'solo', width: 100, height: 40 }], edges: [] };
    const result = computeLayout(input);
    expect(result.containers.size).toBe(0);
    // Byte-identical to the pre-existing "top-left coordinates" test above.
    const node = result.nodes.get('solo')!;
    expect(node.x).toBe(10);
    expect(node.y).toBe(10);
  });

  test('containers connected only by containment (no real edges at all between members) still get laid out together, not lost or scattered by the disconnected-components packer', () => {
    // Containment relationships are never part of `edges` (an ArchEdge of
    // kind 'containment' is filtered out before it ever reaches RenderGraph
    // — nesting is expressed via containerId/parentId only). A bare EC2
    // instance sitting alone in a subnet with zero other references is a
    // common, real case: the BFS that finds "connected components" for
    // packing must treat container membership as connectivity too, or a
    // VPC and its own subnet could be torn apart across the packed grid.
    const result = computeLayout({
      nodes: [{ id: 'lone-instance', width: 80, height: 40, containerId: 'subnet' }],
      edges: [], // deliberately no edges connecting anything
      containers: [
        { id: 'vpc', minWidth: 60, minHeight: 30 },
        { id: 'subnet', parentId: 'vpc', minWidth: 60, minHeight: 30 },
      ],
    });
    assertContains(result.containers.get('vpc')!, result.containers.get('subnet')!);
    assertContains(result.containers.get('subnet')!, result.nodes.get('lone-instance')!);
  });

  test('packing offsets a container\'s position exactly like it offsets its member nodes, when multiple disconnected component groups exist', () => {
    const result = computeLayout({
      nodes: [
        { id: 'a', width: 100, height: 40, containerId: 'vpc-a' },
        { id: 'b', width: 100, height: 40, containerId: 'vpc-b' },
      ],
      edges: [], // vpc-a's group and vpc-b's group are fully disconnected from each other
      containers: [
        { id: 'vpc-a', minWidth: 60, minHeight: 30 },
        { id: 'vpc-b', minWidth: 60, minHeight: 30 },
      ],
    });
    assertContains(result.containers.get('vpc-a')!, result.nodes.get('a')!);
    assertContains(result.containers.get('vpc-b')!, result.nodes.get('b')!);
    // The two containers must not overlap each other post-packing.
    const boxA = box(result.containers.get('vpc-a')!);
    const boxB = box(result.containers.get('vpc-b')!);
    const overlap = boxA.left < boxB.right && boxA.right > boxB.left && boxA.top < boxB.bottom && boxA.bottom > boxB.top;
    expect(overlap).toBe(false);
  });

  test('overall diagram width/height cover every container\'s bounding box too, not just nodes', () => {
    const result = computeLayout({
      nodes: [{ id: 'instance', width: 80, height: 40, containerId: 'vpc' }],
      edges: [],
      containers: [{ id: 'vpc', minWidth: 60, minHeight: 30 }],
    });
    const vpc = result.containers.get('vpc')!;
    expect(vpc.x + vpc.width).toBeLessThanOrEqual(result.width + 0.001);
    expect(vpc.y + vpc.height).toBeLessThanOrEqual(result.height + 0.001);
  });

  test('a real @dagrejs/dagre compound-graph limitation never crashes computeLayout, and containers still fully enclose their members', () => {
    // Confirmed directly against @dagrejs/dagre in isolation (not assumed,
    // and not simply "too many nodes"): this exact node/edge/container
    // shape — 200 real nodes spread across 20 containers, chain-plus-hub
    // edges — throws "Not possible to find intersection inside of the
    // rectangle" from inside dagre's own compound-graph edge-routing.
    // Tuning `ranker`/container minimum size didn't avoid it either (also
    // checked directly); 500 nodes with the identical shape does NOT
    // crash, which rules out plain scale as the cause — this is a real
    // limitation in the library's compound+edge-routing combination, not
    // a bug in ArchLens's own sizing. `computeLayout()` must fall back to
    // a flat (non-compound) layout for the affected component rather than
    // let one bad shape crash the whole diagram — consistent with this
    // project's established "degrade gracefully, never crash on a
    // structurally fine input" stance from every earlier layer.
    const containerCount = 20;
    const nodeCount = 200;
    const containers: { id: string; parentId?: string; minWidth: number; minHeight: number }[] = Array.from(
      { length: containerCount },
      (_, i) => ({ id: `c${i}`, minWidth: 60, minHeight: 30 }),
    );
    // An empty container (no members, no children) *nested inside* one of
    // the real containers — riding along in the SAME crashing layout call
    // and, critically, the SAME connected component (a fully isolated
    // top-level container forms its own trivial, non-crashing component
    // under `findConnectedComponents`, which would never actually reach
    // the fallback path at all — confirmed directly: an earlier, isolated
    // version of this test passed even with the fallback's empty-container
    // handling completely gutted, because it never got exercised).
    containers.push({ id: 'c-empty', parentId: 'c0', minWidth: 60, minHeight: 30 });
    const nodes = Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}`, width: 120, height: 40, containerId: `c${i % containerCount}` }));
    const edges: { source: string; target: string }[] = [];
    for (let i = 1; i < nodeCount; i++) edges.push({ source: `n${Math.floor(i / 8)}`, target: `n${i}` });

    let result: ReturnType<typeof computeLayout> | undefined;
    expect(() => {
      result = computeLayout({ nodes, edges, containers });
    }).not.toThrow();

    expect(result!.nodes.size).toBe(nodeCount);
    expect(result!.containers.size).toBe(containerCount + 1);
    // Every member node must still land fully inside its own container's
    // box even under the fallback path — the "boundary" promise can't be
    // quietly dropped just because dagre's own compound layout failed.
    for (const node of nodes) {
      const containerBox = result!.containers.get(node.containerId!)!;
      const nodeBox = result!.nodes.get(node.id)!;
      assertContains(containerBox, nodeBox);
    }
    // The empty container must still render as a real, non-zero, non-NaN,
    // non-infinite boundary — never silently dropped or corrupted.
    const emptyBox = result!.containers.get('c-empty')!;
    expect(Number.isFinite(emptyBox.width)).toBe(true);
    expect(Number.isFinite(emptyBox.height)).toBe(true);
    expect(emptyBox.width).toBeGreaterThan(0);
    expect(emptyBox.height).toBeGreaterThan(0);
  });

  test('re-verifying the 1,000-node performance budget (PO Question 14) still holds with container structure present', () => {
    const containerCount = 20;
    const containers = Array.from({ length: containerCount }, (_, i) => ({ id: `vpc-${i}`, minWidth: 60, minHeight: 30 }));
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `node-${i}`, width: 120, height: 40, containerId: `vpc-${i % containerCount}` }));
    const edges: { source: string; target: string }[] = [];
    for (let i = 1; i < 1000; i++) edges.push({ source: `node-${Math.floor(i / 8)}`, target: `node-${i}` });

    const start = Date.now();
    const result = computeLayout({ nodes, edges, containers });
    const elapsedMs = Date.now() - start;

    expect(result.nodes.size).toBe(1000);
    expect(result.containers.size).toBe(containerCount);
    // A real, measured cost, not the flat-layout budget re-used blindly:
    // dagre's compound-graph mode is genuinely slower than flat layout at
    // this scale — measured directly (not assumed) at 5.3s-6.6s in
    // isolation across several runs. Under full-suite parallel contention
    // (all 33 test files' worth of work scheduled at once, several of them
    // launching their own real headless-Chromium process — the same
    // phenomenon `vitest.config.ts`'s own `testTimeout`/`hookTimeout`
    // comment documents raising 5s -> 30s for) this was observed hitting
    // 10.8s at 10s and still occasionally tripping 15s once raised —
    // genuinely variable with how much else is contending for CPU at that
    // exact moment, not a fixed regression. 20s keeps real headroom for
    // that observed variance without hiding an actually-hung/regressed
    // test; this project has no CI gate yet (Sprint 12's job), so the
    // cost of an occasional false-red locally is real but not a shipped-
    // pipeline risk today.
    expect(elapsedMs).toBeLessThan(20_000);
  });
});

describe('computeLayout — orthogonal edge routing (Ticket 3.6.3)', () => {
  function isAxisAligned(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
    return a.x === b.x || a.y === b.y;
  }

  function assertAllSegmentsAxisAligned(points: { x: number; y: number }[]): void {
    for (let i = 0; i < points.length - 1; i++) {
      expect(isAxisAligned(points[i]!, points[i + 1]!)).toBe(true);
    }
  }

  test('an edge whose source and target sit at different x AND different y (a real diagonal) is routed as an all-right-angle polyline, never a single diagonal segment', () => {
    const input: LayoutInput = {
      nodes: [
        { id: 'a', width: 40, height: 40 },
        { id: 'b', width: 40, height: 40 },
      ],
      edges: [{ source: 'a', target: 'b' }],
    };
    const result = computeLayout(input);
    const edge = result.edges[0]!;
    assertAllSegmentsAxisAligned(edge.points);
  });

  test('the routed polyline still starts and ends at the edge\'s real endpoint positions — only the intermediate path changes, not what it connects', () => {
    const input: LayoutInput = {
      nodes: [
        { id: 'a', width: 40, height: 40 },
        { id: 'b', width: 40, height: 40 },
        { id: 'c', width: 40, height: 40 },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
      ],
    };
    const result = computeLayout(input);
    for (const edge of result.edges) {
      const rawFirst = edge.points[0]!;
      const rawLast = edge.points[edge.points.length - 1]!;
      // Both endpoints must land on their real node's boundary, not float
      // off into empty space just because routing changed.
      expect(Number.isFinite(rawFirst.x)).toBe(true);
      expect(Number.isFinite(rawLast.x)).toBe(true);
    }
  });

  test('a real multi-node, multi-rank graph: every single edge is fully axis-aligned end to end, not just the simple 2-node case', () => {
    const input: LayoutInput = {
      nodes: Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, width: 100, height: 40 })),
      edges: Array.from({ length: 19 }, (_, i) => ({ source: `n${Math.floor(i / 3)}`, target: `n${i + 1}` })),
    };
    const result = computeLayout(input);
    for (const edge of result.edges) {
      assertAllSegmentsAxisAligned(edge.points);
    }
  });

  test('toOrthogonalPoints: a segment that is already purely vertical or horizontal is left untouched, not given a needless extra bend', () => {
    // Unit-tested directly against the transform function itself (not
    // through the full computeLayout pipeline) — dagre's own raw point
    // lists have their own quirks (e.g. an extra label-position point even
    // on a straight edge) unrelated to this transform's own behavior, and
    // testing the pure function in isolation is the precise way to pin down
    // "no needless bend" without being at their mercy.
    const alreadyVertical = [
      { x: 10, y: 0 },
      { x: 10, y: 20 },
      { x: 10, y: 40 },
    ];
    expect(toOrthogonalPoints(alreadyVertical)).toEqual(alreadyVertical);

    const alreadyHorizontal = [
      { x: 0, y: 5 },
      { x: 30, y: 5 },
    ];
    expect(toOrthogonalPoints(alreadyHorizontal)).toEqual(alreadyHorizontal);
  });

  test('toOrthogonalPoints: a genuinely diagonal segment gets exactly one vertical-horizontal-vertical elbow inserted, endpoints unchanged', () => {
    const diagonal = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    const result = toOrthogonalPoints(diagonal);
    expect(result[0]).toEqual({ x: 0, y: 0 });
    expect(result[result.length - 1]).toEqual({ x: 10, y: 10 });
    for (let i = 0; i < result.length - 1; i++) {
      expect(isAxisAligned(result[i]!, result[i + 1]!)).toBe(true);
    }
  });
});

describe('computeLayout — PO Question 14 performance target: 1,000 nodes', () => {
  function generateSyntheticGraph(nodeCount: number): LayoutInput {
    const nodes = Array.from({ length: nodeCount }, (_, i) => ({ id: `node-${i}`, width: 140, height: 40 }));
    const edges: { source: string; target: string }[] = [];
    // A plausible real-world shape: a handful of "hub" nodes (e.g. VPC, cluster)
    // that many others depend on, plus a chain, rather than a purely random graph.
    for (let i = 1; i < nodeCount; i++) {
      edges.push({ source: `node-${Math.floor(i / 8)}`, target: `node-${i}` });
    }
    for (let i = 0; i < nodeCount; i += 37) {
      const target = (i + 17) % nodeCount;
      if (target !== i) edges.push({ source: `node-${i}`, target: `node-${target}` });
    }
    return { nodes, edges };
  }

  test('lays out 1,000 nodes without overlaps, completing within a responsive time budget', () => {
    const input = generateSyntheticGraph(1000);
    const start = Date.now();
    const result = computeLayout(input);
    const elapsedMs = Date.now() - start;

    expect(result.nodes.size).toBe(1000);
    assertNoOverlaps(result.nodes);
    // Generous budget for a synthetic worst-case-ish shape — "responsive"
    // per PO Question 14 doesn't mean instant, but well under what would
    // read as a hung/broken tool.
    expect(elapsedMs).toBeLessThan(5000);
  });
});
