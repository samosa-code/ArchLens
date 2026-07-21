import { describe, expect, test } from 'vitest';
import { computeLayout, type LayoutInput } from '../layout.js';

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
