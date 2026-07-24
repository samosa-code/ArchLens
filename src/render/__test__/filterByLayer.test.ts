import { describe, expect, test } from 'vitest';
import { filterRenderGraphByLayer } from '../filterByLayer.js';
import type { RenderGraph } from '../types.js';

/**
 * Ticket 3.4 — `--layer=<list>` (allowlist) and `--hide-monitoring`
 * (opt-out, per PO Question 17: monitoring is visible by default). Both
 * are meaningless against the `--raw` 1:1 projection, which has no
 * `layer` concept at all — a node with no `layer` always survives,
 * regardless of either flag.
 */

function graph(nodes: RenderGraph['nodes'], edges: RenderGraph['edges'] = []): RenderGraph {
  return { nodes, edges };
}

describe('filterRenderGraphByLayer', () => {
  test('no options: everything survives unchanged', () => {
    const input = graph([{ id: 'a', label: 'A', layer: 'compute' }, { id: 'b', label: 'B', layer: 'data' }]);
    expect(filterRenderGraphByLayer(input, {})).toEqual(input);
  });

  test('--layer allowlist keeps only matching layers; edges touching a dropped node are dropped too', () => {
    const input = graph(
      [
        { id: 'fn', label: 'Fn', layer: 'compute' },
        { id: 'table', label: 'Table', layer: 'data' },
        { id: 'api', label: 'Api', layer: 'api' },
      ],
      [
        { source: 'fn', target: 'table' },
        { source: 'api', target: 'fn' },
      ],
    );
    const result = filterRenderGraphByLayer(input, { allowLayers: ['compute', 'data'] });
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['fn', 'table']);
    // The Api->Fn edge touches a dropped node (api) and must not survive
    // referencing a node no longer in the output.
    expect(result.edges).toEqual([{ source: 'fn', target: 'table' }]);
  });

  test('a node with no layer at all (the --raw projection) always survives an allowlist filter', () => {
    const input = graph([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', layer: 'compute' }]);
    const result = filterRenderGraphByLayer(input, { allowLayers: ['data'] });
    expect(result.nodes.map((n) => n.id)).toEqual(['a']);
  });

  test('--hide-monitoring removes only the monitoring layer, others untouched (PO Question 17: visible by default otherwise)', () => {
    const input = graph([
      { id: 'dash', label: 'Dashboard', layer: 'monitoring' },
      { id: 'fn', label: 'Fn', layer: 'compute' },
    ]);
    const result = filterRenderGraphByLayer(input, { hideMonitoring: true });
    expect(result.nodes.map((n) => n.id)).toEqual(['fn']);
  });

  test('without --hide-monitoring, monitoring nodes are kept — the default is visible, not hidden', () => {
    // Passes a non-empty options object (an allowlist including
    // 'monitoring') so this actually exercises the filter's per-node
    // logic — {} alone hit an early-return short-circuit and passed even
    // when the mutation-testing pass below unconditionally dropped every
    // monitoring node, a real gap this test now closes.
    const input = graph([
      { id: 'dash', label: 'Dashboard', layer: 'monitoring' },
      { id: 'fn', label: 'Fn', layer: 'compute' },
    ]);
    const result = filterRenderGraphByLayer(input, { allowLayers: ['monitoring', 'compute'] });
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['dash', 'fn']);
  });

  test('--layer and --hide-monitoring compose: hide-monitoring wins even if monitoring is in the allowlist', () => {
    const input = graph([
      { id: 'dash', label: 'Dashboard', layer: 'monitoring' },
      { id: 'fn', label: 'Fn', layer: 'compute' },
    ]);
    const result = filterRenderGraphByLayer(input, { allowLayers: ['monitoring', 'compute'], hideMonitoring: true });
    expect(result.nodes.map((n) => n.id)).toEqual(['fn']);
  });

  test('containers are never filtered by layer — they are structural boundaries, not layered components', () => {
    const input: RenderGraph = {
      nodes: [{ id: 'fn', label: 'Fn', layer: 'compute' }],
      edges: [],
      containers: [{ id: 'vpc', label: 'VPC', kind: 'vpc' }],
    };
    const result = filterRenderGraphByLayer(input, { allowLayers: ['data'] });
    expect(result.containers).toEqual([{ id: 'vpc', label: 'VPC', kind: 'vpc' }]);
    expect(result.nodes).toEqual([]);
  });
});
